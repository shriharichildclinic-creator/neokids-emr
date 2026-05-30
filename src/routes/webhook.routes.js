const router = require('express').Router();
const c = require('../controllers/webhook.controller');

// Raw body parser is applied at app-level for this route
router.post('/cashfree', c.cashfree);

module.exports = router;
