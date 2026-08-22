// server.js — hardened version
//
// Adds:
//   #28 — Origin/Referer + Sec-Fetch-Site CSRF guard on writes
//         (mounted before all /api/* routers; webhooks/public-book/login
//          are explicitly bypassed inside the guard).
//   #31 — Local Tailwind asset served at /assets/vendor/tailwind.css so
//         the three public pages no longer load tailwind from a CDN.
//
// Existing fixes preserved:
//   #15 — Per-route rate limiting (public IP-keyed, authenticated
//         token-keyed, webhook narrow).
//   #21 — Single source of truth for lifecycle interval (5 min).
//   #23 — Dedicated webhook limiter + uniform webhook error.

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');
const path    = require('path');

const { errorHandler, notFound } = require('./middleware/errorHandler');
const { makeCsrfGuard }          = require('./middleware/csrf');
const logger  = require('./utils/logger');
const { runLifecycleJobs } = require('./services/lifecycle.service');

const authRoutes    = require('./routes/auth.routes');
const adminRoutes   = require('./routes/admin.routes');
const doctorRoutes  = require('./routes/doctor.routes');
const receptionistRoutes = require('./routes/receptionist.routes');
const pharmacyRoutes     = require('./routes/pharmacy.routes');
const publicRoutes  = require('./routes/public.routes');
const webhookRoutes = require('./routes/webhook.routes');
const filesRoutes   = require('./routes/files.routes');
const publicCtrl    = require('./controllers/public.controller');
const { ensureStorageWritable } = require('../scripts/ensure-storage');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Bug #1 — Trust the reverse proxy (Nginx) ─────────────────────────
// The app runs behind Nginx, which sets X-Forwarded-For. Without
// `trust proxy`, Express (and express-rate-limit) reads the header as
// untrusted, logs ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request,
// and treats every proxied client as Nginx's own IP — breaking
// per-client rate limiting and request tracking. `1` trusts the first
// hop (the Nginx in front of this process) so req.ip is the real client.
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,

    // Allow the booking widget to be embedded in an iframe.
    // We'll tighten this later so only the booking widget is embeddable.
    frameguard: false,
  })
);

if (process.env.NODE_ENV === 'production') {
  app.use(cors({
    origin: [process.env.APP_URL, 'https://neokidspro.in'].filter(Boolean),
    credentials: true
  }));
} else {
  app.use(cors({ origin: '*' /* credentials intentionally omitted */ }));
}

// ─── Per-route rate limiting ──────────────────────────────────────────
const crypto = require('crypto');
function tokenKey(req) {
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Bearer ')) return null;
  const tok = hdr.slice(7).trim();
  if (!tok) return null;
  return 'tok:' + crypto.createHash('sha256').update(tok).digest('hex').slice(0, 24);
}

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.', code: 'RATE_LIMIT_PUBLIC' }
});

const authenticatedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => tokenKey(req) || req.ip,
  message: { error: 'Too many requests, please slow down.', code: 'RATE_LIMIT_USER' }
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});

app.use(morgan('combined', { stream: { write: (m) => logger.info(m.trim()) } }));

app.use('/api/webhooks/cashfree',
  webhookLimiter,
  express.raw({ type: 'application/json' })
);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Static assets ────────────────────────────────────────────────────
app.use('/files/profile-images',
  express.static(path.join(__dirname, '..', 'storage', 'profile-images')));
// SECURITY FIX (audit finding #2): KYC documents (Aadhaar / PAN /
// cancelled cheque / medical registration certificates) used to be
// served by a PUBLIC express.static mount — anyone who knew or guessed
// the stored UUID filename could download a doctor's identity documents
// with zero authentication. The mount is REMOVED. KYC files are now
// only readable through the authenticated route
//   GET /api/admin/kyc/:doctorId/:kind   (ADMIN JWT required)
// registered in admin.routes.js. No rewrite needed in the admin panel:
// the stored aadhaarUrl/panUrl/... values are still returned in the KYC
// API payload, and the admin UI rewrites them to the protected route
// (see public/admin/app.js setKycFieldStatus).
// Doctor signatures were served by the same kind of public express.static
// mount as KYC documents above, and for the same reason are removed: a
// signature is exactly the artifact needed to forge a certificate or
// prescription. Now readable only through
//   GET /api/doctor/signature/file   (doctor's own JWT, own signature only)
// registered in doctor.routes.js.

const staticOpts = {
  maxAge: '1h',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    // Vendor CSS is content-hashed at build time; aggressive cache.
    if (filePath.includes(path.sep + 'vendor' + path.sep)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      // These ARE actively edited between deploys (app.js,
      // historical-fix.js, styles.css) and aren't content-hashed, so the
      // default 1h cache was letting mobile browsers keep serving a stale
      // build well after a redeploy — symptoms looked like "the fix
      // didn't work" when really the device just hadn't re-fetched yet.
      // ETag/Last-Modified stay on, so this is still a cheap conditional
      // GET (304) whenever the file hasn't actually changed.
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
};
app.use('/doctor',       express.static(path.join(__dirname, '..', 'public', 'doctor'),       staticOpts));
app.use('/admin',        express.static(path.join(__dirname, '..', 'public', 'admin'),        staticOpts));
app.use('/receptionist', express.static(path.join(__dirname, '..', 'public', 'receptionist'), staticOpts));
app.use('/pharmacy',     express.static(path.join(__dirname, '..', 'public', 'pharmacy'),     staticOpts));
app.use('/assets',       express.static(path.join(__dirname, '..', 'public', 'assets'),       staticOpts));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'NeoKidsPro EMR', version: '1.2.3', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'assets', 'gateway.html'));
});

// Machine-readable service descriptor kept available for health checks and
// integrations that previously relied on the JSON at the root.
app.get('/api', (req, res) => {
  res.json({
    name: 'NeoKidsPro EMR API',
    version: '4.0.0',
    panels: { admin: '/admin', doctor: '/doctor', receptionist: '/receptionist', pharmacy: '/pharmacy' }
  });
});

app.get('/payment-status', publicCtrl.paymentStatusPage);

// ─── CSRF guard mounted BEFORE all mutating API routers ───────────────
// The guard itself bypasses /api/webhooks, /api/public/book, login and
// forgot/reset-password — see middleware/csrf.js for the exhaustive list.
app.use(makeCsrfGuard());

// Mount limiters + routers
app.use('/api/auth',         publicLimiter,        authRoutes);
app.use('/api/public',       publicLimiter,        publicRoutes);
app.use('/api/admin',        authenticatedLimiter, adminRoutes);
app.use('/api/doctor',       authenticatedLimiter, doctorRoutes);
app.use('/api/receptionist', authenticatedLimiter, receptionistRoutes);
app.use('/api/pharmacy',     authenticatedLimiter, pharmacyRoutes);
app.use('/api/files',        authenticatedLimiter, filesRoutes);
app.use('/api/webhooks',     webhookRoutes);

app.use(notFound(app));
app.use(errorHandler);

try {
  ensureStorageWritable();
} catch (e) {
  logger.error('Storage initialisation failed:', e.message);
  process.exit(1);
}

app.listen(PORT, async () => {
  logger.info(`🚀 NeoKidsPro EMR running on port ${PORT}`);
  logger.info(`📋 Admin Panel:    http://localhost:${PORT}/admin`);
  logger.info(`👨‍⚕️ Doctor Panel:   http://localhost:${PORT}/doctor`);
  logger.info(`🔖 Booking Widget: http://localhost:${PORT}/assets/booking-widget.html`);
  logger.info(`💳 Payment Status: http://localhost:${PORT}/payment-status`);

  const jobsEnabled = process.env.ENABLE_INTERNAL_JOBS !== 'false';
  const intervalMs  = parseInt(process.env.INTERNAL_JOBS_INTERVAL_MS || '300000', 10);
  if (jobsEnabled) {
    await runLifecycleJobs();
    setInterval(runLifecycleJobs, intervalMs);
    logger.info(`⏰ Lifecycle jobs running every ${Math.round(intervalMs / 1000)}s (${(intervalMs / 60000).toFixed(1)} min)`);
  }
});

module.exports = app;