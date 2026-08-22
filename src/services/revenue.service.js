/* =====================================================================
   NeoKidsPro EMR — Revenue Management service
   ---------------------------------------------------------------------
   Pure business logic for revenue sharing, TDS, and settlement maths.

   Business rules (from the spec):
     Patient Payment      = X  (only Cashfree-processed, PAID appointments)
     Clinic Share         = clinicSharePercent * X         (default 25%)
     Doctor Gross Share   = doctorSharePercent * X         (default 75%)
     TDS                  = tdsPercent * Doctor Gross      (default 10%)
     Doctor Net Payout    = Doctor Gross - TDS

   Inclusions:
     - Cashfree online payments              (PAID)
     - Cashfree-recorded offline payments    (PAID)

   Exclusions (visible in appointments, ZERO weight in revenue):
     - Cash consultations / walk-in cash
     - Any UNPAID / REFUNDED / cancelled appointments

   The "Cashfree-only" filter is enforced by requiring a non-null
   cashfreeOrderId on the appointment row. Cash-only walk-ins never get
   a Cashfree order, so they are naturally excluded.
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const prisma = require('../config/prisma');

/* ---------- Number helpers (₹ has 2 dp, never use float arithmetic) ---------- */

/** Round a Number to 2 decimal places using banker's rounding-safe Math. */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Convert a Prisma Decimal / string / number safely to a JS Number. */
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  // Prisma Decimal exposes .toNumber(); strings are also valid
  if (typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

/* ---------- Core split calculator ---------- */

/**
 * Given a patient-payment amount X and a doctor's percentage configuration,
 * return the full split breakdown.
 *
 * @param {number} amount                    Patient payment (X), in ₹.
 * @param {object} cfg
 * @param {number} cfg.clinicSharePercent    e.g. 25
 * @param {number} cfg.doctorSharePercent    e.g. 75
 * @param {number} cfg.tdsPercent            e.g. 10  (of doctor gross)
 * @returns {{
 *   patientPayment:number, clinicShare:number,
 *   doctorGross:number, tds:number, doctorNet:number
 * }}
 */
function splitOne(amount, cfg) {
  const X      = round2(toNum(amount));
  const cliPct = toNum(cfg.clinicSharePercent);
  const docPct = toNum(cfg.doctorSharePercent);
  const tdsPct = toNum(cfg.tdsPercent);

  const clinic     = round2((X * cliPct) / 100);
  const docGross   = round2((X * docPct) / 100);
  const tds        = round2((docGross * tdsPct) / 100);
  const docNet     = round2(docGross - tds);

  return {
    patientPayment: X,
    clinicShare:    clinic,
    doctorGross:    docGross,
    tds,
    doctorNet:      docNet
  };
}

/**
 * Aggregate a list of {amount, cfg} into a single totals row.
 * Used both for live revenue reports (DRAFT) and for materialising
 * persisted DoctorSettlement rows.
 */
function aggregate(items) {
  const totals = {
    consultations:  0,
    totalRevenue:   0,
    clinicShare:    0,
    doctorGross:    0,
    tds:            0,
    doctorNet:      0
  };
  for (const it of items) {
    const s = splitOne(it.amount, it.cfg);
    totals.consultations += 1;
    totals.totalRevenue  += s.patientPayment;
    totals.clinicShare   += s.clinicShare;
    totals.doctorGross   += s.doctorGross;
    totals.tds           += s.tds;
    totals.doctorNet     += s.doctorNet;
  }
  // Round every total once at the end → avoids drift from per-row rounding.
  totals.totalRevenue = round2(totals.totalRevenue);
  totals.clinicShare  = round2(totals.clinicShare);
  totals.doctorGross  = round2(totals.doctorGross);
  totals.tds          = round2(totals.tds);
  totals.doctorNet    = round2(totals.doctorNet);
  return totals;
}

/* ---------- Period helpers ---------- */

/**
 * For a given (year, month) return the [start, endExclusive] UTC Date range
 * covering the entire calendar month. Used for Appointment.date queries.
 * (Appointment.date is `@db.Date` → boundary comparisons are calendar-safe.)
 */
function monthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m || m < 1 || m > 12) {
    throw Object.assign(new Error('Invalid period: year/month'), { statusCode: 400 });
  }
  // First day inclusive, first day of next month exclusive.
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end   = new Date(Date.UTC(y, m,     1));
  // periodEnd in DB = last day of the month
  const last  = new Date(Date.UTC(y, m,     0));
  return { start, end, last };
}

/**
 * Build the Prisma `where` clause that selects appointments eligible for
 * revenue calculations:
 *   - status      ∈ {COMPLETED, CONFIRMED}  (paid + delivered or paid + scheduled)
 *   - paymentStatus = PAID
 *   - cashfreeOrderId IS NOT NULL          (excludes cash walk-ins)
 *   - date within [start, end)
 *   - optional doctorId filter
 */
function buildEligibleApptWhere({ doctorId, start, end, paymentTypeFilter, source } = {}) {
  const where = {
    paymentStatus:   'PAID',
    // SECURITY/FINANCE FIX (audit finding #3): a doctor-cancelled (or
    // otherwise cancelled) appointment must NEVER contribute to a
    // settlement or payout, even if it was previously PAID. Payment and
    // appointment status are independent columns; requiring PAID alone
    // used to let a cancelled-but-paid consultation flow into the
    // doctor's settlement before any refund was processed. Statuses
    // like NO_SHOW are future-proofed out by the same allow-list:
    // only CONFIRMED/COMPLETED rows can settle.
    status:          { in: ['CONFIRMED', 'COMPLETED'] },
    cashfreeOrderId: { not: null },        // ← excludes all cash transactions
    date:            { gte: start, lt: end }
  };
  if (doctorId) where.doctorId = doctorId;

  // Optional UI filter — "ONLINE", "OFFLINE", or omit for both
  if (paymentTypeFilter === 'ONLINE' || paymentTypeFilter === 'OFFLINE') {
    where.consultationType = paymentTypeFilter;
  }
  // Optional appointment-source filter (NEOKIDSPRO online, WALK_IN/reception,
  // PHONE, OTHER). Narrows the already-eligible dataset only — it never
  // changes what counts as settleable revenue. Legacy CLINIC_RECEPTION is
  // treated as WALK_IN so the merged in-person channel filters together.
  if (source) {
    where.source = source === 'WALK_IN' ? { in: ['WALK_IN', 'CLINIC_RECEPTION'] } : source;
  }
  return where;
}

/* ---------- Live revenue report (DRAFT view) ---------- */

/**
 * Compute the live revenue report for one or all doctors for a given month.
 * This is a READ-ONLY aggregation — it never writes to the DB.
 * Already-PAID settlements take precedence (frozen snapshot) so the report
 * stays stable after the admin has settled the month.
 *
 * Returns one row per doctor with full split breakdown and settlement status.
 */
async function getMonthlyRevenueReport({ year, month, doctorId, paymentType, source }) {
  const { start, end, last } = monthRange(year, month);

  // 1. Pull doctors in scope (active only). If a specific doctor is asked
  //    we still return that one even if soft-deleted, for back-reporting.
  const doctorWhere = doctorId
    ? { id: doctorId }
    : { deletedAt: null };

  const doctors = await prisma.doctor.findMany({
    where: doctorWhere,
    select: {
      id: true, name: true, email: true, specialization: true,
      clinicSharePercent: true, doctorSharePercent: true, tdsPercent: true
    },
    orderBy: { name: 'asc' }
  });

  if (doctors.length === 0) return [];

  // 2. Pull all eligible appointments for these doctors in one query.
  const apptWhere = buildEligibleApptWhere({
    start, end, paymentTypeFilter: paymentType, source
  });
  apptWhere.doctorId = { in: doctors.map(d => d.id) };

  const appts = await prisma.appointment.findMany({
    where: apptWhere,
    select: {
      id: true, doctorId: true, feeAtBooking: true,
      consultationType: true, date: true, paymentStatus: true,
      cashfreeOrderId: true, cashfreePaymentId: true, settlementId: true
    }
  });

  // 3. Pull any already-existing settlement rows for this month so we
  //    can surface "settlementStatus" + override frozen totals.
  const settlements = await prisma.doctorSettlement.findMany({
    where: {
      periodYear:  Number(year),
      periodMonth: Number(month),
      doctorId:    { in: doctors.map(d => d.id) }
    }
  });
  const settlementByDoc = new Map(settlements.map(s => [s.doctorId, s]));

  // 4. Group appointments by doctorId
  const apptsByDoc = new Map();
  for (const a of appts) {
    if (!apptsByDoc.has(a.doctorId)) apptsByDoc.set(a.doctorId, []);
    apptsByDoc.get(a.doctorId).push(a);
  }

  // 5. Build report rows
  return doctors.map(doc => {
    const myAppts = apptsByDoc.get(doc.id) || [];
    const cfg = {
      clinicSharePercent: doc.clinicSharePercent,
      doctorSharePercent: doc.doctorSharePercent,
      tdsPercent:         doc.tdsPercent
    };
    const liveTotals = aggregate(myAppts.map(a => ({ amount: a.feeAtBooking, cfg })));
    const settlement = settlementByDoc.get(doc.id) || null;

    // If a frozen settlement exists, prefer those numbers for display so
    // the historical record stays immutable.
    const useFrozen = settlement && settlement.status !== 'DRAFT';
    const totals = useFrozen
      ? {
          consultations: settlement.totalConsultations,
          totalRevenue:  toNum(settlement.totalRevenue),
          clinicShare:   toNum(settlement.clinicShareAmount),
          doctorGross:   toNum(settlement.doctorGrossAmount),
          tds:           toNum(settlement.tdsAmount),
          doctorNet:     toNum(settlement.doctorNetAmount)
        }
      : liveTotals;

    return {
      doctor: {
        id: doc.id,
        name: doc.name,
        email: doc.email,
        specialization: doc.specialization,
        clinicSharePercent: toNum(doc.clinicSharePercent),
        doctorSharePercent: toNum(doc.doctorSharePercent),
        tdsPercent:         toNum(doc.tdsPercent)
      },
      period: {
        year:  Number(year),
        month: Number(month),
        start, end: last
      },
      totals,
      settlement: settlement ? {
        id: settlement.id,
        status: settlement.status,
        paidAt: settlement.paidAt,
        paymentReference: settlement.paymentReference,
        invoiceUrl: settlement.invoiceUrl,
        invoiceNumber: settlement.invoiceNumber
      } : { status: 'NOT_GENERATED' }
    };
  });
}

/* ---------- Materialise (freeze) a settlement ---------- */

/**
 * Generate (or refresh, while still in GENERATED state) the persisted
 * DoctorSettlement row for a (doctor, month). This snapshots the totals
 * and links every eligible appointment to this settlement row.
 *
 * Idempotent: re-running on a GENERATED settlement re-syncs it. Re-running
 * on a PAID settlement throws — paid settlements are immutable.
 */
async function generateSettlement({ doctorId, year, month }) {
  const { start, end, last } = monthRange(year, month);

  const doctor = await prisma.doctor.findFirst({
    where: { id: doctorId, deletedAt: null },
    include: { kyc: true }
  });
  if (!doctor) {
    throw Object.assign(new Error('Doctor not found'), { statusCode: 404 });
  }

  // KYC gate — clinic should not pay out to a doctor whose KYC isn't verified.
  // Bank details (cancelled cheque) + identity (Aadhaar/PAN) + MCI cert
  // must all be on file and admin-approved before settlement is materialised.
  if (!doctor.kyc || doctor.kyc.kycStatus !== 'VERIFIED') {
    throw Object.assign(
      new Error('Doctor KYC is not VERIFIED. Complete KYC verification before generating a settlement.'),
      { statusCode: 409, code: 'KYC_NOT_VERIFIED' }
    );
  }

  // Block re-generation of PAID settlements (immutable audit record).
  const existing = await prisma.doctorSettlement.findUnique({
    where: { unique_doctor_period: {
      doctorId, periodYear: Number(year), periodMonth: Number(month)
    } }
  });
  if (existing && existing.status === 'PAID') {
    throw Object.assign(
      new Error('Settlement already PAID — cannot regenerate.'),
      { statusCode: 409 }
    );
  }

  // Eligible appointments → recompute totals
  const where = buildEligibleApptWhere({ doctorId, start, end });
  const appts = await prisma.appointment.findMany({
    where,
    select: { id: true, feeAtBooking: true }
  });

  const cfg = {
    clinicSharePercent: doctor.clinicSharePercent,
    doctorSharePercent: doctor.doctorSharePercent,
    tdsPercent:         doctor.tdsPercent
  };
  const totals = aggregate(appts.map(a => ({ amount: a.feeAtBooking, cfg })));

  // Upsert + relink atomically.
  return prisma.$transaction(async (tx) => {
    let settlement;
    if (existing) {
      settlement = await tx.doctorSettlement.update({
        where: { id: existing.id },
        data: {
          clinicSharePercent: cfg.clinicSharePercent,
          doctorSharePercent: cfg.doctorSharePercent,
          tdsPercent:         cfg.tdsPercent,
          totalConsultations: totals.consultations,
          totalRevenue:       totals.totalRevenue,
          clinicShareAmount:  totals.clinicShare,
          doctorGrossAmount:  totals.doctorGross,
          tdsAmount:          totals.tds,
          doctorNetAmount:    totals.doctorNet,
          status:             'GENERATED'
        }
      });
      // Unlink any previously linked but no-longer-eligible appts
      await tx.appointment.updateMany({
        where: { settlementId: existing.id, id: { notIn: appts.map(a => a.id) } },
        data:  { settlementId: null }
      });
    } else {
      settlement = await tx.doctorSettlement.create({
        data: {
          doctorId,
          periodYear:  Number(year),
          periodMonth: Number(month),
          periodStart: start,
          periodEnd:   last,
          clinicSharePercent: cfg.clinicSharePercent,
          doctorSharePercent: cfg.doctorSharePercent,
          tdsPercent:         cfg.tdsPercent,
          totalConsultations: totals.consultations,
          totalRevenue:       totals.totalRevenue,
          clinicShareAmount:  totals.clinicShare,
          doctorGrossAmount:  totals.doctorGross,
          tdsAmount:          totals.tds,
          doctorNetAmount:    totals.doctorNet,
          status:             'GENERATED'
        }
      });
    }

    // Link every eligible appointment to this settlement
    if (appts.length) {
      await tx.appointment.updateMany({
        where: { id: { in: appts.map(a => a.id) } },
        data:  { settlementId: settlement.id }
      });
    }

    return settlement;
  });
}

/* ---------- Per-appointment breakdown (for doctor "My Earnings") ---------- */

/**
 * Return the list of appointments contributing to a doctor's revenue for
 * a given period, with the split applied row-by-row. Used by the doctor
 * panel and by the settlement invoice PDF.
 */
async function getDoctorBreakdown({ doctorId, year, month }) {
  const { start, end } = monthRange(year, month);
  const doctor = await prisma.doctor.findFirst({
    where: { id: doctorId, deletedAt: null },
    select: {
      id: true, name: true, email: true,
      clinicSharePercent: true, doctorSharePercent: true, tdsPercent: true
    }
  });
  if (!doctor) {
    throw Object.assign(new Error('Doctor not found'), { statusCode: 404 });
  }

  const appts = await prisma.appointment.findMany({
    where: buildEligibleApptWhere({ doctorId, start, end }),
    select: {
      id: true, date: true, startTime: true, endTime: true,
      consultationType: true, feeAtBooking: true,
      cashfreePaymentId: true, cashfreeOrderId: true,
      patient: { select: { id: true, name: true, phone: true } }
    },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }]
  });

  const cfg = {
    clinicSharePercent: doctor.clinicSharePercent,
    doctorSharePercent: doctor.doctorSharePercent,
    tdsPercent:         doctor.tdsPercent
  };

  const rows = appts.map(a => {
    const s = splitOne(a.feeAtBooking, cfg);
    return {
      appointmentId:   a.id,
      date:            a.date,
      startTime:       a.startTime,
      endTime:         a.endTime,
      consultationType: a.consultationType,
      patient: a.patient,
      paymentRef: a.cashfreePaymentId || a.cashfreeOrderId,
      ...s
    };
  });

  return { doctor, period: { year: Number(year), month: Number(month) }, rows };
}

/**
 * Returns the on-disk path to a settlement's invoice PDF, generating it
 * first if it doesn't exist yet. Shared by both the admin finance
 * controller and the doctor earnings controller, since a settlement
 * invoice is generated lazily on first download regardless of who
 * requests it.
 */
async function ensureSettlementInvoicePdf(settlement) {
  const pdfSvc = require('./pdf.service');
  const storageDir = process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage');
  const filepath = path.join(storageDir, 'invoices', `settlement_${settlement.id}.pdf`);

  if (!fs.existsSync(filepath)) {
    const { rows } = await getDoctorBreakdown({
      doctorId: settlement.doctorId,
      year: settlement.periodYear,
      month: settlement.periodMonth
    });
    await pdfSvc.generateSettlementInvoice({
      settlement, doctor: settlement.doctor, rows, invoiceNumber: settlement.invoiceNumber
    });
  }

  return filepath;
}

module.exports = {
  // pure maths
  splitOne,
  aggregate,
  round2,
  toNum,
  // period helpers
  monthRange,
  buildEligibleApptWhere,
  // queries
  getMonthlyRevenueReport,
  getDoctorBreakdown,
  // mutations
  generateSettlement,
  ensureSettlementInvoicePdf
};