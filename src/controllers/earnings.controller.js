/* =====================================================================
   NeoKidsPro EMR — Earnings controller (DOCTOR scope)
   ---------------------------------------------------------------------
   A doctor can ONLY see their own data. The doctorId is taken from the
   JWT (req.user.id), never from query / body, so even if a doctor tries
   to pass ?doctorId=<colleague> they will only ever see their own rows.

   Endpoints (mounted under /api/doctor/earnings):
     GET /my-dashboard?year=&month=    — monthly summary (one number per KPI)
     GET /breakdown?year=&month=       — appointment-by-appointment list
     GET /settlements                  — past settlements (history)
     GET /settlements/:id/invoice      — download own settlement invoice
   ===================================================================== */

const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const revenueSvc = require('../services/revenue.service');

function parsePeriod(req) {
  // Default to "current month" if caller omits the period.
  const now = new Date();
  const year  = parseInt(req.query.year,  10) || now.getUTCFullYear();
  const month = parseInt(req.query.month, 10) || (now.getUTCMonth() + 1);
  if (month < 1 || month > 12) {
    const e = new Error('Invalid month (1-12)'); e.statusCode = 400; throw e;
  }
  return { year, month };
}

/* ---------- GET /my-dashboard ---------- */
exports.myDashboard = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const { year, month } = parsePeriod(req);

  const report = await revenueSvc.getMonthlyRevenueReport({ year, month, doctorId });
  const row = report[0];   // exactly one doctor → exactly one row
  if (!row) return res.status(404).json({ error: 'Doctor not found' });

  res.json({
    period: { year, month },
    doctor: row.doctor,
    totals: row.totals,
    settlement: row.settlement
  });
});

/* ---------- GET /breakdown ---------- */
exports.breakdown = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const { year, month } = parsePeriod(req);
  const data = await revenueSvc.getDoctorBreakdown({ doctorId, year, month });
  res.json(data);
});

/* ---------- GET /settlements ---------- */
exports.mySettlements = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const list = await prisma.doctorSettlement.findMany({
    where: { doctorId },
    orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }],
    select: {
      id: true, periodYear: true, periodMonth: true,
      totalConsultations: true, totalRevenue: true,
      doctorGrossAmount: true, tdsAmount: true, doctorNetAmount: true,
      clinicSharePercent: true, doctorSharePercent: true, tdsPercent: true,
      status: true, paidAt: true, paymentMode: true, paymentReference: true,
      invoiceNumber: true, invoiceUrl: true, createdAt: true
    }
  });
  res.json(list);
});

/* ---------- GET /settlements/:id/invoice ---------- */
exports.downloadMyInvoice = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const s = await prisma.doctorSettlement.findUnique({
    where: { id: req.params.id },
    include: { doctor: true }
  });
  // Hard guard: a doctor can never download someone else's invoice
  if (!s || s.doctorId !== doctorId) {
    return res.status(404).json({ error: 'Settlement not found' });
  }
  if (s.status !== 'PAID' || !s.invoiceNumber) {
    return res.status(400).json({ error: 'Invoice not available — settlement is not yet PAID' });
  }

  const filepath = await revenueSvc.ensureSettlementInvoicePdf(s);
  res.download(filepath, `${s.invoiceNumber}.pdf`);
});