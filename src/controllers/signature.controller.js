const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { drawnSignatureSchema } = require('../utils/validators');
const logger = require('../utils/logger');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage');
const PUBLIC = process.env.PUBLIC_STORAGE_URL || '/files';
const SIG_DIR = path.join(STORAGE, 'signatures');
fs.mkdirSync(SIG_DIR, { recursive: true });

function signatureUrlFor(filename) {
  return `${PUBLIC}/signatures/${filename}`;
}

async function removeExistingSignature(signatureUrl) {
  if (!signatureUrl) return;
  try {
    const oldPath = path.join(SIG_DIR, path.basename(signatureUrl));
    await fs.promises.unlink(oldPath);
  } catch (_) {}
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
  await removeExistingSignature(doctor.signatureUrl);
  const newUrl = signatureUrlFor(req.file.filename);
  const updated = await prisma.doctor.update({ where: { id: req.user.id }, data: { signatureUrl: newUrl } });
  logger.info('doctor signature uploaded', { doctorId: req.user.id, file: req.file.filename });
  res.json({ success: true, signatureUrl: updated.signatureUrl });
});

exports.uploadDrawn = asyncHandler(async (req, res) => {
  const parsed = drawnSignatureSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid signature payload', details: parsed.error.flatten() });
  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  const match = parsed.data.dataUrl.match(/^data:image\/(png|svg\+xml);base64,(.+)$/i);
  const subtype = (match[1] || 'png').toLowerCase();
  const ext = subtype === 'svg+xml' ? 'svg' : 'png';
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length) return res.status(400).json({ error: 'Empty signature image' });
  if (buf.length > 1024 * 1024) return res.status(400).json({ error: 'Signature image must be under 1 MB' });

  await removeExistingSignature(doctor.signatureUrl);
  const filename = `${crypto.randomUUID()}.${ext}`;
  await fs.promises.writeFile(path.join(SIG_DIR, filename), buf);
  const url = signatureUrlFor(filename);
  await prisma.doctor.update({ where: { id: req.user.id }, data: { signatureUrl: url } });
  logger.info('doctor signature drawn upload', { doctorId: req.user.id, file: filename });
  res.json({ success: true, signatureUrl: url });
});

exports.remove = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  await removeExistingSignature(doctor.signatureUrl);
  await prisma.doctor.update({ where: { id: req.user.id }, data: { signatureUrl: null } });
  res.json({ success: true });
});

exports.updateRegistration = asyncHandler(async (req, res) => {
  const regNo = String(req.body?.registrationNumber || '').trim().slice(0, 120) || null;
  const updated = await prisma.doctor.update({
    where: { id: req.user.id },
    data:  { registrationNumber: regNo },
    select: { id: true, registrationNumber: true }
  });
  res.json({ success: true, ...updated });
});
