// slot.service.js
//
// The unique constraint is @@unique([doctorId, date, startTime]) and does
// NOT include consultationType, so an ONLINE and OFFLINE booking for the
// same doctor/date/startTime clash at the DB level — correct, since a
// doctor can only be in one place at a time. The slot-availability check
// below applies the same rule: a booked slot is locked regardless of
// consultationType, so ONLINE and OFFLINE share one slot lock per
// doctor/date/startTime.

const prisma = require('../config/prisma');
const { parseDateOnly, getTodayDateString, getCurrentTimeMinutes } = require('../utils/date');
const { expirePendingAppointments } = require('./appointment-state.service');

const DAY_MAP = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

async function getLiveSlots(doctorId, dateStr, consultationType) {
  // Defense in depth: never trust the caller. If the controller
  // forgets to validate, refuse anything that isn't a recognised mode
  // instead of silently mapping it to OFFLINE.
  if (consultationType !== 'ONLINE' && consultationType !== 'OFFLINE') {
    throw Object.assign(
      new Error("consultationType must be 'ONLINE' or 'OFFLINE'"),
      { statusCode: 400 }
    );
  }

  // Defense in depth: reject past dates at the service layer so the
  // slot listing can never disagree with the booking validator.
  if (dateStr < getTodayDateString()) {
    return [];
  }

  // Always expire pending unpaid bookings before returning slots
  // so abandoned payment sessions free their slots automatically
  await expirePendingAppointments();

  const doctor = await prisma.doctor.findFirst({ where: { id: doctorId, deletedAt: null } });
  if (!doctor) throw Object.assign(new Error('Doctor not found'), { statusCode: 404 });
  if (!doctor.isAvailable) return [];

  if (doctor.consultationModes !== 'BOTH' && doctor.consultationModes !== consultationType) {
    return [];
  }

  const date = parseDateOnly(dateStr);

  // Use the UTC day from the stored UTC-midnight date, consistent with parseDateOnly.
  const dayName = DAY_MAP[new Date(date).getUTCDay()];
  const workingDays = (doctor.workingDays || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!workingDays.includes(dayName)) return [];

  const fromKey = consultationType === 'ONLINE' ? 'availableFromOnline' : 'availableFromOffline';
  const toKey   = consultationType === 'ONLINE' ? 'availableToOnline'   : 'availableToOffline';
  const fromTime = doctor[fromKey];
  const toTime   = doctor[toKey];
  if (!fromTime || !toTime) return [];

  const startMin = timeToMinutes(fromTime);
  const endMin   = timeToMinutes(toTime);
  const duration = doctor.slotDuration || 15;

  const slots = [];
  for (let cur = startMin; cur + duration <= endMin; cur += duration) {
    slots.push({ startTime: minutesToTime(cur), endTime: minutesToTime(cur + duration) });
  }

  // Block the slot if ANY active appointment exists for this
  // doctor+date+startTime, regardless of consultationType — a doctor
  // cannot do two appointments at once. PENDING is included — the slot
  // is locked the moment a booking is created.
  const bookedAppointments = await prisma.appointment.findMany({
    where: {
      doctorId,
      date,
      status: { notIn: ['CANCELLED', 'NO_SHOW'] }
      // NOTE: intentionally no consultationType filter here
    },
    select: { startTime: true }
  });
  const bookedSet = new Set(bookedAppointments.map((a) => a.startTime));

  const isToday = dateStr === getTodayDateString();
  const nowMinutes = getCurrentTimeMinutes();

  return slots.map((slot) => {
    let available = !bookedSet.has(slot.startTime);
    // Hide past slots for today
    if (isToday && timeToMinutes(slot.startTime) <= nowMinutes) {
      available = false;
    }
    return { ...slot, available };
  });
}

module.exports = { getLiveSlots, timeToMinutes, minutesToTime };