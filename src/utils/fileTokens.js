/* =====================================================================
   fileTokens.js
   ---------------------------------------------------------------------
   Short-lived signed download tokens for protected media (prescriptions,
   invoices, etc.).

   Why this exists
   ---------------
   A plain <a href="…"> link cannot send an Authorization header, so we
   cannot rely on the normal Bearer-token middleware for browser-initiated
   downloads. Instead we mint a tightly scoped JWT and embed it in the
   URL as `?t=<token>`. The /api/files routes accept EITHER a normal
   Bearer token OR a valid signed download token; nothing on disk is
   served without one.

   Scope of a token
   ----------------
   A token is ONLY valid for ONE specific (kind, appointmentId, userId,
   role) tuple. So even if the URL leaks, it cannot be reused to access
   any other file, and it expires within minutes.
   ===================================================================== */
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';
// Keep download links short-lived. 15 min is plenty for a "click the
// link" UX while limiting blast radius if the URL leaks (e.g. into
// browser history or shared screenshots).
const DEFAULT_TTL_SEC = parseInt(process.env.FILE_TOKEN_TTL_SEC || '900', 10);

/**
 * Sign a download token for a specific file.
 * @param {Object} claims
 * @param {'prescription'|'invoice'} claims.kind   What kind of file.
 * @param {string} claims.appointmentId            Resource id (UUID).
 * @param {string} claims.userId                   Who requested it.
 * @param {string} claims.role                     'DOCTOR' | 'ADMIN' | 'PATIENT'.
 * @param {number} [ttlSec]                        Override expiry.
 */
function signDownloadToken(claims, ttlSec = DEFAULT_TTL_SEC) {
  if (!claims || !claims.kind || !claims.appointmentId) {
    throw new Error('signDownloadToken: kind and appointmentId are required');
  }
  return jwt.sign(
    {
      purpose: 'file',
      kind: claims.kind,
      appointmentId: claims.appointmentId,
      userId: claims.userId || null,
      role: claims.role || null
    },
    SECRET,
    { expiresIn: ttlSec }
  );
}

/**
 * Verify a download token and return its claims, or throw.
 * The caller MUST also confirm that the claims match the resource
 * being requested (kind + appointmentId from the URL path), otherwise
 * a token issued for file A could be used to read file B.
 */
function verifyDownloadToken(token) {
  const decoded = jwt.verify(token, SECRET);
  if (!decoded || decoded.purpose !== 'file') {
    const e = new Error('Invalid download token');
    e.statusCode = 401;
    throw e;
  }
  return decoded;
}

/**
 * Convenience: build a signed URL like
 *   /api/files/prescriptions/<apptId>.pdf?t=<jwt>
 * Returns null if any of the inputs is missing — callers can then keep
 * legacy null/undefined behaviour in API payloads.
 */
function buildSignedFileUrl({ kind, appointmentId, userId, role, ttlSec }) {
  if (!kind || !appointmentId) return null;
  const segment = kind === 'invoice' ? 'invoices' : 'prescriptions';
  const token = signDownloadToken({ kind, appointmentId, userId, role }, ttlSec);
  return `/api/files/${segment}/${appointmentId}.pdf?t=${token}`;
}

module.exports = {
  signDownloadToken,
  verifyDownloadToken,
  buildSignedFileUrl,
  DEFAULT_TTL_SEC
};