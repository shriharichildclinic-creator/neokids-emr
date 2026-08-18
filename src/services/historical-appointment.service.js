// =====================================================================
// historical-appointment.service.js
// ---------------------------------------------------------------------
// Feature 1 + 1A — Historical / Manual Appointment Records with Smart
// Patient Matching.
//
// This service is intentionally isolated from booking.service so that
// the existing NeoKidsPro booking flow is never affected. Historical
// records use their own creation path but share the same `Appointment`
// table (with `source = "MANUAL"`) so they show up everywhere the UI
// already renders appointments — timeline, medical history, prescription
// archive — automatically.
//
// Matching logic (order):
//   1. If patientId explicitly provided → use it (verify existence).
//   2. Else, phone + name (case/space insensitive) → auto-link.
//   3. Else, phone alone matches an existing patient:
//        - If names look similar → auto-link
//        - If names differ AND linkConfirmed=false → return 409 with
//          the candidates so the UI can ask "Link or create new?"
//        - If linkConfirmed=true → create separate patient row
//   4. Else → create a brand new patient row.
//
// The result is: same phone number never spawns a duplicate patient
// silently, and staff always sees a warning when a conflict is possible.
// =====================================================================

const prisma = require('../config/prisma');
const { parseDateOnly, parseDateOnlyOrNull } = require('../utils/date');
const logger = require('../utils/logger');
const { doctorOwnsPatient } = require('../utils/patientAccess');

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
function canonicalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

// Two names are "similar" if:
//   - normalized forms are identical, OR
//   - one is a prefix / suffix of the other (nickname), OR
//   - first token matches (Aarav Sharma vs Aarav S.)
function namesLookSimilar(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.startsWith(nb) || nb.startsWith(na)) return true;
  const firstA = na.split(' ')[0];
  const firstB = nb.split(' ')[0];
  return firstA && firstA === firstB;
}

/**
 * Resolve an existing patient OR determine what should happen.
 *
 * Returns one of:
 *   { action: 'LINKED', patient, matchType }
 *   { action: 'NEEDS_CONFIRMATION', candidates }   // caller must resend with linkConfirmed
 *   { action: 'CREATE_NEW', patient }              // new row created
 */
async function resolvePatient(tx, input, actorRole) {
  const {
    patientId,
    patientName,
    phone,
    email,
    parentName,
    dateOfBirth,
    gender,
    linkConfirmed,
    doctorId
  } = input;

  // ── Case 1: explicit link ──────────────────────────────────────────
  if (patientId) {
    const existing = await tx.patient.findUnique({ where: { id: patientId } });
    if (!existing) {
      const err = new Error('Referenced patient does not exist');
      err.statusCode = 404;
      throw err;
    }
    // SECURITY FIX (Patient Linking audit): an explicit patientId used
    // to be trusted outright — a doctor could attach a historical
    // appointment (and everything that flows from it: prescriptions,
    // certificates) to a patient exclusively under another doctor's
    // care just by supplying that patient's id. Admins create these on
    // a doctor's behalf and legitimately need the full directory, so
    // this only applies when a DOCTOR is the one submitting the record.
    if (actorRole === 'DOCTOR') {
      const owns = await doctorOwnsPatient(doctorId, patientId);
      if (!owns) {
        const err = new Error('You can only link a historical appointment to a patient already under your own care.');
        err.statusCode = 403;
        throw err;
      }
    }
    return { action: 'LINKED', patient: existing, matchType: 'EXPLICIT_ID' };
  }

  // Everything below requires phone + name.
  const cleanName = canonicalizeName(patientName);

  // ── Case 2/3: phone-based match ─────────────────────────────────────
  const candidates = await tx.patient.findMany({
    where: { phone },
    orderBy: { createdAt: 'asc' }
  });

  if (candidates.length) {
    // Exact (normalized) name match → high-confidence link.
    const nameKey = normalizeName(cleanName);
    const exactMatch = candidates.find(p => normalizeName(p.name) === nameKey);
    if (exactMatch) {
      // Opportunistically enrich blank fields (but never overwrite name).
      const enriched = await tx.patient.update({
        where: { id: exactMatch.id },
        data: {
          email:       email       || exactMatch.email       || null,
          parentName:  canonicalizeName(parentName) || exactMatch.parentName,
          dateOfBirth: parseDateOnlyOrNull(dateOfBirth) || exactMatch.dateOfBirth,
          gender:      gender      || exactMatch.gender      || null
        }
      });
      return { action: 'LINKED', patient: enriched, matchType: 'PHONE_NAME' };
    }

    // Similar name (nickname / initial) → medium-confidence link.
    const similar = candidates.find(p => namesLookSimilar(p.name, cleanName));
    if (similar) {
      return { action: 'LINKED', patient: similar, matchType: 'PHONE_SIMILAR_NAME' };
    }

    // Same phone, clearly different names → conflict.
    if (!linkConfirmed) {
      return {
        action: 'NEEDS_CONFIRMATION',
        candidates: candidates.map(p => ({
          id: p.id,
          name: p.name,
          phone: p.phone,
          dateOfBirth: p.dateOfBirth,
          gender: p.gender,
          parentName: p.parentName
        }))
      };
    }

    // User acknowledged conflict and wants a separate patient row → fall through to create.
  }

  // ── Case 4: create new patient ──────────────────────────────────────
  const created = await tx.patient.create({
    data: {
      name:        cleanName,
      phone,
      email:       email || null,
      parentName:  canonicalizeName(parentName),
      dateOfBirth: parseDateOnlyOrNull(dateOfBirth),
      gender:      gender || null
    }
  });
  return { action: 'CREATE_NEW', patient: created };
}

/**
 * Compute a startTime that will not collide with the existing
 * unique_doctor_slot index on (doctorId, date, startTime).
 *
 * Historical rows often have an unknown time. We default to "09:00"
 * for the first record on a given day and probe +1 minute until we
 * find an unused slot. Times are cosmetic on historical rows — the
 * slot service ignores them because CONFIRMED/COMPLETED status is set
 * directly.
 */
async function findFreeHistoricalStartTime(tx, doctorId, date, preferred) {
  const base = preferred && /^\d{2}:\d{2}$/.test(preferred) ? preferred : '09:00';
  const [bh, bm] = base.split(':').map(Number);
  let total = bh * 60 + bm;
  for (let i = 0; i < 60 * 24; i++) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const existing = await tx.appointment.findFirst({
      where: { doctorId, date, startTime: t },
      select: { id: true }
    });
    if (!existing) return t;
    total = (total + 1) % (24 * 60);
  }
  // Fallback — extremely unlikely.
  return base;
}

/**
 * Compute endTime string given a start time and duration (minutes).
 */
function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const nh = Math.floor((total % (24 * 60)) / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

/**
 * Create a historical / manual appointment record. Runs inside a
 * transaction so patient resolution + appointment insert are atomic.
 *
 * @param {Object} input      historicalAppointmentSchema.parse result
 * @param {Object} audit      { addedById, addedByRole }
 * @param {String} manualPrescriptionUrl   optional URL (already stored)
 *
 * @returns One of:
 *   { needsConfirmation: true, candidates }  → caller must re-post with linkConfirmed=true
 *   { appointment, patient, matchType }      → success
 */
async function createHistoricalAppointment(input, audit, manualPrescriptionUrl) {
  const {
    doctorId, date, startTime, consultationType,
    reasonForVisit, diagnosis, notes, followUpDate
  } = input;

  // Verify doctor exists and is not deleted.
  const doctor = await prisma.doctor.findFirst({
    where: { id: doctorId, deletedAt: null }
  });
  if (!doctor) {
    const err = new Error('Doctor not found or inactive');
    err.statusCode = 404;
    throw err;
  }

  return prisma.$transaction(async (tx) => {
    // Step 1 — Smart patient matching / creation.
    const resolution = await resolvePatient(tx, input, audit && audit.addedByRole);
    if (resolution.action === 'NEEDS_CONFIRMATION') {
      return { needsConfirmation: true, candidates: resolution.candidates };
    }
    const patient = resolution.patient;

    // Step 2 — Compute a non-colliding slot.
    const parsedDate = parseDateOnly(date);
    const finalStart = await findFreeHistoricalStartTime(tx, doctorId, parsedDate, startTime);
    const finalEnd = addMinutes(finalStart, doctor.slotDuration || 15);

    // Fee is captured for consistency with existing rows, but zero
    // because no payment was processed through NeoKidsPro.
    const feeAtBooking = 0;

    // Step 3 — Insert the appointment as source=MANUAL.
    const appointment = await tx.appointment.create({
      data: {
        doctorId,
        patientId: patient.id,
        primaryProblem: reasonForVisit,
        date: parsedDate,
        startTime: finalStart,
        endTime: finalEnd,
        consultationType,
        feeAtBooking,
        // Historical rows are already "done" — completed on entry.
        status: 'COMPLETED',
        paymentStatus: 'UNPAID',
        completedAt: new Date(),

        // Feature 1 fields.
        source: 'MANUAL',
        reasonForVisit,
        diagnosis: diagnosis || null,
        notes: notes || null,
        followUpDate: parseDateOnlyOrNull(followUpDate),
        manualPrescriptionUrl: manualPrescriptionUrl || null,
        addedById: audit.addedById || null,
        addedByRole: audit.addedByRole || null
      }
    });

    // Step 4 — If a prescription file was uploaded, also create a
    // lightweight Prescription row so the Rx archive picks it up. This
    // is marked source=MANUAL so PDFs are never regenerated for it —
    // the file the staff uploaded IS the record of truth.
    if (manualPrescriptionUrl) {
      await tx.prescription.create({
        data: {
          appointmentId: appointment.id,
          chiefComplaint: reasonForVisit,
          diagnosis: diagnosis || reasonForVisit,
          medications: [],
          advice: notes || null,
          followUpDate: parseDateOnlyOrNull(followUpDate),
          source: 'MANUAL'
        }
      });
    }

    logger.info('historical-appointment created', {
      id: appointment.id,
      doctorId,
      patientId: patient.id,
      matchType: resolution.matchType || 'NEW'
    });

    return {
      appointment,
      patient,
      matchType: resolution.matchType || 'NEW'
    };
  });
}

module.exports = {
  createHistoricalAppointment,
  resolvePatient,
  namesLookSimilar,
  normalizeName,
  canonicalizeName
};
