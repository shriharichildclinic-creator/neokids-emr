const router = require('express').Router();
const c = require('../controllers/admin.controller');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('ADMIN'));

router.get('/analytics',                  c.analytics);

// Doctors
router.post('/doctors',                   c.createDoctor);
router.get('/doctors',                    c.listDoctors);
router.get('/doctors/:id/insights',       c.doctorInsights);     // FIX 6
router.put('/doctors/:id',                c.updateDoctor);
router.delete('/doctors/:id',             c.deleteDoctor);
router.delete('/doctors/:id/hard',        c.hardDeleteDoctor);

// Appointments
router.get('/appointments',               c.listAppointments);

// Notifications  (FIX 7)
router.get('/notifications',              c.listNotifications);
router.get('/notifications/templates',    c.listNotificationTemplates);

module.exports = router;
