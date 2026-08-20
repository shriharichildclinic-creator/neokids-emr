 /*=====================================================================
   files.routes.js
   ---------------------------------------------------------------------
   Authenticated downloads for prescription / invoice / settlement PDFs.

   These used to be served by `express.static('storage/')` mounted at
   /files, which meant anyone who guessed a UUID could pull a medical
   record. That mount is GONE for the `prescriptions` and `invoices`
   subdirectories — the only way to read those files now is through the
   handlers below.

   Auth model
   ----------
   A request is allowed if EITHER of the following holds:
     1. It carries a valid Bearer JWT (the normal staff session) AND
        the caller is authorised to read that specific resource.
     2. It carries a `?t=<download-token>` whose claims match the URL
        (same kind + appointmentId).

   For (1), ownership rules are:
     * DOCTOR can read prescriptions / invoices on appointments where
       `appointment.doctorId === req.user.id`.
     * ADMIN can read any.
     * Other roles → 403.

   For (2) we also enforce that the requested file path matches the
   token's scope, so a token issued for one file cannot be reused for
   another.
   ===================================================================== */
const fs   = require('fs');
const path = require('path');
const express = require('express');

const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');
const { verifyToken } = require('../middleware/auth');
const { verifyDownloadToken } = require('../utils/fileTokens');

const STORAGE = process.env.STORAGE_PATH ||
                path.resolve(__dirname, '..', '..', 'storage');

const router = express.Router();

/* ─────────────────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────────────────── */

// Strict UUID v1-v5 pattern. Refuses anything with `/`, `..`, etc.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeAppointmentId(raw) {
  if (typeof raw !== 'string') return null;
  // Strip trailing .pdf if the caller passed the full filename.
  const id = raw.replace(/\.pdf$/i, '');
  return UUID_RE.test(id) ? id : null;
}

// Decode whichever credential is on the request (Bearer or `?t=`).
// Returns one of:
//   { mode: 'bearer', user: { id, role } }
//   { mode: 'fileToken', claims: { kind, appointmentId, userId, role } }
//   null  (no credential)
function readCredential(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(header.slice(7));
      return { mode: 'bearer', user: payload };
    } catch (_) { /* fall through */ }
  }
  const tokenStr = req.query && req.query.t;
  if (typeof tokenStr === 'string' && tokenStr.length) {
    try {
      const claims = verifyDownloadToken(tokenStr);
      return { mode: 'fileToken', claims };
    } catch (_) { /* fall through */ }
  }
  return null;
}

// Given a credential, decide if the caller is allowed to read this
// specific resource. Returns true/false; does NOT leak details.
async function isAllowed(cred, kind, appointmentId) {
  if (!cred) return false;

  if (cred.mode === 'fileToken') {
    // The token's own claims must exactly match the requested file.
    return cred.claims.kind === kind &&
           cred.claims.appointmentId === appointmentId;
  }

  // Bearer mode — load the appointment and apply RBAC.
  const role = cred.user && cred.user.role;
  if (role === 'ADMIN') return true;

  if (role === 'DOCTOR') {
    const owns = await prisma.appointment.findFirst({
      where: { id: appointmentId, doctorId: cred.user.id },
      select: { id: true }
    });
    return !!owns;
  }

  // v4.0.0 — receptionist access is scoped to their assigned doctors; a
  // pharmacy-invoice additionally requires the canManagePharmacy toggle.
  if (role === 'RECEPTIONIST') {
    if (kind === 'consultation-invoice') {
      const inv = await prisma.consultationInvoice.findUnique({
        where: { id: appointmentId },
        select: { receptionistId: true, doctorId: true }
      });
      if (!inv) return false;
      if (inv.receptionistId === cred.user.id) return true;
      const asn = await prisma.receptionistAssignment.findFirst({
        where: { receptionistId: cred.user.id, doctorId: inv.doctorId },
        select: { id: true }
      });
      return !!asn;
    }
    if (kind === 'pharmacy-invoice') {
      const rec = await prisma.receptionist.findFirst({
        where: { id: cred.user.id, deletedAt: null },
        select: { canManagePharmacy: true }
      });
      return !!rec && rec.canManagePharmacy;
    }
    if (kind === 'certificate') {
      const cert = await prisma.medicalCertificate.findUnique({
        where: { id: appointmentId },
        select: { doctorId: true, issuedById: true, issuedByRole: true }
      });
      if (!cert) return false;
      if (cert.issuedByRole === 'RECEPTIONIST' && cert.issuedById === cred.user.id) return true;
      const asn = await prisma.receptionistAssignment.findFirst({
        where: { receptionistId: cred.user.id, doctorId: cert.doctorId },
        select: { id: true }
      });
      return !!asn;
    }
    const appt = await prisma.appointment.findFirst({
      where: { id: appointmentId },
      select: { doctorId: true }
    });
    if (!appt) return false;
    const asn = await prisma.receptionistAssignment.findFirst({
      where: { receptionistId: cred.user.id, doctorId: appt.doctorId },
      select: { id: true }
    });
    return !!asn;
  }

  if (role === 'PHARMACY') {
    if (kind !== 'pharmacy-invoice') return false;
    const bill = await prisma.pharmacyBill.findUnique({
      where: { id: appointmentId },
      select: { medicalCentreId: true }
    });
    if (!bill) return false;
    if (!bill.medicalCentreId) return true;
    const pu = await prisma.pharmacyUser.findFirst({
      where: { id: cred.user.id, deletedAt: null },
      select: { medicalCentreId: true }
    });
    return !!pu && pu.medicalCentreId === bill.medicalCentreId;
  }

  return false;
}

// Stream a file to the response, generating a download filename.
function sendPdf(res, filepath, downloadName) {
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  // Inline so PDF viewers can open in a new tab; `download` query toggles.
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${downloadName}"`
  );
  // Don't let intermediaries cache medical data.
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  fs.createReadStream(filepath).pipe(res);
}

// Lazily regenerate the PDF if it is missing on disk (e.g. ephemeral
// disk on redeploy). Returns true if the file is now present.
async function ensurePrescriptionPdf(appointmentId) {
  const pdfSvc = require('../services/pdf.service');
  const fp = path.join(STORAGE, 'prescriptions', `prescription_${appointmentId}.pdf`);
  if (fs.existsSync(fp)) return true;
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true, doctor: true, prescription: true }
  });
  if (!appt || !appt.prescription) return false;
  try {
    await pdfSvc.generatePrescription(appt, appt.prescription);
    return fs.existsSync(fp);
  } catch (e) {
    logger.error('ensurePrescriptionPdf failed', { appointmentId, err: e.message });
    return false;
  }
}

async function ensureInvoicePdf(appointmentId) {
  const pdfSvc = require('../services/pdf.service');
  const fp = path.join(STORAGE, 'invoices', `invoice_${appointmentId}.pdf`);
  if (fs.existsSync(fp)) return true;
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true, doctor: true }
  });
  if (!appt) return false;
  try {
    await pdfSvc.generateInvoice(appt);
    return fs.existsSync(fp);
  } catch (e) {
    logger.error('ensureInvoicePdf failed', { appointmentId, err: e.message });
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────
   GET /api/files/prescriptions/:idAndExt   (e.g. <uuid>.pdf)
   ───────────────────────────────────────────────────────────────────── */
router.get('/prescriptions/:idAndExt', asyncHandler(async (req, res) => {
  const apptId = safeAppointmentId(req.params.idAndExt);
  if (!apptId) return res.status(400).json({ error: 'Invalid file id' });

  const cred = readCredential(req);
  const allowed = await isAllowed(cred, 'prescription', apptId);
  if (!allowed) return res.status(401).json({ error: 'Authentication required' });

  const ok = await ensurePrescriptionPdf(apptId);
  if (!ok) return res.status(404).json({ error: 'Prescription not found' });

  const filepath = path.join(STORAGE, 'prescriptions', `prescription_${apptId}.pdf`);
  return sendPdf(res, filepath, `prescription_${apptId}.pdf`);
}));

/* ─────────────────────────────────────────────────────────────────────
   GET /api/files/invoices/:idAndExt
   ───────────────────────────────────────────────────────────────────── */
router.get('/invoices/:idAndExt', asyncHandler(async (req, res) => {
  const apptId = safeAppointmentId(req.params.idAndExt);
  if (!apptId) return res.status(400).json({ error: 'Invalid file id' });

  const cred = readCredential(req);
  const allowed = await isAllowed(cred, 'invoice', apptId);
  if (!allowed) return res.status(401).json({ error: 'Authentication required' });

  const ok = await ensureInvoicePdf(apptId);
  if (!ok) return res.status(404).json({ error: 'Invoice not found' });

  const filepath = path.join(STORAGE, 'invoices', `invoice_${apptId}.pdf`);
  return sendPdf(res, filepath, `invoice_${apptId}.pdf`);
}));


/* ─────────────────────────────────────────────────────────────────────
   GET /api/files/certificates/:idAndExt   (Feature 2)
   Streams a generated medical certificate PDF. Bearer (doctor/admin)
   or signed download token.
   ───────────────────────────────────────────────────────────────────── */
router.get('/certificates/:idAndExt', asyncHandler(async (req, res) => {
  const rawId = String(req.params.idAndExt || '').replace(/\.pdf$/i, '');
  if (!UUID_RE.test(rawId)) {
    return res.status(400).json({ error: 'Invalid certificate id' });
  }

  const cred = readCredential(req);
  if (!cred) return res.status(401).json({ error: 'Authentication required' });

  // Load certificate to enforce ownership.
  const cert = await prisma.medicalCertificate.findUnique({
    where: { id: rawId },
    select: { id: true, doctorId: true, patientId: true }
  });
  if (!cert) return res.status(404).json({ error: 'Certificate not found' });

  let allowed = false;
  if (cred.mode === 'fileToken') {
    allowed = cred.claims.kind === 'certificate' &&
              cred.claims.appointmentId === rawId;
  } else {
    const role = cred.user && cred.user.role;
    if (role === 'ADMIN') allowed = true;
    if (role === 'DOCTOR' && cred.user.id === cert.doctorId) allowed = true;
  }
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  // Lazily generate if the PDF is missing (ephemeral disk).
  const filepath = path.join(STORAGE, 'certificates', `certificate_${rawId}.pdf`);
  if (!fs.existsSync(filepath)) {
    try {
      const full = await prisma.medicalCertificate.findUnique({
        where: { id: rawId },
        include: { doctor: true, patient: true }
      });
      if (full) {
        const pdfSvc = require('../services/pdf.service');
        await pdfSvc.generateMedicalCertificate({
          certificate: full, doctor: full.doctor, patient: full.patient
        });
      }
    } catch (e) {
      logger.error('certificate regenerate failed', { id: rawId, err: e.message });
    }
  }
  return sendPdf(res, filepath, `certificate_${rawId}.pdf`);
}));

/* ─────────────────────────────────────────────────────────────────────
   GET /api/files/historical-rx/:filename   (Feature 1)
   Streams an uploaded historical prescription (PDF/JPG/PNG).
   Bearer (doctor who owns the appointment, or admin) or signed token.
   ───────────────────────────────────────────────────────────────────── */
router.get('/historical-rx/:filename', asyncHandler(async (req, res) => {
  const fname = path.basename(String(req.params.filename || ''));
  // Allow only safe filenames (uuid + ext).
  if (!/^[0-9a-f-]{36}\.(pdf|jpg|jpeg|png)$/i.test(fname)) {
    return res.status(400).json({ error: 'Invalid file id' });
  }

  const cred = readCredential(req);
  if (!cred) return res.status(401).json({ error: 'Authentication required' });

  // Find which appointment references this file.
  const rel = `/files/historical-rx/${fname}`;
  const appt = await prisma.appointment.findFirst({
    where: { manualPrescriptionUrl: rel },
    select: { id: true, doctorId: true }
  });
  if (!appt) return res.status(404).json({ error: 'File not found' });

  let allowed = false;
  if (cred.mode === 'fileToken') {
    allowed = cred.claims.kind === 'historical-rx' &&
              cred.claims.appointmentId === appt.id;
  } else {
    const role = cred.user && cred.user.role;
    if (role === 'ADMIN') allowed = true;
    if (role === 'DOCTOR' && cred.user.id === appt.doctorId) allowed = true;
  }
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  const filepath = path.join(STORAGE, 'historical-rx', fname);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const ext = fname.split('.').pop().toLowerCase();
  const mime = ext === 'pdf' ? 'application/pdf'
             : ext === 'png' ? 'image/png'
             : 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  fs.createReadStream(filepath).pipe(res);
}));

/* ─────────────────────────────────────────────────────────────────────
   GET /api/files/previous-records/:id   (Historical Records attachment)
   The signed URL for a PreviousRecord attachment (built in
   previous.controller.js / fileTokens.js) points here using the
   record's own id. This route was previously missing entirely, which
   is why opening/downloading a linked attachment 404'd with
   { "error": "Not Found", "code": "NOT_FOUND" } even though the file
   was correctly saved to storage/historical-rx/.
   ───────────────────────────────────────────────────────────────────── */
router.get('/previous-records/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').replace(/\.(pdf|jpg|jpeg|png)$/i, '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid file id' });

  const cred = readCredential(req);
  if (!cred) return res.status(401).json({ error: 'Authentication required' });

  const record = await prisma.previousRecord.findUnique({
    where: { id },
    select: { id: true, doctorId: true, attachmentUrl: true }
  });
  if (!record || !record.attachmentUrl) {
    return res.status(404).json({ error: 'File not found' });
  }

  let allowed = false;
  if (cred.mode === 'fileToken') {
    allowed = cred.claims.kind === 'previous-record' &&
              cred.claims.appointmentId === id;
  } else {
    const role = cred.user && cred.user.role;
    if (role === 'ADMIN') allowed = true;
    if (role === 'DOCTOR' && cred.user.id === record.doctorId) allowed = true;
  }
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  const filename = path.basename(record.attachmentUrl);
  const filepath = path.join(STORAGE, 'historical-rx', filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = filename.split('.').pop().toLowerCase();
  const mime = ext === 'pdf' ? 'application/pdf'
             : ext === 'png' ? 'image/png'
             : 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  fs.createReadStream(filepath).pipe(res);
}));

/* ─────────────────────────────────────────────────────────────────────
   GET /api/files/consultation-invoices/:idAndExt   (v4.0.0)
   Receptionist-issued consultation invoice PDFs.
   ───────────────────────────────────────────────────────────────────── */
router.get('/consultation-invoices/:idAndExt', asyncHandler(async (req, res) => {
  const id = String(req.params.idAndExt || '').replace(/\.pdf$/i, '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid invoice id' });

  const cred = readCredential(req);
  const allowed = await isAllowed(cred, 'consultation-invoice', id);
  if (!allowed) return res.status(401).json({ error: 'Authentication required' });

  const filepath = path.join(STORAGE, 'invoices', `consultation_invoice_${id}.pdf`);
  if (!fs.existsSync(filepath)) {
    try {
      const staffDocs = require('../services/staff-docs.service');
      await staffDocs.generateAndStoreInvoicePdf(id, null);
    } catch (e) {
      logger.error('consultation invoice regenerate failed', { id, err: e.message });
    }
  }
  return sendPdf(res, filepath, `consultation_invoice_${id}.pdf`);
}));

/* ─────────────────────────────────────────────────────────────────────
   GET /api/files/pharmacy-invoices/:idAndExt   (v4.0.0)
   Pharmacy bill PDFs.
   ───────────────────────────────────────────────────────────────────── */
router.get('/pharmacy-invoices/:idAndExt', asyncHandler(async (req, res) => {
  const id = String(req.params.idAndExt || '').replace(/\.pdf$/i, '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid bill id' });

  const cred = readCredential(req);
  const allowed = await isAllowed(cred, 'pharmacy-invoice', id);
  if (!allowed) return res.status(401).json({ error: 'Authentication required' });

  const filepath = path.join(STORAGE, 'pharmacy-invoices', `pharmacy_invoice_${id}.pdf`);
  if (!fs.existsSync(filepath)) {
    try {
      const staffDocs = require('../services/staff-docs.service');
      await staffDocs.generateAndStoreBillPdf(id, null);
    } catch (e) {
      logger.error('pharmacy invoice regenerate failed', { id, err: e.message });
    }
  }
  return sendPdf(res, filepath, `pharmacy_invoice_${id}.pdf`);
}));


// v3.4.3 public signed share links (WhatsApp / Email)
const histSvc = require('../services/historical-record.service');
const prismaShare = require('../config/prisma');
const fsShare = require('fs');
const pathShare = require('path');

router.get('/share/:token', asyncHandler(async (req, res) => {
  const p = histSvc.verify(req.params.token);
  if (!p) return res.status(403).json({ error: 'Invalid or expired link' });
  let fp, mime, name;
  if (p.t === 'att') {
    fp = pathShare.join(histSvc.STORAGE_PATH, 'historical-rx', p.p);
    mime = histSvc.resolveMime(p.m, p.n);
    name = p.n || 'file';
  } else if (p.t === 'pdf') {
    // Generated record-summary PDF — see historical-record.service.js pdfShareUrl.
    fp = pathShare.join(histSvc.STORAGE_PATH, 'historical-pdf', p.fn);
    mime = 'application/pdf';
    name = p.fn || 'record.pdf';
  } else {
    return res.status(403).json({ error: 'Invalid or expired link' });
  }
  if (!fsShare.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Content-Disposition', (req.query.dl === '1' ? 'attachment' : 'inline') + '; filename="' + String(name).replace(/"/g, '') + '"');
  fsShare.createReadStream(fp).pipe(res);
}));

router.get('/share-record/:token', asyncHandler(async (req, res) => {
  const p = histSvc.verify(req.params.token);
  if (!p || p.t !== 'rec') return res.status(403).json({ error: 'Invalid or expired link' });
  const r = await prismaShare.previousRecord.findFirst({ where: { id: p.id, deletedAt: null }, include: { attachments: true, patient: { select: { name: true } } } });
  if (!r) return res.status(404).json({ error: 'Record not found' });
  const rows = r.attachments.map(a => {
    const t = histSvc.attachmentToken(a);
    return '<li>' + (a.label || a.originalName) + ' - <a href="/api/files/share/' + t + '?dl=0" target="_blank">Preview</a> | <a href="/api/files/share/' + t + '?dl=1">Download</a></li>';
  }).join('');
  const pdf = r.pdfUrl ? '<p><a href="' + r.pdfUrl + '" target="_blank">View Record Summary PDF</a></p>' : '';
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.send('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Medical Record - NeoKidsPro</title></head><body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 16px"><h2>Medical Record Shared</h2><p><b>Patient:</b> ' + (r.patient ? r.patient.name : '') + '<br/><b>Record:</b> ' + (r.title || r.recordType || 'Historical Record') + '<br/><b>Date:</b> ' + new Date(r.recordDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + '</p>' + pdf + '<h3>Attachments</h3><ul>' + (rows || '<li>No attachments</li>') + '</ul><p style="color:#777;font-size:12px">Secure link - expires in 7 days. NeoKidsPro EMR.</p></body></html>');
}));

module.exports = router;