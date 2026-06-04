// test-webhook.js — Windows-safe Cashfree webhook test
// Usage:
//   node test-webhook.js              → sends SUCCESS event
//   node test-webhook.js fail         → sends FAILED  event
//   node test-webhook.js success appt_xyz → custom order id
//
// No curl, no PowerShell escaping — pure Node http.

require('dotenv').config();
const crypto = require('crypto');
const http   = require('http');
const https  = require('https');
const url    = require('url');

const SECRET = process.env.CASHFREE_SECRET_KEY;
if (!SECRET) {
  console.error('❌ CASHFREE_SECRET_KEY not set in .env');
  process.exit(1);
}

const mode    = (process.argv[2] || 'success').toLowerCase();
const orderId = process.argv[3] || 'appt_test_' + Date.now();
const isSuccess = mode !== 'fail';

const payloadObj = isSuccess
  ? {
      data: {
        order:   { order_id: orderId, order_amount: 500, order_currency: 'INR', order_status: 'PAID' },
        payment: { cf_payment_id: 'cf_test_' + Date.now(), payment_status: 'SUCCESS', payment_amount: 500 }
      },
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      event_time: new Date().toISOString()
    }
  : {
      data: {
        order:   { order_id: orderId, order_amount: 500, order_currency: 'INR', order_status: 'ACTIVE' },
        payment: { cf_payment_id: 'cf_test_' + Date.now(), payment_status: 'FAILED', payment_amount: 500 }
      },
      type: 'PAYMENT_FAILED_WEBHOOK',
      event_time: new Date().toISOString()
    };

const payload   = JSON.stringify(payloadObj);
const timestamp = String(Date.now());
const signature = crypto.createHmac('sha256', SECRET).update(timestamp + payload).digest('base64');

const target = process.env.TEST_TARGET || 'http://localhost:' + (process.env.PORT || 3000);
const parsed = url.parse(target);
const lib    = parsed.protocol === 'https:' ? https : http;

console.log('────────────────────────────────────────────────');
console.log('Cashfree Webhook Test');
console.log('────────────────────────────────────────────────');
console.log('Target       :', target + '/api/webhooks/cashfree');
console.log('Mode         :', isSuccess ? 'SUCCESS' : 'FAIL');
console.log('Order ID     :', orderId);
console.log('Timestamp    :', timestamp);
console.log('Signature    :', signature);
console.log('Body length  :', Buffer.byteLength(payload), 'bytes');
console.log('Secret tail  : ...' + SECRET.slice(-8));
console.log('────────────────────────────────────────────────\n');

const options = {
  hostname: parsed.hostname,
  port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
  path:     '/api/webhooks/cashfree',
  method:   'POST',
  headers: {
    'Content-Type':        'application/json',
    'Content-Length':      Buffer.byteLength(payload),
    'x-webhook-signature': signature,
    'x-webhook-timestamp': timestamp,
    'x-webhook-version':   '2025-01-01'
  }
};

const req = lib.request(options, (res) => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    console.log('HTTP status :', res.statusCode);
    console.log('Response    :', data);
    console.log();
    if (res.statusCode === 200) {
      console.log('✅ WEBHOOK VERIFICATION PASSED');
      console.log('   The controller accepted the signature and processed the event.');
    } else if (res.statusCode === 400) {
      console.log('❌ WEBHOOK VERIFICATION FAILED (signature mismatch)');
      console.log('   Most likely cause: CASHFREE_SECRET_KEY in .env does not match the key');
      console.log('   the server is actually loading. Restart the server after editing .env.');
    } else {
      console.log('⚠️  Unexpected status. Check server logs.');
    }
  });
});

req.on('error', (e) => {
  console.error('❌ Request error:', e.message);
  console.error('   Is the server running on', target, '?');
});

req.write(payload);
req.end();
