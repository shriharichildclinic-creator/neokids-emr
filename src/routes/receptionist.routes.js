const router = require('express').Router();
const c      = require('../controllers/receptionist.controller');
const cert   = require('../controllers/certificate.controller');
const ph     = require('../controllers/pharmacy.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const { uploadProfileImage } = require('../middleware/upload');

router.use(authenticate, requireRole('RECEPTIONIST'));

router.get('/me',           c.me);
router.post('/profile-image',   uploadProfileImage.single('photo'), c.uploadProfileImage);
router.delete('/profile-image', c.removeProfileImage);
router.get('/stats',        c.stats);
router.get('/assignments',  c.assignments);
router.get('/slots',        c.slots);

router.get('/patients',        c.searchPatients);
router.post('/patients',       c.registerPatient);
router.get('/patients/:id/history', c.patientHistory);

router.get('/appointments',                      c.listAppointments);
router.post('/appointments',                     c.createAppointment);
router.get('/appointments/:id',                  c.appointmentDetail);
router.post('/appointments/:id/reschedule',      c.reschedule);
router.post('/appointments/:id/cancel',          c.cancel);
router.post('/appointments/:id/arrive',          c.markArrived);
router.post('/appointments/:id/mark-paid',       c.markPaid);
router.post('/appointments/:id/invoice',         c.generateInvoice);
router.post('/appointments/:id/prescription',    c.createPrescription);
router.get('/appointments/:id/prescription',     c.appointmentPrescription);

router.get('/invoices',          c.listInvoices);
router.get('/invoices/:id',      c.invoiceDetail);
router.post('/invoices/:id/send', c.sendInvoice);

router.get('/certificates/templates',            cert.listTemplates);
router.get('/certificates',                      c.listCertificates);
router.get('/certificates/:id',                  c.certificateDetail);
router.post('/certificates',                     c.issueCertificate);
router.post('/certificates/:id/send',            c.sendCertificate);
router.post('/appointments/:id/certificate',     c.issueCertificateForAppointment);

router.get('/pharmacy/prescriptions',            ph.myPrescriptions);
router.get('/pharmacy/inventory',                ph.listItems);
router.get('/pharmacy/bills',                    ph.listBills);
router.post('/pharmacy/bills',                   ph.createBill);
router.get('/pharmacy/bills/:id',                ph.billDetail);
router.put('/pharmacy/bills/:id',                ph.updateBill);
router.post('/pharmacy/bills/:id/mark-paid',     ph.markPaid);
router.post('/pharmacy/bills/:id/send',          ph.sendBill);

module.exports = router;