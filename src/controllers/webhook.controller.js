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

    const ok = cashfreeService.verifyWebhookSignature(
      rawBody,
      signature,
      timestamp,
      process.env.CASHFREE_WEBHOOK_SECRET
    );

    if (!ok) {
      logger.warn('Cashfree webhook signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString('utf-8'));
    const orderId = getValue(event, [
      'data.order.order_id',
      'order.order_id',
      'data.payment.order_id',
      'payment.order_id',
      'order_id'
    ]);
    const paymentId = getValue(event, [
      'data.payment.cf_payment_id',
      'payment.cf_payment_id',
      'cf_payment_id'
    ]);
    const paymentStatus = getValue(event, [
      'data.payment.payment_status',
      'payment.payment_status',
      'payment_status',
      'type'
    ]);

    logger.info('Cashfree event:', paymentStatus || 'unknown', orderId || 'no-order-id');

    if (paymentStatus === 'SUCCESS') {
      const appt = await prisma.appointment.findFirst({
        where: { cashfreeOrderId: orderId }
      });

      if (appt) {
        await bookingService.confirmOnlineBooking(appt.id, paymentId || orderId);
      } else {
        logger.warn('Cashfree webhook: no appointment for order', orderId);
      }
    } else if (['FAILED', 'CANCELLED', 'USER_DROPPED', 'NOT_ATTEMPTED'].includes(paymentStatus)) {
      await prisma.appointment.updateMany({
        where: { cashfreeOrderId: orderId },
        data: { paymentStatus: 'FAILED' }
      });
    }

    res.json({ received: true });
  } catch (e) {
    logger.error('Webhook error', e);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};
