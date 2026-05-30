const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { randomUUID } = require('crypto');

const storageRoot = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage'));
const profileDir = path.join(storageRoot, 'profile-images');
fs.mkdirSync(profileDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, profileDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${randomUUID()}${ext}`);
  }
});

const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

const uploadProfileImage = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedTypes.has(file.mimetype)) {
      return cb(Object.assign(new Error('Only JPG, PNG, and WebP images are allowed'), { statusCode: 400 }));
    }
    cb(null, true);
  }
});

module.exports = { uploadProfileImage };
