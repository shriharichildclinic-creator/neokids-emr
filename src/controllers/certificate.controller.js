// =====================================================================
// certificate.controller.js
// ---------------------------------------------------------------------
// Feature 2 — Medical Certificate Generator
//
// Endpoints:
//   POST /api/doctor/certificates                           — issue new
//   POST /api/doctor/appointments/:id/certificate           — issue from appointment
//   GET  /api/doctor/certificates                           — list mine
//   GET  /api/doctor/certificates/:id                       — detail
//   GET  /api/doctor/certificates/templates                 — template catalog
//   GET  /api/admin/certificates                            — list all (admin)
//   GET  /api/admin/certificates/:id                        — detail (admin)
//
// The PDF is streamed via /api/files/certificates/:idAndExt (see
// files.routes.js additions).
// =====================================================================
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { medicalCertificateSchema } = require('../utils/validators');
const { doctorOwnsPatient } = require('../utils/patientAccess');
const { parseDateOnlyOrNull, calcAge } = require('../utils/date');
const pdf = require('../services/pdf.service');
const logger = require('../utils/logger');
const dayjs = require('dayjs');
const { buildSignedFileUrl } = require('../utils/fileTokens');
const automation = require('../services/automation.service');
const certDates = require('../services/certificate-date.service');

// v3.4.4 — Single deterministic date flow (Option A).
// Inputs the doctor controls:   any of {restDays, fromDate, toDateOverride, toDate}
// Inputs NEVER consulted anymore: reverse-derivation, dual-mode, legacy DAY_COUNT.
// Helper kept only for legacy DATE_RANGE rows that pre-existed the rewrite —
// new writes ALWAYS go through certDates.normalizeCertificateDates().
function resolveDurationType(d) {
  return d && d.durationType === 'SINGLE_DAY' ? 'SINGLE_DAY' : 'DATE_RANGE';
}
function deriveToDate(fromDate, restDays) {
  // Back-compat only. New code uses certDates.computeEndDate.
  if (!fromDate || !restDays || restDays < 1) return null;
  return dayjs(fromDate).add(restDays - 1, 'day').format('YYYY-MM-DD');
}
function resolveCertificateDates(d) {
  const dates = certDates.normalizeCertificateDates(d || {});
  return Object.assign(
    { durationType: resolveDurationType(d) },
    dates
  );
}

// Load the full graph the delivery + PDF pipeline needs.
async function loadCertificateGraph(id) {
  return prisma.medicalCertificate.findUnique({
    where: { id },
    include: { patient: true, doctor: true, appointment: true }
  });
}

// Fire PDF regeneration + WhatsApp + email delivery without letting a
// channel failure fail the request. Returns a per-channel delivery summary
// so the UI can show exactly what happened.
async function deliverCertificate(cert, { sendWhatsapp = true, sendEmail = true } = {}) {
  const full = cert && cert.patient ? cert : await loadCertificateGraph(cert.id);
  if (!full) return { whatsapp: 'skipped', email: 'skipped' };

  // Always (re)generate the PDF first so both channels attach fresh bytes.
  let pdfRes = null;
  try {
    pdfRes = await pdf.generateMedicalCertificate({ certificate: full, doctor: full.doctor, patient: full.patient });
    await prisma.medicalCertificate.update({ where: { id: full.id }, data: { pdfUrl: pdfRes.url } });
    full.pdfUrl = pdfRes.url;
  } catch (e) {
    logger.error('deliverCertificate: PDF generation failed', { id: full.id, err: e.message });
    return { whatsapp: 'pdf_failed', email: 'pdf_failed' };
  }

  return automation.onCertificateIssued({ certificate: full, pdfRes, sendWhatsapp, sendEmail });
}

// v3.4.0 — expanded catalog. Keep keys in sync with
// pdf.service.js CERT_TEMPLATES and validators.medicalCertificateSchema.
const TEMPLATES = [
  { key: 'GENERAL',           label: 'General Medical Certificate' },
  { key: 'SCHOOL_LEAVE',      label: 'School Leave Certificate' },
  { key: 'FITNESS',           label: 'Fitness Certificate' },
  { key: 'MEDICAL_REST',      label: 'Rest Advised Certificate' },
  { key: 'VACCINATION',       label: 'Vaccination Certificate' },
  { key: 'RETURN_TO_SCHOOL',  label: 'Return To School Certificate' }
];

function nextCertNumber() {
  const yr = new Date().getUTCFullYear();
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  const ts  = Date.now().toString().slice(-4);
  return `NKP-CERT-${yr}-${ts}${rnd}`;
}


function withSignedPdfUrl(cert, user) {
  if (!cert) return cert;
  return {
    ...cert,
    pdfUrl: buildSignedFileUrl({
      kind: 'certificate',
      appointmentId: cert.id,
      userId: user && user.id,
      role: user && user.role
    })
  };
}

exports.listTemplates = asyncHandler(async (req, res) => {
  res.json(TEMPLATES);
});

exports.list = asyncHandler(async (req, res) => {
  const where = {};
  if (req.user.role === 'DOCTOR') where.doctorId = req.user.id;
  const { from, to, q } = req.query;
  if (from || to) {
    where.issuedAt = {};
    if (from) where.issuedAt.gte = new Date(from + 'T00:00:00.000Z');
    if (to)   { const e = new Date(to + 'T23:59:59.999Z'); where.issuedAt.lte = e; }
  }
  if (q && String(q).trim().length >= 2) {
    const term = String(q).trim();
    where.OR = [
      { certificateNumber: { contains: term } },
      { patientNameSnapshot: { contains: term } },
      { diagnosis: { contains: term } },
      { reason: { contains: term } }
    ];
  }
  const rows = await prisma.medicalCertificate.findMany({
    where,
    include: {
      patient: { select: { id: true, name: true, phone: true } },
      doctor:  { select: { id: true, name: true, specialization: true } },
      appointment: { select: { id: true, date: true, startTime: true, consultationType: true } }
    },
    orderBy: { issuedAt: 'desc' },
    take: Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500)
  });
  res.json(rows.map(row => withSignedPdfUrl(row, req.user)));
});

exports.detail = asyncHandler(async (req, res) => {
  const where = { id: req.params.id };
  if (req.user.role === 'DOCTOR') where.doctorId = req.user.id;
  const cert = await prisma.medicalCertificate.findFirst({
    where,
    include: {
      patient: true,
      doctor:  { select: { id: true, name: true, specialization: true, qualification: true, registrationNumber: true, clinicName: true, clinicAddress: true } },
      appointment: { select: { id: true, date: true, startTime: true, consultationType: true } }
    }
  });
  if (!cert) return res.status(404).json({ error: 'Certificate not found' });
  res.json(withSignedPdfUrl(cert, req.user));
});

exports.create = asyncHandler(async (req, res) => {
  const parsed = medicalCertificateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  const d = parsed.data;

  // Resolve appointment + patient snapshot.
  let appointment = null;
  let patient = null;

  if (d.appointmentId) {
    const where = { id: d.appointmentId };
    if (req.user.role === 'DOCTOR') where.doctorId = req.user.id;
    appointment = await prisma.appointment.findFirst({
      where,
      include: { patient: true, doctor: true }
    });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    patient = appointment.patient;
  } else {
    // SECURITY FIX (Patient Linking audit): a standalone certificate
    // (no appointmentId) used to trust any patientId the client sent —
    // a doctor could issue a certificate for a patient they'd never
    // treated, exclusively belonging to another doctor. Now requires an
    // established relationship (appointment, previous record, or an
    // earlier certificate) with that patient. Admins are unaffected —
    // they can already only reach here by explicitly supplying doctorId.
    if (req.user.role === 'DOCTOR') {
      const owns = await doctorOwnsPatient(req.user.id, d.patientId);
      if (!owns) return res.status(404).json({ error: 'Patient not found' });
    }
    patient = await prisma.patient.findUnique({ where: { id: d.patientId } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
  }

  // Doctor context.
  let doctor;
  if (appointment) {
    doctor = appointment.doctor;
  } else if (req.user.role === 'DOCTOR') {
    doctor = await prisma.doctor.findFirst({ where: { id: req.user.id, deletedAt: null } });
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  } else {
    // Admin issuing without appointment must supply doctorId in body.
    if (!req.body.doctorId) {
      return res.status(400).json({ error: 'doctorId is required when admin issues a standalone certificate' });
    }
    doctor = await prisma.doctor.findFirst({ where: { id: req.body.doctorId, deletedAt: null } });
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  }

  const ageStr = calcAge(patient.dateOfBirth) || null;
  const certificateNumber = nextCertNumber();
  const dates = resolveCertificateDates(d);

  const cert = await prisma.medicalCertificate.create({
    data: {
      certificateNumber,
      appointmentId: appointment ? appointment.id : null,
      patientId: patient.id,
      doctorId: doctor.id,
      templateKey: d.templateKey || 'GENERAL',
      diagnosis: d.diagnosis || null,
      reason: d.reason,
      restDays: d.restDays ?? null,
      durationType: dates.durationType,
      certificateDate: dates.certificateDate,
      fromDate: dates.fromDate,
      toDate:   dates.toDate,
      additionalNotes: d.additionalNotes || null,
      // v3.4.0 — snapshot consultation mode so the certificate layout is
      // frozen at issue time even if the appointment is edited later.
      // Appointment-linked: from the appointment. Standalone: doctor's pick.
      consultationType: appointment ? (appointment.consultationType || null) : (d.consultationType || null),
      patientNameSnapshot: patient.name,
      patientAgeSnapshot: ageStr,
      patientGenderSnapshot: patient.gender || null
    },
    include: { appointment: true }
  });

  // Generate PDF + deliver (WhatsApp + email, best-effort per channel).
  // The controller still succeeds if a channel fails — the doctor can
  // re-send from the certificates list via /:id/send.
  const delivery = await deliverCertificate({ ...cert, patient, doctor }, {
    sendWhatsapp: req.body.sendWhatsapp !== false,
    sendEmail: req.body.sendEmail !== false
  });

  const fresh = await prisma.medicalCertificate.findUnique({ where: { id: cert.id } });
  res.status(201).json({ ...withSignedPdfUrl(fresh || cert, req.user), delivery });
});

// Convenience endpoint: POST /appointments/:id/certificate
exports.createForAppointment = asyncHandler(async (req, res) => {
  req.body = { ...(req.body || {}), appointmentId: req.params.id };
  return exports.create(req, res);
});

// PUT /api/doctor/certificates/:id — edit an issued certificate.
// The doctor can correct the wording/dates; the PDF is regenerated so the
// download always reflects the latest content.
exports.update = asyncHandler(async (req, res) => {
  const where = { id: req.params.id };
  if (req.user.role === 'DOCTOR') where.doctorId = req.user.id;
  const existing = await prisma.medicalCertificate.findFirst({
    where,
    include: { appointment: true, patient: true }
  });
  if (!existing) return res.status(404).json({ error: 'Certificate not found' });

  const parsed = medicalCertificateSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  const d = parsed.data;
  const data = {};
  if (d.templateKey) data.templateKey = d.templateKey;
  if (Object.prototype.hasOwnProperty.call(d, 'reason') && d.reason) data.reason = d.reason;
  if (Object.prototype.hasOwnProperty.call(d, 'diagnosis')) data.diagnosis = d.diagnosis || null;
  if (Object.prototype.hasOwnProperty.call(d, 'restDays')) data.restDays = d.restDays ?? null;
  if (Object.prototype.hasOwnProperty.call(d, 'additionalNotes')) data.additionalNotes = d.additionalNotes || null;

  // Duration semantics: if the doctor switches type or touches any date
  // field, recompute the full date set from the merged view (existing +
  // patch) so single-day ↔ range conversions never leave stale dates.
  const touchesDates =
    Object.prototype.hasOwnProperty.call(d, 'durationType') ||
    Object.prototype.hasOwnProperty.call(d, 'certificateDate') ||
    Object.prototype.hasOwnProperty.call(d, 'fromDate') ||
    Object.prototype.hasOwnProperty.call(d, 'toDate') ||
    Object.prototype.hasOwnProperty.call(d, 'restDays');
  if (touchesDates) {
    const merged = {
      durationType: d.durationType || existing.durationType || 'DATE_RANGE',
      certificateDate: Object.prototype.hasOwnProperty.call(d, 'certificateDate')
        ? d.certificateDate
        : (existing.certificateDate ? dayjs(existing.certificateDate).format('YYYY-MM-DD') : undefined),
      fromDate: Object.prototype.hasOwnProperty.call(d, 'fromDate')
        ? d.fromDate
        : (existing.fromDate ? dayjs(existing.fromDate).format('YYYY-MM-DD') : undefined),
      toDate: Object.prototype.hasOwnProperty.call(d, 'toDate')
        ? d.toDate
        : (existing.toDate ? dayjs(existing.toDate).format('YYYY-MM-DD') : undefined),
      restDays: Object.prototype.hasOwnProperty.call(d, 'restDays') ? d.restDays : existing.restDays
    };
    const dates = resolveCertificateDates(merged);
    data.durationType = dates.durationType;
    data.certificateDate = dates.certificateDate;
    data.fromDate = dates.fromDate;
    data.toDate = dates.toDate;
  }

  // v3.4.4 — Always re-run the date normalizer when ANY date-relevant
  // field changes, so single-day toggles, partial overrides and restDays
  // edits converge on a single canonical state and never drift.
  const durTouched =
    Object.prototype.hasOwnProperty.call(data, 'durationType') ||
    Object.prototype.hasOwnProperty.call(data, 'certificateDate') ||
    Object.prototype.hasOwnProperty.call(data, 'fromDate') ||
    Object.prototype.hasOwnProperty.call(data, 'toDate') ||
    Object.prototype.hasOwnProperty.call(data, 'restDays');
  if (durTouched) {
    const merged = Object.assign(
      {},
      {
        durationType:    existing.durationType || 'DATE_RANGE',
        certificateDate: existing.certificateDate ? dayjs(existing.certificateDate).format('YYYY-MM-DD') : undefined,
        fromDate:        existing.fromDate ? dayjs(existing.fromDate).format('YYYY-MM-DD') : undefined,
        toDate:          existing.toDate   ? dayjs(existing.toDate).format('YYYY-MM-DD')   : undefined,
        restDays:        existing.restDays
      },
      {
        restDays:       data.restDays,
        fromDate:       data.fromDate,
        toDate:         data.toDate,
        toDateOverride: data.toDateOverride,
        durationType:   data.durationType,
        certificateDate:data.certificateDate
      }
    );
    Object.assign(data, certDates.normalizeCertificateDates(merged));
  }

  const cert = await prisma.medicalCertificate.update({
    where: { id: existing.id },
    data,
    include: { appointment: true }
  });

  // Regenerate the PDF so downloads always reflect the latest wording.
  // NOTE: an edit intentionally does NOT re-notify the patient — delivery
  // is an explicit action (POST /:id/send) so a typo fix can't spam them.
  try {
    const doctor = await prisma.doctor.findUnique({ where: { id: existing.doctorId } });
    const result = await pdf.generateMedicalCertificate({ certificate: cert, doctor, patient: existing.patient });
    await prisma.medicalCertificate.update({ where: { id: cert.id }, data: { pdfUrl: result.url } });
    cert.pdfUrl = result.url;
  } catch (e) {
    logger.error('generateMedicalCertificate (update) failed', { id: cert.id, err: e.message });
  }

  res.json(withSignedPdfUrl(cert, req.user));
});

// POST /api/doctor/certificates/:id/send
// Body: { channels: ['whatsapp','email'] } — defaults to both.
// Explicit re-delivery of an issued certificate, mirroring the prescription
// "resend" workflow. Per-channel statuses are returned so the UI can show
// e.g. "sent on WhatsApp, no email on file".
exports.send = asyncHandler(async (req, res) => {
  const where = { id: req.params.id };
  if (req.user.role === 'DOCTOR') where.doctorId = req.user.id;
  const existing = await prisma.medicalCertificate.findFirst({ where });
  if (!existing) return res.status(404).json({ error: 'Certificate not found' });

  const channels = Array.isArray(req.body && req.body.channels) ? req.body.channels : ['whatsapp', 'email'];
  const delivery = await deliverCertificate(existing, {
    sendWhatsapp: channels.includes('whatsapp'),
    sendEmail: channels.includes('email')
  });
  res.json({ success: true, delivery });
});
