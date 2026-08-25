// Shared payment-status vocabulary for appointment revenue calculations.
// "Collected" = money actually received (online Cashfree payment, or cash/
// card taken at the desk). "Pending" = billed but not yet received. Every
// controller that reports revenue must use the SAME two lists, so a
// dashboard never shows two different numbers for what "collected" means.
const COLLECTED_PAYMENT_STATUSES = ['PAID', 'CASH_COLLECTED'];
const PENDING_PAYMENT_STATUSES = ['CASH_PENDING'];

// A "phantom" appointment row: an unpaid-expired online booking, a
// Cashfree order-creation failure, or a gateway payment failure. These
// never became real bookings — no patient actually showed up, no slot was
// really held — they only exist as a DB row because the booking attempt
// was recorded before the payment was known to fail. They are reliably
// identified by this status+paymentStatus pair (a genuine cancellation by
// doctor/reception/patient never sets paymentStatus to FAILED).
//
// Every place in this codebase that counts/aggregates appointments for a
// human-facing total (dashboards, insights, cards) must exclude these the
// same way listAppointments/myAppointments/todayWaitingRoom already do —
// otherwise failed checkout attempts silently inflate "total" and
// "cancelled" counters and make the same doctor's numbers disagree
// between screens depending on whether that screen happened to filter
// them out.
const PHANTOM_APPOINTMENT_WHERE = { status: 'CANCELLED', paymentStatus: 'FAILED' };

module.exports = { COLLECTED_PAYMENT_STATUSES, PENDING_PAYMENT_STATUSES, PHANTOM_APPOINTMENT_WHERE };
