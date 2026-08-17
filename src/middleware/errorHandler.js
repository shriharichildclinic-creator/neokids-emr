/* =====================================================================
   errorHandler.js
   ---------------------------------------------------------------------
   Two jobs:
     1. NEVER leak server internals to clients. No stack traces, no
        absolute filesystem paths, no raw Prisma / library payloads.
     2. Translate "framework-ish" errors (Prisma, body-parser, multer,
        JSON parse, Zod) into clean, predictable HTTP responses.

   Issue 25 — Log severity now matches the actual nature of the error.
   ===========================================================
   Previously EVERY error — including expected 4xx business errors
   like "Doctor not found", "Selected slot is no longer available",
   "Invalid date format" — was logged with:

       [ERROR] Unhandled error: ...

   That made real unhandled errors invisible in the log stream and
   trained ops to ignore the ERROR channel.

   New severity rules:
     • 5xx, unexpected/unknown errors      → logger.error ("Unhandled error")
     • Recognised library errors (Prisma
       known codes, Zod, Multer, JSON
       parse, payload-too-large, JWT)      → logger.warn  ("Client error")
     • Operational errors thrown by us
       with statusCode/status < 500        → logger.info  ("Client error")

   Real unhandled production errors are now the ONLY entries in the
   ERROR channel and become trivially alertable.

   Every error response still looks like:

     {
       "error":     "Human-readable summary",
       "code":      "STABLE_MACHINE_CODE",
       "requestId": "f1c83a…",          // for log correlation
       "details":   { ... }             // optional, ALWAYS safe to expose
     }
   ===================================================================== */
const crypto = require('crypto');
const logger = require('../utils/logger');

/* ─── small helpers ─────────────────────────────────────────────── */

function newRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

function isPrismaError(err) {
  if (!err || !err.name) return false;
  return err.name.startsWith('PrismaClient');
}

function mapPrismaKnownCode(code) {
  switch (code) {
    case 'P2000': return { status: 400, code: 'VALUE_TOO_LONG',     message: 'A value is too long for the database column' };
    case 'P2001': return { status: 404, code: 'NOT_FOUND',          message: 'Record not found' };
    case 'P2002': return { status: 409, code: 'UNIQUE_VIOLATION',   message: 'A record with these values already exists' };
    case 'P2003': return { status: 409, code: 'FK_VIOLATION',       message: 'Related record is missing or in use' };
    case 'P2004': return { status: 400, code: 'CONSTRAINT_FAILED',  message: 'A database constraint failed' };
    case 'P2005': return { status: 400, code: 'INVALID_VALUE',      message: 'A value is invalid for its column type' };
    case 'P2006': return { status: 400, code: 'INVALID_VALUE',      message: 'A value is invalid' };
    case 'P2007': return { status: 400, code: 'VALIDATION_FAILED',  message: 'Data validation failed' };
    case 'P2011': return { status: 400, code: 'NULL_VIOLATION',     message: 'A required field is missing' };
    case 'P2012': return { status: 400, code: 'MISSING_REQUIRED',   message: 'A required field is missing' };
    case 'P2014': return { status: 409, code: 'RELATION_VIOLATION', message: 'Operation violates a relation constraint' };
    case 'P2025': return { status: 404, code: 'NOT_FOUND',          message: 'Record to update or delete was not found' };
    default:      return { status: 400, code: 'DB_REQUEST_ERROR',   message: 'Database rejected the request' };
  }
}

/* ─── 404 / 405 fallback ───────────────────────────────────────────── */

let _routeIndexCache = null;

function _flattenRoutes(app) {
  const out = [];
  function walk(stack, mountPath) {
    if (!stack) return;
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods || {})
          .filter(m => m !== '_all')
          .map(m => m.toUpperCase());
        out.push({ mountPath, routePath: layer.route.path, methods });
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const subMount = _routerMountPath(layer);
        walk(layer.handle.stack, _joinPaths(mountPath, subMount));
      }
    }
  }
  walk(app._router && app._router.stack, '');
  return out;
}

function _routerMountPath(layer) {
  if (layer.path) return layer.path;
  const src = layer.regexp && layer.regexp.source;
  if (!src) return '';
  const m = src.match(/^\^\\?\/([^?]*?)\\\/\?\(\?=\\\/\|\$\)/);
  if (m) return '/' + m[1].replace(/\\\//g, '/');
  return '';
}

function _joinPaths(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return (a.replace(/\/$/, '') + '/' + b.replace(/^\//, ''));
}

function _patternToRegex(pattern) {
  const safe = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:[A-Za-z_][A-Za-z0-9_]*/g, '/[^/]+')
    .replace(/\*/g, '.*');
  return new RegExp('^' + safe + '/?$');
}

function _buildIndex(app) {
  const flat = _flattenRoutes(app);
  return flat.map(r => ({
    full:    _joinPaths(r.mountPath, r.routePath),
    methods: r.methods,
    regex:   _patternToRegex(_joinPaths(r.mountPath, r.routePath))
  }));
}

function _allowedMethodsFor(app, pathname) {
  if (!_routeIndexCache) _routeIndexCache = _buildIndex(app);
  const allowed = new Set();
  for (const r of _routeIndexCache) {
    if (r.regex.test(pathname)) {
      r.methods.forEach(m => allowed.add(m));
    }
  }
  return [...allowed];
}

function notFound(appOrReq, maybeRes, maybeNext) {
  if (appOrReq && (appOrReq.method || appOrReq.originalUrl)) {
    const res = maybeRes;
    return res.status(404).json({ error: 'Not Found', code: 'NOT_FOUND' });
  }
  const app = appOrReq;
  return (req, res, _next) => {
    let allowed = [];
    try { allowed = _allowedMethodsFor(app, req.path); } catch (_) {}

    if (allowed.length > 0) {
      const set = new Set(allowed);
      if (set.has('GET')) set.add('HEAD');
      set.add('OPTIONS');
      const allowHeader = [...set].sort().join(', ');
      res.setHeader('Allow', allowHeader);
      if (req.method === 'OPTIONS') return res.status(204).end();
      return res.status(405).json({
        error:  'Method Not Allowed',
        code:   'METHOD_NOT_ALLOWED',
        method: req.method,
        allow:  allowHeader
      });
    }
    return res.status(404).json({ error: 'Not Found', code: 'NOT_FOUND' });
  };
}

/* ─── Issue 25 — severity-aware logging helper ─────────────────────── */
//
// Decide how loud this error should be in the log stream.
//   level = 'error'  → unexpected / 5xx / unrecognised. Page-able.
//   level = 'warn'   → recognised library error, client-fault 4xx.
//   level = 'info'   → operational error thrown by our own code with a
//                      4xx statusCode (e.g. "Doctor not found"). These
//                      are the most common; logging them at ERROR
//                      hid real failures behind noise.
function classify(err, finalStatus, knownLibrary) {
  if (finalStatus >= 500) return 'error';
  if (knownLibrary)       return 'warn';
  if (finalStatus >= 400) return 'info';
  return 'error';
}

function logAtLevel(level, message, meta) {
  // `logger` is winston-shaped: error/warn/info methods all exist.
  // If a project ever swaps in a logger without `.warn`, fall back.
  if (typeof logger[level] === 'function') return logger[level](message, meta);
  return logger.info(message, meta);
}

/* ─── master error handler ─────────────────────────────────────── */

const errorHandler = (err, req, res, _next) => {
  const requestId = newRequestId();

  // We decide log severity AFTER we know the final status, so we
  // collect everything in `meta` first and emit one record at the end.
  const meta = {
    requestId,
    method:  req && req.method,
    path:    req && req.originalUrl,
    name:    err && err.name,
    code:    err && err.code,
    message: err && err.message
    // NB: stack is only attached for 5xx / unknown — see below.
  };

  // 1. Prisma validation error → 400 (recognised library error)
  if (err && err.name === 'PrismaClientValidationError') {
    logAtLevel(classify(err, 400, true), 'Client error (Prisma validation)', meta);
    return res.status(400).json({
      error:     'Invalid input for database operation',
      code:      'VALIDATION_FAILED',
      requestId
    });
  }

  // 2. Prisma known request errors (P2002 etc.)
  if (err && err.name === 'PrismaClientKnownRequestError') {
    const mapped = mapPrismaKnownCode(err.code);
    logAtLevel(classify(err, mapped.status, true), 'Client error (Prisma known)', meta);
    return res.status(mapped.status).json({
      error:     mapped.message,
      code:      mapped.code,
      requestId
    });
  }

  // 3. Other Prisma client errors → opaque 500. THESE are real.
  if (isPrismaError(err)) {
    logAtLevel('error', 'Unhandled error (Prisma)', { ...meta, stack: err && err.stack });
    return res.status(500).json({
      error:     'Database error',
      code:      'DB_ERROR',
      requestId
    });
  }

  // 4. JSON body parser — malformed JSON.
  if (err && err.type === 'entity.parse.failed') {
    logAtLevel(classify(err, 400, true), 'Client error (malformed JSON)', meta);
    return res.status(400).json({
      error:     'Malformed JSON body',
      code:      'INVALID_JSON',
      requestId
    });
  }

  // 5. Payload-too-large.
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    logAtLevel(classify(err, 413, true), 'Client error (payload too large)', meta);
    return res.status(413).json({
      error:     'Request payload is too large',
      code:      'PAYLOAD_TOO_LARGE',
      requestId
    });
  }

  // 6. Multer upload errors.
  if (err && err.name === 'MulterError') {
    logAtLevel(classify(err, 400, true), 'Client error (upload)', { ...meta, multerCode: err.code, field: err.field });
    return res.status(400).json({
      error:     'File upload rejected',
      code:      `UPLOAD_${err.code || 'ERROR'}`,
      details:   err.field ? { field: err.field } : undefined,
      requestId
    });
  }

  // 7. Zod errors that escaped controller-level handling.
  // v3.4.4: ALWAYS include `details.flatten()` so the frontend can show
  // the specific failing field instead of a generic "Invalid Input".
  if (err && err.name === 'ZodError') {
    logAtLevel(classify(err, 400, true), 'Client error (Zod validation)', meta);
    return res.status(400).json({
      error:     'Invalid input',
      code:      'VALIDATION_FAILED',
      details:   err.flatten ? err.flatten() : undefined,
      issues:    Array.isArray(err.issues) ? err.issues.map(i => ({
        path: Array.isArray(i.path) ? i.path.join('.') : String(i.path || ''),
        message: i.message,
        code: i.code
      })) : undefined,
      requestId
    });
  }

  // 8. JWT errors leaking through (defence in depth).
  if (err && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')) {
    logAtLevel(classify(err, 401, true), 'Client error (JWT)', meta);
    return res.status(401).json({
      error:     'Invalid or expired token',
      code:      err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      requestId
    });
  }

  // 9. Operational errors WE threw (statusCode/status). For < 500 these
  //    are expected client errors (e.g. "Doctor not found"). Log at info
  //    — they were never "unhandled".
  const status = (err && (err.statusCode || err.status)) || 500;

  if (status < 500) {
    logAtLevel(classify(err, status, false), 'Client error', meta);
    return res.status(status).json({
      error:     err.message || 'Bad Request',
      code:      err.code || 'BAD_REQUEST',
      requestId
    });
  }

  // 10. Unknown 5xx — THE only thing we still call "Unhandled error".
  logAtLevel('error', 'Unhandled error', { ...meta, stack: err && err.stack });
  return res.status(500).json({
    error:     'Internal Server Error',
    code:      'INTERNAL_ERROR',
    requestId
  });
};

/* ─── tiny async wrapper (unchanged) ───────────────────────────── */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { notFound, errorHandler, asyncHandler };
module.exports._internals = { _allowedMethodsFor, _patternToRegex, classify };