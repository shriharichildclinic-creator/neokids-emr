const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { createDoctorSchema, updateDoctorByAdminSchema } = require('../utils/validators');
const { asyncHandler } = require('../middleware/errorHandler');
const { createPasswordToken, revokeActivePasswordTokens } = require('../services/token.service');
const { _helpers: authHelpers } = require('./auth.controller');
const { parseDateOnly, getTodayDateOnly } = require('../utils/date');
const automation = require('../services/automation.service');

const SALT = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);
const TOKEN_TTL_MINUTES = parseInt(process.env.PASSWORD_TOKEN_TTL_MINUTES || '60', 10);

function randomPassword() {
  return `Neo${Math.random().toString(36).slice(2, 6)}${Date.now().toString().slice(-4)}`;
}

// Flatten Zod errors into a readable "field: message" list
function flattenZod(err) {
  const flat = err.flatten();
  const lines = [];
  for (const [k, msgs] of Object.entries(flat.fieldErrors || {})) {
    (msgs || []).forEach(m => lines.push(`${k}: ${m}`));
  }
  (flat.formErrors || []).forEach(m => lines.push(m));
  return lines.length ? lines.join(' | ') : 'Invalid input';
}

exports.createDoctor = asyncHandler(async (req, res) => {
  const parsed = createDoctorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: flattenZod(parsed.error), details: parsed.error.flatten() });
  }

  const { password, ...rest } = parsed.data;
  const exists = await prisma.doctor.findUnique({ where: { email: rest.email } });
  if (exists && !exists.deletedAt) return res.status(409).json({ error: 'A doctor with this email already exists' });

  const initialPassword = password || randomPassword();
  const passwordHash = await bcrypt.hash(initialPassword, SALT);

  const doctor = exists
    ? await prisma.doctor.update({
        where: { email: rest.email },
        data: { ...rest, passwordHash, deletedAt: null, mustChangePassword: true, isAvailable: true }
      })
    : await prisma.doctor.create({
        data: { ...rest, passwordHash, mustChangePassword: true }
      });

  await revokeActivePasswordTokens('DOCTOR', doctor.id, ['INVITE', 'RESET']);
  const { rawToken } = await createPasswordToken({
    userType: 'DOCTOR', userId: doctor.id, purpose: 'INVITE', expiresInMinutes: TOKEN_TTL_MINUTES
  });

  const inviteLink = await authHelpers.sendPasswordEmail({
    to: doctor.email, name: doctor.name, rawToken, purpose: 'INVITE'
  });

  // Welcome WhatsApp + email (Feature: Full automations item 1)
  automation.onDoctorCreated({ doctor, inviteLink }).catch(e => console.error('onDoctorCreated failed:', e.message));

  const { passwordHash: _, ...safe } = doctor;
  res.status(201).json({
    ...safe,
    inviteSent: true,
    ...(process.env.SMTP_HOST ? {} : { invitePreviewUrl: inviteLink })
  });
});

exports.listDoctors = asyncHandler(async (req, res) => {
  const doctors = await prisma.doctor.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, email: true, phone: true,
      specialization: true, qualification: true, experience: true, bio: true,
      consultationModes: true, onlineConsultFee: true, physicalConsultFee: true,
      clinicName: true, clinicAddress: true, clinicMapUrl: true,
      isAvailable: true, mustChangePassword: true, consults: true, revenue: true,
      photoUrl: true, createdAt: true
    }
  });
  res.json(doctors);
});

// Bug 8 — proper update
exports.updateDoctor = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const parsed = updateDoctorByAdminSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: flattenZod(parsed.error), details: parsed.error.flatten() });
  }
  const data = { ...parsed.data };
  if (data.password) {
    data.passwordHash = await bcrypt.hash(data.password, SALT);
    data.mustChangePassword = true;
  }
  delete data.password;

  const exists = await prisma.doctor.findFirst({ where: { id, deletedAt: null } });
  if (!exists) return res.status(404).json({ error: 'Doctor not found' });

  const updated = await prisma.doctor.update({ where: { id }, data });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

// Soft delete = Deactivate (per Bug 8)
exports.deleteDoctor = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.doctor.update({
    where: { id },
    data: { isAvailable: false, deletedAt: new Date() }
  });
  res.json({ success: true, message: 'Doctor deactivated' });
});

// Hard delete = only if no appointments (per Bug 8)
exports.hardDeleteDoctor = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appointmentCount = await prisma.appointment.count({ where: { doctorId: id } });
  if (appointmentCount > 0) {
    return res.status(409).json({ error: `Doctor has ${appointmentCount} appointment(s). Hard delete is blocked. Use Deactivate instead.` });
  }
  await prisma.passwordToken.deleteMany({ where: { userType: 'DOCTOR', userId: id } });
  await prisma.doctor.delete({ where: { id } });
  res.json({ success: true, message: 'Doctor permanently deleted' });
});

exports.listAppointments = asyncHandler(async (req, res) => {
  const { status, doctorId, date, from, to } = req.query;
  const where = {};
  if (status) where.status = status;
  if (doctorId) where.doctorId = doctorId;
  if (date) where.date = parseDateOnly(date);
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = parseDateOnly(from);
    if (to)   where.date.lte = parseDateOnly(to);
  }
  const appointments = await prisma.appointment.findMany({
    where,
    include: { doctor: { select: { name: true, specialization: true } }, patient: true },
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
    take: 200
  });
  res.json(appointments);
});

exports.analytics = asyncHandler(async (req, res) => {
  const today = getTodayDateOnly();
  const [totalDoctors, totalPatients, totalAppointments, completed, revenueAgg, todayCount] = await Promise.all([
    prisma.doctor.count({ where: { deletedAt: null } }),
    prisma.patient.count(),
    prisma.appointment.count(),
    prisma.appointment.count({ where: { status: 'COMPLETED' } }),
    prisma.appointment.aggregate({
      _sum: { feeAtBooking: true },
      where: { status: 'COMPLETED', paymentStatus: { in: ['PAID', 'CASH_COLLECTED', 'CASH_PENDING'] } }
    }),
    prisma.appointment.count({ where: { date: today } })
  ]);
  res.json({
    totalDoctors, totalPatients, totalAppointments,
    completedAppointments: completed,
    totalRevenue: Number(revenueAgg._sum.feeAtBooking || 0),
    todayAppointments: todayCount
  });
});
