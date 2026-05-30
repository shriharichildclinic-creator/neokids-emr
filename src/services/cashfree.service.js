/**
 * Cashfree Payment Gateway Integration
 * - Create order from backend
 * - Verify webhook signature using timestamp + raw payload
 */
const crypto = require('crypto');

function getMode() {
  return (process.env.CASHFREE_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'sandbox')).toLowerCase();
}

function getBaseUrl() {
  return getMode() === 'production'
    ? 'https://api.cashfree.com'
    : 'https://sandbox.cashfree.com';
}

async function createOrder({ orderId, amount, currency = 'INR', customer, orderNote, orderTags, returnUrl, notifyUrl }) {
  if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
    return {
      order_id: orderId || `order_mock_${Date.now()}`,
      order_amount: Number(amount),
      order_currency: currency,
      payment_session_id: `session_mock_${Date.now()}`,
      order_status: 'ACTIVE'
    };
  }

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
      return_url: returnUrl || `${process.env.APP_URL}/payment-status?order_id={order_id}`,
      notify_url: notifyUrl || `${process.env.API_URL}/api/webhooks/cashfree`
    },
    order_tags: orderTags || {}
  };

  const response = await fetch(`${getBaseUrl()}/pg/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': process.env.CASHFREE_APP_ID,
      'x-client-secret': process.env.CASHFREE_SECRET_KEY,
      'x-api-version': process.env.CASHFREE_API_VERSION || '2025-01-01'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.message || data.type || 'Cashfree order creation failed'), {
      statusCode: 502,
      details: data
    });
  }
  return data;
}

function verifyWebhookSignature(rawBody, signature, timestamp, secret) {
  if (!rawBody || !signature || !timestamp) return false;
  const payload = `${timestamp}${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)}`;
  const expected = crypto
    .createHmac('sha256', secret || process.env.CASHFREE_WEBHOOK_SECRET)
    .update(payload)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

module.exports = { createOrder, verifyWebhookSignature, getMode };
