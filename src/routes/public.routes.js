const router = require('express').Router();
const c = require('../controllers/public.controller');

router.get('/doctors',           c.listDoctors);
router.get('/doctors/:id',       c.doctorDetail);
router.get('/slots',             c.getSlots);
router.post('/book',             c.book);
router.get('/appointments/:id',  c.appointmentStatus);

// Force-verify payment with Cashfree (bypasses webhook delay).
// Used by /payment-status page AND by the booking widget after checkout.
router.get('/verify-payment',    c.verifyPayment);

// Follow-up recall pre-fill (idempotent GET, no auth)
router.get('/recall/:id',        c.recallPrefill);

module.exports = router;
