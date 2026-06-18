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

function parsePeriod(req) {
  const year  = parseInt(req.query.year  || req.body.year,  10);
  const month = parseInt(req.query.month || req.body.month, 10);
  if (!year || year < 2000 || year > 2100) {
    const e = new Error('Invalid year'); e.statusCode = 400; throw e;
  }
  if (!month || month < 1 || month > 12) {
    const e = new Error('Invalid month (1-12)'); e.statusCode = 400; throw e;
  }
  return { year, month };
}

function buildInvoiceNumber(settlement) {
  // INV-YYYYMM-<8 chars of doctorId>
  const mm = String(settlement.periodMonth).padStart(2, '0');
  return `STL-${settlement.periodYear}${mm}-${settlement.doctorId.slice(0, 8).toUpperCase()}`;
}

/* ---------- GET /revenue-report ---------- */
// Query: year, month, doctorId?, paymentType?  (ONLINE | OFFLINE)
exports.revenueReport = asyncHandler(async (req, res) => {
  const { year, month } = parsePeriod(req);
  const { doctorId, paymentType } = req.query;

  const rows = await revenueSvc.getMonthlyRevenueReport({
    year, month, doctorId, paymentType
  });

  // Compute clinic-wide grand totals across all returned doctors
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
    period: { year, month },
    filters: { doctorId: doctorId || null, paymentType: paymentType || null },
    rows,
    grandTotals: grand
  });
});

/* ---------- POST /settlements/generate ---------- */
// Body: { doctorId, year, month }
exports.generateSettlement = asyncHandler(async (req, res) => {
  const { year, month } = parsePeriod(req);
  const { doctorId } = req.body;
  if (!doctorId) {
    return res.status(400).json({ error: 'doctorId is required' });
  }

  // Refuse to settle a month that hasn't ended yet — common admin mistake.
  // (We allow settling the current month but warn; we BLOCK settling a
  // future month outright.)
  const now = new Date();
  if (year > now.getUTCFullYear() ||
      (year === now.getUTCFullYear() && month > (now.getUTCMonth() + 1))) {
    return res.status(400).json({ error: 'Cannot settle a future period' });
  }

  const settlement = await revenueSvc.generateSettlement({ doctorId, year, month });
  res.status(201).json(settlement);
});

/* ---------- GET /settlements ---------- */
// Query: year?, month?, doctorId?, status?
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

  // Re-compute appointment-level breakdown for the modal table
  const breakdown = await revenueSvc.getDoctorBreakdown({
    doctorId: s.doctorId, year: s.periodYear, month: s.periodMonth
  });

  res.json({ settlement: s, rows: breakdown.rows });
});

/* ---------- POST /settlements/:id/mark-paid ---------- */
// Body: { paymentMode, paymentReference, paymentNotes? }
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

  // 1. Build invoice number
  const invoiceNumber = buildInvoiceNumber(existing);

  // 2. Compute per-appointment breakdown for the PDF
  const { rows } = await revenueSvc.getDoctorBreakdown({
    doctorId: existing.doctorId,
    year:     existing.periodYear,
    month:    existing.periodMonth
  });

  // 3. Stamp settlement with payment info FIRST (so PDF reflects PAID state)
  const stamped = {
    ...existing,
    status: 'PAID',
    paidAt: new Date(),
    paymentMode, paymentReference, paymentNotes: paymentNotes || null
  };

  // 4. Render PDF
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

  // 5. Persist
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
// All settlements that have an invoice generated (i.e. PAID).
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

  // Lazy regenerate if the file was lost (e.g. ephemeral disk on redeploy).
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