const prisma  = require('../config/prisma');
const logger  = require('../utils/logger');
const { expirePendingAppointments } = require('./appointment-state.service');
const { getTodayDateOnly, getCurrentTimeMinutes } = require('../utils/date');

/**
 * Bug 9 — Auto-complete appointments whose endTime has passed.
 * This is the ONLY place revenue/consults are incremented for online appointments
 * (the duplicate increment in onOnlineBookingConfirmed has been removed).
 */
async function autoCompletePassedAppointments() {
  const today = getTodayDateOnly();
  const nowMinutes = getCurrentTimeMinutes();

  const passed = await prisma.appointment.findMany({
    where: { date: today, status: 'CONFIRMED' },
    select: { id: true, endTime: true, feeAtBooking: true, doctorId: true, paymentStatus: true }
  });

  const toComplete = passed.filter(a => {
    const [h, m] = a.endTime.split(':').map(Number);
    return (h * 60 + m) <= nowMinutes;
  });

  if (!toComplete.length) return 0;

  const ids = toComplete.map(a => a.id);
  await prisma.appointment.updateMany({
    where: { id: { in: ids } },
    data: { status: 'COMPLETED', completedAt: new Date() }
  });

  // Offline CASH_PENDING → CASH_COLLECTED on auto-complete
  const cashIds = toComplete.filter(a => a.paymentStatus === 'CASH_PENDING').map(a => a.id);
  if (cashIds.length) {
    await prisma.appointment.updateMany({
      where: { id: { in: cashIds } },
      data: { paymentStatus: 'CASH_COLLECTED' }
    });
  }

  // Revenue + consults: count PAID (online) and CASH_PENDING (offline being auto-collected now)
  const payable = toComplete.filter(a => a.paymentStatus === 'PAID' || a.paymentStatus === 'CASH_PENDING');
  const byDoctor = {};
  for (const a of payable) {
    if (!byDoctor[a.doctorId]) byDoctor[a.doctorId] = { revenue: 0, consults: 0 };
    byDoctor[a.doctorId].revenue += Number(a.feeAtBooking);
    byDoctor[a.doctorId].consults += 1;
  }
  for (const [doctorId, agg] of Object.entries(byDoctor)) {
    await prisma.doctor.update({
      where: { id: doctorId },
      data: { revenue: { increment: agg.revenue }, consults: { increment: agg.consults } }
    });
  }

  logger.info(`Auto-completed ${toComplete.length} appointment(s); credited ${Object.keys(byDoctor).length} doctor(s)`);
  return toComplete.length;
}

// Manual completion path (still used by doctor's "Mark Complete" button)
async function incrementDoctorRevenue(doctorId, feeAtBooking, paymentStatus) {
  if (!['PAID', 'CASH_PENDING', 'CASH_COLLECTED'].includes(paymentStatus)) return;
  await prisma.doctor.update({
    where: { id: doctorId },
    data: { revenue: { increment: Number(feeAtBooking) }, consults: { increment: 1 } }
  });
}

async function decrementDoctorRevenue(doctorId, feeAtBooking, paymentStatus) {
  if (!['PAID', 'CASH_PENDING', 'CASH_COLLECTED'].includes(paymentStatus)) return;
  await prisma.doctor.update({
    where: { id: doctorId },
    data: { revenue: { decrement: Number(feeAtBooking) }, consults: { decrement: 1 } }
  });
}

async function runLifecycleJobs() {
  try {
    await expirePendingAppointments();        // Bug 10
    await autoCompletePassedAppointments();   // Bug 9
    const automation = require('./automation.service');
    await automation.processReminders();
  } catch (error) {
    logger.error('Lifecycle job failed', error);
  }
}

module.exports = {
  expirePendingAppointments,
  autoCompletePassedAppointments,
  incrementDoctorRevenue,
  decrementDoctorRevenue,
  runLifecycleJobs
};
