const router = require('express').Router();
const c      = require('../controllers/doctor.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const { uploadProfileImage } = require('../middleware/upload');

router.use(authenticate, requireRole('DOCTOR'));

router.get('/me',                                           c.me);
router.get('/stats',                                        c.stats);
router.put('/availability',                                 c.updateAvailability);
router.put('/fees',                                         c.updateFees);
router.put('/clinic',                                       c.updateClinic);          // Bug 6
router.post('/profile-image', uploadProfileImage.single('photo'), c.uploadProfileImage);
router.delete('/profile-image',                             c.removeProfileImage);

router.get('/appointments',                                 c.myAppointments);
router.get('/waiting-room',                                 c.todayWaitingRoom);
router.get('/appointments/:id',                             c.appointmentDetail);
router.post('/appointments/:id/prescription',               c.createPrescription);
router.post('/appointments/:id/reschedule',                 c.reschedule);
router.post('/appointments/:id/cancel',                     c.cancelAppointment);
router.post('/appointments/:id/complete',                   c.toggleComplete);
router.post('/appointments/:id/toggle-complete',            c.toggleComplete);

// Bug 3 — Doctor's pending follow-ups inbox
router.get('/follow-ups/pending',                           c.pendingFollowUps);

module.exports = router;
