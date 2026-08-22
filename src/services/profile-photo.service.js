// Shared helpers for the profile-photo upload/remove pattern used by
// Doctor, Admin, Receptionist and Pharmacy accounts alike — one place to
// build the public URL and clean up the old file on disk, instead of
// four near-identical copies drifting apart over time.
const fs = require('fs');
const path = require('path');

const PUBLIC_BASE = () => process.env.PUBLIC_STORAGE_URL || '/files';
const STORAGE_ROOT = () => process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage');

function photoUrlFor(filename) {
  return `${PUBLIC_BASE()}/profile-images/${filename}`;
}

function resolveStoragePath(photoUrl) {
  return path.resolve(STORAGE_ROOT(), photoUrl.replace(`${PUBLIC_BASE()}/`, ''));
}

async function deleteOldPhoto(oldPhotoUrl) {
  if (!oldPhotoUrl) return;
  await fs.promises.unlink(resolveStoragePath(oldPhotoUrl)).catch(() => null);
}

module.exports = { photoUrlFor, deleteOldPhoto };
