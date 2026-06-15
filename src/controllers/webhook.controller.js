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

exports.cashfree = async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody = req.body;

    const ok = cashfreeService.verifyWebhookSignature(rawBody, signature, timestamp);
    if (!ok) {
      logger.warn('Cashfree webhook signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }

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
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};
