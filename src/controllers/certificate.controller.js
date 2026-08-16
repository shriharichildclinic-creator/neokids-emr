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
const { parseDateOnlyOrNull, calcAge } = require('../utils/date');
const pdf = require('../services/pdf.service');
const logger = require('../utils/logger');
const dayjs = require('dayjs');
const { buildSignedFileUrl } = require('../utils/fileTokens');

const TEMPLATES = [
  { key: 'GENERAL',       label: 'General Medical Certificate' },
  { key: 'SCHOOL_LEAVE',  label: 'School Leave Certificate' },
  { key: 'FITNESS',       label: 'Fitness Certificate' },
  { key: 'MEDICAL_REST',  label: 'Medical Rest Certificate' }
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
      doctor:  { select: { id: true, name: true, specialization: true } }
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
      appointment: { select: { id: true, date: true, consultationType: true } }
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
      fromDate: parseDateOnlyOrNull(d.fromDate),
      toDate:   parseDateOnlyOrNull(d.toDate),
      additionalNotes: d.additionalNotes || null,
      patientNameSnapshot: patient.name,
      patientAgeSnapshot: ageStr,
      patientGenderSnapshot: patient.gender || null
    }
  });

  // Generate PDF (best-effort; controller still succeeds if generation fails,
  // the file can be regenerated on next download via the file route).
  try {
    const result = await pdf.generateMedicalCertificate({ certificate: cert, doctor, patient });
    await prisma.medicalCertificate.update({
      where: { id: cert.id },
      data:  { pdfUrl: result.url }
    });
    cert.pdfUrl = result.url;
  } catch (e) {
    logger.error('generateMedicalCertificate failed', { id: cert.id, err: e.message });
  }

  res.status(201).json(withSignedPdfUrl(cert, req.user));
});

// Convenience endpoint: POST /appointments/:id/certificate
exports.createForAppointment = asyncHandler(async (req, res) => {
  req.body = { ...(req.body || {}), appointmentId: req.params.id };
  return exports.create(req, res);
});
