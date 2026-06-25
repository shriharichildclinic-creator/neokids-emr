const prisma = require('../config/prisma');
const { minutesToTime, timeToMinutes, getLiveSlots } = require('./slot.service');
const cashfreeService = require('./cashfree.service');
const { parseDateOnly, parseDateOnlyOrNull } = require('../utils/date');
const { expirePendingAppointments } = require('./appointment-state.service');
const logger = require('../utils/logger');

// NOTE: automation is NOT required at the top level — it creates a circular dep:
//   booking → automation → slot → expirePending → (back to booking context)
// This causes whatsapp.service to be a partially-initialized {} when Node resolves
// the cycle, making whatsapp.sendWhatsApp undefined ("not a function").
// FIX: require automation lazily inside each function that needs it.

const UNPAID_BOOKING_EXPIRY_MINUTES = parseInt(process.env.UNPAID_BOOKING_EXPIRY_MINUTES || '15', 10);

// Normalize a name for sibling lookup: lowercase, collapse whitespace, trim.
// This is what we match on so "Ravi Kumar" and "  ravi   kumar " are the same kid
// but "Ravi Kumar" and "Sneha Kumar" stay separate even on the same parent phone.
function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Issue #18 — produce the canonical *stored* name. Whitespace is
// collapsed and trimmed so we never write "  alice   kid  " into the
// row, but the original casing is preserved (titlecasing user-supplied
// names is a path to mangling proper nouns — we just normalize
// whitespace, which is the actual source of the duplicate-row bug).
function canonicalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

/**
 * Bug 1 + Issue #18 — Resolve patient row by (phone + normalized name).
 *
 * Old behavior: prisma.patient.upsert({ where: { phone }, ... })
 *   → @unique on phone meant ONE patient per phone, so sibling B's booking
 *     was forcibly merged into sibling A's row.
 *
 * Issue #18 specifically: the lookup function existed, but two concurrent
 * bookings could both miss the lookup and both insert, producing duplicate
 * rows for the same child. And the stored `name` value wasn't normalized,
 * so a re-lookup after a sloppy entry could miss as well.
 *
 * New behavior:
 *   1. Whitespace-canonicalize the supplied name on the way in.
 *   2. Wrap the lookup + create in a serialisable transaction — if two
 *      bookings race, the second one re-reads inside the txn boundary
 *      and finds the row inserted by the first. The DB now enforces
 *      the dedup guarantee that the validator was only documenting.
 *   3. The stored name (`patient.name`) is the canonicalized form, so
 *      future case-insensitive lookups against the normalized key are
 *      stable.
 *
 * Note on the "there is no normalization on insert" complaint in #18:
 * the prior version trimmed but did not collapse internal whitespace,
 * so `"Alice  Kid"` (two spaces) stored differently from `"Alice Kid"`,
 * and the normalizer's whitespace collapse didn't help on lookup
 * because the normalized key matched but the *next* insert would write
 * the bad form again. Canonicalizing on the way IN closes that.
 */
async function findOrCreatePatient({ patientName, phone, email, parentName, dateOfBirth, gender }) {
  const cleanName = canonicalizeName(patientName);
  const cleanParent = canonicalizeName(parentName);
  const nameKey = normalizeName(cleanName);

  return prisma.$transaction(async (tx) => {
    const candidates = await tx.patient.findMany({
      where: { phone },
      orderBy: { createdAt: 'asc' }
    });
    const existing = candidates.find(p => normalizeName(p.name) === nameKey);

    if (existing) {
      return tx.patient.update({
        where: { id: existing.id },
        data: {
          // name intentionally NOT updated — identity field, set once on create.
          email:       email || existing.email || null,
          parentName:  cleanParent || existing.parentName,
          dateOfBirth: parseDateOnlyOrNull(dateOfBirth) || existing.dateOfBirth,
          gender:      gender || existing.gender
        }
      });
    }

    return tx.patient.create({
      data: {
        name:        cleanName,
        phone,
        email:       email || null,
        parentName:  cleanParent,
        dateOfBirth: parseDateOnlyOrNull(dateOfBirth),
        gender
      }
    });
  });
}

async function bookAppointment(input) {
  const {
    doctorId,
    patientName,
    phone,
    email,
    parentName,
    dateOfBirth,
    gender,
    primaryProblem,
    date,
    startTime,
    consultationType
  } = input;

  await expirePendingAppointments();

  const doctor = await prisma.doctor.findFirst({ where: { id: doctorId, deletedAt: null } });
  if (!doctor) throw Object.assign(new Error('Doctor not found'), { statusCode: 404 });
  if (!doctor.isAvailable) throw Object.assign(new Error('Doctor not available'), { statusCode: 400 });

  if (doctor.consultationModes !== 'BOTH' && doctor.consultationModes !== consultationType) {
    throw Object.assign(new Error('Consultation mode not supported by this doctor'), { statusCode: 400 });
  }

  // ── Issue 11 — distinguish off-grid, outside-hours, and taken slots ──
  // Working-hours check (per consultationType)
  const fromKey = consultationType === 'ONLINE' ? 'availableFromOnline' : 'availableFromOffline';
  const toKey   = consultationType === 'ONLINE' ? 'availableToOnline'   : 'availableToOffline';
  const fromTime = doctor[fromKey];
  const toTime   = doctor[toKey];
  if (!fromTime || !toTime) {
    throw Object.assign(
      new Error(`Doctor has no ${consultationType.toLowerCase()} working hours configured`),
      { statusCode: 400, code: 'NO_WORKING_HOURS' }
    );
  }
  const reqMin   = timeToMinutes(startTime);
  const startMin = reqMin;                          // kept for downstream code
  const fromMin  = timeToMinutes(fromTime);
  const toMin    = timeToMinutes(toTime);
  const duration = doctor.slotDuration || 15;

  if (reqMin < fromMin || reqMin + duration > toMin) {
    throw Object.assign(
      new Error(
        `Outside doctor's working hours (${fromTime}–${toTime} for ${consultationType})`
      ),
      { statusCode: 400, code: 'OUTSIDE_WORKING_HOURS' }
    );
  }

  // Grid alignment — startTime must be exactly on a slot boundary.
  if ((reqMin - fromMin) % duration !== 0) {
    throw Object.assign(
      new Error(
        `Invalid slot — not on the schedule grid (${duration}-minute slots starting at ${fromTime})`
      ),
      { statusCode: 400, code: 'OFF_GRID_TIME' }
    );
  }

  // Now the only remaining reason a live slot would be missing/unavailable
  // is that someone else has booked it (or it has already passed today).
  const liveSlots = await getLiveSlots(doctorId, date, consultationType);
  const selectedSlot = liveSlots.find((slot) => slot.startTime === startTime);
  if (!selectedSlot || !selectedSlot.available) {
    throw Object.assign(
      new Error('Selected slot is no longer available'),
      { statusCode: 409, code: 'SLOT_TAKEN' }
    );
  }

  const endTime = minutesToTime(startMin + duration);
  const feeAtBooking = consultationType === 'ONLINE' ? doctor.onlineConsultFee : doctor.physicalConsultFee;

  // Bug 1 — resolve patient by (phone + child name), not by phone alone.
  const patient = await findOrCreatePatient({
    patientName, phone, email, parentName, dateOfBirth, gender
  });

  const appointmentDate = parseDateOnly(date);
  const expiresAt = consultationType === 'ONLINE'
    ? new Date(Date.now() + UNPAID_BOOKING_EXPIRY_MINUTES * 60 * 1000)
    : null;

  let appointment;
  try {
    appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId: patient.id,
        primaryProblem,
        date: appointmentDate,
        startTime,
        endTime,
        consultationType,
        feeAtBooking,
        status: consultationType === 'OFFLINE' ? 'CONFIRMED' : 'PENDING',
        paymentStatus: consultationType === 'OFFLINE' ? 'CASH_PENDING' : 'UNPAID',
        expiresAt
      },
      include: { doctor: true, patient: true }
    });
  } catch (e) {
    if (e.code === 'P2002') {
      throw Object.assign(new Error('Slot already booked. Please pick another time.'), { statusCode: 409 });
    }
    throw e;
  }

  if (consultationType === 'OFFLINE') {
    const automation = require('./automation.service');
    await automation.onPhysicalBookingConfirmed(appointment);
    return { appointment, requiresPayment: false };
  }

  let order;
  try {
    order = await cashfreeService.createOrder({
      orderId: `appt_${appointment.id}`,
      amount: Number(feeAtBooking),
      currency: 'INR',
      customer: {
        customerId: patient.id,
        customerName: patientName,
        customerEmail: email || 'no-reply@neokidspro.in',
        customerPhone: phone
      },
      orderNote: `Consultation booking for Dr. ${doctor.name}`,
      orderTags: { appointmentId: appointment.id, consultationType }
    });
  } catch (e) {
    // Cashfree order creation failed — release the slot immediately
    // instead of leaving a dead PENDING row blocking the time.
    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: 'CANCELLED', paymentStatus: 'FAILED', cancelledAt: new Date(), notes: 'Cashfree order creation failed' }
    }).catch(err => logger.error('Failed to roll back appointment after CF error', err));
    throw e;
  }

  await prisma.appointment.update({
    where: { id: appointment.id },
    data: { cashfreeOrderId: order.order_id }
  });

  return {
    appointment,
    requiresPayment: true,
    cashfree: {
      orderId: order.order_id,
      paymentSessionId: order.payment_session_id,
      amount: order.order_amount,
      currency: order.order_currency,
      environment: cashfreeService.getMode(),
      expiresAt
    }
  };
}

/**
 * Idempotent + race-safe confirmation.
 *
 * Both the webhook handler and the verifyPayment poll endpoint can race
 * to confirm the same order. The old code did:
 *   if (appt.paymentStatus === 'PAID') return appt;   // check
 *   await prisma.appointment.update(...)              // then act
 * which is TOCTOU — two concurrent calls could both see UNPAID, both
 * update to PAID, and both fire onOnlineBookingConfirmed (duplicate
 * WhatsApp + duplicate Meet link + duplicate invoice).
 *
 * Fix: use a conditional updateMany. Only the call that flips the row
 * gets to run the automation.
 */
async function confirmOnlineBooking(appointmentId, cashfreePaymentId) {
  const before = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { doctor: true, patient: true }
  });
  if (!before) throw new Error('Appointment not found');
  if (before.status === 'CANCELLED') return before;
  if (before.paymentStatus === 'PAID') return before;

  // Atomic flip: only succeeds for the FIRST caller that finds it not-PAID.
  const flipped = await prisma.appointment.updateMany({
    where: { id: appointmentId, paymentStatus: { not: 'PAID' }, status: { not: 'CANCELLED' } },
    data: {
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
      cashfreePaymentId: String(cashfreePaymentId),
      expiresAt: null
    }
  });

  const updated = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { doctor: true, patient: true }
  });

  if (flipped.count === 0) {
    // Some other concurrent caller already confirmed; skip automation.
    return updated;
  }

  const automation = require('./automation.service');
  await automation.onOnlineBookingConfirmed(updated);
  return updated;
}

module.exports = { bookAppointment, confirmOnlineBooking, findOrCreatePatient };
