// =====================================================================
// doctor.controller.js
// =====================================================================
const { clinicSettingsSchema } = require('../utils/validators');
const fs   = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const { photoUrlFor, deleteOldPhoto } = require('../services/profile-photo.service');
const { asyncHandler } = require('../middleware/errorHandler');
const audit = require('../services/audit.service');
const notifications = require('../services/notification.service');
const staffAccess = require('../services/staffAccess.service');

function doctorActor(req, name) {
  return { id: req.user.id, role: 'DOCTOR', name: name || 'Dr. ' + req.user.id };
}
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
const { parseDateOnly, parseDateOnlyOrNull, getTodayDateOnly, getTodayDateString, buildDailyTrend } = require('../utils/date');
const { COLLECTED_PAYMENT_STATUSES, PENDING_PAYMENT_STATUSES, PHANTOM_APPOINTMENT_WHERE } = require('../utils/payment');
const { incrementDoctorRevenue, decrementDoctorRevenue } = require('../services/lifecycle.service');
const pdf = require('../services/pdf.service');
const logger = require('../utils/logger');
const { buildSignedFileUrl } = require('../utils/fileTokens');
const { myPatientIdSet, doctorOwnsPatient } = require('../utils/patientAccess');
const consultInvoiceSvc = require('../services/consultation-invoice.service');

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
  const photoUrl = photoUrlFor(req.file.filename);
  let updated;
  try {
    updated = await prisma.doctor.update({ where: { id: req.user.id }, data: { photoUrl } });
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    throw err;
  }
  await deleteOldPhoto(doctor.photoUrl);
  res.json({ success: true, photoUrl: updated.photoUrl });
});

exports.removeProfileImage = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  await prisma.doctor.update({ where: { id: req.user.id }, data: { photoUrl: null } });
  await deleteOldPhoto(doctor.photoUrl);
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
  // Unpaid-expired online bookings, Cashfree order-creation failures, and
  // gateway payment failures never became real bookings — they auto-cancel
  // themselves and are pure noise here, so they're excluded unless the
  // doctor explicitly asks to see cancelled appointments. Matched on
  // status+paymentStatus (not notes text) since a genuine cancellation
  // never sets paymentStatus to FAILED, so this reliably catches every
  // path that produces one of these phantom rows.
  if (status !== 'CANCELLED') {
    where.NOT = { status: 'CANCELLED', paymentStatus: 'FAILED' };
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
    // paymentStatus: FAILED is excluded defensively even though status
    // should already be CANCELLED for these — see webhook/verifyPayment
    // fixes that now cancel the appointment the moment payment fails,
    // instead of leaving it sitting here as PENDING forever.
    where: { doctorId: req.user.id, date: today, status: { in: ['CONFIRMED', 'PENDING'] }, paymentStatus: { not: 'FAILED' } },
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
      // v4.0.0 — who entered the prescription (doctor vs clinic reception)
      createdByRole: v.prescription.createdByRole || null,
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
    create: { appointmentId: id, ...data, createdById: req.user.id, createdByRole: 'DOCTOR' }
  });

  await audit.log({
    actor: doctorActor(req, 'Dr. ' + appt.doctor.name), action: 'PRESCRIPTION_CREATED',
    entityType: 'PRESCRIPTION', entityId: id,
    summary: `Prescribed for ${appt.patient.name}`,
    doctorId: req.user.id
  });

  // Generates the PDF and finalizes the appointment only. Delivery to
  // the patient (email / WhatsApp) is a separate, explicit doctor
  // action — see sendPrescription() below.
  const pdfRes = await automation.onPrescriptionCreated(appt, rx);

  const pharmacyUserIds = await staffAccess.getPharmacyUserIdsForDoctor(req.user.id).catch(() => []);
  for (const pharmacyUserId of pharmacyUserIds) {
    await notifications.create({
      userType: 'PHARMACY', userId: pharmacyUserId,
      type: 'PRESCRIPTION_CREATED', title: 'New prescription to dispense',
      message: `Dr. ${appt.doctor.name} prescribed medicines for ${appt.patient.name} — ready to dispense.`,
      iconUrl: appt.doctor.photoUrl || null,
      entityType: 'PRESCRIPTION', entityId: rx.id
    }).catch(() => {});
  }

  const refreshed = await prisma.appointment.findUnique({
    where: { id },
    include: { prescription: true, patient: true, doctor: true }
  });

  // Returns a rich payload so the frontend can render a real success card
  // instead of a bare acknowledgement. No delivery has happened yet —
  // the frontend prompts the doctor to choose Email / WhatsApp / Both.
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
    pdf: {
      url: signedPrescriptionUrl,
      filename: (pdfRes && pdfRes.filename) || null
    },
    patient: {
      hasEmail: !!refreshed.patient.email,
      hasPhone: !!refreshed.patient.phone
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

// ────────────────────────────────────────────────────────────────────
// Prescription delivery — explicit, doctor-chosen channel.
// Triggered from the "Send Prescription" modal shown after save (and
// reused for later resends). Saving a prescription never sends it by
// itself; nothing goes out to the patient until this is called.
// ────────────────────────────────────────────────────────────────────
exports.sendPrescription = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const channel = String(req.body.channel || '').toUpperCase();
  if (!['EMAIL', 'WHATSAPP', 'BOTH'].includes(channel)) {
    return res.status(400).json({ error: 'Invalid channel. Choose Email, WhatsApp, or Both.' });
  }

  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { prescription: true, patient: true, doctor: true }
  });
  if (!appt)              return res.status(404).json({ error: 'Appointment not found' });
  if (!appt.prescription) return res.status(400).json({ error: 'No prescription to send. Please save the prescription first.' });

  const wantsEmail    = channel === 'EMAIL'    || channel === 'BOTH';
  const wantsWhatsapp = channel === 'WHATSAPP' || channel === 'BOTH';
  if (wantsEmail && !appt.patient.email)    return res.status(400).json({ error: 'Patient has no email on file.' });
  if (wantsWhatsapp && !appt.patient.phone) return res.status(400).json({ error: 'Patient has no phone number on file.' });

  let result;
  try {
    result = await automation.deliverPrescription(appt, appt.prescription, { email: wantsEmail, whatsapp: wantsWhatsapp });
  } catch (e) {
    logger.error('sendPrescription: PDF generation failed', e);
    return res.status(502).json({ error: 'Could not generate the prescription PDF. Please try again.', detail: e.message });
  }

  const emailOk    = !wantsEmail    || result.email    === 'sent';
  const whatsappOk = !wantsWhatsapp || result.whatsapp === 'sent';

  if (!emailOk && !whatsappOk) {
    return res.status(502).json({
      error: 'Could not send the prescription. Please try again.',
      detail: { email: result.emailError, whatsapp: result.whatsappError }
    });
  }

  if (!emailOk || !whatsappOk) {
    const sentChannel   = !emailOk ? 'WhatsApp' : 'Email';
    const failedChannel = !emailOk ? 'Email' : 'WhatsApp';
    return res.status(207).json({
      success: true,
      partial: true,
      message: `Prescription sent successfully via ${sentChannel}, but ${failedChannel} delivery failed.`,
      detail: { email: result.emailError, whatsapp: result.whatsappError }
    });
  }

  const label = channel === 'BOTH' ? 'Email and WhatsApp' : (channel === 'EMAIL' ? 'Email' : 'WhatsApp');
  res.json({ success: true, message: `Prescription sent successfully via ${label}.` });
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

  const liveSlots = await slotService.getLiveSlots(existing.doctorId, date, existing.consultationType, existing.id);
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

  await audit.log({
    actor: doctorActor(req, 'Dr. ' + existing.doctor.name), action: 'APPOINTMENT_RESCHEDULED',
    entityType: 'APPOINTMENT', entityId: id,
    summary: `Rescheduled ${existing.patient.name}'s appointment to ${date} ${startTime} (${reason})`,
    doctorId: req.user.id
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
  // Same reasoning as the receptionist cancel path: void any invoice tied
  // to this appointment so it drops out of collected-today/trend totals.
  await prisma.consultationInvoice.updateMany({
    where: { appointmentId: id, status: { in: ['PAID', 'PENDING'] } },
    data: { status: 'VOID' }
  });

  await audit.log({
    actor: doctorActor(req, 'Dr. ' + updated.doctor.name), action: 'APPOINTMENT_CANCELLED',
    entityType: 'APPOINTMENT', entityId: id,
    summary: `Cancelled ${updated.patient.name}'s appointment (${reason})`,
    doctorId: req.user.id
  });

  const cancelMsg = `Dr. ${updated.doctor.name} cancelled ${updated.patient.name}'s appointment on ${String(updated.date).slice(0, 10)} at ${updated.startTime} (${reason || 'no reason given'}).`;
  const cancelIcon = updated.doctor.photoUrl || null;
  await notifications.create({
    userType: 'ADMIN', userId: null,
    type: 'APPOINTMENT_CANCELLED', title: 'Appointment cancelled by doctor',
    message: cancelMsg, iconUrl: cancelIcon, entityType: 'APPOINTMENT', entityId: id
  }).catch(() => {});
  const receptionistIds = await staffAccess.getReceptionistIdsForDoctor(req.user.id).catch(() => []);
  for (const receptionistId of receptionistIds) {
    await notifications.create({
      userType: 'RECEPTIONIST', userId: receptionistId,
      type: 'APPOINTMENT_CANCELLED', title: 'Appointment cancelled by doctor',
      message: cancelMsg, iconUrl: cancelIcon, entityType: 'APPOINTMENT', entityId: id
    }).catch(() => {});
  }

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

  // Double-credit race fix: claim the transition atomically. The auto-
  // complete cron applies the same pattern, so whichever path flips the
  // row first (count === 1) is the only one that credits/debits revenue.
  //
  // Marking a consultation complete does NOT touch paymentStatus — cash
  // collection is a separate, explicit action (see exports.markPaid)
  // performed by whoever actually took the money, not an automatic
  // side effect of the doctor finishing the visit.
  const claim = await prisma.appointment.updateMany({
    where: { id, status: shouldComplete ? 'CONFIRMED' : 'COMPLETED' },
    data: shouldComplete
      ? { status: 'COMPLETED', completedAt: new Date() }
      : { status: 'CONFIRMED', completedAt: null }
  });

  if (claim.count === 0) {
    return res.status(409).json({ error: 'Appointment status changed concurrently — refresh and try again' });
  }

  if (shouldComplete) await incrementDoctorRevenue(appt.doctorId, appt.feeAtBooking, appt.paymentStatus);
  else                await decrementDoctorRevenue(appt.doctorId, appt.feeAtBooking, appt.paymentStatus);

  const updated = await prisma.appointment.findUnique({ where: { id } });
  res.json({ ...updated, toggledTo: shouldComplete ? 'COMPLETED' : 'CONFIRMED' });
});

// Explicit, doctor-initiated cash collection — mirrors receptionist's
// exports.markPaid. Completing a consultation no longer implies cash was
// collected; this is the only way a CASH_PENDING appointment becomes
// CASH_COLLECTED from the doctor portal. Also issues the ConsultationInvoice
// in the same action (see consultation-invoice.service.js), attributed to
// no specific receptionist since the doctor collected it directly — but it
// still counts toward this doctor's clinic-wide revenue, which reception
// sees identically (both panels now read from the same invoice records).
exports.markPaid = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { patient: true, doctor: true, consultationInvoice: true }
  });
  if (!appt) return res.status(404).json({ error: 'Not found' });
  if (appt.paymentStatus !== 'CASH_PENDING') {
    return res.status(400).json({ error: 'Only a cash-pending appointment can be marked as paid' });
  }
  // Race-safe: only the caller that actually flips CASH_PENDING → 
  // CASH_COLLECTED goes on to create the invoice, mirroring the same
  // conditional-update pattern used for online payment confirmation
  // (booking.service.js confirmOnlineBooking) — if a receptionist and this
  // doctor both tap "mark paid" on the same appointment at once, exactly
  // one invoice gets created, not two.
  const flipped = await prisma.appointment.updateMany({
    where: { id, paymentStatus: 'CASH_PENDING' },
    data: { paymentStatus: 'CASH_COLLECTED' }
  });
  if (flipped.count === 0) {
    // Someone else already marked it paid a moment ago.
    const updated = await prisma.appointment.findUnique({ where: { id } });
    return res.json({ ...updated, invoice: null });
  }
  await audit.log({
    actor: doctorActor(req, 'Dr. ' + appt.doctor.name), action: 'APPOINTMENT_MARKED_PAID',
    entityType: 'APPOINTMENT', entityId: appt.id,
    summary: `Marked cash collected for ${appt.patient.name}`,
    medicalCentreId: appt.medicalCentreId, doctorId: appt.doctorId
  });
  const invoiceResult = await consultInvoiceSvc.issueInvoiceForAppointment(appt, doctorActor(req, 'Dr. ' + appt.doctor.name));
  const updated = await prisma.appointment.findUnique({ where: { id } });
  res.json({ ...updated, invoice: invoiceResult.skipped ? null : invoiceResult.invoice });
});

// ────────────────────────────────────────────────────────────────────
// STATS / CLINIC / FOLLOW-UPS
// ────────────────────────────────────────────────────────────────────
exports.stats = asyncHandler(async (req, res) => {
  const today = getTodayDateOnly();
  const doctorId = req.user.id;
  const COLLECTED = COLLECTED_PAYMENT_STATUSES;
  const PENDING = PENDING_PAYMENT_STATUSES;

  const yesterday = new Date(today); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const last14 = new Date(today); last14.setUTCDate(last14.getUTCDate() - 13); // prior 7-day window for w/w delta
  const last30 = new Date(today); last30.setUTCDate(last30.getUTCDate() - 29);
  const prev30 = new Date(today); prev30.setUTCDate(prev30.getUTCDate() - 59);

  const [
    todayCount, completedToday, totalConsults,
    onlineConsults, offlineConsults,
    onlineCollected, offlineCollected,
    onlinePending, offlinePending,
    completedAll, cancelledAll,
    yesterdayCount,
    fortnightRows,
    last30Count, prev30Count
  ] = await Promise.all([
    prisma.appointment.count({ where: { doctorId, date: today, status: { not: 'CANCELLED' } } }),
    prisma.appointment.count({ where: { doctorId, date: today, status: 'COMPLETED' } }),
    prisma.appointment.count({ where: { doctorId, status: 'COMPLETED' } }),
    prisma.appointment.count({ where: { doctorId, status: 'COMPLETED', consultationType: 'ONLINE'  } }),
    prisma.appointment.count({ where: { doctorId, status: 'COMPLETED', consultationType: 'OFFLINE' } }),
    // Revenue = money actually collected, keyed on paymentStatus alone —
    // NOT gated on appointment status. A paid online booking is usually
    // still CONFIRMED (not COMPLETED) until the consult happens, and a
    // cancelled-but-not-yet-refunded visit keeps its PAID/CASH_COLLECTED
    // payment status too. Filtering these aggregates to status:'COMPLETED'
    // silently dropped both cases from every revenue figure on the
    // dashboard. paymentStatus flips to REFUNDED on refund, so a refunded
    // appointment is naturally excluded here without needing a status
    // check at all.
    prisma.appointment.aggregate({ _sum: { feeAtBooking: true }, where: { doctorId, consultationType: 'ONLINE',  paymentStatus: { in: COLLECTED } } }),
    prisma.appointment.aggregate({ _sum: { feeAtBooking: true }, where: { doctorId, consultationType: 'OFFLINE', paymentStatus: { in: COLLECTED } } }),
    // Pending (billed, not yet received) still excludes cancelled visits —
    // once a visit is cancelled nobody is going to hand over that cash, so
    // it shouldn't linger in the clinic's "still owed" figure.
    prisma.appointment.aggregate({ _sum: { feeAtBooking: true }, where: { doctorId, consultationType: 'ONLINE',  status: { not: 'CANCELLED' }, paymentStatus: { in: PENDING } } }),
    prisma.appointment.aggregate({ _sum: { feeAtBooking: true }, where: { doctorId, consultationType: 'OFFLINE', status: { not: 'CANCELLED' }, paymentStatus: { in: PENDING } } }),
    prisma.appointment.count({ where: { doctorId, status: 'COMPLETED' } }),
    prisma.appointment.count({ where: { doctorId, status: 'CANCELLED' } }),
    prisma.appointment.count({ where: { doctorId, date: yesterday, status: { not: 'CANCELLED' } } }),
    // Includes CANCELLED rows too — a cancelled-but-not-refunded row still
    // needs to contribute its collected amount to the weekly revenue trend
    // below. The accumulate step (not this query) is what keeps CANCELLED
    // rows out of the *appointment volume* counters while still crediting
    // their revenue.
    prisma.appointment.findMany({
      where: { doctorId, date: { gte: last14 } },
      select: { date: true, status: true, paymentStatus: true, feeAtBooking: true, consultationType: true }
    }),
    prisma.appointment.count({ where: { doctorId, date: { gte: last30 }, status: { not: 'CANCELLED' } } }),
    prisma.appointment.count({ where: { doctorId, date: { gte: prev30, lt: last30 }, status: { not: 'CANCELLED' } } })
  ]);

  const onlineCollectedAmt  = Number(onlineCollected._sum.feeAtBooking || 0);
  const offlineCollectedAmt = Number(offlineCollected._sum.feeAtBooking || 0);
  const onlinePendingAmt    = Number(onlinePending._sum.feeAtBooking || 0);
  const offlinePendingAmt   = Number(offlinePending._sum.feeAtBooking || 0);
  const totalAll = completedAll + cancelledAll;

  // Bucket the trailing 14 days into a per-day series (for the dashboard's
  // trend sparkline) and split it into this-week vs the prior week so the
  // UI can show a real week-over-week delta instead of a bare number.
  const { daily, thisWeek, prevWeek, last7Key } = buildDailyTrend({
    start: last14,
    emptyBucket: () => ({ appointments: 0, completed: 0, revenue: 0 }),
    sources: [{
      rows: fortnightRows,
      dateOf: (row) => row.date,
      accumulate: (bucket, row) => {
        // Appointment-volume counters intentionally exclude cancelled
        // visits (nothing to show up for), but revenue does not — a
        // cancelled-but-not-yet-refunded row already collected real
        // money and must still count towards the day's total. Gating
        // revenue on status==='COMPLETED' (the old behaviour) silently
        // dropped every CONFIRMED-but-paid online booking and every
        // cancelled-but-paid visit from this chart.
        if (row.status !== 'CANCELLED') {
          bucket.appointments += 1;
          if (row.status === 'COMPLETED') bucket.completed += 1;
        }
        if (COLLECTED.includes(row.paymentStatus)) {
          bucket.revenue += Number(row.feeAtBooking || 0);
        }
      }
    }],
    weekFields: ['appointments', 'revenue']
  });
  const thisWeekCount = thisWeek.appointments, prevWeekCount = prevWeek.appointments;
  const thisWeekRevenue = thisWeek.revenue, prevWeekRevenue = prevWeek.revenue;

  // UI FIX (Doctor Analytics Audit): the dashboard's "Revenue this week"
  // card showed `thisWeekRevenue` (a real trailing-7-day figure) as its
  // headline, then rendered `online`/`offline` (below, `collected` =
  // LIFETIME collected, see the comment on those aggregates above)
  // directly underneath as if it were that week's split. The two numbers
  // had no relationship to each other, which is exactly why that card
  // looked broken. Derive a real this-week online/offline split from the
  // same fortnightRows used for the chart above, using the identical
  // `last7Key` boundary buildDailyTrend used for `thisWeek` itself, so the
  // split always matches the headline it sits under.
  const onlineThisWeek  = { consults: 0, collected: 0 };
  const offlineThisWeek = { consults: 0, collected: 0 };
  for (const row of fortnightRows) {
    const key = new Date(row.date).toISOString().slice(0, 10);
    if (key < last7Key) continue; // prior-week half of the 14-day window
    const bucket = row.consultationType === 'ONLINE' ? onlineThisWeek : offlineThisWeek;
    if (row.status === 'COMPLETED') bucket.consults += 1;
    if (COLLECTED.includes(row.paymentStatus)) bucket.collected += Number(row.feeAtBooking || 0);
  }

  res.json({
    todayAppointments: todayCount,
    completedToday,
    totalConsults,
    // Headline revenue = collected only (online + offline).
    totalRevenue: onlineCollectedAmt + offlineCollectedAmt,
    // Online vs offline split — LIFETIME totals (the doctor's two work
    // streams tracked apart). Kept for the earnings/all-time views.
    online:  { consults: onlineConsults,  collected: onlineCollectedAmt,  pending: onlinePendingAmt  },
    offline: { consults: offlineConsults, collected: offlineCollectedAmt, pending: offlinePendingAmt },
    // Same split, scoped to the trailing 7 days — this is what belongs
    // directly under the "Revenue this week" headline.
    onlineThisWeek, offlineThisWeek,
    pendingTotal: onlinePendingAmt + offlinePendingAmt,
    completionRate: totalAll > 0 ? Math.round((completedAll / totalAll) * 100) : 0,
    cancelledAll,
    trend: {
      today:    { appointments: todayCount, vsYesterday: todayCount - yesterdayCount },
      daily:    Object.values(daily).slice(7), // last 7 days, oldest → newest
      thisWeek: { appointments: thisWeekCount, revenue: thisWeekRevenue },
      prevWeek: { appointments: prevWeekCount, revenue: prevWeekRevenue },
      last30Days: { appointments: last30Count, vsPrevious: last30Count - prev30Count }
    }
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