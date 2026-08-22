// Shared payment-status vocabulary for appointment revenue calculations.
// "Collected" = money actually received (online Cashfree payment, or cash/
// card taken at the desk). "Pending" = billed but not yet received. Every
// controller that reports revenue must use the SAME two lists, so a
// dashboard never shows two different numbers for what "collected" means.
const COLLECTED_PAYMENT_STATUSES = ['PAID', 'CASH_COLLECTED'];
const PENDING_PAYMENT_STATUSES = ['CASH_PENDING'];

module.exports = { COLLECTED_PAYMENT_STATUSES, PENDING_PAYMENT_STATUSES };
