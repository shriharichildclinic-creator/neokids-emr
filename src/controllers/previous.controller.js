// =====================================================================
// previous.controller.js — v3.4.3 Historical Records (Professional EMR)
// FIXES:
//  1) "Invalid Input" on edit: fully-tolerant PATCH-style validation —
//     every field optional, empty strings coerced to null, unknown keys
//     stripped. patientId is NEVER required on update.
//  2) Multiple attachments per record (PDFs / images / reports / scans)
//     each with its own label + kind.
//  3) Professional metadata: title, recordType, recordDate, diagnosis,
//     notes, treatment, medications.
//  4) Per-attachment actions: preview / download / replace / delete /
//     open-in-new-tab (signed URLs).
//  5) Share via WhatsApp + Email with secure expiring links; smart
//     recipient resolution (same patient -> stored phone/email, or
//     override for a different recipient).
//  6) PDF generation mirroring Prescription/Certificate architecture.
// =====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { z } = require('zod');
const prisma = require('../config/prisma');
const { asyncHandler: asyncH } = require('../middleware/errorHandler');
const svc = require('../services/historical-record.service');
const pdfSvc = require('../services/historical-record-pdf.service');

const UP_DIR = path.join(svc.STORAGE_PATH, 'historical-rx');
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['application/pdf','image/jpeg','image/png','image/webp','image/gif']);
function kindOf(mime, name){
  if (mime === 'application/pdf') return /\.pdf$/i.test(name) && /rx|presc/i.test(name) ? 'PRESCRIPTION' : 'PDF';
  if (mime.startsWith('image/')) return 'IMAGE';
  return 'OTHER';
}
const storage = multer.diskStorage({
  destination: (_req, _f, cb) => cb(null, UP_DIR),
  filename: (_req, f, cb) => cb(null, crypto.randomUUID() + (path.extname(f.originalname) || '').toLowerCase())
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024, files: 20 },
  fileFilter: (_req, f, cb) => ALLOWED_MIME.has(f.mimetype) ? cb(null, true) : cb(new Error('Only PDF or image files are allowed')) });

// --- tolerant validation (the "Invalid Input" fix) -------------------
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const baseFields = {
  title: z.preprocess(emptyToUndef, z.string().max(190).optional()),
  recordType: z.preprocess(emptyToUndef, z.string().max(64).optional()),
  recordDate: z.preprocess(emptyToUndef, z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
  diagnosis: z.preprocess(emptyToUndef, z.string().max(10000).optional()),
  notes: z.preprocess(emptyToUndef, z.string().max(10000).optional()),
  treatment: z.preprocess(emptyToUndef, z.string().max(10000).optional()),
  medications: z.preprocess(emptyToUndef, z.string().max(10000).optional()),
};
const createSchema = z.object(Object.assign({ patientId: z.string().min(1).optional() }, baseFields)).strip();
const updateSchema = z.object(baseFields).strip(); // everything optional — never throws "Invalid Input" for partial edits
const shareSchema = z.object({
  channel: z.enum(['whatsapp', 'email']),
  phone: z.preprocess(emptyToUndef, z.string().max(32).optional()),
  email: z.preprocess(emptyToUndef, z.string().email().max(190).optional()),
  attachmentIds: z.array(z.string()).max(20).optional(),
}).strip();

function parseBody(req, schema){
  const raw = typeof req.body === 'object' && req.body ? req.body : {};
  const r = schema.safeParse(raw);
  if (!r.success) { const e = new Error('Invalid input: ' + r.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; ')); e.status = 422; throw e; }
  return r.data;
}
async function saveAttachments(req, record){
  const files = req.files || [];
  const labels = [].concat(req.body.labels || req.body['labels[]'] || []);
  const out = [];
  for (let i = 0; i < files.length; i++){
    const f = files[i];
    const label = (labels[i] || f.originalname || 'Attachment').toString().slice(0, 190);
    out.push(await prisma.previousRecordAttachment.create({ data: {
      recordId: record.id, filename: f.filename, originalName: f.originalname, mimeType: f.mimetype,
      sizeBytes: f.size, label, kind: kindOf(f.mimetype, f.originalname), storagePath: f.filename,
      uploadedById: req.user && req.user.id, uploadedByRole: 'DOCTOR'
    }}));
  }
  return out;
}
const include = { attachments: { orderBy: { createdAt: 'asc' } }, patient: { select: { id:true, name:true, phone:true, email:true } }, doctor: { select: { id:true, name:true } } };
function notFound(){ const e = new Error('Historical record not found'); e.status = 404; return e; }
function unlinkQuiet(rel){ try { const p = path.join(UP_DIR, rel || ''); if (rel && fs.existsSync(p)) fs.unlinkSync(p); } catch(_){} }

// GET /doctor/patients/:patientId/previous-records
exports.listForPatient = asyncH(async (req, res) => {
  const rows = await prisma.previousRecord.findMany({
    where: { patientId: req.params.patientId, deletedAt: null },
    orderBy: [{ recordDate: 'desc' }, { createdAt: 'desc' }], include
  });
  res.json({ success: true, records: rows.map(r => svc.decorateRecord(req, r)) });
});

// GET /doctor/previous-records/:id
exports.detail = asyncH(async (req, res) => {
  const r = await prisma.previousRecord.findFirst({ where: { id: req.params.id, deletedAt: null }, include });
  if (!r) throw notFound();
  res.json({ success: true, record: svc.decorateRecord(req, r) });
});

// POST /doctor/patients/:patientId/previous-records  (multipart, attachments[])
exports.create = [ upload.array('attachments', 20), asyncH(async (req, res) => {
  const data = parseBody(req, createSchema);
  const patientId = req.params.patientId || data.patientId;
  if (!patientId) { const e = new Error('patientId is required'); e.status = 422; throw e; }
  const record = await prisma.previousRecord.create({ data: {
    doctorId: req.user.id, patientId,
    title: data.title || null, recordType: data.recordType || 'OTHER',
    recordDate: data.recordDate ? new Date(data.recordDate) : new Date(),
    diagnosis: data.diagnosis || null, notes: data.notes || null,
    treatment: data.treatment || null, medications: data.medications || null,
  }});
  await saveAttachments(req, record);
  const full = await prisma.previousRecord.findUnique({ where: { id: record.id }, include });
  res.status(201).json({ success: true, record: svc.decorateRecord(req, full) });
})];

// PUT /doctor/previous-records/:id  (multipart optional, attachments[] appended)
exports.update = [ upload.array('attachments', 20), asyncH(async (req, res) => {
  const existing = await prisma.previousRecord.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!existing) throw notFound();
  const data = parseBody(req, updateSchema); // tolerant — fixes "Invalid Input"
  const patch = {};
  for (const k of ['title','recordType','diagnosis','notes','treatment','medications'])
    if (data[k] !== undefined) patch[k] = data[k] === '' ? null : data[k];
  if (data.recordDate) patch.recordDate = new Date(data.recordDate);
  const record = await prisma.previousRecord.update({ where: { id: existing.id }, data: patch });
  await saveAttachments(req, record);
  const full = await prisma.previousRecord.findUnique({ where: { id: record.id }, include });
  res.json({ success: true, record: svc.decorateRecord(req, full) });
})];

// DELETE /doctor/previous-records/:id (soft delete)
exports.remove = asyncH(async (req, res) => {
  const existing = await prisma.previousRecord.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!existing) throw notFound();
  await prisma.previousRecord.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
  res.json({ success: true });
});

// POST /doctor/previous-records/:id/attachments
exports.addAttachments = [ upload.array('attachments', 20), asyncH(async (req, res) => {
  const record = await prisma.previousRecord.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!record) throw notFound();
  const added = await saveAttachments(req, record);
  res.status(201).json({ success: true, attachments: added.map(a => ({ id: a.id, label: a.label, originalName: a.originalName })) });
})];

// POST /doctor/previous-records/:id/attachments/:attachmentId/replace
exports.replaceAttachment = [ upload.single('file'), asyncH(async (req, res) => {
  const att = await prisma.previousRecordAttachment.findFirst({ where: { id: req.params.attachmentId, recordId: req.params.id } });
  if (!att) throw notFound();
  if (!req.file) { const e = new Error('file is required'); e.status = 422; throw e; }
  unlinkQuiet(att.storagePath);
  const label = (req.body.label || att.label || req.file.originalname).toString().slice(0,190);
  const updated = await prisma.previousRecordAttachment.update({ where: { id: att.id }, data: {
    filename: req.file.filename, originalName: req.file.originalname, mimeType: req.file.mimetype,
    sizeBytes: req.file.size, label, kind: kindOf(req.file.mimetype, req.file.originalname), storagePath: req.file.filename
  }});
  res.json({ success: true, attachment: { id: updated.id, label: updated.label } });
})];

// DELETE /doctor/previous-records/:id/attachments/:attachmentId
exports.deleteAttachment = asyncH(async (req, res) => {
  const att = await prisma.previousRecordAttachment.findFirst({ where: { id: req.params.attachmentId, recordId: req.params.id } });
  if (!att) throw notFound();
  await prisma.previousRecordAttachment.delete({ where: { id: att.id } });
  unlinkQuiet(att.storagePath);
  res.json({ success: true });
});

// POST /doctor/previous-records/:id/generate-pdf
exports.generatePdf = asyncH(async (req, res) => {
  const record = await prisma.previousRecord.findFirst({ where: { id: req.params.id, deletedAt: null }, include });
  if (!record) throw notFound();
  const pdf = await pdfSvc.generateHistoricalRecordPdf(record);
  await prisma.previousRecord.update({ where: { id: record.id }, data: { pdfUrl: pdf.publicUrl, pdfGeneratedAt: new Date() } });
  res.json({ success: true, pdfUrl: pdf.publicUrl });
});

// POST /doctor/previous-records/:id/share  { channel, phone?, email?, attachmentIds? }
exports.share = asyncH(async (req, res) => {
  const record = await prisma.previousRecord.findFirst({ where: { id: req.params.id, deletedAt: null }, include });
  if (!record) throw notFound();
  const body = parseBody(req, shareSchema);
  // Smart recipient resolution: default to the same patient's contact,
  // override only when a different phone/email is explicitly provided.
  const to = body.channel === 'whatsapp'
    ? (body.phone || (record.patient && record.patient.phone))
    : (body.email || (record.patient && record.patient.email));
  if (!to) { const e = new Error('No recipient available — patient has no ' + (body.channel === 'whatsapp' ? 'phone' : 'email') + ' on file; provide one explicitly.'); e.status = 422; throw e; }
  const url = svc.recordShareUrl(req, record);
  const delivery = await svc.deliver({
    channel: body.channel, to,
    patientName: record.patient ? record.patient.name : 'Patient',
    doctorName: record.doctor ? 'Dr. ' + record.doctor.name : 'Your doctor',
    recordType: pdfSvc.humanType(record.recordType),
    recordDate: new Date(record.recordDate).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }),
    url, clinicName: process.env.CLINIC_NAME || 'NeoKidsPro Clinic'
  });
  await prisma.previousRecord.update({ where: { id: record.id }, data: { lastSharedAt: new Date(), lastSharedVia: body.channel } });
  res.json({ success: true, delivery, shareUrl: url });
});

// ─── v3.4.3 hotfix: gate endpoint used by the doctor UI to show/hide the
// "Historical / Previous Records" tab. The route existed in doctor.routes.js
// but the controller export was missing → app crashed on boot. Default to
// allowed=true so behaviour matches the pre-feature production build; if
// finer-grained gating is needed later, plug logic here.
exports.permission = asyncH(async (_req, res) => {
  res.json({ allowed: true });
});
