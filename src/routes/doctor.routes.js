const router = require('express').Router();
const c      = require('../controllers/doctor.controller');
const earn   = require('../controllers/earnings.controller');
const kyc    = require('../controllers/kyc.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const { uploadProfileImage } = require('../middleware/upload');

router.use(authenticate, requireRole('DOCTOR'));

// ─── Profile / settings ───
router.get('/me',                                           c.me);
router.get('/stats',                                        c.stats);
router.put('/availability',                                 c.updateAvailability);
router.put('/fees',                                         c.updateFees);
router.put('/clinic',                                       c.updateClinic);
router.post('/profile-image', uploadProfileImage.single('photo'), c.uploadProfileImage);
router.delete('/profile-image',                             c.removeProfileImage);

// ─── KYC (self read-only) ───
router.get('/kyc',                                          kyc.myKycStatus);

// ─── Appointments ───
router.get('/appointments',                                 c.myAppointments);
router.get('/waiting-room',                                 c.todayWaitingRoom);
router.get('/appointments/:id',                             c.appointmentDetail);
router.post('/appointments/:id/reschedule',                 c.reschedule);
router.post('/appointments/:id/cancel',                     c.cancelAppointment);
router.post('/appointments/:id/complete',                   c.toggleComplete);
router.post('/appointments/:id/toggle-complete',            c.toggleComplete);

// ─── Bug 3 — Prescription endpoints ───
router.post('/appointments/:id/prescription',               c.createPrescription);
router.get('/appointments/:id/prescription',                c.appointmentPrescription);
router.post('/appointments/:id/prescription/resend',        c.resendPrescription);

// ─── Bug 2/5 — Patient identity & history ───
router.get('/patients/search',                              c.searchPatients);
router.get('/patients/:patientId/history',                  c.patientHistory);

// ─── Follow-ups inbox ───
router.get('/follow-ups/pending', c.pendingFollowUps);

// ─── My Earnings (Revenue Management — doctor view) ───
router.get('/earnings/my-dashboard',            earn.myDashboard);
router.get('/earnings/breakdown',               earn.breakdown);
router.get('/earnings/settlements',             earn.mySettlements);
router.get('/earnings/settlements/:id/invoice', earn.downloadMyInvoice);

module.exports = router;
