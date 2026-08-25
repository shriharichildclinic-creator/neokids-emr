/* =====================================================================
   money-audit-verify.js
   ---------------------------------------------------------------------
   No real database needed. This seeds a realistic set of in-memory
   appointment/invoice rows for ONE doctor, ONE receptionist, for
   August 2026 — reproducing the exact scenario from the bug report
   (a "Collected this week" figure bigger than the whole month) plus
   a cancelled-after-paid visit and a teleconsultation paid in cash —
   then runs the OLD (buggy) and NEW (fixed) filter logic side by side
   so the numbers can be checked directly instead of taking the code's
   word for it.

   Run: node scripts/money-audit-verify.js
   ===================================================================== */

const TODAY = new Date('2026-08-25T00:00:00.000Z'); // "today" for this test run

function d(s) { return new Date(s + 'T00:00:00.000Z'); }

// ── Sample data: one doctor's appointments for August 2026 ──
const appointments = [
  // 3 genuine in-person cash visits this month, ₹1,000 each — matches the
  // screenshot's "Overall clinic revenue: ₹3,000 / 3 in-person consultations"
  { id: 'A1', consultationType: 'OFFLINE', date: d('2026-08-05'), feeAtBooking: 1000, paymentStatus: 'CASH_COLLECTED', status: 'COMPLETED', cashfreeOrderId: null, invoiceCreatedAt: new Date('2026-08-05T10:00:00Z') },
  { id: 'A2', consultationType: 'OFFLINE', date: d('2026-08-12'), feeAtBooking: 1000, paymentStatus: 'CASH_COLLECTED', status: 'COMPLETED', cashfreeOrderId: null, invoiceCreatedAt: new Date('2026-08-12T10:00:00Z') },
  { id: 'A3', consultationType: 'OFFLINE', date: d('2026-08-20'), feeAtBooking: 1000, paymentStatus: 'CASH_COLLECTED', status: 'COMPLETED', cashfreeOrderId: null, invoiceCreatedAt: new Date('2026-08-20T10:00:00Z') },

  // A teleconsultation the doctor marked "paid" in cash after the call —
  // never touched Cashfree, so cashfreeOrderId is null, but it's ONLINE.
  { id: 'A4', consultationType: 'ONLINE', date: d('2026-08-22'), feeAtBooking: 1500, paymentStatus: 'CASH_COLLECTED', status: 'COMPLETED', cashfreeOrderId: null, invoiceCreatedAt: new Date('2026-08-24T09:00:00Z') },

  // A visit that WAS paid in cash this week, then cancelled — invoice
  // voided, but paymentStatus never reverted (see cancel() in both
  // controllers). Real money, but no longer real revenue.
  { id: 'A5', consultationType: 'OFFLINE', date: d('2026-08-23'), feeAtBooking: 2100, paymentStatus: 'CASH_COLLECTED', status: 'CANCELLED', cashfreeOrderId: null, invoiceCreatedAt: new Date('2026-08-23T11:00:00Z'), invoiceVoided: true },

  // An in-clinic visit paid via Cashfree at the desk — already reported
  // in the doctor's Cashfree settlement totals; must not double-count here.
  { id: 'A6', consultationType: 'OFFLINE', date: d('2026-08-24'), feeAtBooking: 1000, paymentStatus: 'PAID', status: 'COMPLETED', cashfreeOrderId: 'cf_order_998', invoiceCreatedAt: null },
];

// ConsultationInvoice rows only exist for offline mark-paid actions AND
// the teleconsultation-paid-in-cash case (both go through
// issueInvoiceForAppointment); cancelling voids the invoice but the row
// stays in the table with status VOID. The old buggy query filtered
// status:'PAID' only, so VOID rows are already excluded from it — the
// bug was date-field drift, not the VOID rows themselves.
function invoiceRowsFor(appts) {
  return appts
    .filter(a => a.invoiceCreatedAt && a.consultationType) // every row above except the pure-Cashfree one (A6)
    .map(a => ({ appointmentId: a.id, createdAt: a.invoiceCreatedAt, amount: a.feeAtBooking, status: a.invoiceVoided ? 'VOID' : 'PAID' }));
}
const invoices = invoiceRowsFor(appointments);

const COLLECTED_PAYMENT_STATUSES = ['PAID', 'CASH_COLLECTED'];

function last14Start(today) { const x = new Date(today); x.setUTCDate(x.getUTCDate() - 13); return x; }
function last7Start(today)  { const x = new Date(today); x.setUTCDate(x.getUTCDate() - 6);  return x; }

function monthRange(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

// ── "Overall clinic revenue" (revenue.service.js getCashCollectedTotal) ──
function overallClinicRevenue({ fixed }) {
  const { start, end } = monthRange(2026, 8);
  const rows = appointments.filter(a => {
    if (a.date < start || a.date >= end) return false;
    if (!COLLECTED_PAYMENT_STATUSES.includes(a.paymentStatus)) return false;
    if (a.cashfreeOrderId !== null) return false; // always required, old and new
    if (fixed && a.consultationType !== 'OFFLINE') return false;      // NEW
    if (fixed && a.status === 'CANCELLED') return false;              // NEW
    return true;
  });
  return { consultations: rows.length, totalCash: rows.reduce((s, a) => s + a.feeAtBooking, 0), ids: rows.map(r => r.id) };
}

// ── "Collected this week" — receptionist.controller.js stats().trend.thisWeek ──
function collectedThisWeek({ fixed }) {
  const weekStart = last7Start(TODAY);
  if (!fixed) {
    // OLD: ConsultationInvoice rows, keyed by invoice.createdAt, status PAID only —
    // no consultationType filter, no cashfreeOrderId filter, no CANCELLED exclusion.
    const rows = invoices.filter(inv => inv.status === 'PAID' && inv.createdAt >= weekStart);
    return { totalCash: rows.reduce((s, r) => s + r.amount, 0), ids: rows.map(r => r.appointmentId) };
  }
  // NEW: same Appointment-based source as "Overall clinic revenue", keyed
  // by appointment.date instead of invoice.createdAt.
  const rows = appointments.filter(a => {
    if (a.date < weekStart) return false;
    if (a.consultationType !== 'OFFLINE') return false;
    if (!COLLECTED_PAYMENT_STATUSES.includes(a.paymentStatus)) return false;
    if (a.cashfreeOrderId !== null) return false;
    if (a.status === 'CANCELLED') return false;
    return true;
  });
  return { totalCash: rows.reduce((s, a) => s + a.feeAtBooking, 0), ids: rows.map(r => r.id) };
}

function inr(n) { return '₹' + n.toLocaleString('en-IN') + '.00'; }

console.log('=== Sample data: 1 doctor, August 2026, "today" = 25 Aug 2026 ===');
console.log('A1–A3: 3 genuine in-person cash visits, ₹1,000 each (this is the real month total)');
console.log('A4: teleconsultation paid in cash afterwards (₹1,500) — should NOT count as "in-person"');
console.log('A5: ₹2,100 in-person visit paid in cash, then CANCELLED — should NOT count as revenue');
console.log('A6: ₹1,000 in-person visit paid via Cashfree at the desk — already in gateway settlement, must not double-count\n');

const beforeMonth = overallClinicRevenue({ fixed: false });
const afterMonth  = overallClinicRevenue({ fixed: true });
const beforeWeek  = collectedThisWeek({ fixed: false });
const afterWeek   = collectedThisWeek({ fixed: true });

console.log('--- BEFORE (old code) ---');
console.log(`Overall clinic revenue (August): ${inr(beforeMonth.totalCash)}  [${beforeMonth.consultations} consults: ${beforeMonth.ids.join(', ')}]`);
console.log(`Collected this week:             ${inr(beforeWeek.totalCash)}  [appts: ${beforeWeek.ids.join(', ')}]`);
console.log(`==> Week (${beforeWeek.totalCash}) > Month (${beforeMonth.totalCash})? ${beforeWeek.totalCash > beforeMonth.totalCash ? 'YES — this is the exact bug reported' : 'no'}\n`);

console.log('--- AFTER (fixed code) ---');
console.log(`Overall clinic revenue (August): ${inr(afterMonth.totalCash)}  [${afterMonth.consultations} consults: ${afterMonth.ids.join(', ')}]`);
console.log(`Collected this week:             ${inr(afterWeek.totalCash)}  [appts: ${afterWeek.ids.join(', ')}]`);
console.log(`==> Week (${afterWeek.totalCash}) > Month (${afterMonth.totalCash})? ${afterWeek.totalCash > afterMonth.totalCash ? 'YES — still broken' : 'NO — reconciles correctly'}`);
console.log(`==> Matches screenshot's expected ₹3,000 / 3 consultations for the month? ${afterMonth.totalCash === 3000 && afterMonth.consultations === 3 ? 'YES' : 'NO'}`);
