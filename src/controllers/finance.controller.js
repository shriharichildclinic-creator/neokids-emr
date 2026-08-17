/* =====================================================================
   NeoKidsPro EMR — Finance controller (ADMIN scope)
   ---------------------------------------------------------------------
   Endpoints (mounted under /api/admin/finance):
     GET    /revenue-report                  — live monthly aggregation
     GET    /settlements                     — list (audit trail)
     GET    /settlements/:id                 — detail (with appt rows)
     POST   /settlements/generate            — freeze totals for (doc, month)
     POST   /settlements/:id/mark-paid       — record payout + invoice
     GET    /invoices                        — list settlement invoices
     GET    /invoices/:settlementId/download — stream PDF

   Issue 29 — parsePeriod is now:
     • Forgiving:  GET /revenue-report with NO params defaults to the
                   *current* UTC year+month, matching how the admin UI
                   actually uses the endpoint on first paint.
     • Helpful:    when params ARE supplied and ARE invalid, the error
                   payload tells the caller EXACTLY what to send,
                   with a concrete example. No more bare "Invalid year".
     • Strict for writes: state-changing endpoints (POST /generate, etc.)
                   still require an explicit period — defaulting would
                   silently settle the wrong month. They opt-in with
                   { requireExplicit: true }.
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const revenueSvc = require('../services/revenue.service');
const pdfSvc = require('../services/pdf.service');
const logger = require('../utils/logger');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage');

/* ---------- Validation helpers ---------- */

// Build a friendly, actionable error.
function periodHelpError(message) {
  const now = new Date();
  const exampleYear  = now.getUTCFullYear();
  const exampleMonth = now.getUTCMonth() + 1;
  const e = new Error(message);
  e.statusCode = 400;
  e.code = 'INVALID_PERIOD';
  // The errorHandler will pass `message` through verbatim for status<500.
  // The example/usage hints are stamped onto the error for controllers
  // that prefer to return them inline (see below).
  e.details = {
    expected: 'year (2000-2100) and month (1-12) as query params',
    example:  `?year=${exampleYear}&month=${exampleMonth}`,
    receivedYear:  null,
    receivedMonth: null
  };
  return e;
}

/**
 * parsePeriod
 * @param {express.Request} req
 * @param {Object} [opts]
 * @param {boolean} [opts.requireExplicit=false] When true, no defaulting
 *        — both year and month MUST be present in the request. Used for
 *        write endpoints like POST /settlements/generate where silently
 *        defaulting could settle the wrong month.
 * @returns {{year:number, month:number, defaulted:boolean}}
 */
function parsePeriod(req, opts = {}) {
  const requireExplicit = !!opts.requireExplicit;
  const rawYear  = req.query.year  != null ? req.query.year  : (req.body ? req.body.year  : undefined);
  const rawMonth = req.query.month != null ? req.query.month : (req.body ? req.body.month : undefined);

  const yearProvided  = rawYear  !== undefined && rawYear  !== '' && rawYear  !== null;
  const monthProvided = rawMonth !== undefined && rawMonth !== '' && rawMonth !== null;

  // Issue 29 — for the READ endpoint (revenue-report), no params at all
  // is a sensible "what does this month look like so far?" question.
  // Default to the current UTC year+month and tell the caller via the
  // response payload (`defaulted: true`).
  if (!yearProvided && !monthProvided && !requireExplicit) {
    const now = new Date();
    return {
      year:  now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      defaulted: true
    };
  }

  // From here on, validate whatever the caller sent.
  const year  = parseInt(rawYear,  10);
  const month = parseInt(rawMonth, 10);

  if (!yearProvided) {
    const e = periodHelpError('Missing query param "year". Provide year and month, e.g. ' + _example());
    e.details.receivedMonth = monthProvided ? rawMonth : null;
    throw e;
  }
  if (!monthProvided) {
    const e = periodHelpError('Missing query param "month". Provide year and month, e.g. ' + _example());
    e.details.receivedYear = rawYear;
    throw e;
  }
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    const e = periodHelpError(`Invalid "year" (got "${rawYear}"). Expected an integer 2000-2100, e.g. ${_example()}`);
    e.details.receivedYear  = rawYear;
    e.details.receivedMonth = rawMonth;
    throw e;
  }
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    const e = periodHelpError(`Invalid "month" (got "${rawMonth}"). Expected an integer 1-12, e.g. ${_example()}`);
    e.details.receivedYear  = rawYear;
    e.details.receivedMonth = rawMonth;
    throw e;
  }

  return { year, month, defaulted: false };
}

function _example() {
  const now = new Date();
  return `?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`;
}

function buildInvoiceNumber(settlement) {
  const mm = String(settlement.periodMonth).padStart(2, '0');
  return `STL-${settlement.periodYear}${mm}-${settlement.doctorId.slice(0, 8).toUpperCase()}`;
}

/* ---------- GET /revenue-report ---------- */
// Query: year?, month?, doctorId?, paymentType?  (ONLINE | OFFLINE)
// If year+month are omitted, defaults to the current UTC period and sets
// `period.defaulted = true` in the response so the UI can render a hint.
exports.revenueReport = asyncHandler(async (req, res, next) => {
  let period;
  try {
    period = parsePeriod(req, { requireExplicit: false });
  } catch (e) {
    // Surface the rich, friendly error body inline so the admin UI can
    // show the suggested example URL without having to know our
    // INVALID_PERIOD code.
    if (e && e.code === 'INVALID_PERIOD') {
      return res.status(400).json({
        error:   e.message,
        code:    e.code,
        details: e.details
      });
    }
    return next(e);
  }
  const { year, month, defaulted } = period;
  const { doctorId, paymentType } = req.query;

  const rows = await revenueSvc.getMonthlyRevenueReport({
    year, month, doctorId, paymentType
  });

  const grand = rows.reduce((g, r) => {
    g.consultations += r.totals.consultations;
    g.totalRevenue  += r.totals.totalRevenue;
    g.clinicShare   += r.totals.clinicShare;
    g.doctorGross   += r.totals.doctorGross;
    g.tds           += r.totals.tds;
    g.doctorNet     += r.totals.doctorNet;
    return g;
  }, { consultations: 0, totalRevenue: 0, clinicShare: 0, doctorGross: 0, tds: 0, doctorNet: 0 });
  Object.keys(grand).forEach(k => { if (k !== 'consultations') grand[k] = revenueSvc.round2(grand[k]); });

  res.json({
    period: { year, month, defaulted },
    filters: { doctorId: doctorId || null, paymentType: paymentType || null },
    rows,
    grandTotals: grand
  });
});

/* ---------- POST /settlements/generate ---------- */
// Body: { doctorId, year, month }
exports.generateSettlement = asyncHandler(async (req, res, next) => {
  let period;
  try {
    // Writes MUST be explicit — refuse to silently settle the current month.
    period = parsePeriod(req, { requireExplicit: true });
  } catch (e) {
    if (e && e.code === 'INVALID_PERIOD') {
      return res.status(400).json({ error: e.message, code: e.code, details: e.details });
    }
    return next(e);
  }
  const { year, month } = period;
  const { doctorId } = req.body;
  if (!doctorId) {
    return res.status(400).json({ error: 'doctorId is required' });
  }

  const now = new Date();
  if (year > now.getUTCFullYear() ||
      (year === now.getUTCFullYear() && month > (now.getUTCMonth() + 1))) {
    return res.status(400).json({ error: 'Cannot settle a future period' });
  }

  const settlement = await revenueSvc.generateSettlement({ doctorId, year, month });
  res.status(201).json(settlement);
});

/* ---------- GET /settlements ---------- */
exports.listSettlements = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.year)     where.periodYear  = parseInt(req.query.year, 10);
  if (req.query.month)    where.periodMonth = parseInt(req.query.month, 10);
  if (req.query.doctorId) where.doctorId    = req.query.doctorId;
  if (req.query.status)   where.status      = req.query.status;

  const settlements = await prisma.doctorSettlement.findMany({
    where,
    include: {
      doctor: { select: { id: true, name: true, email: true, specialization: true } }
    },
    orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }, { createdAt: 'desc' }]
  });
  res.json(settlements);
});

/* ---------- GET /settlements/:id ---------- */
exports.settlementDetail = asyncHandler(async (req, res) => {
  const s = await prisma.doctorSettlement.findUnique({
    where: { id: req.params.id },
    include: {
      doctor: {
        select: {
          id: true, name: true, email: true, specialization: true,
          clinicSharePercent: true, doctorSharePercent: true, tdsPercent: true
        }
      }
    }
  });
  if (!s) return res.status(404).json({ error: 'Settlement not found' });

  const breakdown = await revenueSvc.getDoctorBreakdown({
    doctorId: s.doctorId, year: s.periodYear, month: s.periodMonth
  });

  res.json({ settlement: s, rows: breakdown.rows });
});

/* ---------- POST /settlements/:id/mark-paid ---------- */
exports.markSettlementPaid = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { paymentMode, paymentReference, paymentNotes } = req.body || {};

  if (!paymentMode || !paymentReference) {
    return res.status(400).json({
      error: 'paymentMode and paymentReference (UTR/ref) are required'
    });
  }

  const existing = await prisma.doctorSettlement.findUnique({
    where: { id },
    include: { doctor: true }
  });
  if (!existing) return res.status(404).json({ error: 'Settlement not found' });
  if (existing.status === 'PAID') {
    return res.status(409).json({ error: 'Settlement is already marked PAID' });
  }
  if (existing.totalConsultations === 0) {
    return res.status(400).json({ error: 'Cannot pay a settlement with zero consultations' });
  }

  const invoiceNumber = buildInvoiceNumber(existing);

  const { rows } = await revenueSvc.getDoctorBreakdown({
    doctorId: existing.doctorId,
    year:     existing.periodYear,
    month:    existing.periodMonth
  });

  const stamped = {
    ...existing,
    status: 'PAID',
    paidAt: new Date(),
    paymentMode, paymentReference, paymentNotes: paymentNotes || null
  };

  let pdf;
  try {
    pdf = await pdfSvc.generateSettlementInvoice({
      settlement: stamped,
      doctor:     existing.doctor,
      rows,
      invoiceNumber
    });
  } catch (e) {
    logger.error('Settlement PDF generation failed:', e);
    return res.status(500).json({ error: 'Failed to generate settlement invoice PDF' });
  }

  const updated = await prisma.doctorSettlement.update({
    where: { id },
    data: {
      status:             'PAID',
      paidAt:             stamped.paidAt,
      paymentMode,
      paymentReference,
      paymentNotes:       paymentNotes || null,
      processedById:      req.user?.id || null,
      invoiceNumber,
      invoiceUrl:         pdf.url,
      invoiceGeneratedAt: new Date()
    },
    include: { doctor: { select: { id: true, name: true, email: true } } }
  });

  res.json(updated);
});

/* ---------- GET /invoices ---------- */
exports.listInvoices = asyncHandler(async (req, res) => {
  const where = { status: 'PAID', invoiceNumber: { not: null } };
  if (req.query.year)     where.periodYear  = parseInt(req.query.year, 10);
  if (req.query.month)    where.periodMonth = parseInt(req.query.month, 10);
  if (req.query.doctorId) where.doctorId    = req.query.doctorId;

  const list = await prisma.doctorSettlement.findMany({
    where,
    include: { doctor: { select: { id: true, name: true, email: true, specialization: true } } },
    orderBy: [{ paidAt: 'desc' }]
  });
  res.json(list);
});

/* ---------- GET /invoices/:settlementId/download ---------- */
exports.downloadInvoice = asyncHandler(async (req, res) => {
  const s = await prisma.doctorSettlement.findUnique({
    where: { id: req.params.settlementId },
    include: { doctor: true }
  });
  if (!s) return res.status(404).json({ error: 'Settlement not found' });
  if (s.status !== 'PAID' || !s.invoiceNumber) {
    return res.status(400).json({ error: 'No invoice — settlement is not PAID yet' });
  }

  const filename = `settlement_${s.id}.pdf`;
  const filepath = path.join(STORAGE, 'invoices', filename);

  if (!fs.existsSync(filepath)) {
    const { rows } = await revenueSvc.getDoctorBreakdown({
      doctorId: s.doctorId, year: s.periodYear, month: s.periodMonth
    });
    await pdfSvc.generateSettlementInvoice({
      settlement: s, doctor: s.doctor, rows, invoiceNumber: s.invoiceNumber
    });
  }

  res.download(filepath, `${s.invoiceNumber}.pdf`);
});

/* Exported for unit tests of the new parsing logic. */
exports._internals = { parsePeriod };