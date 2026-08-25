const router = require('express').Router();
const c      = require('../controllers/admin.controller');
const clinic = require('../controllers/admin-clinic.controller');
const fin  = require('../controllers/finance.controller');
const kyc  = require('../controllers/kyc.controller');
const cert = require('../controllers/certificate.controller');
const dataMgmt = require('../controllers/admin-data.controller');
const notif = require('../controllers/notification.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  uploadKycDocuments, KYC_FIELDS, uploadProfileImage
} = require('../middleware/upload');

router.use(authenticate, requireRole('ADMIN'));

// NOTE: named "my-notifications" (not "/notifications") — this route file
// already has a pre-existing GET /notifications (c.listNotifications, the
// WhatsApp/email delivery audit log below). Reusing that path here silently
// shadowed it, since Express matches route registration order and this
// handler always responds instead of calling next().
router.get('/my-notifications',                notif.list);
router.get('/my-notifications/unread-count',   notif.unreadCount);
router.post('/my-notifications/:id/read',      notif.markRead);
router.post('/my-notifications/read-all',      notif.markAllRead);

router.get('/analytics', c.analytics);

// Admin's own profile photo (self-service)
router.post('/profile-image', uploadProfileImage.single('photo'), c.uploadOwnProfileImage);
router.delete('/profile-image', c.removeOwnProfileImage);

// Data Management — permanent deletion. Kept apart from the regular
// Doctors/Patients screens on purpose: same admin auth as every other
// route here, but a separate, clearly-labeled surface for an irreversible
// action, not something one accidental click away from Edit/Deactivate.
router.get('/data-management/search', dataMgmt.search);
router.get('/data-management/patients/:id', dataMgmt.patientDetail);
router.get('/data-management/doctors/:id', dataMgmt.doctorDetail);
router.delete('/data-management/patients/:id', dataMgmt.purgePatient);
router.delete('/data-management/doctors/:id', dataMgmt.purgeDoctor);
router.get('/data-management/medical-centres/:id', dataMgmt.medicalCentreDetail);
router.get('/data-management/receptionists/:id', dataMgmt.receptionistDetail);
router.get('/data-management/pharmacy-users/:id', dataMgmt.pharmacyUserDetail);
router.delete('/data-management/medical-centres/:id', dataMgmt.purgeMedicalCentre);
router.delete('/data-management/receptionists/:id', dataMgmt.purgeReceptionist);
router.delete('/data-management/pharmacy-users/:id', dataMgmt.purgePharmacyUser);

// Doctors
router.post('/doctors', c.createDoctor);
router.get('/doctors', c.listDoctors);
router.get('/doctors/:id/insights', c.doctorInsights);
router.put('/doctors/:id', c.updateDoctor);
router.delete('/doctors/:id', c.deleteDoctor);
router.delete('/doctors/:id/hard', c.hardDeleteDoctor);
router.post('/doctors/:id/invite', c.sendDoctorInvite);
router.post('/doctors/:id/invite/whatsapp', c.sendDoctorInviteWhatsapp);
router.post('/doctors/:id/profile-image', uploadProfileImage.single('photo'), c.uploadDoctorProfileImage);
router.delete('/doctors/:id/profile-image', c.removeDoctorProfileImage);

// KYC
router.post('/doctors/:id/kyc',          uploadKycDocuments.fields(KYC_FIELDS), kyc.uploadKyc);
router.get('/doctors/:id/kyc',           kyc.getKyc);
router.patch('/doctors/:id/kyc/status',  kyc.updateKycStatus);
router.delete('/doctors/:id/kyc/:kind',  kyc.removeKycDocument);

// Protected KYC document streaming (replaces the removed public static
// mount on /files/kyc-documents — audit finding #2). Admin JWT required.
router.get('/kyc/:doctorId/:kind', kyc.streamKycDocument);

// Appointments
router.get('/appointments', c.listAppointments);
router.post('/appointments/:id/refund', c.refundAppointment);

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
router.post('/medical-centres/:id/activate', clinic.activateCentre);

// v4.0.0 — Receptionists (created by Admin only; no self-registration)
router.post('/receptionists',       clinic.createReceptionist);
router.get('/receptionists',        clinic.listReceptionists);
router.get('/receptionists/:id',    clinic.getReceptionist);
router.put('/receptionists/:id',    clinic.updateReceptionist);
router.delete('/receptionists/:id', clinic.deleteReceptionist);
router.post('/receptionists/:id/invite', clinic.sendReceptionistInvite);
router.post('/receptionists/:id/profile-image', uploadProfileImage.single('photo'), clinic.uploadReceptionistProfileImage);
router.delete('/receptionists/:id/profile-image', clinic.removeReceptionistProfileImage);

// v4.0.0 — Pharmacy users (separate role; no receptionist permissions)
router.post('/pharmacy-users',       clinic.createPharmacyUser);
router.get('/pharmacy-users',        clinic.listPharmacyUsers);
router.get('/pharmacy-users/:id',    clinic.getPharmacyUser);
router.put('/pharmacy-users/:id',    clinic.updatePharmacyUser);
router.delete('/pharmacy-users/:id', clinic.deletePharmacyUser);
router.post('/pharmacy-users/:id/invite', clinic.sendPharmacyInvite);
router.post('/pharmacy-users/:id/profile-image', uploadProfileImage.single('photo'), clinic.uploadPharmacyUserProfileImage);
router.delete('/pharmacy-users/:id/profile-image', clinic.removePharmacyUserProfileImage);

// v4.0.0 — Front-desk finance & audit
router.get('/available-offline-doctors', c.availableOfflineDoctors);
router.get('/consultation-invoices',     c.consultationInvoices);
router.get('/online-invoices',           c.onlineInvoices);
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
