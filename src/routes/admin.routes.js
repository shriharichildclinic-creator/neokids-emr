const router = require('express').Router();
const c    = require('../controllers/admin.controller');
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

// Appointments
router.get('/appointments', c.listAppointments);

// Feature 2 — Medical certificates (admin can view all)
router.get('/certificates/templates', cert.listTemplates);
router.get('/certificates',           cert.list);
router.get('/certificates/:id',       cert.detail);

// Notifications
router.get('/notifications', c.listNotifications);
router.get('/notifications/templates', c.listNotificationTemplates);

// Revenue Management
router.get('/finance/revenue-report', fin.revenueReport);
router.get('/finance/settlements', fin.listSettlements);
router.get('/finance/settlements/:id', fin.settlementDetail);
router.post('/finance/settlements/generate', fin.generateSettlement);
router.post('/finance/settlements/:id/mark-paid', fin.markSettlementPaid);
router.get('/finance/invoices', fin.listInvoices);
router.get('/finance/invoices/:settlementId/download', fin.downloadInvoice);

module.exports = router;
