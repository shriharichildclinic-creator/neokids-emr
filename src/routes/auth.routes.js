const router = require('express').Router();
const c = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');

router.post('/login', c.login);
router.get('/me', authenticate, c.me);
router.post('/forgot-password', c.forgotPassword);
router.post('/reset-password', c.resetPassword);
router.post('/change-password', authenticate, c.changePassword);

module.exports = router;
