// =====================================================================
// doctor.controller.js — Bug 2/3/4/5 hardened version
// =====================================================================
// Bug 2: Patient identity is per (phone + name). Added patientHistory and
//        searchPatients endpoints exposing siblings + full history.
// Bug 3: Prescription create endpoint now returns the saved Rx + PDF URL
//        + delivery status; added appointmentPrescription (read) and
//        resendPrescription (manual delivery).
// Bug 4: Reschedule still routed to automation.onAppointmentRescheduled;
//        actual WhatsApp fix lives in automation.service.js.
// Bug 5: patientHistory returns visits + prescriptions + diagnoses + notes.
// =====================================================================
const { clinicSettingsSchema } = require('../utils/validators');
const fs   = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  updateDoctorAvailabilitySchema,
  updateDoctorFeesSchema,
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
  const parsed = updateDoctorAvailabilitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const payload = Object.fromEntries(
    Object.entries(parsed.data).map(([k, v]) => [k, v === '' ? null : v])
  );
  const updated = await prisma.doctor.update({ where: { id: req.user.id }, data: payload });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

exports.updateFees = asyncHandler(async (req, res) => {
  const parsed = updateDoctorFeesSchema.safeParse(req.body);
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
  res.json(appts);
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

  // Bug 2/5 — past visits for THIS child only (siblings are separate rows).
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

  res.json({ appointment: appt, history });
});

// ────────────────────────────────────────────────────────────────────
// Bug 2/5 — Patient Identity: search + dedicated history endpoint
// ────────────────────────────────────────────────────────────────────

/**
 * GET /api/doctor/patients/search?q=<phone or name fragment>
 * Returns up to 20 patient rows seen by this doctor.
 * Supports the "same parent phone, multiple children" case.
 */
exports.searchPatients = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  // Distinct patientIds this doctor has seen (so doctors don't see other clinics' patients).
  const seen = await prisma.appointment.findMany({
    where: { doctorId: req.user.id },
    select: { patientId: true },
    distinct: ['patientId']
  });
  const patientIds = seen.map(s => s.patientId);
  if (!patientIds.length) return res.json([]);

  const digitsOnly = q.replace(/\D/g, '');
  const orClauses = [
    { name: { contains: q } }
  ];
  if (digitsOnly.length >= 4) orClauses.push({ phone: { contains: digitsOnly } });

  const rows = await prisma.patient.findMany({
    where: { id: { in: patientIds }, OR: orClauses },
    orderBy: [{ phone: 'asc' }, { name: 'asc' }],
    take: 20
  });

  // Augment with last visit date so the UI can show "Last seen 12 Jun 2026".
  const enriched = await Promise.all(rows.map(async (p) => {
    const last = await prisma.appointment.findFirst({
      where: { patientId: p.id, doctorId: req.user.id },
      orderBy: { date: 'desc' },
      select: { date: true, status: true }
    });
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

/**
 * GET /api/doctor/patients/:patientId/history
 * Bug 5 — Patient profile aggregating ALL clinical data:
 *   - visits[] (every appointment with this doctor)
 *   - prescriptions[] (each prescription with meds + diagnosis + follow-up)
 *   - notes[] (consultation notes from appointment.notes)
 *   - diagnoses[] (deduped list)
 *   - lastVisitAt, totalVisits, openFollowUps
 *
 * Doctor scoping: a doctor only sees their OWN consultation history with the
 * patient — they can never read another clinic's appointments.
 */
exports.patientHistory = asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  // Scope to THIS doctor only (privacy / RBAC).
  const visits = await prisma.appointment.findMany({
    where: { patientId, doctorId: req.user.id },
    include: {
      prescription: true,
      doctor: { select: { id: true, name: true, specialization: true } }
    },
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }]
  });

  // Sibling list (same parent phone, different child) — handy for the UI.
  const siblings = await prisma.patient.findMany({
    where: { phone: patient.phone, id: { not: patient.id } },
    select: { id: true, name: true, dateOfBirth: true, gender: true }
  });

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
      pdfUrl: v.prescriptionUrl
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

  const lastVisitAt = visits.length ? visits[0].date : null;

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
      prescriptionUrl: v.prescriptionUrl,
      hasPrescription: !!v.prescription,
      doctorName: v.doctor.name
    })),
    prescriptions,
    diagnoses,
    notes,
    openFollowUps
  });
});

// ────────────────────────────────────────────────────────────────────
// Bug 3 — Prescription
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

  // automation.onPrescriptionCreated:
  //   - generates the PDF
  //   - sets appointment.prescriptionUrl
  //   - flips status to COMPLETED + credits revenue (only the FIRST time)
  //   - emails the patient with the PDF attached
  // It does its own internal try/catch; failures are logged but do NOT throw.
  const delivery = await automation.onPrescriptionCreated(appt, rx);

  // Re-read so the client gets the canonical row (status=COMPLETED, prescriptionUrl set).
  const refreshed = await prisma.appointment.findUnique({
    where: { id },
    include: { prescription: true, patient: true, doctor: true }
  });

  // Bug 3 — return rich payload so the frontend can render a real success card.
  res.json({
    success: true,
    prescription: refreshed.prescription,
    appointment: {
      id: refreshed.id,
      status: refreshed.status,
      prescriptionUrl: refreshed.prescriptionUrl,
      completedAt: refreshed.completedAt
    },
    delivery: {
      pdfUrl: refreshed.prescriptionUrl || (delivery && delivery.url) || null,
      pdfFilename: (delivery && delivery.filename) || null,
      emailQueued: !!refreshed.patient.email,
      emailRecipient: refreshed.patient.email || null
    }
  });
});

/**
 * GET /api/doctor/appointments/:id/prescription
 * Bug 3 — Doctor reads the saved prescription + PDF URL for view/download.
 */
exports.appointmentPrescription = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { prescription: true, patient: true, doctor: true }
  });
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (!appt.prescription) return res.status(404).json({ error: 'No prescription on this appointment yet' });

  // Ensure the PDF actually exists on disk; regenerate if missing (e.g. storage wiped in dev).
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

  res.json({
    prescription: appt.prescription,
    pdfUrl: appt.prescriptionUrl
      || `${process.env.PUBLIC_STORAGE_URL || '/files'}/prescriptions/${fileName}`,
    patient: { id: appt.patient.id, name: appt.patient.name, phone: appt.patient.phone, email: appt.patient.email }
  });
});

/**
 * POST /api/doctor/appointments/:id/prescription/resend
 * Bug 3 — Re-send prescription to the patient (email).
 * Idempotent: doesn't change status or revenue. Logs delivery in
 * notification_logs so doctor can see whether it succeeded.
 */
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

  // Bug 4 — automation now sends BOTH patient & doctor WhatsApp via env-configurable
  // templates, with structured failure logging so the doctor can see delivery status.
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
  if (appt.status === 'CANCELLED') return res.json(appt); // idempotent

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