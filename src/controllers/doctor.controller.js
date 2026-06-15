// doctor.controller.js — fixed version
// Issue 3 fix: toggleComplete now DISABLED for PENDING appointments
// Issue 6 fix: revenue + consults updated on manual complete/uncomplete
// Issue 4 fix: history tab already works — just exposed clearly
// Additional Issue 1: cancelAppointment now fires onAppointmentCancelled
const { clinicSettingsSchema } = require('../utils/validators');
const fs   = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  updateDoctorAvailabilitySchema,
  updateDoctorFeesSchema,
  prescriptionSchema,
  rescheduleSchema
} = require('../utils/validators');
const automation = require('../services/automation.service');
const slotService = require('../services/slot.service');
const { timeToMinutes, minutesToTime } = require('../services/slot.service');
const { parseDateOnly, parseDateOnlyOrNull, getTodayDateOnly, getTodayDateString } = require('../utils/date');
const { incrementDoctorRevenue, decrementDoctorRevenue } = require('../services/lifecycle.service');

exports.me = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findFirst({ where: { id: req.user.id, deletedAt: null } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  const { passwordHash, ...safe } = doctor;
  res.json(safe);
});

exports.updateAvailability = asyncHandler(async (req, res) => {
  const parsed = updateDoctorAvailabilitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const payload = Object.fromEntries(
    Object.entries(parsed.data).map(([key, value]) => [key, value === '' ? null : value])
  );
  const updated = await prisma.doctor.update({ where: { id: req.user.id }, data: payload });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

exports.updateFees = asyncHandler(async (req, res) => {
  const parsed = updateDoctorFeesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const updated = await prisma.doctor.update({ where: { id: req.user.id }, data: parsed.data });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

exports.uploadProfileImage = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Profile image file is required' });
  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  const photoUrl = `${process.env.PUBLIC_STORAGE_URL || '/files'}/profile-images/${req.file.filename}`;
  if (doctor.photoUrl) {
    const oldPath = path.resolve(
      process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage'),
      doctor.photoUrl.replace(`${process.env.PUBLIC_STORAGE_URL || '/files'}/`, '')
    );
    fs.promises.unlink(oldPath).catch(() => null);
  }
  const updated = await prisma.doctor.update({ where: { id: req.user.id }, data: { photoUrl } });
  res.json({ success: true, photoUrl: updated.photoUrl });
});

exports.removeProfileImage = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.user.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  if (doctor.photoUrl) {
    const filePath = path.resolve(
      process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'storage'),
      doctor.photoUrl.replace(`${process.env.PUBLIC_STORAGE_URL || '/files'}/`, '')
    );
    fs.promises.unlink(filePath).catch(() => null);
  }
  await prisma.doctor.update({ where: { id: req.user.id }, data: { photoUrl: null } });
  res.json({ success: true });
});

exports.myAppointments = asyncHandler(async (req, res) => {
  const { status, date, from, to } = req.query;
  const where = { doctorId: req.user.id };
  if (status) where.status = status;
  if (date) where.date = parseDateOnly(date);
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = parseDateOnly(from);
    if (to)   where.date.lte = parseDateOnly(to);
  }
  const appts = await prisma.appointment.findMany({
    where,
    include: { patient: true, prescription: true },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }]
  });
  res.json(appts);
});

exports.todayWaitingRoom = asyncHandler(async (req, res) => {
  const today = getTodayDateOnly();
  const appts = await prisma.appointment.findMany({
    where: {
      doctorId: req.user.id,
      date: today,
      status: { in: ['CONFIRMED', 'PENDING'] }
    },
    include: { patient: true },
    orderBy: { startTime: 'asc' }
  });
  res.json(appts);
});

exports.appointmentDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { patient: true, doctor: true, prescription: true }
  });
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  // Bug 1 — siblings are now separate patient rows, so this history query
  // correctly returns ONLY this child's past completed appointments.
  const history = await prisma.appointment.findMany({
    where: {
      patientId: appt.patientId,
      id: { not: appt.id },
      status: 'COMPLETED'
    },
    include: {
      prescription: true,
      doctor: { select: { name: true } }
    },
    orderBy: { date: 'desc' },
    take: 20
  });
  res.json({ appointment: appt, history });
});

exports.createPrescription = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const parsed = prescriptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });

  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { patient: true, doctor: true }
  });
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const data = {
    ...parsed.data,
    medications: parsed.data.medications,
    followUpDate: parseDateOnlyOrNull(parsed.data.followUpDate)
  };

  const rx = await prisma.prescription.upsert({
    where: { appointmentId: id },
    update: data,
    create: { appointmentId: id, ...data }
  });

  await automation.onPrescriptionCreated(appt, rx);
  res.json(rx);
});

exports.reschedule = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });

  const { date, startTime, reason } = parsed.data;

  // Additional Issue 3 — defense in depth: never allow rescheduling into the past
  if (date < getTodayDateString()) {
    return res.status(400).json({ error: 'Cannot reschedule to a past date' });
  }

  const existing = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { doctor: true, patient: true }
  });
  if (!existing) return res.status(404).json({ error: 'Appointment not found' });
  if (['COMPLETED', 'CANCELLED'].includes(existing.status)) {
    return res.status(400).json({ error: 'Cannot reschedule a completed or cancelled appointment' });
  }

  const liveSlots = await slotService.getLiveSlots(existing.doctorId, date, existing.consultationType);
  const slot = liveSlots.find(item => item.startTime === startTime);
  if (!slot || !slot.available) {
    return res.status(409).json({ error: 'Selected slot is not available for reschedule' });
  }

  const endTime = minutesToTime(timeToMinutes(startTime) + (existing.doctor.slotDuration || 15));
  const updated = await prisma.appointment.update({
    where: { id },
    data: {
      date: parseDateOnly(date),
      startTime,
      endTime,
      rescheduleReason: reason,
      rescheduledAt: new Date(),
      status: (existing.paymentStatus === 'PAID' || existing.consultationType === 'OFFLINE')
        ? 'CONFIRMED' : 'PENDING'
    },
    include: { doctor: true, patient: true }
  });

  await automation.onAppointmentRescheduled(updated);
  res.json(updated);
});

exports.cancelAppointment = asyncHandler(async (req, res) => {
  const { id } = req.params;
const reason = (req.body?.reason || '').trim();

if (reason.length < 3) {
  return res.status(400).json({
    error: 'A cancellation reason (min 3 chars) is required'
  });
}  const appt = await prisma.appointment.findFirst({
    where: { id, doctorId: req.user.id },
    include: { doctor: true, patient: true }
  });
  if (!appt) return res.status(404).json({ error: 'Not found' });
  if (appt.status === 'COMPLETED') {
    return res.status(400).json({ error: 'Cannot cancel a completed appointment' });
  }
  if (appt.status === 'CANCELLED') {
    return res.json(appt); // idempotent
  }

  const updated = await prisma.appointment.update({
    where: { id },
    data: { status: 'CANCELLED', notes: reason || null, cancelledAt: new Date() },
    include: { doctor: true, patient: true }
  });

  // Additional Issue 1 — fire the patient/doctor cancellation notifications.
  // Without this, the patient never finds out the doctor cancelled.
  // Don't let an automation failure block the API response — fire and log.
  automation.onAppointmentCancelled(updated, reason).catch(e => {
    require('../utils/logger').error('onAppointmentCancelled failed', e);
  });

  res.json(updated);
});

exports.toggleComplete = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appt = await prisma.appointment.findFirst({ where: { id, doctorId: req.user.id } });
  if (!appt) return res.status(404).json({ error: 'Not found' });

  if (appt.status === 'PENDING') {
    return res.status(400).json({
      error: 'Cannot mark a PENDING appointment as complete. Payment must be confirmed first.'
    });
  }
  if (appt.status === 'CANCELLED') {
    return res.status(400).json({ error: 'Cancelled appointments cannot be toggled' });
  }

  const shouldComplete = appt.status !== 'COMPLETED';

  const updated = await prisma.appointment.update({
    where: { id },
    data: shouldComplete
      ? {
          status: 'COMPLETED',
          completedAt: new Date(),
          ...(appt.paymentStatus === 'CASH_PENDING' && { paymentStatus: 'CASH_COLLECTED' })
        }
      : {
          status: 'CONFIRMED',
          completedAt: null,
          ...(appt.paymentStatus === 'CASH_COLLECTED' && { paymentStatus: 'CASH_PENDING' })
        }
  });

  if (shouldComplete) {
    await incrementDoctorRevenue(appt.doctorId, appt.feeAtBooking, appt.paymentStatus);
  } else {
    await decrementDoctorRevenue(appt.doctorId, appt.feeAtBooking, appt.paymentStatus);
  }

  res.json({ ...updated, toggledTo: shouldComplete ? 'COMPLETED' : 'CONFIRMED' });
});

exports.stats = asyncHandler(async (req, res) => {
  const today = getTodayDateOnly();

  const [todayCount, completedToday, totalConsults, revenueAgg] = await Promise.all([
    prisma.appointment.count({
      where: { doctorId: req.user.id, date: today, status: { not: 'CANCELLED' } }
    }),
    prisma.appointment.count({
      where: { doctorId: req.user.id, date: today, status: 'COMPLETED' }
    }),
    prisma.appointment.count({
      where: { doctorId: req.user.id, status: 'COMPLETED' }
    }),
    prisma.appointment.aggregate({
      _sum: { feeAtBooking: true },
      where: {
        doctorId: req.user.id,
        status: 'COMPLETED',
        paymentStatus: { in: ['PAID', 'CASH_COLLECTED', 'CASH_PENDING'] }
      }
    })
  ]);

  res.json({
    todayAppointments: todayCount,
    completedToday,
    totalConsults,
    totalRevenue: Number(revenueAgg._sum.feeAtBooking || 0)
  });
});

exports.updateClinic = asyncHandler(async (req, res) => {
  const parsed = clinicSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  let { clinicName, clinicAddress, clinicMapUrl, clinicLat, clinicLng } = parsed.data;
  if (!clinicMapUrl) {
    const q = [clinicName, clinicAddress].filter(Boolean).join(' ');
    clinicMapUrl = `https://maps.google.com/?q=${encodeURIComponent(q)}`;
  }
  const updated = await prisma.doctor.update({
    where: { id: req.user.id },
    data: { clinicName, clinicAddress, clinicMapUrl, clinicLat, clinicLng }
  });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

// ─────────────────────────────────────────────────────────────────
// Bug 3 — Doctor's "Pending follow-ups" list
// Returns prescriptions where followUpDate ≤ today AND the patient
// has not re-booked since the original consult was completed.
// Used by the doctor dashboard to show patients who missed their recall.
// ─────────────────────────────────────────────────────────────────
exports.pendingFollowUps = asyncHandler(async (req, res) => {
  const todayStr = getTodayDateString();
  const today = parseDateOnly(todayStr);

  // All my prescriptions with a follow-up date that has arrived or passed.
  const rxs = await prisma.prescription.findMany({
    where: {
      appointment: { doctorId: req.user.id },
      followUpDate: { lte: today, not: null }
    },
    include: {
      appointment: {
        include: { patient: true }
      }
    },
    orderBy: { followUpDate: 'desc' },
    take: 100
  });

  // Filter out ones where the patient has re-booked with me since.
  const out = [];
  for (const rx of rxs) {
    const a = rx.appointment;
    if (!a) continue;
    const rebooked = await prisma.appointment.findFirst({
      where: {
        patientId: a.patientId,
        doctorId: req.user.id,
        createdAt: { gt: a.completedAt || a.createdAt },
        status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] }
      },
      select: { id: true }
    });
    if (rebooked) continue;
    out.push({
      prescriptionId: rx.id,
      appointmentId: a.id,
      followUpDate: rx.followUpDate,
      patient: {
        id: a.patient.id,
        name: a.patient.name,
        phone: a.patient.phone,
        email: a.patient.email,
        dateOfBirth: a.patient.dateOfBirth
      },
      lastConsult: a.completedAt || a.date
    });
  }
  res.json(out);
});
