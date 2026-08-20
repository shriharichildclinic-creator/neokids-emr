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

  const byDoctor = {};
  let completedCount = 0;
  for (const a of toComplete) {
    const claim = await prisma.appointment.updateMany({
      where: { id: a.id, status: 'CONFIRMED' },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        ...(a.paymentStatus === 'CASH_PENDING' ? { paymentStatus: 'CASH_COLLECTED' } : {})
      }
    });
    if (claim.count === 0) continue;
    completedCount += 1;
    if (a.paymentStatus === 'PAID' || a.paymentStatus === 'CASH_PENDING') {
      if (!byDoctor[a.doctorId]) byDoctor[a.doctorId] = { revenue: 0, consults: 0 };
      byDoctor[a.doctorId].revenue += Number(a.feeAtBooking);
      byDoctor[a.doctorId].consults += 1;
    }
  }
  for (const [doctorId, agg] of Object.entries(byDoctor)) {
    await prisma.doctor.update({
      where: { id: doctorId },
      data: { revenue: { increment: agg.revenue }, consults: { increment: agg.consults } }
    });
  }

  if (completedCount) {
    logger.info(`Auto-completed ${completedCount} appointment(s); credited ${Object.keys(byDoctor).length} doctor(s)`);
  }
  return completedCount;
}

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

// =====================================================================
// Vaccination reminder gating  (v3.5.2 timing fix)
// ---------------------------------------------------------------------
// The vaccination scan is now gated by TWO conditions, evaluated inside
// vaccination.service.processVaccinationReminders():
//
//   1. Ops switch  — VACC_REMINDERS_ENABLED must not be 'false'.
//   2. Delivery window — the current wall-clock time in Asia/Kolkata
//      must be inside [VACC_WINDOW_START_HOUR_IST, VACC_WINDOW_END_HOUR_IST).
//      Default 18:00–20:00 IST.
//
// The lifecycle cron still fires every 5 minutes for appointment
// reminders (which are 30-min-before-appointment, timezone-agnostic
// on the appointment's own start time), but vaccination reminders will
// no-op every tick that is outside the window. The `alreadyScannedToday`
// flag ensures that inside the window we don't loop-send on every 5-min
// tick — the FIRST tick inside the window fires, and further ticks skip
// because vaccinations were already dispatched today.
//
// This is the fix for the "reminders arriving around 5:20 AM" bug: the
// day used to roll at 00:00 UTC = 05:30 IST, and the first cron tick
// after that boundary would send. Now the same tick sees `hour=5`, the
// service returns `skippedWindow=true`, no reminder goes out. The
// ~18:00 IST tick is the one that dispatches.
// =====================================================================
let _lastVaccinationScanDay = null;

// Re-entrancy guard for the whole lifecycle tick (revenue race protection).
let _jobsInFlight = false;
let _jobsStartedAt = 0;
const JOB_WATCHDOG_MS = parseInt(process.env.LIFECYCLE_JOB_WATCHDOG_MS || '600000', 10); // 10 min

async function runLifecycleJobs() {
  if (_jobsInFlight) {
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
    await automation.processReminders();                 // 30-min appointment reminders
    await automation.processFollowUpRecalls();           // soft follow-up recall

    // Vaccination reminder scan.
    //   • Only ONE successful scan per calendar day (IST) — the service
    //     itself dedups per (patient, vaccine, dueDate) so a duplicate
    //     run is safe, but this saves DB roundtrips on every 5-min tick
    //     for the ~22h/day the window is closed.
    //   • Delivery-window gate lives inside the service; a tick outside
    //     18:00–20:00 IST returns {skippedWindow:true} and we do NOT
    //     stamp `_lastVaccinationScanDay`, so the next in-window tick
    //     will still run.
    const vacc = require('./vaccination.service');
    const istDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    if (_lastVaccinationScanDay !== istDay) {
      const result = await vacc.processVaccinationReminders();
      if (result && !result.disabled && !result.skippedWindow) {
        _lastVaccinationScanDay = istDay;
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
