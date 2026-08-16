// =====================================================================
// signature.controller.js
// ---------------------------------------------------------------------
// Feature 3 — Doctor Digital Signature Management
//
// Endpoints:
//   GET    /api/doctor/signature           — get current signature meta
//   POST   /api/doctor/signature           — upload / replace signature (multipart PNG/JPG)
//   DELETE /api/doctor/signature           — remove signature
//
// Signatures are stored on disk under storage/signatures/<uuid>.<ext>.
// The stored URL on the doctor row is served via a NEW public static
// mount (/files/signatures) since a signature is meant to be visible on
// every certificate/prescription — it is not sensitive PHI.
// =====================================================================
const fs = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage');
const PUBLIC = process.env.PUBLIC_STORAGE_URL || '/files';

function signatureUrlFor(filename) {
  return `${PUBLIC}/signatures/${filename}`;
}

exports.get = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findFirst({
    where: { id: req.user.id, deletedAt: null },
    select: { id: true, signatureUrl: true, registrationNumber: true, name: true, qualification: true }
  });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  res.json({
    signatureUrl: doctor.signatureUrl,
    registrationNumber: doctor.registrationNumber,
    name: doctor.name,
    qualification: doctor.qualification
  });
});

exports.upload = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Signature image file is required' });

  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  // Delete any prior signature file — best effort, non-fatal.
  if (doctor.signatureUrl) {
    try {
      const oldName = path.basename(doctor.signatureUrl);
      const oldPath = path.join(STORAGE, 'signatures', oldName);
      fs.promises.unlink(oldPath).catch(() => null);
    } catch (_) { /* ignore */ }
  }

  const newUrl = signatureUrlFor(req.file.filename);
  const updated = await prisma.doctor.update({
    where: { id: req.user.id },
    data:  { signatureUrl: newUrl }
  });

  logger.info('doctor signature uploaded', { doctorId: req.user.id, file: req.file.filename });
  res.json({ success: true, signatureUrl: updated.signatureUrl });
});

exports.remove = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  if (doctor.signatureUrl) {
    try {
      const oldPath = path.join(STORAGE, 'signatures', path.basename(doctor.signatureUrl));
      fs.promises.unlink(oldPath).catch(() => null);
    } catch (_) { /* ignore */ }
  }
  await prisma.doctor.update({ where: { id: req.user.id }, data: { signatureUrl: null } });
  res.json({ success: true });
});

// Also allow the doctor to update their registration number in the
// same "signature settings" screen — a tightly scoped write that
// deliberately does NOT touch anything else. Sensitive profile fields
// remain under admin control (existing updateDoctor endpoint).
exports.updateRegistration = asyncHandler(async (req, res) => {
  const regNo = String(req.body?.registrationNumber || '').trim().slice(0, 120) || null;
  const updated = await prisma.doctor.update({
    where: { id: req.user.id },
    data:  { registrationNumber: regNo },
    select: { id: true, registrationNumber: true }
  });
  res.json({ success: true, ...updated });
});
