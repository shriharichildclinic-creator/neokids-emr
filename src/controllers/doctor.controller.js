// =====================================================================
// doctor.controller.js
// =====================================================================
const { clinicSettingsSchema } = require('../utils/validators');
const fs   = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  updateDoctorAvailabilitySchema,
  updateDoctorAvailabilitySchemaForMode,
  updateDoctorFeesSchema,
  updateDoctorFeesSchemaForMode,
  prescriptionSchema,
  rescheduleSchema
} = require('../utils/validators');
const automation = require('../services/automation.service');
const slotService = require('../services/slot.service');
const { timeToMinutes, minutesToTime } = require('../services/slot.service');
const { parseDateOnly, parseDateOnlyOrNull, getTodayDateOnly, getTodayDateString } = require('../utils/date');
const { incrementDoctorRevenue, decrementDoctorRevenue } = require('../services/lifecycle.service');
const pdf = require('../services/pdf.service');
const logger = require('../utils/logger');
const { buildSignedFileUrl } = require('../utils/fileTokens');
const { myPatientIdSet, doctorOwnsPatient } = require('../utils/patientAccess');

/* ────────────────────────────────────────────────────────────────────
   Helper: rewrite a stored `prescriptionUrl` / `invoiceUrl` into a
   short-lived signed URL the doctor's browser can fetch via plain
   `<a href>` (no Authorization header needed for the link itself).
   ──────────────────────────────────────────────────────────────────── */
function signApptFileUrl(appt, kind, userId) {
  if (!appt) return null;
  const stored = kind === 'invoice' ? appt.invoiceUrl : appt.prescriptionUrl;
  if (!stored) return null;
  return buildSignedFileUrl({
    kind,
    appointmentId: appt.id,
    userId,
    role: 'DOCTOR'
  });
}

function withSignedUrls(appt, userId) {
  if (!appt) return appt;
  return {
    ...appt,
    prescriptionUrl: signApptFileUrl(appt, 'prescription', userId),
    invoiceUrl:      signApptFileUrl(appt, 'invoice',      userId)
  };
}

function signPreviousRecordAttachment(record, userId) {
  if (!record || !record.attachmentUrl) return null;
  return buildSignedFileUrl({
    kind: 'previous-record',
    appointmentId: record.id,
    userId,
    role: 'DOCTOR'
  });
}

// ────────────────────────────────────────────────────────────────────
// PROFILE
// ────────────────────────────────────────────────────────────────────
exports.me = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findFirst({ where: { id: req.user.id, deletedAt: null } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  const { passwordHash, ...safe } = doctor;
  res.json(safe);
});

exports.updateAvailability = asyncHandler(async (req, res) => {
  // Availability fields are validated against the doctor's consultation
  // modes: an ONLINE-only doctor cannot save offline hours (and vice versa),
  // so stale mode-specific values never get written.
  const current = await prisma.doctor.findUnique({ where: { id: req.user.id }, select: { consultationModes: true } });
  if (!current) return res.status(404).json({ error: 'Doctor not found' });
  const schema = updateDoctorAvailabilitySchemaForMode(current.consultationModes);
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const payload = Object.fromEntries(
    Object.entries(parsed.data).map(([k, v]) => [k, v === '' ? null : v])
  );
  const updated = await prisma.doctor.update({ where: { id: req.user.id }, data: payload });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

exports.updateFees = asyncHandler(async (req, res) => {
  // Same consultation-mode guard as updateAvailability, applied to fees.
  const current = await prisma.doctor.findUnique({ where: { id: req.user.id }, select: { consultationModes: true } });
  if (!current) return res.status(404).json({ error: 'Doctor not found' });
  const schema = updateDoctorFeesSchemaForMode(current.consultationModes);
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const updated = await prisma.doctor.update({ where: { id: req.user.id }, data: parsed.data });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

exports.uploadProfileImage = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Profile image file is required' });
  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  const photoUrl = `${process.env.PUBLIC_STORAGE_URL || '/files'}/profile-images/${req.file.filename}`;
  if (doctor.photoUrl) {
    const oldPath = path.resolve(
      process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage'),
      doctor.photoUrl.replace(`${process.env.PUBLIC_STORAGE_URL || '/files'}/`, '')
    );
    fs.promises.unlink(oldPath).catch(() => null);
  }
  const updated = await prisma.doctor.update({ where: { id: req.user.id }, data: { photoUrl } });
  res.json({ success: true, photoUrl: updated.photoUrl });
});

exports.removeProfileImage = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  if (doctor.photoUrl) {
    const filePath = path.resolve(
      process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage'),
      doctor.photoUrl.replace(`${process.env.PUBLIC_STORAGE_URL || '/files'}/`, '')
    );
    fs.promises.unlink(filePath).catch(() => null);
  }
  await prisma.doctor.update({ where: { id: req.user.id }, data: { photoUrl: null } });
  res.json({ success: true });
});

// ────────────────────────────────────────────────────────────────────
// APPOINTMENTS
// ────────────────────────────────────────────────────────────────────
exports.myAppointments = asyncHandler(async (req, res) => {
  const { status, date, from, to } = req.query;
  const where = { doctorId: req.user.id };
  if (status) where.status = status;
  if (date) where.date = parseDateOnly(date);
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = parseDateOnly(from);
    if (to)   where.date.lte = parseDateOnly(to);
  }
  const appts = await prisma.appointment.findMany({
    where,
    include: { patient: true, prescription: true },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }]
  });
  // Replace raw DB URLs with short-lived signed download URLs.
  res.json(appts.map(a => withSignedUrls(a, req.user.id)));
});

exports.todayWaitingRoom = asyncHandler(async (req, res) => {
  const today = getTodayDateOnly();
  const appts = await prisma.appointment.findMany({
    where: { doctorId: req.user.id, date: today, status: { in: ['CONFIRMED', 'PENDING'] } },
    include: { patient: true },
    orderBy: { startTime: 'asc' }
  });
  res.json(appts);
});

exports.appointmentDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { patient: true, doctor: true, prescription: true }
  });
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  const apptSigned = withSignedUrls(appt, req.user.id);

  // Past visits for this patient (child) only — siblings are separate
  // patient rows and are never merged into this history.
  const history = await prisma.appointment.findMany({
    where: {
      patientId: appt.patientId,
      id: { not: appt.id },
      status: { in: ['COMPLETED', 'CONFIRMED'] }
    },
    include: {
      prescription: true,
      doctor: { select: { name: true, specialization: true } }
    },
    orderBy: { date: 'desc' },
    take: 50
  });

  res.json({
    appointment: apptSigned,
    history: history.map(h => withSignedUrls(h, req.user.id))
  });
});

// ────────────────────────────────────────────────────────────────────
// Patient search + dedicated per-patient history endpoint
// ────────────────────────────────────────────────────────────────────
exports.searchPatients = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const digitsOnly = q.replace(/\D/g, '');
  const orClauses = [{ name: { contains: q } }];
  if (digitsOnly.length >= 4) orClauses.push({ phone: { contains: digitsOnly } });

  // SECURITY FIX (Patient Linking audit): this used to search the FULL
  // cross-clinic patient directory, so a doctor could find and select
  // any patient in the system — including ones exclusively under
  // another doctor's care — for certificates and previous records.
  // "My patients" is now the authoritative scope: an appointment,
  // a previous record I authored, or a certificate I issued for them.
  // If a doctor genuinely hasn't treated this patient before, the
  // Previous Records "Legacy / Historical Patient" branch is the
  // correct path — not linking to someone else's directory patient.
  const myPatientIds = await myPatientIdSet(req.user.id);
  if (!myPatientIds.size) return res.json([]);

  const rows = await prisma.patient.findMany({
    where: { AND: [{ OR: orClauses }, { id: { in: Array.from(myPatientIds) } }] },
    orderBy: [{ name: 'asc' }, { phone: 'asc' }],
    take: 20
  });

  // Only run the (relatively expensive) last-visit enrichment for patients
  // this doctor has actually seen; others get a fast null.
  const todayBoundary = getTodayDateOnly();
  const enriched = await Promise.all(rows.map(async (p) => {
    let last = null;
    if (myPatientIds.has(p.id)) {
      last = await prisma.appointment.findFirst({
        where: {
          patientId: p.id,
          doctorId:  req.user.id,
          status:    'COMPLETED',
          date:      { lte: todayBoundary }
        },
        orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
        select: { date: true, status: true }
      });
    }
    return {
      id: p.id,
      name: p.name,
      phone: p.phone,
      email: p.email,
      gender: p.gender,
      dateOfBirth: p.dateOfBirth,
      parentName: p.parentName,
      lastVisit: last ? last.date : null,
      lastStatus: last ? last.status : null
    };
  }));

  res.json(enriched);
});

exports.patientHistory = asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  // SECURITY FIX (Patient Linking audit): previously fetched the patient
  // and their "siblings" (other patients sharing the same phone) with no
  // ownership check at all — only 404ing if the row didn't exist. Any
  // doctor could pull another doctor's-only patient's name/phone/email/
  // DOB/parent name (and their family members' too) even though the
  // clinical data below (visits/prescriptions/previousRecords) was
  // already correctly doctor-scoped. Now the whole endpoint 404s unless
  // this doctor actually has an established relationship with the
  // patient.
  const owns = await doctorOwnsPatient(req.user.id, patientId);
  if (!owns) return res.status(404).json({ error: 'Patient not found' });

  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const visits = await prisma.appointment.findMany({
    where: { patientId, doctorId: req.user.id },
    include: {
      prescription: true,
      doctor: { select: { id: true, name: true, specialization: true } }
    },
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }]
  });

  // SECURITY FIX (Patient Linking audit): siblings are now filtered to
  // only those this doctor also has an established relationship with —
  // otherwise a shared-phone family member exclusively seen by another
  // doctor would leak here even though the primary patient check above
  // passed.
  const siblingRows = await prisma.patient.findMany({
    where: { phone: patient.phone, id: { not: patient.id } },
    select: { id: true, name: true, dateOfBirth: true, gender: true }
  });
  const siblingIds = await myPatientIdSet(req.user.id);
  const siblings = siblingRows.filter(s => siblingIds.has(s.id));

  const doctorMeta = await prisma.doctor.findUnique({
    where: { id: req.user.id },
    select: { canAddPreviousRecords: true }
  });

  const previousRecords = doctorMeta?.canAddPreviousRecords
    ? await prisma.previousRecord.findMany({
        where: { patientId, doctorId: req.user.id },
        orderBy: [{ recordDate: 'desc' }, { createdAt: 'desc' }]
      })
    : [];

  const prescriptions = visits
    .filter(v => v.prescription)
    .map(v => ({
      id: v.prescription.id,
      appointmentId: v.id,
      visitDate: v.date,
      doctorName: v.doctor.name,
      chiefComplaint: v.prescription.chiefComplaint,
      diagnosis: v.prescription.diagnosis,
      allergies: v.prescription.allergies,
      pastHistory: v.prescription.pastHistory,
      medications: v.prescription.medications,
      advice: v.prescription.advice,
      investigations: v.prescription.investigations,
      followUpDate: v.prescription.followUpDate,
      // Feature 1A — flag + uploaded-file link for historical prescriptions
      source: v.prescription.source || 'NEOKIDSPRO',
      manualUrl: v.manualPrescriptionUrl || null,
      pdfUrl: signApptFileUrl(v, 'prescription', req.user.id)   // ← signed
    }));

  const diagnoses = Array.from(new Set(
    prescriptions.map(p => (p.diagnosis || '').trim()).filter(Boolean)
  ));

  const notes = visits
    .filter(v => v.notes && v.notes.trim())
    .map(v => ({
      appointmentId: v.id, date: v.date, note: v.notes, status: v.status
    }));

  const todayStr = getTodayDateString();
  const openFollowUps = prescriptions
    .filter(p => p.followUpDate && new Date(p.followUpDate) >= new Date(todayStr + 'T00:00:00.000Z'))
    .map(p => ({ prescriptionId: p.id, dueDate: p.followUpDate, doctorName: p.doctorName }));

  const todayBoundaryDate = new Date(todayStr + 'T23:59:59.999Z');
  const completedPastVisits = visits.filter(v =>
    v.status === 'COMPLETED' && new Date(v.date) <= todayBoundaryDate
  );
  const lastVisitAt = completedPastVisits.length ? completedPastVisits[0].date : null;

  res.json({
    patient: {
      id: patient.id,
      name: patient.name,
      phone: patient.phone,
      email: patient.email,
      parentName: patient.parentName,
      gender: patient.gender,
      dateOfBirth: patient.dateOfBirth,
      address: patient.address
    },
    siblings,
    summary: {
      totalVisits: visits.length,
      completedVisits: visits.filter(v => v.status === 'COMPLETED').length,
      lastVisitAt,
      openFollowUps: openFollowUps.length
    },
    visits: visits.map(v => ({
      id: v.id,
      date: v.date,
      startTime: v.startTime,
      endTime: v.endTime,
      consultationType: v.consultationType,
      status: v.status,
      paymentStatus: v.paymentStatus,
      primaryProblem: v.primaryProblem,
      notes: v.notes,
      meetLink: v.meetLink,
      prescriptionUrl: signApptFileUrl(v, 'prescription', req.user.id),  // ← signed
      hasPrescription: !!v.prescription,
      doctorName: v.doctor.name,
      // Feature 1 — surface historical-record fields for UI badges/links
      source: v.source || 'NEOKIDSPRO',
      diagnosis: v.diagnosis || null,
      followUpDate: v.followUpDate || null,
      manualPrescriptionUrl: v.manualPrescriptionUrl || null
    })),
    prescriptions,
    diagnoses,
    notes,
    openFollowUps,
    previousRecords: previousRecords.map(r => ({
      id: r.id,
      recordDate: r.recordDate,
      diagnosis: r.diagnosis,
      notes: r.notes,
      treatment: r.treatment,
      medications: r.medications,
      attachmentUrl: signPreviousRecordAttachment(r, req.user.id),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    })),
    permissions: {
      canAddPreviousRecords: !!doctorMeta?.canAddPreviousRecords
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Prescription creation
// ────────────────────────────────────────────────────────────────────
exports.createPrescription = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const parsed = prescriptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });

  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { patient: true, doctor: true, prescription: true }
  });
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (appt.status === 'CANCELLED') {
    return res.status(400).json({ error: 'Cannot prescribe on a cancelled appointment' });
  }

  const data = {
    ...parsed.data,
    medications: parsed.data.medications,
    followUpDate: parseDateOnlyOrNull(parsed.data.followUpDate)
  };

  const rx = await prisma.prescription.upsert({
    where: { appointmentId: id },
    update: data,
    create: { appointmentId: id, ...data }
  });

  const delivery = await automation.onPrescriptionCreated(appt, rx);

  const refreshed = await prisma.appointment.findUnique({
    where: { id },
    include: { prescription: true, patient: true, doctor: true }
  });

  // Returns a rich payload so the frontend can render a real success card
  // instead of a bare acknowledgement.
  const signedPrescriptionUrl = signApptFileUrl(refreshed, 'prescription', req.user.id);
  res.json({
    success: true,
    prescription: refreshed.prescription,
    appointment: {
      id: refreshed.id,
      status: refreshed.status,
      prescriptionUrl: signedPrescriptionUrl,
      completedAt: refreshed.completedAt
    },
    delivery: {
      pdfUrl: signedPrescriptionUrl,
      pdfFilename: (delivery && delivery.filename) || null,
      emailQueued: !!refreshed.patient.email,
      emailRecipient: refreshed.patient.email || null
    }
  });
});

exports.appointmentPrescription = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { prescription: true, patient: true, doctor: true }
  });
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (!appt.prescription) return res.status(404).json({ error: 'No prescription on this appointment yet' });

  const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage');
  const fileName = `prescription_${appt.id}.pdf`;
  const filePath = path.join(storagePath, 'prescriptions', fileName);

  if (!fs.existsSync(filePath)) {
    try {
      const result = await pdf.generatePrescription(appt, appt.prescription);
      await prisma.appointment.update({ where: { id }, data: { prescriptionUrl: result.url } });
      appt.prescriptionUrl = result.url;
    } catch (e) {
      logger.error('appointmentPrescription: PDF regeneration failed', e);
    }
  }

  const signedUrl = buildSignedFileUrl({
    kind: 'prescription',
    appointmentId: appt.id,
    userId: req.user.id,
    role: 'DOCTOR'
  });
  res.json({
    prescription: appt.prescription,
    pdfUrl: signedUrl,
    patient: { id: appt.patient.id, name: appt.patient.name, phone: appt.patient.phone, email: appt.patient.email }
  });
});

exports.resendPrescription = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { prescription: true, patient: true, doctor: true }
  });
  if (!appt)              return res.status(404).json({ error: 'Appointment not found' });
  if (!appt.prescription) return res.status(400).json({ error: 'No prescription to resend' });
  if (!appt.patient.email) return res.status(400).json({ error: 'Patient has no email on file' });

  try {
    await automation.resendPrescription(appt, appt.prescription);
    res.json({ success: true, recipient: appt.patient.email });
  } catch (e) {
    logger.error('resendPrescription failed', e);
    res.status(502).json({ error: 'Could not re-send prescription', detail: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────
// RESCHEDULE / CANCEL / COMPLETE
// ────────────────────────────────────────────────────────────────────
exports.reschedule = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });

  const { date, startTime, reason } = parsed.data;
  if (date < getTodayDateString()) {
    return res.status(400).json({ error: 'Cannot reschedule to a past date' });
  }

  const existing = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { doctor: true, patient: true }
  });
  if (!existing) return res.status(404).json({ error: 'Appointment not found' });
  if (['COMPLETED', 'CANCELLED'].includes(existing.status)) {
    return res.status(400).json({ error: 'Cannot reschedule a completed or cancelled appointment' });
  }

  const liveSlots = await slotService.getLiveSlots(existing.doctorId, date, existing.consultationType);
  const slot = liveSlots.find(s => s.startTime === startTime);
  if (!slot || !slot.available) {
    return res.status(409).json({ error: 'Selected slot is not available for reschedule' });
  }

  const endTime = minutesToTime(timeToMinutes(startTime) + (existing.doctor.slotDuration || 15));
  const updated = await prisma.appointment.update({
    where: { id },
    data: {
      date: parseDateOnly(date),
      startTime,
      endTime,
      rescheduleReason: reason,
      rescheduledAt: new Date(),
      status: (existing.paymentStatus === 'PAID' || existing.consultationType === 'OFFLINE')
        ? 'CONFIRMED' : 'PENDING'
    },
    include: { doctor: true, patient: true }
  });

  await automation.onAppointmentRescheduled(updated);
  res.json(updated);
});

exports.cancelAppointment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const reason = (req.body?.reason || '').trim();
  if (reason.length < 3) {
    return res.status(400).json({ error: 'A cancellation reason (min 3 chars) is required' });
  }

  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { doctor: true, patient: true }
  });
  if (!appt) return res.status(404).json({ error: 'Not found' });
  if (appt.status === 'COMPLETED') {
    return res.status(400).json({ error: 'Cannot cancel a completed appointment' });
  }
  // Cancelling an already-cancelled appointment is a conflict, not a
  // no-op — the UI needs to distinguish "I just cancelled this" from
  // "this was already cancelled in another tab / by someone else".
  if (appt.status === 'CANCELLED') {
    return res.status(409).json({
      error: 'Appointment is already cancelled',
      code: 'ALREADY_CANCELLED',
      appointment: {
        id: appt.id,
        status: appt.status,
        cancelledAt: appt.cancelledAt,
        cancellationReason: appt.notes
      }
    });
  }

  const updated = await prisma.appointment.update({
    where: { id },
    data: { status: 'CANCELLED', notes: reason || null, cancelledAt: new Date() },
    include: { doctor: true, patient: true }
  });

  automation.onAppointmentCancelled(updated, reason).catch(e => {
    logger.error('onAppointmentCancelled failed', e);
  });

  res.json(updated);
});

exports.toggleComplete = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appt = await prisma.appointment.findFirst({ where: { id, doctorId: req.user.id } });
  if (!appt) return res.status(404).json({ error: 'Not found' });

  if (appt.status === 'PENDING') {
    return res.status(400).json({
      error: 'Cannot mark a PENDING appointment as complete. Payment must be confirmed first.'
    });
  }
  if (appt.status === 'CANCELLED') {
    return res.status(400).json({ error: 'Cancelled appointments cannot be toggled' });
  }

  const shouldComplete = appt.status !== 'COMPLETED';
  const updated = await prisma.appointment.update({
    where: { id },
    data: shouldComplete
      ? {
          status: 'COMPLETED',
          completedAt: new Date(),
          ...(appt.paymentStatus === 'CASH_PENDING' && { paymentStatus: 'CASH_COLLECTED' })
        }
      : {
          status: 'CONFIRMED',
          completedAt: null,
          ...(appt.paymentStatus === 'CASH_COLLECTED' && { paymentStatus: 'CASH_PENDING' })
        }
  });

  if (shouldComplete) await incrementDoctorRevenue(appt.doctorId, appt.feeAtBooking, appt.paymentStatus);
  else                await decrementDoctorRevenue(appt.doctorId, appt.feeAtBooking, appt.paymentStatus);

  res.json({ ...updated, toggledTo: shouldComplete ? 'COMPLETED' : 'CONFIRMED' });
});

// ────────────────────────────────────────────────────────────────────
// STATS / CLINIC / FOLLOW-UPS
// ────────────────────────────────────────────────────────────────────
exports.stats = asyncHandler(async (req, res) => {
  const today = getTodayDateOnly();
  const [todayCount, completedToday, totalConsults, revenueAgg] = await Promise.all([
    prisma.appointment.count({ where: { doctorId: req.user.id, date: today, status: { not: 'CANCELLED' } } }),
    prisma.appointment.count({ where: { doctorId: req.user.id, date: today, status: 'COMPLETED' } }),
    prisma.appointment.count({ where: { doctorId: req.user.id, status: 'COMPLETED' } }),
    prisma.appointment.aggregate({
      _sum: { feeAtBooking: true },
      where: {
        doctorId: req.user.id,
        status: 'COMPLETED',
        paymentStatus: { in: ['PAID', 'CASH_COLLECTED', 'CASH_PENDING'] }
      }
    })
  ]);
  res.json({
    todayAppointments: todayCount,
    completedToday,
    totalConsults,
    totalRevenue: Number(revenueAgg._sum.feeAtBooking || 0)
  });
});

exports.updateClinic = asyncHandler(async (req, res) => {
  // Practice location only makes sense for doctors who see patients in
  // person — ONLINE-only doctors have no clinic to configure.
  const me = await prisma.doctor.findUnique({ where: { id: req.user.id }, select: { consultationModes: true } });
  if (!me) return res.status(404).json({ error: 'Doctor not found' });
  if (String(me.consultationModes).toUpperCase() === 'ONLINE') {
    return res.status(400).json({ error: 'Practice location settings do not apply to an online-only doctor' });
  }
  const parsed = clinicSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  let { clinicName, clinicAddress, clinicMapUrl, clinicLat, clinicLng } = parsed.data;
  if (!clinicMapUrl) {
    const q = [clinicName, clinicAddress].filter(Boolean).join(' ');
    clinicMapUrl = `https://maps.google.com/?q=${encodeURIComponent(q)}`;
  }
  const updated = await prisma.doctor.update({
    where: { id: req.user.id },
    data: { clinicName, clinicAddress, clinicMapUrl, clinicLat, clinicLng }
  });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

exports.pendingFollowUps = asyncHandler(async (req, res) => {
  const todayStr = getTodayDateString();
  const today = parseDateOnly(todayStr);

  const rxs = await prisma.prescription.findMany({
    where: { appointment: { doctorId: req.user.id }, followUpDate: { lte: today, not: null } },
    include: { appointment: { include: { patient: true } } },
    orderBy: { followUpDate: 'desc' },
    take: 100
  });

  const out = [];
  for (const rx of rxs) {
    const a = rx.appointment;
    if (!a) continue;
    const rebooked = await prisma.appointment.findFirst({
      where: {
        patientId: a.patientId,
        doctorId: req.user.id,
        createdAt: { gt: a.completedAt || a.createdAt },
        status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] }
      },
      select: { id: true }
    });
    if (rebooked) continue;
    out.push({
      prescriptionId: rx.id,
      appointmentId: a.id,
      followUpDate: rx.followUpDate,
      patient: {
        id: a.patient.id, name: a.patient.name, phone: a.patient.phone,
        email: a.patient.email, dateOfBirth: a.patient.dateOfBirth
      },
      lastConsult: a.completedAt || a.date
    });
  }
  res.json(out);
});