/**
 * Cashfree Payment Gateway Integration — hardened
 * -----------------------------------------------------------------
 *  Adds:
 *   - hasRealCredentials() rejects placeholder values like "your_cashfree_app_id"
 *   - getOrderPayments() fetches the actual payment rows for an order
 *   - isOrderTrulyPaid() composite check: order_status PAID + a SUCCESS
 *     payment row whose amount matches the order amount
 *  This closes the "phantom confirmation" gap where Cashfree sandbox
 *  occasionally returns order_status: PAID without a real payment.
 * -----------------------------------------------------------------
 */
const crypto = require('crypto');

const PLACEHOLDER_PATTERN = /^(your_|<.*>|changeme|placeholder|undefined|null)/i;

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

function isPlaceholder(v) {
  if (!v) return true;
  return PLACEHOLDER_PATTERN.test(String(v).trim());
}

function hasRealCredentials() {
  const id  = process.env.CASHFREE_APP_ID;
  const key = process.env.CASHFREE_SECRET_KEY;
  if (!id || !key) return false;
  if (isPlaceholder(id) || isPlaceholder(key)) return false;
  return true;
}

async function createOrder({
  orderId, amount, currency = 'INR', customer,
  orderNote, orderTags, returnUrl, notifyUrl
}) {
  if (!hasRealCredentials()) {
    return {
      order_id: orderId || `order_mock_${Date.now()}`,
      order_amount: Number(amount),
      order_currency: currency,
      payment_session_id: `session_mock_${Date.now()}`,
      order_status: 'ACTIVE',
      mock: true
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

async function getOrderStatus(orderId) {
  if (!hasRealCredentials()) {
    return { order_id: orderId, order_status: 'ACTIVE', mock: true };
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

/**
 * NEW — fetch the actual payment attempts for an order.
 * Returns [] in mock mode (no real payments possible).
 * Used by isOrderTrulyPaid() to verify a real SUCCESS row exists.
 */
async function getOrderPayments(orderId) {
  if (!hasRealCredentials()) return [];
  const res = await fetch(
    `${getBaseUrl()}/pg/orders/${encodeURIComponent(orderId)}/payments`,
    { method: 'GET', headers: authHeaders() }
  );
  const data = await res.json().catch(() => ([]));
  if (!res.ok) {
    throw Object.assign(
      new Error((data && data.message) || 'Cashfree payments fetch failed'),
      { statusCode: 502, details: data }
    );
  }
  return Array.isArray(data) ? data : [];
}

/**
 * NEW — composite proof that an order is genuinely paid.
 * Returns: { paid: boolean, cfPaymentId?: string, reason?: string }
 *
 * Required signals:
 *   1. /pg/orders/:id           → order_status === 'PAID'
 *   2. /pg/orders/:id/payments  → at least one row with
 *        payment_status === 'SUCCESS' AND payment_amount == order amount
 *
 * If STRICT_PAYMENT_VERIFICATION is 'false', signal (2) is skipped
 * and only the order_status check is used (legacy behavior).
 */
async function isOrderTrulyPaid(orderId, expectedAmount) {
  const order = await getOrderStatus(orderId);
  const cfStatus = (order.order_status || '').toUpperCase();

  if (cfStatus !== 'PAID') {
    return { paid: false, reason: `order_status=${cfStatus}`, order };
  }

  // Mock mode never reaches here (mock returns ACTIVE).
  const strict = process.env.STRICT_PAYMENT_VERIFICATION !== 'false';
  if (!strict) {
    return { paid: true, reason: 'order_status=PAID (non-strict)', order };
  }

  const payments = await getOrderPayments(orderId);
  const successful = payments.find(p => {
    const status = String(p.payment_status || '').toUpperCase();
    const amt = Number(p.payment_amount);
    return status === 'SUCCESS' &&
           Number.isFinite(amt) &&
           Number.isFinite(Number(expectedAmount)) &&
           Math.abs(amt - Number(expectedAmount)) < 0.01;
  });
  if (!successful) {
    return {
      paid: false,
      reason: `order_status=PAID but no matching SUCCESS payment (got ${payments.length} rows)`,
      order, payments
    };
  }
  return {
    paid: true,
    reason: 'strict-verified',
    cfPaymentId: successful.cf_payment_id || successful.payment_id,
    order, payments
  };
}

/**
 * Refund a previously-paid order via Cashfree's PG refunds API.
 * `refundId` must be unique per refund attempt (Cashfree dedupes retries by
 * this id) — callers should derive it deterministically from the
 * appointment id rather than random, so a retried request after a network
 * timeout doesn't double-refund.
 */
async function createRefund({ orderId, refundId, refundAmount, refundNote }) {
  if (!hasRealCredentials()) {
    return {
      refund_id: refundId,
      cf_refund_id: `mock_refund_${Date.now()}`,
      refund_amount: Number(refundAmount),
      refund_status: 'SUCCESS',
      mock: true
    };
  }
  const response = await fetch(`${getBaseUrl()}/pg/orders/${encodeURIComponent(orderId)}/refunds`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      refund_id: refundId,
      refund_amount: Number(refundAmount),
      refund_note: refundNote || 'Appointment cancelled — refund issued by clinic admin'
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(
      new Error(data.message || data.type || 'Cashfree refund failed'),
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
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

module.exports = {
  createOrder,
  getOrderStatus,
  getOrderPayments,         // NEW
  isOrderTrulyPaid,         // NEW
  createRefund,
  verifyWebhookSignature,
  getMode,
  getWebhookSigningSecret,
  hasRealCredentials
};
