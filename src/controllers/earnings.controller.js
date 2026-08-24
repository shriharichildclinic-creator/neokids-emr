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

  // Cash collected at the clinic — separate from row.totals, which is
  // deliberately Cashfree-only (that's the only money the platform ever
  // holds and owes a payout on). Without this, a doctor doing both online
  // and in-clinic work would see their in-clinic cash income nowhere at
  // all on their own earnings dashboard.
  const cash = await revenueSvc.getCashCollectedTotal({ doctorId, year, month });

  res.json({
    period: { year, month },
    doctor: row.doctor,
    totals: row.totals,
    cash,
    settlement: row.settlement
  });
});

/* ---------- GET /breakdown ---------- */
exports.breakdown = asyncHandler(async (req, res) => {
  const doctorId = req.user.id;
  const { year, month } = parsePeriod(req);

  // If this period has already been settled, pin the breakdown to the
  // frozen appointment set + split percentages recorded on that settlement
  // (see revenueSvc.getDoctorBreakdown) so this list always matches what
  // the doctor was actually paid, even if a later refund/status change or
  // a doctor revenue-share edit would otherwise change the live numbers.
  const settlement = await prisma.doctorSettlement.findUnique({
    where: { unique_doctor_period: { doctorId, periodYear: year, periodMonth: month } }
  });

  const data = await revenueSvc.getDoctorBreakdown({ doctorId, year, month, settlement });
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