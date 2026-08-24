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
const crypto = require('crypto');

// Deliberately NOT the same secret as session/login JWTs (JWT_SECRET,
// signed in middleware/auth.js). Both are plain HS256 JWTs verified with
// jsonwebtoken, and middleware/auth.js's authenticate() accepts ANY
// token that verifies against JWT_SECRET as a Bearer session — it has no
// way to know a token was actually minted here for one file, not as a
// login session. A download-token payload has no `id` claim (only
// `userId`), so if it were accepted as a Bearer token, req.user.id would
// be `undefined` in every controller — and Prisma silently drops an
// `undefined` value from a `where` filter, turning every
// "scope to my own records" query (e.g. `where: { doctorId: req.user.id }`)
// into "every doctor's records", plus letting the token's `role` claim
// satisfy requireRole() checks it was never meant to pass. Using a
// distinct secret means a signed download token's signature never
// validates against JWT_SECRET (and a login token's never validates
// against this one), so each kind of token only works the one way it
// was minted for. FILE_TOKEN_SECRET can be set explicitly; otherwise we
// derive one deterministically from JWT_SECRET so no extra deployment
// step is required.
const SECRET = process.env.FILE_TOKEN_SECRET
  || (process.env.JWT_SECRET
        ? crypto.createHash('sha256').update(`${process.env.JWT_SECRET}:file-download-token`).digest('hex')
        : 'change-me-in-production');
// Keep download links short-lived. 15 min is plenty for a "click the
// link" UX while limiting blast radius if the URL leaks (e.g. into
// browser history or shared screenshots).
const DEFAULT_TTL_SEC = parseInt(process.env.FILE_TOKEN_TTL_SEC || '900', 10);

/**
 * Sign a download token for a specific file.
 * @param {Object} claims
 * @param {'prescription'|'invoice'|'certificate'|'previous-record'} claims.kind   What kind of file.
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
  const segmentMap = {
    invoice: 'invoices',
    prescription: 'prescriptions',
    certificate: 'certificates',
    'previous-record': 'previous-records',
    'consultation-invoice': 'consultation-invoices',
    'pharmacy-invoice': 'pharmacy-invoices'
  };
  const segment = segmentMap[kind];
  if (!segment) return null;
  const suffix = kind === 'previous-record' ? '' : '.pdf';
  const token = signDownloadToken({ kind, appointmentId, userId, role }, ttlSec);
  return `/api/files/${segment}/${appointmentId}${suffix}?t=${token}`;
}

module.exports = {
  signDownloadToken,
  verifyDownloadToken,
  buildSignedFileUrl,
  DEFAULT_TTL_SEC
};