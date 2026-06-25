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

const uploadProfileImage = multer({
  storage: profileStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedImageTypes.has(file.mimetype)) {
      return cb(Object.assign(new Error('Only JPG, PNG, and WebP images are allowed'), { statusCode: 400 }));
    }
    cb(null, true);
  }
});

// ───── KYC documents (NEW) ─────
// Admin uploads four onboarding documents per doctor:
//   aadhaar, pan, cancelledCheque, medicalRegCert
// Accept images + PDF. 5MB per file. Each saved as {uuid}{ext} in storage/kyc-documents/.
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

const uploadKycDocuments = multer({
  storage: kycStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
  fileFilter: (req, file, cb) => {
    if (!allowedKycTypes.has(file.mimetype)) {
      return cb(Object.assign(
        new Error('Only JPG, PNG, WebP, or PDF files are allowed for KYC documents'),
        { statusCode: 400 }
      ));
    }
    cb(null, true);
  }
});

// Field config the controller will pass to .fields([...])
const KYC_FIELDS = [
  { name: 'aadhaar',         maxCount: 1 },
  { name: 'pan',             maxCount: 1 },
  { name: 'cancelledCheque', maxCount: 1 },
  { name: 'medicalRegCert',  maxCount: 1 }
];

module.exports = {
  uploadProfileImage,
  uploadKycDocuments,
  KYC_FIELDS
};
