const prisma = require('../config/prisma');
const logger = require('../utils/logger');

async function expirePendingAppointments() {
  const result = await prisma.appointment.updateMany({
    where: {
      consultationType: 'ONLINE',
      status: 'PENDING',
      paymentStatus: 'UNPAID',
      expiresAt: { lt: new Date() }
    },
    data: {
      status: 'CANCELLED',
      paymentStatus: 'FAILED',
      cancelledAt: new Date(),
      notes: 'Auto-cancelled because payment was not completed before expiry.'
    }
  });

  if (result.count) {
    logger.info(`Expired ${result.count} unpaid online appointment(s)`);
  }

  return result.count;
}

module.exports = { expirePendingAppointments };
