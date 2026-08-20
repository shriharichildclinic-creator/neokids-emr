const router = require('express').Router();
const c      = require('../controllers/admin.controller');
const clinic = require('../controllers/admin-clinic.controller');
const fin  = require('../controllers/finance.controller');
const kyc  = require('../controllers/kyc.controller');
const cert = require('../controllers/certificate.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  uploadKycDocuments, KYC_FIELDS
} = require('../middleware/upload');

router.use(authenticate, requireRole('ADMIN'));

router.get('/analytics', c.analytics);

// Doctors
router.post('/doctors', c.createDoctor);
router.get('/doctors', c.listDoctors);
router.get('/doctors/:id/insights', c.doctorInsights);
router.put('/doctors/:id', c.updateDoctor);
router.delete('/doctors/:id', c.deleteDoctor);
router.delete('/doctors/:id/hard', c.hardDeleteDoctor);

// KYC
router.post('/doctors/:id/kyc',         uploadKycDocuments.fields(KYC_FIELDS), kyc.uploadKyc);
router.get('/doctors/:id/kyc',          kyc.getKyc);
router.patch('/doctors/:id/kyc/status', kyc.updateKycStatus);

// Protected KYC document streaming (replaces the removed public static
// mount on /files/kyc-documents — audit finding #2). Admin JWT required.
router.get('/kyc/:doctorId/:kind', kyc.streamKycDocument);

// Appointments
router.get('/appointments', c.listAppointments);

// Feature 2 — Medical certificates (admin can view all)
router.get('/certificates/templates', cert.listTemplates);
router.get('/certificates',           cert.list);
router.get('/certificates/:id',       cert.detail);

// Notifications
router.get('/notifications', c.listNotifications);
router.get('/notifications/templates', c.listNotificationTemplates);

// Automation — manual trigger for the vaccination reminder scan (testing/ops)
router.post('/jobs/vaccination-reminders/run', c.runVaccinationReminders);

// v4.0.0 — Medical Centres (clinics / branches)
router.post('/medical-centres',       clinic.createCentre);
router.get('/medical-centres',        clinic.listCentres);
router.put('/medical-centres/:id',    clinic.updateCentre);
router.delete('/medical-centres/:id', clinic.deleteCentre);

// v4.0.0 — Receptionists (created by Admin only; no self-registration)
router.post('/receptionists',       clinic.createReceptionist);
router.get('/receptionists',        clinic.listReceptionists);
router.get('/receptionists/:id',    clinic.getReceptionist);
router.put('/receptionists/:id',    clinic.updateReceptionist);
router.delete('/receptionists/:id', clinic.deleteReceptionist);

// v4.0.0 — Pharmacy users (separate role; no receptionist permissions)
router.post('/pharmacy-users',       clinic.createPharmacyUser);
router.get('/pharmacy-users',        clinic.listPharmacyUsers);
router.get('/pharmacy-users/:id',    clinic.getPharmacyUser);
router.put('/pharmacy-users/:id',    clinic.updatePharmacyUser);
router.delete('/pharmacy-users/:id', clinic.deletePharmacyUser);

// v4.0.0 — Front-desk finance & audit
router.get('/available-offline-doctors', c.availableOfflineDoctors);
router.get('/consultation-invoices',     c.consultationInvoices);
router.get('/pharmacy/bills',            clinic.listPharmacyBillsAdmin);
router.get('/audit-trail',               c.auditTrail);

// Revenue Management
router.get('/finance/revenue-report', fin.revenueReport);
router.get('/finance/settlements', fin.listSettlements);
router.get('/finance/settlements/:id', fin.settlementDetail);
router.post('/finance/settlements/generate', fin.generateSettlement);
router.post('/finance/settlements/:id/mark-paid', fin.markSettlementPaid);
router.get('/finance/invoices', fin.listInvoices);
router.get('/finance/invoices/:settlementId/download', fin.downloadInvoice);

module.exports = router;
