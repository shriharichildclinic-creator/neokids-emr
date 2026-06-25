const logger = require('../utils/logger');
const cashfreeService = require('../services/cashfree.service');
const bookingService = require('../services/booking.service');
const prisma = require('../config/prisma');

function getValue(event, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => acc && acc[key], event);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// Issue #23 — uniform external response.
//
// We log internally with a fine-grained reason ('missing-signature',
// 'missing-timestamp', 'bad-signature', 'stale-timestamp', etc.) so the
// SOC and the on-call engineer can tell what's happening — but the
// public response is always the same generic 401 with no body hint.
// This denies free reconnaissance to anyone scripting signature-replay
// probes against the unauthenticated webhook endpoint.
//
// Pair this with the dedicated webhookLimiter mounted in server.js
// (also from #23): a brute-force probe gets rate-limited *and* gets no
// useful feedback even when it's not throttled.
const WEBHOOK_TIMESTAMP_MAX_SKEW_MS = 5 * 60 * 1000;   // 5 min

function _reject(res, reason) {
  // Internal-only telemetry — never sent to the client.
  logger.warn(`Cashfree webhook rejected: ${reason}`);
  return res.status(401).json({ error: 'Unauthorized' });
}

exports.cashfree = async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody   = req.body;

    // All of these failure modes return the SAME response. We log the
    // distinct reason server-side but never expose which check failed.
    if (!signature)         return _reject(res, 'missing-signature-header');
    if (!timestamp)         return _reject(res, 'missing-timestamp-header');
    if (!rawBody)           return _reject(res, 'missing-body');

    // Timestamp skew check — same uniform 401 if the timestamp is
    // unparseable or too old. Replay attempts that try to reuse an
    // old signed payload get caught here.
    const tsMs = Number(timestamp) > 1e12 ? Number(timestamp) : Number(timestamp) * 1000;
    if (!Number.isFinite(tsMs))                                  return _reject(res, 'malformed-timestamp');
    if (Math.abs(Date.now() - tsMs) > WEBHOOK_TIMESTAMP_MAX_SKEW_MS) {
      return _reject(res, 'stale-timestamp');
    }

    const ok = cashfreeService.verifyWebhookSignature(rawBody, signature, timestamp);
    if (!ok) return _reject(res, 'signature-mismatch');

    // ── Signature verified, real processing begins ──
    const event = JSON.parse(rawBody.toString('utf-8'));
    const orderId = getValue(event, [
      'data.order.order_id', 'order.order_id',
      'data.payment.order_id', 'payment.order_id', 'order_id'
    ]);
    const paymentId = getValue(event, [
      'data.payment.cf_payment_id', 'payment.cf_payment_id', 'cf_payment_id'
    ]);
    const paymentStatus = getValue(event, [
      'data.payment.payment_status', 'payment.payment_status',
      'payment_status', 'type'
    ]);
    const paymentAmount = Number(getValue(event, [
      'data.payment.payment_amount', 'payment.payment_amount', 'payment_amount'
    ]));

    logger.info('Cashfree event:', paymentStatus || 'unknown', orderId || 'no-order-id');

    if (paymentStatus === 'SUCCESS') {
      const appt = await prisma.appointment.findFirst({
        where: { cashfreeOrderId: orderId }
      });
      if (!appt) {
        logger.warn('Cashfree webhook: no appointment for order', orderId);
        return res.json({ received: true });
      }

      // Bug 1 hardening — re-verify with Cashfree before confirming.
      // The webhook is signed, but a replay/forgery beyond our control could
      // still arrive. Server-to-server check + amount match is bulletproof.
      const verdict = await cashfreeService
        .isOrderTrulyPaid(orderId, appt.feeAtBooking)
        .catch(e => ({ paid: false, reason: `verify-error:${e.message}` }));

      if (!verdict.paid) {
        logger.warn(
          `Webhook SUCCESS rejected — verification failed. order=${orderId} reason=${verdict.reason}`
        );
        return res.json({ received: true, accepted: false, reason: verdict.reason });
      }

      // Optional sanity check on the webhook's own amount field
      if (Number.isFinite(paymentAmount) &&
          Math.abs(paymentAmount - Number(appt.feeAtBooking)) > 0.01) {
        logger.warn(
          `Webhook amount mismatch order=${orderId} ` +
          `webhook=${paymentAmount} appt=${appt.feeAtBooking}`
        );
        return res.json({ received: true, accepted: false, reason: 'amount-mismatch' });
      }

      await bookingService.confirmOnlineBooking(appt.id, verdict.cfPaymentId || paymentId || orderId);
    } else if (['FAILED', 'CANCELLED', 'USER_DROPPED', 'NOT_ATTEMPTED'].includes(paymentStatus)) {
      await prisma.appointment.updateMany({
        where: {
          cashfreeOrderId: orderId,
          paymentStatus: { not: 'PAID' },
          status: { not: 'CANCELLED' }
        },
        data: { paymentStatus: 'FAILED' }
      });
    }

    res.json({ received: true });
  } catch (e) {
    logger.error('Webhook error', e);
    // Even processing errors after signature verification get a generic
    // body to deny probing leverage.
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};
