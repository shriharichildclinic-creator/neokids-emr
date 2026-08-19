const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { randomUUID } = require('crypto');

const storageRoot = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage'));

// ───── profile images (unchanged) ─────
const profileDir = path.join(storageRoot, 'profile-images');
fs.mkdirSync(profileDir, { recursive: true });

const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, profileDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${randomUUID()}${ext}`);
  }
});

const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

const allowedProfileExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const uploadProfileImage = multer({
  storage: profileStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedImageTypes.has(file.mimetype)) {
      return cb(Object.assign(new Error('Only JPG, PNG, and WebP images are allowed'), { statusCode: 400 }));
    }
    // Defence in depth: mimetype is client-supplied, so also whitelist
    // the extension that lands on disk.
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedProfileExts.has(ext)) {
      return cb(Object.assign(new Error('Only .jpg, .jpeg, .png, .webp files are allowed'), { statusCode: 400 }));
    }
    cb(null, true);
  }
});

// ───── KYC documents (unchanged) ─────
const kycDir = path.join(storageRoot, 'kyc-documents');
fs.mkdirSync(kycDir, { recursive: true });

const kycStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, kycDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
    cb(null, `${randomUUID()}${ext}`);
  }
});

const allowedKycTypes = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'application/pdf'
]);

const allowedKycExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

const uploadKycDocuments = multer({
  storage: kycStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedKycTypes.has(file.mimetype)) {
      return cb(Object.assign(
        new Error('Only JPG, PNG, WebP, or PDF files are allowed for KYC documents'),
        { statusCode: 400 }
      ));
    }
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedKycExts.has(ext)) {
      return cb(Object.assign(
        new Error('Only .jpg, .jpeg, .png, .webp, .pdf files are allowed for KYC documents'),
        { statusCode: 400 }
      ));
    }
    cb(null, true);
  }
});

const KYC_FIELDS = [
  { name: 'aadhaar',         maxCount: 1 },
  { name: 'pan',             maxCount: 1 },
  { name: 'cancelledCheque', maxCount: 1 },
  { name: 'medicalRegCert',  maxCount: 1 }
];

// ───── Feature 3 — Doctor digital signature ─────
// PNG (transparent PNG preferred). Max 1 MB. Stored in
// storage/signatures/<uuid>.<ext>. The stored URL is served through the
// same signed-file mechanism as the other private assets so a stray
// signature file can't be linked publicly.
const signatureDir = path.join(storageRoot, 'signatures');
fs.mkdirSync(signatureDir, { recursive: true });

const signatureStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, signatureDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
    cb(null, `${randomUUID()}${ext}`);
  }
});

// Signatures MUST be PNG (transparent PNG preferred). We also accept
// JPEG as a fallback for doctors who don't have a transparent asset.
const allowedSignatureTypes = new Set(['image/png', 'image/jpeg']);

const allowedSignatureExts = new Set(['.png', '.jpg', '.jpeg']);

const uploadSignature = multer({
  storage: signatureStorage,
  limits: { fileSize: 1 * 1024 * 1024 }, // 1 MB
  fileFilter: (req, file, cb) => {
    if (!allowedSignatureTypes.has(file.mimetype)) {
      return cb(Object.assign(
        new Error('Only PNG (transparent preferred) or JPEG images are allowed for signatures'),
        { statusCode: 400 }
      ));
    }
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedSignatureExts.has(ext)) {
      return cb(Object.assign(
        new Error('Only .png, .jpg, .jpeg files are allowed for signatures'),
        { statusCode: 400 }
      ));
    }
    cb(null, true);
  }
});

// ───── Feature 1 — Manual/Historical prescription uploads ─────
// PDF, JPG or PNG. Max 5 MB. Stored in storage/historical-rx/.
const historicalRxDir = path.join(storageRoot, 'historical-rx');
fs.mkdirSync(historicalRxDir, { recursive: true });

const historicalRxStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, historicalRxDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
    cb(null, `${randomUUID()}${ext}`);
  }
});

const allowedHistoricalRxTypes = new Set([
  'image/jpeg', 'image/png', 'application/pdf'
]);

const allowedHistoricalRxExts = new Set(['.jpg', '.jpeg', '.png', '.pdf']);

const uploadHistoricalPrescription = multer({
  storage: historicalRxStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedHistoricalRxTypes.has(file.mimetype)) {
      return cb(Object.assign(
        new Error('Only PDF, JPG, or PNG files are allowed for historical prescriptions'),
        { statusCode: 400 }
      ));
    }
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedHistoricalRxExts.has(ext)) {
      return cb(Object.assign(
        new Error('Only .pdf, .jpg, .jpeg, .png files are allowed for historical prescriptions'),
        { statusCode: 400 }
      ));
    }
    cb(null, true);
  }
});

module.exports = {
  uploadProfileImage,
  uploadKycDocuments,
  KYC_FIELDS,
  uploadSignature,
  uploadHistoricalPrescription
};
