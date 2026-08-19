const prisma  = require('../config/prisma');
const logger  = require('../utils/logger');
const { expirePendingAppointments } = require('./appointment-state.service');
const { getTodayDateOnly, getCurrentTimeMinutes } = require('../utils/date');

/**
 * Auto-complete appointments whose endTime has passed.
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

// Vaccination reminders run at most once per calendar day per process.
// The dedup lives in NotificationLog, but this cheap guard avoids
// hammering the scan every 5 minutes.
let _lastVaccinationScanDay = null;

// SECURITY/RELIABILITY FIX (audit finding #6): runLifecycleJobs is on a
// 5-minute setInterval AND is invoked once at boot. If a tick overruns
// the interval (slow WhatsApp/email sends, DB stall), the next tick used
// to start while the previous one was still mid-flight — sending
// duplicate reminders and double-crediting revenue. This in-process
// re-entrancy guard skips the overlapping tick. (The 5-min cron is
// single-process by design; for multi-instance deploys, add a DB-level
// advisory lock as well.)
let _jobsInFlight = false;
let _jobsStartedAt = 0;
const JOB_WATCHDOG_MS = parseInt(process.env.LIFECYCLE_JOB_WATCHDOG_MS || '600000', 10); // 10 min

async function runLifecycleJobs() {
  if (_jobsInFlight) {
    // Watchdog: a crashed/hung tick (e.g. a WhatsApp API call that never
    // resolves) must not wedge reminders for the rest of the day.
    if (Date.now() - _jobsStartedAt > JOB_WATCHDOG_MS) {
      logger.error('Lifecycle jobs watchdog: previous run exceeded ' + JOB_WATCHDOG_MS + 'ms — resetting lock');
      _jobsInFlight = false;
    } else {
      logger.warn('Lifecycle jobs skipped — previous run still in progress');
      return;
    }
  }
  _jobsInFlight = true;
  _jobsStartedAt = Date.now();
  try {
    await expirePendingAppointments();
    await autoCompletePassedAppointments();
    const automation = require('./automation.service');
    await automation.processReminders();
    await automation.processFollowUpRecalls();   // soft recall for missed follow-ups

    // Vaccination reminders (daily scan)
    const today = new Date().toISOString().slice(0, 10);
    if (_lastVaccinationScanDay !== today) {
      const vacc = require('./vaccination.service');
      try {
        await vacc.processVaccinationReminders();
        _lastVaccinationScanDay = today;
      } catch (e) {
        logger.error('Vaccination reminder scan failed', e);
      }
    }
  } catch (error) {
    logger.error('Lifecycle job failed', error);
  } finally {
    _jobsInFlight = false;
  }
}


module.exports = {
  expirePendingAppointments,
  autoCompletePassedAppointments,
  incrementDoctorRevenue,
  decrementDoctorRevenue,
  runLifecycleJobs
};
