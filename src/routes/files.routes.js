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

module.exports = router;