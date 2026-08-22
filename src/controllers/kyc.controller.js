/* =====================================================================
   NeoKidsPro EMR — KYC controller
   ---------------------------------------------------------------------
   Admin-managed KYC document workflow.

   Documents accepted (all stored under storage/kyc-documents/):
     • Aadhaar Card           (field: aadhaar)
     • PAN Card               (field: pan)
     • Cancelled Cheque       (field: cancelledCheque)   — used for payouts
     • Medical Reg. Cert.     (field: medicalRegCert)    — MCI / state council

   Endpoints (mounted under /api/admin/doctors/:id/kyc):
     POST   /                 — upload / replace KYC files (multer.fields)
     GET    /                 — read KYC record for a doctor
     PATCH  /status           — VERIFIED | REJECTED (with rejectionReason?)

   Also exposes a read-only endpoint for the doctor panel (no file URLs).
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const notifications = require('../services/notification.service');

const STORAGE_ROOT  = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage'));
const KYC_DIR       = path.join(STORAGE_ROOT, 'kyc-documents');
const PUBLIC_PREFIX = (process.env.PUBLIC_STORAGE_URL || '/files') + '/kyc-documents';

const ALLOWED_STATUSES = new Set(['PENDING', 'UPLOADED', 'VERIFIED', 'REJECTED']);

/* ---------- helpers ---------- */

// Convert a stored public URL (e.g. "/files/kyc-documents/abc.pdf") back to an
// absolute disk path so we can unlink the old file when it's replaced.
function publicUrlToDiskPath(publicUrl) {
  if (!publicUrl) return null;
  const fname = path.basename(publicUrl);
  // Refuse to resolve outside KYC_DIR (defence in depth).
  const abs = path.join(KYC_DIR, fname);
  if (!abs.startsWith(KYC_DIR + path.sep)) return null;
  return abs;
}

function safeUnlink(absPath) {
  if (!absPath) return;
  fs.promises.unlink(absPath).catch(() => null);
}

function publicUrlForFile(filename) {
  return `${PUBLIC_PREFIX}/${filename}`;
}

async function assertDoctorExists(id) {
  const doc = await prisma.doctor.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true } });
  if (!doc) {
    const e = new Error('Doctor not found');
    e.statusCode = 404;
    throw e;
  }
  return doc;
}

/* =====================================================================
   POST /api/admin/doctors/:id/kyc
   Upload/replace any subset of the four KYC documents.
   Uses multer.fields([...]) — req.files is an object keyed by field name.
   ===================================================================== */
exports.uploadKyc = asyncHandler(async (req, res) => {
  const { id: doctorId } = req.params;
  await assertDoctorExists(doctorId);

  const files = req.files || {};
  const uploadedAny =
    files.aadhaar || files.pan || files.cancelledCheque || files.medicalRegCert;
  if (!uploadedAny) {
    return res.status(400).json({ error: 'No KYC files received. Attach at least one of: aadhaar, pan, cancelledCheque, medicalRegCert.' });
  }

  // Existing record (may be null on first upload)
  const existing = await prisma.doctorKyc.findUnique({ where: { doctorId } });

  // Build patch + collect old files to delete
  const patch = {};
  const oldFilesToDelete = [];

  function applyField(fieldName, dbColumn) {
    const f = files[fieldName] && files[fieldName][0];
    if (!f) return;
    if (existing && existing[dbColumn]) {
      oldFilesToDelete.push(publicUrlToDiskPath(existing[dbColumn]));
    }
    patch[dbColumn] = publicUrlForFile(f.filename);
  }
  applyField('aadhaar',         'aadhaarUrl');
  applyField('pan',             'panUrl');
  applyField('cancelledCheque', 'cancelledChequeUrl');
  applyField('medicalRegCert',  'medicalRegCertUrl');

  // Status logic:
  // - If record was VERIFIED and admin re-uploads ANY document, drop back to UPLOADED
  //   (re-verification required). This is the safer audit posture.
  // - If it was REJECTED, treat new uploads as a fresh attempt → UPLOADED.
  // - Otherwise: PENDING → UPLOADED.
  // - Always clear rejectionReason / verifiedAt / verifiedById on a fresh upload.
  patch.kycStatus = 'UPLOADED';
  patch.rejectionReason = null;
  patch.verifiedAt = null;
  patch.verifiedById = null;

  const saved = await prisma.doctorKyc.upsert({
    where:  { doctorId },
    update: patch,
    create: { doctorId, ...patch }
  });

  // Best-effort cleanup of replaced files
  oldFilesToDelete.forEach(safeUnlink);

  res.status(existing ? 200 : 201).json(saved);
});

/* =====================================================================
   GET /api/admin/doctors/:id/kyc
   Return the full KYC record (including file URLs) for the admin panel.
   ===================================================================== */
exports.getKyc = asyncHandler(async (req, res) => {
  const { id: doctorId } = req.params;
  await assertDoctorExists(doctorId);

  const kyc = await prisma.doctorKyc.findUnique({ where: { doctorId } });
  if (!kyc) {
    // Return a stable "empty" shape so the UI doesn't need a 404 branch.
    return res.json({
      doctorId,
      aadhaarUrl: null,
      panUrl: null,
      cancelledChequeUrl: null,
      medicalRegCertUrl: null,
      kycStatus: 'PENDING',
      rejectionReason: null,
      verifiedAt: null,
      verifiedById: null,
      createdAt: null,
      updatedAt: null
    });
  }
  res.json(kyc);
});

/* =====================================================================
   PATCH /api/admin/doctors/:id/kyc/status
   Body: { status: 'VERIFIED' | 'REJECTED', rejectionReason?: string }
   ===================================================================== */
exports.updateKycStatus = asyncHandler(async (req, res) => {
  const { id: doctorId } = req.params;
  const { status, rejectionReason } = req.body || {};

  const doctor = await assertDoctorExists(doctorId);

  if (!ALLOWED_STATUSES.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...ALLOWED_STATUSES].join(', ')}` });
  }
  if (status === 'REJECTED' && !(rejectionReason && String(rejectionReason).trim())) {
    return res.status(400).json({ error: 'rejectionReason is required when status is REJECTED' });
  }

  const existing = await prisma.doctorKyc.findUnique({ where: { doctorId } });
  if (!existing) {
    return res.status(404).json({ error: 'No KYC record exists for this doctor yet. Upload documents first.' });
  }

  // Block VERIFIED if all four mandatory documents aren't present.
  if (status === 'VERIFIED') {
    const missing = [];
    if (!existing.aadhaarUrl)         missing.push('Aadhaar');
    if (!existing.panUrl)             missing.push('PAN');
    if (!existing.cancelledChequeUrl) missing.push('Cancelled Cheque');
    if (!existing.medicalRegCertUrl)  missing.push('Medical Registration Certificate');
    if (missing.length) {
      return res.status(400).json({ error: `Cannot mark VERIFIED — missing documents: ${missing.join(', ')}` });
    }
  }

  const patch = {
    kycStatus: status,
    rejectionReason: status === 'REJECTED' ? String(rejectionReason).trim() : null,
    verifiedAt:      status === 'VERIFIED' ? new Date() : null,
    verifiedById:    status === 'VERIFIED' ? (req.user && req.user.id) || null : null
  };

  const updated = await prisma.doctorKyc.update({
    where: { doctorId },
    data:  patch
  });

  await notifications.create({
    userType: 'DOCTOR', userId: doctorId,
    type: status === 'VERIFIED' ? 'KYC_VERIFIED' : 'KYC_REJECTED',
    title: status === 'VERIFIED' ? 'KYC verified' : 'KYC rejected',
    message: status === 'VERIFIED'
      ? 'Your KYC documents have been verified by the admin.'
      : `Your KYC was rejected: ${patch.rejectionReason}`,
    entityType: 'DOCTOR_KYC', entityId: doctorId
  }).catch(() => {});

  res.json(updated);
});

/* =====================================================================
   GET /api/doctor/kyc — Doctor self-view (NO file URLs returned).
   Mounted in doctor.routes.js. Lets the doctor see their KYC status,
   verifiedAt timestamp, and any rejection reason from the admin.
   ===================================================================== */
exports.myKycStatus = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const kyc = await prisma.doctorKyc.findUnique({
    where: { doctorId },
    select: {
      kycStatus: true,
      rejectionReason: true,
      verifiedAt: true,
      // Booleans only — never expose file URLs to the doctor.
      aadhaarUrl: true,
      panUrl: true,
      cancelledChequeUrl: true,
      medicalRegCertUrl: true,
      updatedAt: true
    }
  });

  if (!kyc) {
    return res.json({
      kycStatus: 'PENDING',
      rejectionReason: null,
      verifiedAt: null,
      documents: { aadhaar: false, pan: false, cancelledCheque: false, medicalRegCert: false },
      updatedAt: null
    });
  }

  res.json({
    kycStatus: kyc.kycStatus,
    rejectionReason: kyc.rejectionReason,
    verifiedAt: kyc.verifiedAt,
    documents: {
      aadhaar:         !!kyc.aadhaarUrl,
      pan:             !!kyc.panUrl,
      cancelledCheque: !!kyc.cancelledChequeUrl,
      medicalRegCert:  !!kyc.medicalRegCertUrl
    },
    updatedAt: kyc.updatedAt
  });
});

/* =====================================================================
   GET /api/admin/kyc/:doctorId/:kind   (audit finding #2)
   Streams ONE KYC document (aadhaar | pan | cancelledCheque |
   medicalRegCert) to an authenticated ADMIN. This replaces the removed
   public express.static mount on /files/kyc-documents: KYC identity
   documents are now readable ONLY with an admin JWT, and the filename
   is resolved strictly inside KYC_DIR (path-traversal safe).
   ===================================================================== */
const KYC_KIND_TO_COLUMN = {
  aadhaar:         'aadhaarUrl',
  pan:             'panUrl',
  cancelledCheque: 'cancelledChequeUrl',
  medicalRegCert:  'medicalRegCertUrl'
};

exports.streamKycDocument = asyncHandler(async (req, res) => {
  const { doctorId, kind } = req.params;
  const column = KYC_KIND_TO_COLUMN[kind];
  if (!column) return res.status(400).json({ error: 'Invalid KYC document kind' });

  const kyc = await prisma.doctorKyc.findUnique({
    where: { doctorId },
    select: { [column]: true }
  });
  const stored = kyc && kyc[column];
  if (!stored) return res.status(404).json({ error: 'Document not found' });

  const disk = publicUrlToDiskPath(stored);
  if (!disk || !fs.existsSync(disk)) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const ext = path.extname(disk).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf'
             : ext === '.png' ? 'image/png'
             : ext === '.webp' ? 'image/webp'
             : 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${kind}_${doctorId}${ext}"`);
  // Identity documents must never be cached by browsers or intermediaries.
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  fs.createReadStream(disk).pipe(res);
});
