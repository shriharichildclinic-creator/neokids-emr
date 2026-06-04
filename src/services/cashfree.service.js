/**
 * Cashfree Payment Gateway Integration
 * -----------------------------------------------------------------
 *  1. createOrder()            → create PG order from backend
 *  2. verifyWebhookSignature() → verify x-webhook-signature
 *  3. getOrderStatus()         → server-to-server source-of-truth check
 *                                (used when webhook is delayed)
 *
 *  IMPORTANT FACT (the source of all your previous webhook pain):
 *  Cashfree PG does NOT issue a separate "webhook secret".
 *  Webhooks are signed with your CASHFREE_SECRET_KEY (the same API
 *  Client Secret you use to call /pg/orders).
 *  Ref: https://www.cashfree.com/docs/payments/online/webhooks/signature-verification
 * -----------------------------------------------------------------
 */
const crypto = require('crypto');

function getMode() {
  return (process.env.CASHFREE_ENV ||
    (process.env.NODE_ENV === 'production' ? 'production' : 'sandbox')
  ).toLowerCase();
}

function getBaseUrl() {
  return getMode() === 'production'
    ? 'https://api.cashfree.com'
    : 'https://sandbox.cashfree.com';
}

function getWebhookSigningSecret() {
  return process.env.CASHFREE_WEBHOOK_SECRET_OVERRIDE
      || process.env.CASHFREE_SECRET_KEY;
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-client-id': process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
    'x-api-version': process.env.CASHFREE_API_VERSION || '2025-01-01'
  };
}

async function createOrder({
  orderId, amount, currency = 'INR', customer,
  orderNote, orderTags, returnUrl, notifyUrl
}) {
  if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
    return {
      order_id: orderId || `order_mock_${Date.now()}`,
      order_amount: Number(amount),
      order_currency: currency,
      payment_session_id: `session_mock_${Date.now()}`,
      order_status: 'ACTIVE'
    };
  }

  const apiBase = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
  const defaultReturn = `${apiBase}/payment-status?order_id={order_id}`;
  const defaultNotify = `${apiBase}/api/webhooks/cashfree`;

  const payload = {
    order_id: orderId,
    order_amount: Number(amount),
    order_currency: currency,
    customer_details: {
      customer_id: customer.customerId,
      customer_name: customer.customerName,
      customer_email: customer.customerEmail,
      customer_phone: customer.customerPhone
    },
    order_note: orderNote,
    order_meta: {
      return_url: returnUrl || defaultReturn,
      notify_url: notifyUrl || defaultNotify
    },
    order_tags: orderTags || {}
  };

  const response = await fetch(`${getBaseUrl()}/pg/orders`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(
      new Error(data.message || data.type || 'Cashfree order creation failed'),
      { statusCode: 502, details: data }
    );
  }
  return data;
}

/**
 * Server-to-server status check. Used by /payment-status page and the
 * /api/public/verify-payment endpoint as the SOURCE OF TRUTH when the
 * webhook hasn't fired yet (sandbox can take 30s–2min).
 */
async function getOrderStatus(orderId) {
  if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
    return { order_id: orderId, order_status: 'PAID', mock: true };
  }
  const res = await fetch(`${getBaseUrl()}/pg/orders/${encodeURIComponent(orderId)}`, {
    method: 'GET',
    headers: authHeaders()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(data.message || 'Cashfree order fetch failed'),
      { statusCode: 502, details: data }
    );
  }
  return data;
}

function verifyWebhookSignature(rawBody, signature, timestamp, secret) {
  if (!rawBody || !signature || !timestamp) return false;
  const key = secret || getWebhookSigningSecret();
  if (!key) return false;

  const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signedPayload = `${timestamp}${bodyString}`;

  const expected = crypto.createHmac('sha256', key).update(signedPayload).digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = {
  createOrder,
  getOrderStatus,
  verifyWebhookSignature,
  getMode,
  getWebhookSigningSecret
};
