// lifecycle.service.js — fixed version
// Added: autoCompletePassedAppointments() for Issue 8
// Added: updateDoctorRevenueCounters() for Issue 6

const prisma  = require('../config/prisma');
const logger  = require('../utils/logger');
const automation = require('./automation.service');
const { expirePendingAppointments } = require('./appointment-state.service');
const { getTodayDateOnly, getCurrentTimeMinutes } = require('../utils/date');

// Issue 8 fix: Auto-complete appointments whose time has passed
// Runs every cycle. Only marks CONFIRMED appointments as COMPLETED.
// PENDING (unpaid) appointments are cancelled by expirePendingAppointments instead.
async function autoCompletePassedAppointments() {
  const today = getTodayDateOnly();
  const nowMinutes = getCurrentTimeMinutes();

  // Get all CONFIRMED appointments for today where endTime has passed
  const passed = await prisma.appointment.findMany({
    where: {
      date: today,
      status: 'CONFIRMED'
    },
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

  // Issue 6 fix: update revenue for each doctor after auto-complete
  // Group completed paid appointments by doctorId
  const paidCompleted = toComplete.filter(a => a.paymentStatus === 'PAID');
  const revenueByDoctor = {};
  for (const a of paidCompleted) {
    revenueByDoctor[a.doctorId] = (revenueByDoctor[a.doctorId] || 0) + Number(a.feeAtBooking);
  }

  for (const [doctorId, amount] of Object.entries(revenueByDoctor)) {
    await prisma.doctor.update({
      where: { id: doctorId },
      data: {
        revenue: { increment: amount },
        consults: { increment: paidCompleted.filter(a => a.doctorId === doctorId).length }
      }
    });
  }

  logger.info(`Auto-completed ${toComplete.length} appointment(s)`);
  return toComplete.length;
}

// Issue 6 fix: Also call this when doctor manually marks complete
// Exported so doctor.controller can call it
async function incrementDoctorRevenue(doctorId, feeAtBooking, paymentStatus) {
  if (paymentStatus !== 'PAID') return; // only count paid appointments
  await prisma.doctor.update({
    where: { id: doctorId },
    data: {
      revenue: { increment: Number(feeAtBooking) },
      consults: { increment: 1 }
    }
  });
}

async function decrementDoctorRevenue(doctorId, feeAtBooking, paymentStatus) {
  if (paymentStatus !== 'PAID') return;
  await prisma.doctor.update({
    where: { id: doctorId },
    data: {
      revenue: { decrement: Number(feeAtBooking) },
      consults: { decrement: 1 }
    }
  });
}

async function runLifecycleJobs() {
  try {
    await expirePendingAppointments();
    await autoCompletePassedAppointments();
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
