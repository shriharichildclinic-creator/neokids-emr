// server.js — fixed version
// Added ENABLE_INTERNAL_JOBS default to true in dev
// Lifecycle jobs now always run in dev for Issue 6/8

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

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.APP_URL, 'https://neokidspro.in'].filter(Boolean)
    : '*',
  credentials: true
}));

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
app.use('/admin',  express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/doctor', express.static(path.join(__dirname, '..', 'public', 'doctor')));
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'NeoKidsPro EMR', version: '1.2.0', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    name: 'NeoKidsPro EMR API',
    version: '1.2.0',
    panels: { admin: '/admin', doctor: '/doctor' }
  });
});

app.use('/api/auth',     authRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/doctor',   doctorRoutes);
app.use('/api/public',   publicRoutes);
app.use('/api/webhooks', webhookRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, async () => {
  logger.info(`🚀 NeoKidsPro EMR running on port ${PORT}`);
  logger.info(`📋 Admin Panel: http://localhost:${PORT}/admin`);
  logger.info(`👨‍⚕️ Doctor Panel: http://localhost:${PORT}/doctor`);
  logger.info(`🔖 Booking Widget: http://localhost:${PORT}/assets/booking-widget.html`);

  // Run lifecycle jobs — default ON in all environments
  const jobsEnabled = process.env.ENABLE_INTERNAL_JOBS !== 'false';
  const intervalMs  = parseInt(process.env.INTERNAL_JOBS_INTERVAL_MS || '300000', 10);

  if (jobsEnabled) {
    await runLifecycleJobs(); // run immediately on startup
    setInterval(runLifecycleJobs, intervalMs);
    logger.info(`⏰ Lifecycle jobs running every ${intervalMs / 1000}s`);
  }
});

module.exports = app;
