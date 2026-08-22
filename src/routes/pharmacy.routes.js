const router = require('express').Router();
const ph = require('../controllers/pharmacy.controller');
const notif = require('../controllers/notification.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const { uploadProfileImage } = require('../middleware/upload');

router.use(authenticate, requireRole('PHARMACY'));

router.get('/my-notifications',                notif.list);
router.get('/my-notifications/unread-count',   notif.unreadCount);
router.post('/my-notifications/:id/read',      notif.markRead);
router.post('/my-notifications/read-all',      notif.markAllRead);

router.get('/me',            ph.me);
router.post('/profile-image',   uploadProfileImage.single('photo'), ph.uploadProfileImage);
router.delete('/profile-image', ph.removeProfileImage);
router.get('/stats',         ph.stats);
router.get('/assignments',   ph.assignments);
router.get('/prescriptions', ph.myPrescriptions);
router.get('/patients',      ph.searchPatients);

router.get('/inventory',                       ph.listItems);
router.post('/inventory',                      ph.createItem);
router.put('/inventory/:id',                   ph.updateItem);
router.post('/inventory/:id/stock',            ph.adjustStock);
router.delete('/inventory/:id',                ph.deactivateItem);

router.get('/bills',            ph.listBills);
router.post('/bills',           ph.createBill);
router.get('/bills/:id',        ph.billDetail);
router.put('/bills/:id',        ph.updateBill);
router.post('/bills/:id/mark-paid', ph.markPaid);
router.post('/bills/:id/send',  ph.sendBill);

module.exports = router;