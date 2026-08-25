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

// ─────────────────────────────────────────────────────────────────────
// Root-cause fix for "signature saves but never appears in PDFs":
// prescription/invoice/certificate PDFs are cached on disk and every
// download route only regenerates one "if missing" (a pattern meant for
// ephemeral-disk redeploys). Nothing previously invalidated that cache
// when a doctor uploaded, redrew, or removed their signature — so any
// PDF generated before the signature existed (or before it changed)
// stayed signature-less forever, even though the signature itself saved
// correctly. Deleting the cached files here makes the existing
// "regenerate if missing" logic in files.routes.js / doctor.controller.js
// pick them back up with the current signature on next view/download.
// ─────────────────────────────────────────────────────────────────────
async function invalidateGeneratedPdfsForDoctor(doctorId) {
  const targets = [];

  try {
    const appointments = await prisma.appointment.findMany({
      where: { doctorId },
      select: { id: true }
    });
    for (const { id } of appointments) {
      targets.push(path.join(STORAGE, 'prescriptions', `prescription_${id}.pdf`));
      targets.push(path.join(STORAGE, 'invoices', `invoice_${id}.pdf`));
    }
  } catch (err) {
    logger.error('invalidateGeneratedPdfsForDoctor: appointment lookup failed', { doctorId, err: err.message });
  }

  try {
    const certificates = await prisma.medicalCertificate.findMany({
      where: { doctorId },
      select: { id: true }
    });
    for (const { id } of certificates) {
      targets.push(path.join(STORAGE, 'certificates', `certificate_${id}.pdf`));
    }
  } catch (err) {
    logger.error('invalidateGeneratedPdfsForDoctor: certificate lookup failed', { doctorId, err: err.message });
  }

  let deleted = 0;
  await Promise.all(targets.map(async (fp) => {
    try {
      await fs.promises.unlink(fp);
      deleted++;
    } catch (_) { /* file may not exist yet — fine */ }
  }));

  logger.info('invalidated cached PDFs after signature change', { doctorId, candidates: targets.length, deleted });
}

// GET /api/doctor/signature/file — streams the doctor's OWN current
// signature image to an authenticated doctor. Replaces the removed public
// express.static mount on /files/signatures: a signature is exactly the
// artifact needed to forge a certificate/prescription, so it must never be
// reachable by a bare, unauthenticated URL. Mirrors kyc.controller.js's
// streamKycDocument (path resolved strictly inside SIG_DIR).
exports.streamFile = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findFirst({
    where: { id: req.user.id, deletedAt: null },
    select: { signatureUrl: true }
  });
  if (!doctor || !doctor.signatureUrl) return res.status(404).json({ error: 'No signature uploaded' });

  const filename = path.basename(doctor.signatureUrl);
  const disk = path.join(SIG_DIR, filename);
  if (!disk.startsWith(SIG_DIR + path.sep) || !fs.existsSync(disk)) {
    return res.status(404).json({ error: 'Signature file not found' });
  }

  const ext = path.extname(disk).toLowerCase();
  res.setHeader('Content-Type', ext === '.png' ? 'image/png' : 'image/jpeg');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  fs.createReadStream(disk).pipe(res);
});

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
  await invalidateGeneratedPdfsForDoctor(req.user.id);
  logger.info('doctor signature uploaded', { doctorId: req.user.id, file: req.file.filename });
  res.json({ success: true, signatureUrl: updated.signatureUrl });
});

exports.uploadDrawn = asyncHandler(async (req, res) => {
  const parsed = drawnSignatureSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid signature payload', details: parsed.error.flatten() });
  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  // SECURITY FIX (audit hardening): SVG signatures were accepted and
    // later embedded into generated PDFs / served back to browsers.
    // SVG is an active content type (can carry <script>) — removed from
    // the whitelist. PNG remains the only accepted drawn format.
    const match = parsed.data.dataUrl.match(/^data:image\/png;base64,(.+)$/i);
    if (!match) return res.status(400).json({ error: 'Invalid signature payload' });
    const ext = 'png';
    const buf = Buffer.from(match[1], 'base64');
  if (!buf.length) return res.status(400).json({ error: 'Empty signature image' });
  if (buf.length > 1024 * 1024) return res.status(400).json({ error: 'Signature image must be under 1 MB' });

  await removeExistingSignature(doctor.signatureUrl);
  const filename = `${crypto.randomUUID()}.${ext}`;
  await fs.promises.writeFile(path.join(SIG_DIR, filename), buf);
  const url = signatureUrlFor(filename);
  await prisma.doctor.update({ where: { id: req.user.id }, data: { signatureUrl: url } });
  await invalidateGeneratedPdfsForDoctor(req.user.id);
  logger.info('doctor signature drawn upload', { doctorId: req.user.id, file: filename });
  res.json({ success: true, signatureUrl: url });
});

exports.remove = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  await removeExistingSignature(doctor.signatureUrl);
  await prisma.doctor.update({ where: { id: req.user.id }, data: { signatureUrl: null } });
  await invalidateGeneratedPdfsForDoctor(req.user.id);
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
