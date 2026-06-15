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

/**
 * Bug 1 — Resolve patient row by (phone + normalized name).
 *
 * Old behavior: prisma.patient.upsert({ where: { phone }, ... })
 *   → @unique on phone meant ONE patient per phone, so sibling B's booking
 *     was forcibly merged into sibling A's row. Even with `name` removed from
 *     the update block, gender / DOB / parentName were still being overwritten
 *     on the shared row, contaminating sibling A's clinical record.
 *
 * New behavior:
 *   - Look up patient by phone + normalized name.
 *   - If found  → update non-identity fields (email, parentName, DOB, gender)
 *                 on THAT specific child only.
 *   - If not found → create a brand new patient row (new patientId).
 *
 * Result: Each child gets their own immutable patientId. Doctor history,
 * prescriptions, and visit list for sibling A are no longer touched when
 * sibling B books.
 */
async function findOrCreatePatient({ patientName, phone, email, parentName, dateOfBirth, gender }) {
  const nameKey = normalizeName(patientName);

  // findFirst with a name comparison done in code (MySQL collation may or may
  // not be case-insensitive depending on column; we normalize manually for safety).
  const candidates = await prisma.patient.findMany({
    where: { phone },
    orderBy: { createdAt: 'asc' }
  });
  const existing = candidates.find(p => normalizeName(p.name) === nameKey);

  if (existing) {
    return prisma.patient.update({
      where: { id: existing.id },
      data: {
        // name intentionally NOT updated — identity field, set once on create.
        email:       email || existing.email || null,
        parentName:  parentName || existing.parentName,
        dateOfBirth: parseDateOnlyOrNull(dateOfBirth) || existing.dateOfBirth,
        gender:      gender || existing.gender
      }
    });
  }

  return prisma.patient.create({
    data: {
      name: String(patientName).trim(),
      phone,
      email: email || null,
      parentName,
      dateOfBirth: parseDateOnlyOrNull(dateOfBirth),
      gender
    }
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

  const liveSlots = await getLiveSlots(doctorId, date, consultationType);
  const selectedSlot = liveSlots.find((slot) => slot.startTime === startTime);
  if (!selectedSlot || !selectedSlot.available) {
    throw Object.assign(new Error('Selected slot is no longer available'), { statusCode: 409 });
  }

  const startMin = timeToMinutes(startTime);
  const endTime = minutesToTime(startMin + (doctor.slotDuration || 15));
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
