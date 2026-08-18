// =====================================================================
// historical.controller.js
// ---------------------------------------------------------------------
// Feature 1 + 1A — Historical / Manual Appointment Records
//
// Endpoints:
//   POST /api/doctor/historical-appointments
//   POST /api/admin/historical-appointments
//   GET  /api/doctor/appointments/lookup-patient?phone=...
//   GET  /api/admin/appointments/lookup-patient?phone=...
//
// The core business logic lives in
// services/historical-appointment.service.js so the controller stays
// thin. This controller only:
//   * parses & validates the request
//   * enforces role/ownership (doctors can only add for themselves)
//   * routes uploaded files to the service
//   * returns the right HTTP shape for each service outcome
// =====================================================================
const path = require('path');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { historicalAppointmentSchema } = require('../utils/validators');
const svc = require('../services/historical-appointment.service');
const logger = require('../utils/logger');
const { myPatientIdSet } = require('../utils/patientAccess');

// Build a stable, forward-only URL for uploaded prescription files.
// Kept relative so the same value works in every env.
function historicalPrescriptionUrl(filename) {
  return `/files/historical-rx/${filename}`;
}

exports.lookupPatient = asyncHandler(async (req, res) => {
  const phone = String(req.query.phone || '').replace(/\D/g, '');
  if (!/^[6-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid Indian phone number' });
  }
  const rows = await prisma.patient.findMany({
    where: { phone },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, name: true, phone: true, email: true,
      dateOfBirth: true, gender: true, parentName: true, createdAt: true
    }
  });
  // SECURITY FIX (Patient Linking audit): admins may look up any patient
  // by phone (they run this same endpoint under /admin), but a doctor
  // must only see matches among patients already under their own care —
  // otherwise typing any real phone number surfaced another doctor's
  // patient by name/DOB/parent name. Doctors with no existing match
  // create a fresh historical-appointment patient record as before.
  if (req.user && req.user.role === 'DOCTOR') {
    const mine = await myPatientIdSet(req.user.id);
    return res.json({ matches: rows.filter(r => mine.has(r.id)) });
  }
  res.json({ matches: rows });
});

exports.create = asyncHandler(async (req, res) => {
  // linkConfirmed comes as string "true" via multipart; coerce it.
  const body = { ...(req.body || {}) };
  if (typeof body.linkConfirmed === 'string') {
    body.linkConfirmed = body.linkConfirmed === 'true';
  }

  // Doctors can only add records for themselves; ignore/override any
  // supplied doctorId in that case.
  if (req.user.role === 'DOCTOR') {
    body.doctorId = req.user.id;
  }

  const parsed = historicalAppointmentSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }

  // Handle uploaded prescription file (optional).
  let manualPrescriptionUrl = null;
  if (req.file) {
    manualPrescriptionUrl = historicalPrescriptionUrl(req.file.filename);
  }

  try {
    const result = await svc.createHistoricalAppointment(
      parsed.data,
      { addedById: req.user.id, addedByRole: req.user.role },
      manualPrescriptionUrl
    );

    if (result.needsConfirmation) {
      return res.status(409).json({
        error: 'An existing patient with this mobile number already exists. Please verify before creating a new patient.',
        code: 'PATIENT_LINK_REQUIRED',
        candidates: result.candidates
      });
    }

    return res.status(201).json({
      success: true,
      appointment: result.appointment,
      patient: result.patient,
      matchType: result.matchType,
      manualPrescriptionUrl
    });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    logger.error('createHistoricalAppointment failed', { err: e.message });
    // Duplicate slot collision -> 409 with helpful message.
    if (e.code === 'P2002') {
      return res.status(409).json({
        error: 'A record for this doctor/date/time already exists',
        code: 'SLOT_CONFLICT'
      });
    }
    throw e;
  }
});
