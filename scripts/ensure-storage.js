/* =====================================================================
   ensure-storage.js
   ---------------------------------------------------------------------
   Make sure every storage subdirectory exists AND is writable for the
   current process. This stops the silent "EACCES: permission denied,
   open 'storage/prescriptions/prescription_<id>.pdf'" crash where the
   Prisma row was already created but the PDF write failed.

   Run modes
   ---------
     * Imported at server boot: just call `ensureStorageWritable()`.
       It logs and (best-effort) chmod's any subdir that isn't writable.
     * CLI:  node scripts/ensure-storage.js
       Same behaviour, exits non-zero on failure. Wire into npm scripts
       (`npm run postinstall` / `npm run prestart`) so dev environments
       can never reproduce the original bug.
   ===================================================================== */
const fs   = require('fs');
const path = require('path');

const STORAGE_ROOT = process.env.STORAGE_PATH ||
                     path.resolve(__dirname, '..', 'storage');

const SUBDIRS = [
  'prescriptions',
  'invoices',
  'profile-images',
  'kyc-documents'
];

const DIR_MODE = 0o755;

function info(msg, extra)  { console.log('[storage]', msg, extra || ''); }
function warn(msg, extra)  { console.warn('[storage]', msg, extra || ''); }
function error(msg, extra) { console.error('[storage]', msg, extra || ''); }

function ensureOne(dir) {
  // 1. create if missing
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    info('created', dir);
    return;
  }

  // 2. confirm we can write into it; if not, try chmod +rwx.
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (_) {
    warn('not writable, attempting chmod 0755:', dir);
    try {
      fs.chmodSync(dir, DIR_MODE);
      fs.accessSync(dir, fs.constants.W_OK);
      info('chmod succeeded:', dir);
    } catch (e) {
      error('FATAL: storage dir is not writable and chmod failed:', dir);
      throw new Error(
        `Storage directory is not writable: ${dir}. ` +
        `Run: chmod -R u+w "${STORAGE_ROOT}"`
      );
    }
  }
}

function ensureStorageWritable() {
  if (!fs.existsSync(STORAGE_ROOT)) {
    fs.mkdirSync(STORAGE_ROOT, { recursive: true, mode: DIR_MODE });
    info('created STORAGE_ROOT:', STORAGE_ROOT);
  }

  // Make sure the root itself is writable too.
  try {
    fs.accessSync(STORAGE_ROOT, fs.constants.W_OK);
  } catch (_) {
    try { fs.chmodSync(STORAGE_ROOT, DIR_MODE); } catch (_) {}
  }

  for (const sub of SUBDIRS) {
    ensureOne(path.join(STORAGE_ROOT, sub));
  }
  info('OK — all storage subdirectories are writable');
}

if (require.main === module) {
  try {
    ensureStorageWritable();
    process.exit(0);
  } catch (e) {
    error(e.message);
    process.exit(1);
  }
}

module.exports = { ensureStorageWritable, STORAGE_ROOT, SUBDIRS };