const router = require('express').Router();
const c = require('../controllers/public.controller');

router.get('/doctors', c.listDoctors);
router.get('/doctors/:id', c.doctorDetail);
router.get('/slots', c.getSlots);
router.post('/book', c.book);
router.get('/appointments/:id', c.appointmentStatus);

module.exports = router;
