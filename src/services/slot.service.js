// slot.service.js — fixed version
// ROOT CAUSE of Issue 2: The unique constraint is @@unique([doctorId, date, startTime])
// but it does NOT include consultationType. So an ONLINE and OFFLINE booking
// for the same doctor/date/startTime would clash at DB level — correct.
// BUT the slot query filtered status: { notIn: ['CANCELLED', 'NO_SHOW'] }
// which correctly blocks PENDING slots. The real bug was the widget default
// mode was 'ONLINE' but the doctor had offline hours only — slots showed
// but booking failed. Fixed by ensuring consultationType filter is applied
// to booked check so ONLINE and OFFLINE share the same slot lock (correct
// since the doctor can only be in one place at a time).

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

  // FIX: Use UTC day from stored UTC-midnight date — consistent with parseDateOnly
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

  // FIX: Block slot if ANY active appointment exists for this doctor+date+startTime
  // regardless of consultationType — a doctor cannot do two appointments at once.
  // PENDING is included — slot is locked the moment booking is created.
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
