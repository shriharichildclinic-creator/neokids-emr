const router = require('express').Router();
const c      = require('../controllers/doctor.controller');
const earn   = require('../controllers/earnings.controller');
const kyc    = require('../controllers/kyc.controller');
const hist   = require('../controllers/historical.controller');
const cert   = require('../controllers/certificate.controller');
const sig    = require('../controllers/signature.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  uploadProfileImage,
  uploadSignature,
  uploadHistoricalPrescription
} = require('../middleware/upload');

router.use(authenticate, requireRole('DOCTOR'));

// ─── Profile / settings ───
router.get('/me',                                           c.me);
router.get('/stats',                                        c.stats);
router.put('/availability',                                 c.updateAvailability);
router.put('/fees',                                         c.updateFees);
router.put('/clinic',                                       c.updateClinic);
router.post('/profile-image', uploadProfileImage.single('photo'), c.uploadProfileImage);
router.delete('/profile-image',                             c.removeProfileImage);

// ─── Feature 3 — Doctor digital signature ───
router.get('/signature',                                    sig.get);
router.post('/signature', uploadSignature.single('signature'), sig.upload);
router.delete('/signature',                                 sig.remove);
router.put('/registration-number',                          sig.updateRegistration);

// ─── KYC (self read-only) ───
router.get('/kyc',                                          kyc.myKycStatus);

// ─── Appointments ───
router.get('/appointments',                                 c.myAppointments);
router.get('/waiting-room',                                 c.todayWaitingRoom);
// Feature 1 lookup MUST be registered before /appointments/:id
router.get('/appointments/lookup-patient',                  hist.lookupPatient);
router.get('/appointments/:id',                             c.appointmentDetail);
router.post('/appointments/:id/reschedule',                 c.reschedule);
router.post('/appointments/:id/cancel',                     c.cancelAppointment);
router.post('/appointments/:id/complete',                   c.toggleComplete);
router.post('/appointments/:id/toggle-complete',            c.toggleComplete);

// ─── Feature 1 — Historical / Manual appointment records ───
router.post(
  '/historical-appointments',
  uploadHistoricalPrescription.single('prescriptionFile'),
  hist.create
);

// ─── Prescription endpoints ───
router.post('/appointments/:id/prescription',               c.createPrescription);
router.get('/appointments/:id/prescription',                c.appointmentPrescription);
router.post('/appointments/:id/prescription/resend',        c.resendPrescription);

// ─── Feature 2 — Medical certificate endpoints ───
router.get('/certificates/templates',                       cert.listTemplates);
router.get('/certificates',                                 cert.list);
router.get('/certificates/:id',                             cert.detail);
router.post('/certificates',                                cert.create);
router.post('/appointments/:id/certificate',                cert.createForAppointment);

// ─── Patient identity & history ───
router.get('/patients/search',                              c.searchPatients);
router.get('/patients/:patientId/history',                  c.patientHistory);

// ─── Follow-ups inbox ───
router.get('/follow-ups/pending', c.pendingFollowUps);

// ─── My Earnings ───
router.get('/earnings/my-dashboard',            earn.myDashboard);
router.get('/earnings/breakdown',               earn.breakdown);
router.get('/earnings/settlements',             earn.mySettlements);
router.get('/earnings/settlements/:id/invoice', earn.downloadMyInvoice);

module.exports = router;
