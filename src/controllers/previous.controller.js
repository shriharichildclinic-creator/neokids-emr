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
// --- patient linkage fields (v3.4.8 fix) ------------------------------
// A record either links to a real directory patient (patientSource:
// 'EXISTING', patientId required) or is a manually-entered pre-EMR
// patient (patientSource: 'LEGACY', legacyPatientName required). Both
// branches are optional at the schema level; create()/update() enforce
// the actual "one or the other" requirement so validation errors stay
// specific instead of a generic Zod message.
const patientLinkFields = {
  patientId: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  patientSource: z.preprocess(emptyToUndef, z.enum(['EXISTING', 'LEGACY']).optional()),
  legacyPatientName: z.preprocess(emptyToUndef, z.string().max(190).optional()),
  legacyPatientPhone: z.preprocess(emptyToUndef, z.string().max(32).optional()),
  legacyPatientDob: z.preprocess(emptyToUndef, z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
  legacyPatientGender: z.preprocess(emptyToUndef, z.string().max(16).optional()),
  legacyPatientGuardian: z.preprocess(emptyToUndef, z.string().max(190).optional()),
  legacyPatientNotes: z.preprocess(emptyToUndef, z.string().max(10000).optional()),
};
const createSchema = z.object(Object.assign({}, patientLinkFields, baseFields)).strip();
const updateSchema = z.object(Object.assign({}, patientLinkFields, baseFields)).strip(); // everything optional — never throws "Invalid Input" for partial edits

// Build the patientId / patientSource / legacy* portion of a create or
// update payload. Throws a 422 with a clear message when neither an
// existing patient nor legacy patient details were supplied.
function resolvePatientLink(data, fallbackPatientId) {
  const source = data.patientSource || (data.legacyPatientName ? 'LEGACY' : 'EXISTING');
  if (source === 'LEGACY') {
    if (!data.legacyPatientName) { const e = new Error('Legacy patient name is required'); e.status = 422; throw e; }
    return {
      patientId: null,
      patientSource: 'LEGACY',
      legacyPatientName: data.legacyPatientName,
      legacyPatientPhone: data.legacyPatientPhone || null,
      legacyPatientDob: data.legacyPatientDob ? new Date(data.legacyPatientDob) : null,
      legacyPatientGender: data.legacyPatientGender || null,
      legacyPatientGuardian: data.legacyPatientGuardian || null,
      legacyPatientNotes: data.legacyPatientNotes || null,
    };
  }
  const patientId = data.patientId || fallbackPatientId;
  if (!patientId) { const e = new Error('Select an existing patient, or switch to "Legacy / Historical Patient" and enter their details'); e.status = 422; throw e; }
  return {
    patientId, patientSource: 'EXISTING',
    legacyPatientName: null, legacyPatientPhone: null, legacyPatientDob: null,
    legacyPatientGender: null, legacyPatientGuardian: null, legacyPatientNotes: null,
  };
}
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
  // Accept BOTH single-file and multi-file uploads. The doctor SPA submits
  // a single `<input name="attachment">` (legacy field), but the controller
  // also accepts an `attachments[]` field-name convention. So we read either
  // req.file or req.files and normalise to the same flat list.
  const files = [];
  if (Array.isArray(req.files) && req.files.length) files.push(...req.files);
  if (req.file) files.push(req.file);
  // labels / attachmentTypes / notes travel as parallel arrays, sent either
  // as `labels[]=a&labels[]=b` or as repeated `labels=a&labels=b`.
  const asList = (base) => []
    .concat(req.body[base] || [])
    .concat(Array.isArray(req.body[base + '[]']) ? req.body[base + '[]'] : (req.body[base + '[]'] ? [req.body[base + '[]']] : []));
  const labels = asList('labels');
  const types  = asList('attachmentTypes');
  const notesL = asList('attachmentNotes');
  const startOrder = await prisma.previousRecordAttachment.count({ where: { recordId: record.id } });
  const out = [];
  for (let i = 0; i < files.length; i++){
    const f = files[i];
    const label = (labels[i] || f.originalname || 'Attachment').toString().slice(0, 190);
    const attachmentType = types[i] ? String(types[i]).slice(0, 190) : null;
    const notes = notesL[i] ? String(notesL[i]).slice(0, 2000) : null;
    if (!f || !f.filename) continue;
    out.push(await prisma.previousRecordAttachment.create({ data: {
      recordId: record.id, filename: f.filename, originalName: f.originalname, mimeType: f.mimetype,
      sizeBytes: f.size, label, kind: kindOf(f.mimetype, f.originalname), attachmentType, notes,
      sortOrder: startOrder + i, storagePath: f.filename,
      uploadedById: req.user && req.user.id, uploadedByRole: 'DOCTOR'
    }}));
  }
  return out;
}
const include = { attachments: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }, patient: { select: { id:true, name:true, phone:true, email:true } }, doctor: { select: { id:true, name:true } } };
function notFound(){ const e = new Error('Historical record not found'); e.status = 404; return e; }
function unlinkQuiet(rel){ try { const p = path.join(UP_DIR, rel || ''); if (rel && fs.existsSync(p)) fs.unlinkSync(p); } catch(_){} }

// GET /doctor/patients/:patientId/previous-records
//
// SECURITY FIX (Patient Linking audit): this used to fetch every
// PreviousRecord for the patient with no doctorId filter at all, so a
// doctor viewing a shared patient's timeline saw every OTHER doctor's
// previous-record notes for that patient too (clinical notes, legacy
// patient details, attachments). previousRecord.doctorId scopes
// authorship, not the patient — the patient directory is intentionally
// shared clinic-wide (see doctor.controller.js#searchPatients), but each
// doctor's previous-record entries are private to that doctor, exactly
// like patientHistory() already enforces for appointments/prescriptions.
exports.listForPatient = asyncH(async (req, res) => {
  const rows = await prisma.previousRecord.findMany({
    where: { patientId: req.params.patientId, doctorId: req.user.id, deletedAt: null },
    orderBy: [{ recordDate: 'desc' }, { createdAt: 'desc' }], include
  });
  res.json({ success: true, records: rows.map(r => svc.decorateRecord(req, r)) });
});

// GET /doctor/previous-records
// -----------------------------------------------------------------
// v3.4.6 — Historical Records list for the doctor panel refactor.
// Returns every record this doctor has authored, with optional
// text search (patient name / diagnosis / notes / medications /
// treatment / title), date-range filter, recordType filter, and
// pagination. Legacy per-patient endpoint above is untouched so
// existing callers (patient history timeline) keep working.
// -----------------------------------------------------------------
exports.listAllForDoctor = asyncH(async (req, res) => {
  const q         = String(req.query.q || '').trim();
  const patientId = String(req.query.patientId || '').trim();
  const recordType= String(req.query.recordType || '').trim();
  const dateFrom  = String(req.query.dateFrom || '').trim();
  const dateTo    = String(req.query.dateTo   || '').trim();
  const page      = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const pageSize  = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '25', 10) || 25));

  const where = { doctorId: req.user.id, deletedAt: null };
  if (patientId) where.patientId = patientId;
  if (recordType) where.recordType = recordType;
  if (dateFrom || dateTo) {
    where.recordDate = {};
    if (dateFrom && /^\d{4}-\d{2}-\d{2}/.test(dateFrom)) where.recordDate.gte = new Date(dateFrom);
    if (dateTo   && /^\d{4}-\d{2}-\d{2}/.test(dateTo))   where.recordDate.lte = new Date(dateTo);
  }
  if (q) {
    where.OR = [
      { title:       { contains: q } },
      { diagnosis:   { contains: q } },
      { notes:       { contains: q } },
      { treatment:   { contains: q } },
      { medications: { contains: q } },
      { patient:     { name:  { contains: q } } },
      { patient:     { phone: { contains: q.replace(/\D/g, '') || q } } },
      { legacyPatientName:  { contains: q } },
      { legacyPatientPhone: { contains: q.replace(/\D/g, '') || q } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.previousRecord.count({ where }),
    prisma.previousRecord.findMany({
      where, include,
      orderBy: [{ recordDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize
    })
  ]);

  res.json({
    success: true,
    page, pageSize, total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    records: rows.map(r => svc.decorateRecord(req, r))
  });
});

// GET /doctor/previous-records/:id
//
// SECURITY FIX (Patient Linking audit — cross-doctor record access):
// this looked up the record by id alone, with no doctorId check. Every
// authenticated doctor account could open ANY other doctor's previous
// record — clinical notes, diagnosis, legacy-patient PII, attachments —
// simply by knowing/guessing its id. Scoping by doctorId here (and on
// every other :id-based handler below) makes a record 404 for anyone
// but the doctor who authored it, matching how listAllForDoctor() and
// patientHistory() already scope things.
exports.detail = asyncH(async (req, res) => {
  const r = await prisma.previousRecord.findFirst({ where: { id: req.params.id, doctorId: req.user.id, deletedAt: null }, include });
  if (!r) throw notFound();
  res.json({ success: true, record: svc.decorateRecord(req, r) });
});

// POST /doctor/patients/:patientId/previous-records
//
// IMPORTANT (v3.4.4): this handler does NOT mount its own multer
// middleware. The route already runs `multer.single('attachment')` (or
// `array('attachments', 20)` on the admin route) and writes the file
// paths to req.file / req.files. Re-running multer here would consume
// the body stream twice and silently drop files.
exports.create = asyncH(async (req, res) => {
  const data = parseBody(req, createSchema);
  const link = resolvePatientLink(data, req.params.patientId);
  const record = await prisma.previousRecord.create({ data: Object.assign({
    doctorId: req.user.id,
    title: data.title || null, recordType: data.recordType || 'OTHER',
    recordDate: data.recordDate ? new Date(data.recordDate) : new Date(),
    diagnosis: data.diagnosis || null, notes: data.notes || null,
    treatment: data.treatment || null, medications: data.medications || null,
  }, link)});
  await saveAttachments(req, record);
  const full = await prisma.previousRecord.findUnique({ where: { id: record.id }, include });
  res.status(201).json({ success: true, record: svc.decorateRecord(req, full) });
});

// PUT /doctor/previous-records/:id
exports.update = asyncH(async (req, res) => {
  // SECURITY FIX (Patient Linking audit): doctorId-scoped, see detail()
  // above — without this a doctor could edit, or re-link to a different
  // patient, a record they never created.
  const existing = await prisma.previousRecord.findFirst({ where: { id: req.params.id, doctorId: req.user.id, deletedAt: null } });
  if (!existing) throw notFound();
  const data = parseBody(req, updateSchema); // tolerant — fixes "Invalid Input"
  const patch = {};
  for (const k of ['title','recordType','diagnosis','notes','treatment','medications'])
    if (data[k] !== undefined) patch[k] = data[k] === '' ? null : data[k];
  if (data.recordDate) patch.recordDate = new Date(data.recordDate);
  // Only touch patient linkage if the edit form actually sent linkage
  // fields (patientSource, or a patientId, or legacy details) — the
  // Edit modal hides the picker for existing records, but the API
  // still supports re-linking so a mis-entered legacy record can later
  // be matched to a real directory patient (or vice-versa).
  if (data.patientSource !== undefined || data.patientId !== undefined || data.legacyPatientName !== undefined) {
    Object.assign(patch, resolvePatientLink(data, existing.patientId));
  }
  const record = await prisma.previousRecord.update({ where: { id: existing.id }, data: patch });
  await saveAttachments(req, record);
  const full = await prisma.previousRecord.findUnique({ where: { id: record.id }, include });
  res.json({ success: true, record: svc.decorateRecord(req, full) });
});

// DELETE /doctor/previous-records/:id (soft delete)
// SECURITY FIX (Patient Linking audit): doctorId-scoped — see detail().
exports.remove = asyncH(async (req, res) => {
  const existing = await prisma.previousRecord.findFirst({ where: { id: req.params.id, doctorId: req.user.id, deletedAt: null } });
  if (!existing) throw notFound();
  await prisma.previousRecord.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
  res.json({ success: true });
});

// POST /doctor/previous-records/:id/attachments
// SECURITY FIX (Patient Linking audit): doctorId-scoped — see detail().
exports.addAttachments = asyncH(async (req, res) => {
  const record = await prisma.previousRecord.findFirst({ where: { id: req.params.id, doctorId: req.user.id, deletedAt: null } });
  if (!record) throw notFound();
  const added = await saveAttachments(req, record);
  res.status(201).json({ success: true, attachments: added.map(a => ({ id: a.id, label: a.label, originalName: a.originalName })) });
});

// POST /doctor/previous-records/:id/attachments/:attachmentId/replace
// SECURITY FIX (Patient Linking audit): the attachment lookup only
// checked recordId, not who owns that record, so any doctor could
// overwrite another doctor's attachment file by id. Filtering through
// the `record` relation's doctorId closes that off, same as every
// other attachment endpoint below.
exports.replaceAttachment = [ upload.single('file'), asyncH(async (req, res) => {
  const att = await prisma.previousRecordAttachment.findFirst({ where: { id: req.params.attachmentId, recordId: req.params.id, record: { doctorId: req.user.id } } });
  if (!att) throw notFound();
  if (!req.file) { const e = new Error('file is required'); e.status = 422; throw e; }
  unlinkQuiet(att.storagePath);
  const label = (req.body.label || att.label || req.file.originalname).toString().slice(0,190);
  const attachmentType = req.body.attachmentType !== undefined
    ? (req.body.attachmentType ? String(req.body.attachmentType).slice(0,190) : null)
    : att.attachmentType;
  const notes = req.body.notes !== undefined
    ? (req.body.notes ? String(req.body.notes).slice(0,2000) : null)
    : att.notes;
  const updated = await prisma.previousRecordAttachment.update({ where: { id: att.id }, data: {
    filename: req.file.filename, originalName: req.file.originalname, mimeType: req.file.mimetype,
    sizeBytes: req.file.size, label, attachmentType, notes, kind: kindOf(req.file.mimetype, req.file.originalname), storagePath: req.file.filename
  }});
  res.json({ success: true, attachment: { id: updated.id, label: updated.label } });
})];

// PATCH /doctor/previous-records/:id/attachments/:attachmentId
// Rename / re-categorize / annotate an existing attachment WITHOUT
// touching the file itself — powers the Edit modal's inline "Rename"
// action so metadata changes never require a re-upload.
const attachmentMetaSchema = z.object({
  label: z.preprocess(emptyToUndef, z.string().max(190).optional()),
  attachmentType: z.preprocess(emptyToUndef, z.string().max(190).optional()),
  notes: z.preprocess((v) => (v === undefined ? undefined : (typeof v === 'string' && v.trim() === '' ? null : v)), z.string().max(2000).nullable().optional()),
}).strip();
// SECURITY FIX (Patient Linking audit): doctorId-scoped via the record
// relation — see replaceAttachment() above.
exports.updateAttachmentMeta = asyncH(async (req, res) => {
  const att = await prisma.previousRecordAttachment.findFirst({ where: { id: req.params.attachmentId, recordId: req.params.id, record: { doctorId: req.user.id } } });
  if (!att) throw notFound();
  const body = attachmentMetaSchema.safeParse(req.body || {});
  if (!body.success) { const e = new Error('Invalid input'); e.status = 422; throw e; }
  const data = body.data;
  const patch = {};
  if (data.label !== undefined) patch.label = data.label;
  if (data.attachmentType !== undefined) patch.attachmentType = data.attachmentType || null;
  if (data.notes !== undefined) patch.notes = data.notes;
  const updated = await prisma.previousRecordAttachment.update({ where: { id: att.id }, data: patch });
  res.json({ success: true, attachment: { id: updated.id, label: updated.label, attachmentType: updated.attachmentType, notes: updated.notes } });
});

// PATCH /doctor/previous-records/:id/attachments/reorder  { order: [attachmentId, ...] }
// Persists the doctor's drag/reorder of the attachment list. `order` must
// contain every attachment id currently on the record; sortOrder is set
// to each id's index in that array.
// SECURITY FIX (Patient Linking audit): doctorId-scoped — see detail().
exports.reorderAttachments = asyncH(async (req, res) => {
  const record = await prisma.previousRecord.findFirst({ where: { id: req.params.id, doctorId: req.user.id, deletedAt: null } });
  if (!record) throw notFound();
  const order = Array.isArray(req.body && req.body.order) ? req.body.order.map(String) : null;
  if (!order || !order.length) { const e = new Error('order[] is required'); e.status = 422; throw e; }
  const existing = await prisma.previousRecordAttachment.findMany({ where: { recordId: record.id }, select: { id: true } });
  const validIds = new Set(existing.map(a => a.id));
  const filtered = order.filter(id => validIds.has(id));
  await prisma.$transaction(filtered.map((id, i) =>
    prisma.previousRecordAttachment.update({ where: { id }, data: { sortOrder: i } })
  ));
  res.json({ success: true });
});

// DELETE /doctor/previous-records/:id/attachments/:attachmentId
// SECURITY FIX (Patient Linking audit): doctorId-scoped via the record
// relation — see replaceAttachment() above.
exports.deleteAttachment = asyncH(async (req, res) => {
  const att = await prisma.previousRecordAttachment.findFirst({ where: { id: req.params.attachmentId, recordId: req.params.id, record: { doctorId: req.user.id } } });
  if (!att) throw notFound();
  await prisma.previousRecordAttachment.delete({ where: { id: att.id } });
  unlinkQuiet(att.storagePath);
  res.json({ success: true });
});

// POST /doctor/previous-records/:id/generate-pdf
// SECURITY FIX (Patient Linking audit): doctorId-scoped — see detail().
exports.generatePdf = asyncH(async (req, res) => {
  const record = await prisma.previousRecord.findFirst({ where: { id: req.params.id, doctorId: req.user.id, deletedAt: null }, include });
  if (!record) throw notFound();
  const pdf = await pdfSvc.generateHistoricalRecordPdf(record);
  // Stream through the same signed-token route attachments use, not a
  // bare static path — see historical-record.service.js pdfShareUrl.
  const pdfUrl = svc.pdfShareUrl(req, record, pdf.filename);
  await prisma.previousRecord.update({ where: { id: record.id }, data: { pdfUrl, pdfGeneratedAt: new Date() } });
  res.json({ success: true, pdfUrl });
});

// POST /doctor/previous-records/:id/share  { channel, phone?, email?, attachmentIds? }
// SECURITY FIX (Patient Linking audit): doctorId-scoped — see detail().
// This one mattered most of all: unscoped, any doctor could trigger a
// WhatsApp/email share of another doctor's record — including to an
// attacker-supplied phone/email override — turning the IDOR into an
// active PII-exfiltration primitive, not just a read.
exports.share = asyncH(async (req, res) => {
  const record = await prisma.previousRecord.findFirst({ where: { id: req.params.id, doctorId: req.user.id, deletedAt: null }, include });
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
