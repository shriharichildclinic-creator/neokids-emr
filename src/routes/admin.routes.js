const router = require('express').Router();
const c = require('../controllers/admin.controller');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('ADMIN'));

router.get('/analytics', c.analytics);
router.post('/doctors', c.createDoctor);
router.get('/doctors', c.listDoctors);
router.put('/doctors/:id', c.updateDoctor);
router.delete('/doctors/:id', c.deleteDoctor);
router.delete('/doctors/:id/hard', c.hardDeleteDoctor);
router.get('/appointments', c.listAppointments);

module.exports = router;
