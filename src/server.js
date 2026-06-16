// server.js — fixed version
// - Added /payment-status route (was 404 previously)
// - Lifecycle jobs always run by default
// - Additional Issue 9: CORS no longer pairs '*' with credentials

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');
const path    = require('path');

const { errorHandler, notFound } = require('./middleware/errorHandler');
const logger  = require('./utils/logger');
const { runLifecycleJobs } = require('./services/lifecycle.service');

const authRoutes    = require('./routes/auth.routes');
const adminRoutes   = require('./routes/admin.routes');
const doctorRoutes  = require('./routes/doctor.routes');
const publicRoutes  = require('./routes/public.routes');
const webhookRoutes = require('./routes/webhook.routes');
const publicCtrl    = require('./controllers/public.controller');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// Additional Issue 9 — `Access-Control-Allow-Origin: *` is incompatible with
// `Access-Control-Allow-Credentials: true`. We use Bearer tokens (no
// cookies), so credentials is unnecessary; drop it in dev. In production
// we lock the origin list down anyway.
if (process.env.NODE_ENV === 'production') {
  app.use(cors({
    origin: [process.env.APP_URL, 'https://neokidspro.in'].filter(Boolean),
    credentials: true
  }));
} else {
  app.use(cors({ origin: '*' /* credentials intentionally omitted */ }));
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);
app.use(morgan('combined', { stream: { write: (m) => logger.info(m.trim()) } }));

// Cashfree webhook needs raw body BEFORE json parser
app.use('/api/webhooks/cashfree', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/files',  express.static(path.join(__dirname, '..', 'storage')));

// HTML must never be cached long — JS/CSS use ?v=… for cache-busting (see index.html).
const staticOpts = {
  maxAge: '1h',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
};
app.use('/doctor', express.static(path.join(__dirname, '..', 'public', 'doctor'), staticOpts));
app.use('/admin',  express.static(path.join(__dirname, '..', 'public', 'admin'),  staticOpts));
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'NeoKidsPro EMR', version: '1.2.2', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    name: 'NeoKidsPro EMR API',
    version: '1.2.2',
    panels: { admin: '/admin', doctor: '/doctor' }
  });
});

// ── Cashfree return URL lands here ─────────────────────────────────
// /payment-status?order_id=appt_xxxxx
app.get('/payment-status', publicCtrl.paymentStatusPage);

app.use('/api/auth',     authRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/doctor',   doctorRoutes);
app.use('/api/public',   publicRoutes);
app.use('/api/webhooks', webhookRoutes);

app.use(notFound);
app.use(errorHandler);

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
    logger.info(`⏰ Lifecycle jobs running every ${intervalMs / 1000}s`);
  }
});

module.exports = app;
