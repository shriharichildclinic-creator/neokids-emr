const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const c = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');

// Account-scoped brute-force guard, layered on top of server.js's IP-only
// publicLimiter on /api/auth (300 req/15min). That ceiling alone still lets
// a single IP make ~1200 login attempts/hour against one victim account, and
// a small botnet bypasses the IP key entirely. Keying by the submitted
// email/phone instead means spreading requests across many IPs doesn't help
// an attacker — the account itself is what's throttled.
function accountKey(req) {
  const id = String((req.body && (req.body.email || req.body.phone)) || '').trim().toLowerCase();
  return id || req.ip;
}
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: accountKey,
  message: { error: 'Too many login attempts for this account. Please wait a few minutes and try again.', code: 'RATE_LIMIT_ACCOUNT' }
});
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: accountKey,
  message: { error: 'Too many password reset requests for this account. Please wait a few minutes and try again.', code: 'RATE_LIMIT_ACCOUNT' }
});

router.post('/login', loginLimiter, c.login);
router.get('/me', authenticate, c.me);
router.post('/forgot-password', forgotPasswordLimiter, c.forgotPassword);
router.get('/password-token/:token', c.validatePasswordToken);
router.post('/reset-password', c.resetPassword);
router.post('/change-password', authenticate, c.changePassword);

module.exports = router;
