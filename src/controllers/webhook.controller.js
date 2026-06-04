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
    const rawBody   = req.body; // Buffer (thanks to express.raw())

    const ok = cashfreeService.verifyWebhookSignature(rawBody, signature, timestamp);

    if (!ok) {
      logger.warn('Cashfree webhook signature mismatch', {
        hasSig: !!signature,
        hasTs:  !!timestamp,
        bodyLen: rawBody ? rawBody.length : 0,
        keyConfigured: !!process.env.CASHFREE_SECRET_KEY,
        bodyPreview: rawBody ? rawBody.toString('utf8').slice(0, 120) : ''
      });
      return res.status(400).json({ error: 'Invalid signature' });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString('utf-8'));
    } catch (e) {
      logger.error('Cashfree webhook: invalid JSON body');
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const orderId = getValue(event, [
      'data.order.order_id', 'order.order_id',
      'data.payment.order_id', 'payment.order_id', 'order_id'
    ]);
    const paymentId = getValue(event, [
      'data.payment.cf_payment_id', 'payment.cf_payment_id', 'cf_payment_id'
    ]);
    const paymentStatus = getValue(event, [
      'data.payment.payment_status', 'payment.payment_status', 'payment_status'
    ]);
    const eventType = event.type || event.event;

    logger.info(`Cashfree webhook OK · type=${eventType || '-'} status=${paymentStatus || '-'} order=${orderId || '-'}`);

    const SUCCESS_STATES = ['SUCCESS', 'PAID'];
    const SUCCESS_TYPES  = ['PAYMENT_SUCCESS_WEBHOOK'];
    const FAIL_STATES    = ['FAILED', 'CANCELLED', 'USER_DROPPED', 'NOT_ATTEMPTED'];
    const FAIL_TYPES     = ['PAYMENT_FAILED_WEBHOOK', 'PAYMENT_USER_DROPPED_WEBHOOK'];

    const isSuccess = SUCCESS_STATES.includes(paymentStatus) || SUCCESS_TYPES.includes(eventType);
    const isFailure = FAIL_STATES.includes(paymentStatus)    || FAIL_TYPES.includes(eventType);

    if (isSuccess && orderId) {
      const appt = await prisma.appointment.findFirst({ where: { cashfreeOrderId: orderId } });
      if (appt) {
        await bookingService.confirmOnlineBooking(appt.id, paymentId || orderId);
        logger.info(`✅ Appointment ${appt.id} marked PAID via webhook`);
      } else {
        logger.warn(`Cashfree webhook: no appointment for order ${orderId}`);
      }
    } else if (isFailure && orderId) {
      const result = await prisma.appointment.updateMany({
        where: { cashfreeOrderId: orderId, paymentStatus: { not: 'PAID' } },
        data:  { paymentStatus: 'FAILED' }
      });
      logger.info(`❌ Marked ${result.count} appointment(s) FAILED for order ${orderId}`);
    } else {
      logger.info(`Cashfree webhook: ignoring status=${paymentStatus} type=${eventType}`);
    }

    return res.json({ received: true });
  } catch (e) {
    logger.error('Webhook error', e);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
};
