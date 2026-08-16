const fs = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { previousRecordSchema } = require('../utils/validators');
const { parseDateOnly } = require('../utils/date');
const { buildSignedFileUrl } = require('../utils/fileTokens');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage');
const UPLOAD_SEGMENT = '/files/historical-rx/';

async function ensureDoctorPermission(doctorId) {
  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
    select: { id: true, canAddPreviousRecords: true, deletedAt: true }
  });
  if (!doctor || doctor.deletedAt) {
    const e = new Error('Doctor not found');
    e.statusCode = 404;
    throw e;
  }
  if (!doctor.canAddPreviousRecords) {
    const e = new Error('Previous Records access is disabled for this doctor');
    e.statusCode = 403;
    throw e;
  }
  return doctor;
}

function signAttachment(record, user) {
  if (!record || !record.attachmentUrl) return null;
  return buildSignedFileUrl({
    kind: 'previous-record',
    appointmentId: record.id,
    userId: user && user.id,
    role: user && user.role
  });
}

function cleanPayload(data) {
  return {
    patientId: data.patientId,
    recordDate: parseDateOnly(data.recordDate),
    diagnosis: data.diagnosis || null,
    notes: data.notes || null,
    treatment: data.treatment || null,
    medications: data.medications || null
  };
}

function buildAttachmentUrl(file) {
  return file ? `${UPLOAD_SEGMENT}${file.filename}` : null;
}

async function deleteAttachment(relUrl) {
  if (!relUrl || !relUrl.includes(UPLOAD_SEGMENT)) return;
  const filename = path.basename(relUrl);
  const fp = path.join(STORAGE, 'historical-rx', filename);
  try { await fs.promises.unlink(fp); } catch (_) {}
}

exports.permission = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({
    where: { id: req.user.id },
    select: { canAddPreviousRecords: true }
  });
  res.json({ allowed: !!doctor?.canAddPreviousRecords });
});

exports.listForPatient = asyncHandler(async (req, res) => {
  await ensureDoctorPermission(req.user.id);
  const patientId = req.params.patientId;

  const link = await prisma.appointment.findFirst({
    where: { doctorId: req.user.id, patientId },
    select: { id: true }
  });
  if (!link) return res.status(404).json({ error: 'Patient not found in your panel' });

  const rows = await prisma.previousRecord.findMany({
    where: { doctorId: req.user.id, patientId },
    orderBy: [{ recordDate: 'desc' }, { createdAt: 'desc' }]
  });
  res.json(rows.map(r => ({ ...r, attachmentSignedUrl: signAttachment(r, req.user) })));
});

exports.create = asyncHandler(async (req, res) => {
  await ensureDoctorPermission(req.user.id);
  const parsed = previousRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }

  const patient = await prisma.appointment.findFirst({
    where: { doctorId: req.user.id, patientId: parsed.data.patientId },
    select: { patientId: true }
  });
  if (!patient) return res.status(404).json({ error: 'Patient not found in your panel' });

  const created = await prisma.previousRecord.create({
    data: {
      doctorId: req.user.id,
      ...cleanPayload(parsed.data),
      attachmentUrl: buildAttachmentUrl(req.file)
    }
  });
  res.status(201).json({ ...created, attachmentSignedUrl: signAttachment(created, req.user) });
});

exports.update = asyncHandler(async (req, res) => {
  await ensureDoctorPermission(req.user.id);
  const parsed = previousRecordSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }

  const existing = await prisma.previousRecord.findFirst({
    where: { id: req.params.id, doctorId: req.user.id }
  });
  if (!existing) return res.status(404).json({ error: 'Previous record not found' });

  const data = {};
  if (parsed.data.recordDate) data.recordDate = parseDateOnly(parsed.data.recordDate);
  if (Object.prototype.hasOwnProperty.call(parsed.data, 'diagnosis')) data.diagnosis = parsed.data.diagnosis || null;
  if (Object.prototype.hasOwnProperty.call(parsed.data, 'notes')) data.notes = parsed.data.notes || null;
  if (Object.prototype.hasOwnProperty.call(parsed.data, 'treatment')) data.treatment = parsed.data.treatment || null;
  if (Object.prototype.hasOwnProperty.call(parsed.data, 'medications')) data.medications = parsed.data.medications || null;
  if (req.file) {
    await deleteAttachment(existing.attachmentUrl);
    data.attachmentUrl = buildAttachmentUrl(req.file);
  }

  const updated = await prisma.previousRecord.update({ where: { id: existing.id }, data });
  res.json({ ...updated, attachmentSignedUrl: signAttachment(updated, req.user) });
});

exports.remove = asyncHandler(async (req, res) => {
  await ensureDoctorPermission(req.user.id);
  const existing = await prisma.previousRecord.findFirst({
    where: { id: req.params.id, doctorId: req.user.id }
  });
  if (!existing) return res.status(404).json({ error: 'Previous record not found' });
  await prisma.previousRecord.delete({ where: { id: existing.id } });
  await deleteAttachment(existing.attachmentUrl);
  res.json({ success: true });
});
