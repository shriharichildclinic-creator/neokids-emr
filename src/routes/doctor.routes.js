const router = require('express').Router();
const c      = require('../controllers/doctor.controller');
const earn   = require('../controllers/earnings.controller');
const kyc    = require('../controllers/kyc.controller');
const hist   = require('../controllers/historical.controller');
const prev   = require('../controllers/previous.controller');
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
router.get('/signature/file',                               sig.streamFile);
router.post('/signature', uploadSignature.single('signature'), sig.upload);
router.post('/signature/drawn',                             sig.uploadDrawn);
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
router.post('/appointments/:id/mark-paid',                  c.markPaid);

// ─── Legacy historical-appointment flow retained for backward compatibility ───
router.post(
  '/historical-appointments',
  uploadHistoricalPrescription.single('prescriptionFile'),
  hist.create
);

// ─── Previous Records (doctor-only feature flag) ───
// The controller export is a raw function (NOT an array with
// inline multer). The single/array multer middleware lives here on the
// route, so the request body is parsed exactly ONCE and req.body keeps
// the same shape the controller expects (Zod-validated, empty-string
// tolerant, PATCH-style). This was the second cause of "Invalid input for
// database operation" — double-multer parsed the multipart stream twice,
// stripping all text fields after the file.
router.get('/previous-records/permission',                  prev.permission);
// Doctor-wide list with search/filter/pagination for the
// refactored Historical Records panel. Must be registered BEFORE
// `/previous-records/:id` so the literal “/permission” & bare list
// don’t collide with the `:id` route.
router.get('/previous-records',                             prev.listAllForDoctor);
router.get('/previous-records/:id',                         prev.detail);
router.get('/patients/:patientId/previous-records',         prev.listForPatient);
// Patient Linkage — generic create endpoint that does NOT
// force a patientId from the URL. Used by the current Add/Edit modal
// for BOTH branches (existing patient chosen via search, or a legacy/
// historical patient entered manually) — patientSource + patientId /
// legacyPatient* fields travel in the body and prev.create()'s
// resolvePatientLink() decides which branch applies. The older
// `/patients/:patientId/previous-records` route below is kept exactly
// as-is for backward compatibility with any existing callers.
router.post(
  '/previous-records',
  uploadHistoricalPrescription.array('attachment', 20),
  prev.create
);
router.post(
  '/patients/:patientId/previous-records',
  uploadHistoricalPrescription.array('attachment', 20),
  (req, _res, next) => {
    req.body = { ...(req.body || {}), patientId: req.params.patientId, patientSource: 'EXISTING' };
    next();
  },
  prev.create
);
router.put(
  '/previous-records/:id',
  uploadHistoricalPrescription.array('attachment', 20),
  prev.update
);
router.delete('/previous-records/:id',                      prev.remove);

router.post(
  '/previous-records/:id/attachments',
  uploadHistoricalPrescription.array('attachment', 20),
  prev.addAttachments
);
router.post(
  '/previous-records/:id/attachments/:attachmentId/replace',
  uploadHistoricalPrescription.single('attachment'),
  prev.replaceAttachment
);
// Rename / re-categorize / annotate an attachment without a
// re-upload, and persist a manual drag-reorder of the attachment list.
// The literal `/reorder` path is registered before the `:attachmentId`
// PATCH so it can never be swallowed by the param route.
router.patch(
  '/previous-records/:id/attachments/reorder',
  prev.reorderAttachments
);
router.patch(
  '/previous-records/:id/attachments/:attachmentId',
  prev.updateAttachmentMeta
);
router.delete(
  '/previous-records/:id/attachments/:attachmentId',
  prev.deleteAttachment
);
router.post('/previous-records/:id/generate-pdf',           prev.generatePdf);
router.post('/previous-records/:id/share',                  prev.share);

// ─── Prescription endpoints ───
router.post('/appointments/:id/prescription',               c.createPrescription);
router.get('/appointments/:id/prescription',                c.appointmentPrescription);
router.post('/appointments/:id/prescription/resend',        c.resendPrescription);

// ─── Feature 2 — Medical certificate endpoints ───
router.get('/certificates/templates',                       cert.listTemplates);
router.get('/certificates',                                 cert.list);
router.get('/certificates/:id',                             cert.detail);
router.post('/certificates',                                cert.create);
router.put('/certificates/:id',                             cert.update);
router.post('/certificates/:id/send',                       cert.send);   // WhatsApp/email delivery
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
