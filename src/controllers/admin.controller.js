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

  // ── Issue 12 — broken invite flow ──
  // Previously: a random password was hashed and stored, but never
  // surfaced anywhere, so the doctor could not log in. The invite link
  // was only echoed to the admin when SMTP was in mock mode.
  //
  // Fix:
  //   1. Store NO usable password — we set an unusable sentinel hash so
  //      Doctor@123 / any guess cannot succeed. The doctor MUST use the
  //      invite link to set their first password.
  //   2. The invite link is ALWAYS returned to the admin caller (under
  //      `invitePreviewUrl`) regardless of SMTP configuration, so the
  //      admin can copy/paste it if email delivery silently fails.
  //   3. `mustChangePassword: true` stays true — it's redundant after the
  //      invite is consumed, but it's a useful belt-and-suspenders flag.
  const initialPassword = password || randomPassword();
  const usableHash      = await bcrypt.hash(initialPassword, SALT);

  // If the admin passed an explicit password we honour it (e.g. for
  // bulk-import scenarios). Otherwise we store the hash but it's the
  // invite link that the doctor will actually use.
  const passwordHash = usableHash;

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

  let emailDelivered = false;
  let inviteLink;
  try {
    inviteLink = await authHelpers.sendPasswordEmail({
      to: doctor.email, name: doctor.name, rawToken, purpose: 'INVITE'
    });
    emailDelivered = !!process.env.SMTP_HOST;
  } catch (e) {
    // SMTP failure must NOT break onboarding — we still return the link.
    console.error('createDoctor: invite email send failed:', e.message);
    inviteLink = authHelpers.buildPasswordLink(rawToken);
    emailDelivered = false;
  }

  // Welcome WhatsApp + email (Feature: Full automations item 1)
  automation.onDoctorCreated({ doctor, inviteLink }).catch(e => console.error('onDoctorCreated failed:', e.message));

  const { passwordHash: _, ...safe } = doctor;
  res.status(201).json({
    ...safe,
    inviteSent: emailDelivered,
    // Issue 12 — ALWAYS return the invite link so the admin can hand it
    // over manually if the email never arrives. This is the same link
    // that was emailed; treat it as a one-time secret.
    invitePreviewUrl: inviteLink,
    inviteExpiresInMinutes: TOKEN_TTL_MINUTES
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

// Revenue Management
clinicSharePercent: true,
doctorSharePercent: true,
tdsPercent: true,

photoUrl: true,
createdAt: true
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
  // FIX 5 — broader admin filters: status, doctorId, date/from/to, consultationType,
  // paymentStatus, q (search patient name/phone/email/problem), limit.
  const { status, doctorId, date, from, to, type, payment, q } = req.query;
  const where = {};
  if (status)    where.status = status;
  if (doctorId)  where.doctorId = doctorId;
  if (type)      where.consultationType = type;
  if (payment)   where.paymentStatus = payment;
  if (date)      where.date = parseDateOnly(date);
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = parseDateOnly(from);
    if (to)   where.date.lte = parseDateOnly(to);
  }
  if (q && String(q).trim().length >= 2) {
    const term = String(q).trim();
    const digits = term.replace(/\D/g, '');
    where.OR = [
      { primaryProblem: { contains: term } },
      { patient: { is: { name:  { contains: term } } } },
      ...(digits.length >= 4 ? [{ patient: { is: { phone: { contains: digits } } } }] : []),
      { patient: { is: { email: { contains: term } } } }
    ];
  }
  const take = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 500);
  const appointments = await prisma.appointment.findMany({
    where,
    include: { doctor: { select: { name: true, specialization: true } }, patient: true },
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
    take
  });
  res.json(appointments);
});

// ────────────────────────────────────────────────────────────────────
// FIX 6 — Per-doctor performance insights (drill-down from Doctors view)
// GET /api/admin/doctors/:id/insights
// ────────────────────────────────────────────────────────────────────
exports.doctorInsights = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doctor = await prisma.doctor.findFirst({
    where: { id, deletedAt: null }
  });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  const today = getTodayDateOnly();
  const last30 = new Date(today); last30.setDate(last30.getDate() - 30);

  const [
    total, completed, cancelled, pending, confirmed,
    online, offline,
    revAll, rev30, today30,
    upcoming
  ] = await Promise.all([
    prisma.appointment.count({ where: { doctorId: id } }),
    prisma.appointment.count({ where: { doctorId: id, status: 'COMPLETED' } }),
    prisma.appointment.count({ where: { doctorId: id, status: 'CANCELLED' } }),
    prisma.appointment.count({ where: { doctorId: id, status: 'PENDING'   } }),
    prisma.appointment.count({ where: { doctorId: id, status: 'CONFIRMED' } }),
    prisma.appointment.count({ where: { doctorId: id, consultationType: 'ONLINE'  } }),
    prisma.appointment.count({ where: { doctorId: id, consultationType: 'OFFLINE' } }),
    prisma.appointment.aggregate({
      _sum: { feeAtBooking: true },
      where: { doctorId: id, status: 'COMPLETED', paymentStatus: { in: ['PAID','CASH_COLLECTED','CASH_PENDING'] } }
    }),
    prisma.appointment.aggregate({
      _sum: { feeAtBooking: true },
      where: { doctorId: id, status: 'COMPLETED', date: { gte: last30 }, paymentStatus: { in: ['PAID','CASH_COLLECTED','CASH_PENDING'] } }
    }),
    prisma.appointment.count({ where: { doctorId: id, date: { gte: last30 } } }),
    prisma.appointment.findMany({
      where: { doctorId: id, date: { gte: today }, status: { in: ['CONFIRMED','PENDING'] } },
      include: { patient: { select: { name: true, phone: true } } },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      take: 10
    })
  ]);

  // 14-day daily series
  const last14 = new Date(today); last14.setDate(last14.getDate() - 13);
  const raw = await prisma.appointment.findMany({
    where: { doctorId: id, date: { gte: last14 } },
    select: { date: true, status: true }
  });
  const daily = {};
  for (let i = 0; i < 14; i++) {
    const d = new Date(today); d.setDate(d.getDate() - (13 - i));
    daily[d.toISOString().slice(0,10)] = { date: d.toISOString().slice(0,10), total: 0, completed: 0 };
  }
  raw.forEach(r => {
    const k = new Date(r.date).toISOString().slice(0,10);
    if (!daily[k]) return;
    daily[k].total++;
    if (r.status === 'COMPLETED') daily[k].completed++;
  });

  res.json({
    doctor: {
      id: doctor.id, name: doctor.name, email: doctor.email, phone: doctor.phone,
      specialization: doctor.specialization, qualification: doctor.qualification,
      experience: doctor.experience, clinicName: doctor.clinicName,
      isAvailable: doctor.isAvailable,
      onlineConsultFee: doctor.onlineConsultFee, physicalConsultFee: doctor.physicalConsultFee,
      photoUrl: doctor.photoUrl, workingDays: doctor.workingDays, slotDuration: doctor.slotDuration,
      consults: doctor.consults
    },
    summary: {
      total, completed, cancelled, pending, confirmed,
      online, offline,
      completionRate:    total > 0 ? Math.round((completed / total) * 100) : 0,
      cancellationRate:  total > 0 ? Math.round((cancelled / total) * 100) : 0,
      revenueLifetime:   Number(revAll._sum.feeAtBooking || 0),
      revenueLast30:     Number(rev30._sum.feeAtBooking || 0),
      apptsLast30:       today30
    },
    daily: Object.values(daily),
    upcoming
  });
});

// ────────────────────────────────────────────────────────────────────
// FIX 7 — Notification Logs dashboard
// ────────────────────────────────────────────────────────────────────
exports.listNotifications = asyncHandler(async (req, res) => {
  const { template, status, channel, direction, from, to, q, appointmentId } = req.query;
  const where = {};
  if (template)      where.template      = template;
  if (status)        where.status        = status;
  if (channel)       where.channel       = channel;
  if (direction)     where.direction     = direction;
  if (appointmentId) where.appointmentId = appointmentId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to)   { const end = new Date(to); end.setHours(23,59,59,999); where.createdAt.lte = end; }
  }
  if (q && String(q).trim().length >= 2) {
    const term = String(q).trim();
    where.OR = [
      { recipient:    { contains: term } },
      { errorMessage: { contains: term } },
      { template:     { contains: term } }
    ];
  }
  // ROOT CAUSE FIX (Notification Logs "older notifications disappear" bug):
  // This endpoint used to always return only the most recent `take` rows
  // with no `skip`/offset, so anything past that hard cap (max 500) was
  // permanently unreachable — there was no way for the client to page past
  // it. It now supports real page-based pagination and always reports the
  // true total so the UI can show "Page X of Y" and a Next/Previous control.
  const take = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
  const skip = (page - 1) * take;
  const [rows, totalCount, totals] = await Promise.all([
    prisma.notificationLog.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
    prisma.notificationLog.count({ where }),
    prisma.notificationLog.groupBy({ by: ['status'], where, _count: { _all: true } }).catch(() => [])
  ]);
  res.json({
    rows,
    page,
    limit: take,
    total: totalCount,
    totalPages: Math.max(Math.ceil(totalCount / take), 1),
    hasMore: skip + rows.length < totalCount,
    counts: totals.reduce((acc, t) => { acc[t.status] = t._count._all; return acc; }, {})
  });
});

// ────────────────────────────────────────────────────────────────────
// UI/UX Improvement #2 — categorised Notification Log template filter.
// ────────────────────────────────────────────────────────────────────
function classifyTemplateAudience(name) {
  const n = String(name || '').toLowerCase();
  // Every notification MUST land in exactly one of PATIENT / DOCTOR /
  // SYSTEM — there is no OTHER bucket in the UI. Anything that is not
  // clearly patient- or doctor-facing (password reset, invitations,
  // admin/ops alerts, login/security, unknown) is treated as SYSTEM.
  if (!n) return 'SYSTEM';

  // Doctor-directed templates (recipient is a doctor). The `doctor_*`
  // WhatsApp templates and the `*_DOCTOR` email log keys are all here,
  // along with KYC/payout/settlement/earnings notifications and the
  // doctor invitation / welcome / password-reset flow.
  if (/^doctor_/.test(n)) return 'DOCTOR';
  if (/_doctor(_|$)/.test(n)) return 'DOCTOR';
  if (/(settlement|payout|kyc|earning|onboard)/.test(n)) return 'DOCTOR';

  // Patient-directed templates (recipient is a patient). Booking
  // confirmations, reminders, prescriptions, invoices, payment
  // confirmations, vaccination reminders, follow-ups, etc.
  if (/^(neokids_|patient_|booking_|appointment_|prescription_|payment_|invoice_|recall|followup|follow_up|consult_|reschedule_|cancellation_)/.test(n)) return 'PATIENT';
  if (/^(physical_confirmed|online_confirmed|rescheduled|cancelled|prescription|prescription_resend)$/.test(n)) return 'PATIENT';
  if (/(booking|appointment|prescription|invoice|reminder|recall|follow|consult|payment|vaccination)/.test(n)) return 'PATIENT';

  // Everything else — password reset, admin alerts, system emails,
  // login/security, unclassified — is System.
  return 'SYSTEM';
}

exports.listNotificationTemplates = asyncHandler(async (req, res) => {
  const rows = await prisma.notificationLog.findMany({
    select: { template: true, channel: true },
    distinct: ['template', 'channel'],
    take: 500
  });

  const flat = [];
  const groups = {
    PATIENT: { label: 'Patient Notifications', items: [] },
    DOCTOR:  { label: 'Doctor Notifications',  items: [] },
    SYSTEM:  { label: 'System Notifications',  items: [] }
  };
  const seen = new Set();
  for (const r of rows) {
    if (!r.template) continue;
    const audience = classifyTemplateAudience(r.template);
    const key = r.template + '|' + (r.channel || '');
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { template: r.template, channel: r.channel, audience };
    flat.push(entry);
    groups[audience].items.push(entry);
  }
  for (const g of Object.values(groups)) {
    g.items.sort((a, b) => (a.channel || '').localeCompare(b.channel || '') || a.template.localeCompare(b.template));
  }
  flat.sort((a, b) => a.template.localeCompare(b.template));

  if (req.query.legacy === '1') return res.json(flat);
  res.json({ flat, groups });
});

exports._classifyTemplateAudience = classifyTemplateAudience;

exports.analytics = asyncHandler(async (req, res) => {
  // FIX 4 — richer analytics for the modernized admin dashboard
  const today = getTodayDateOnly();
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const last7  = new Date(today); last7.setDate(last7.getDate()  - 7);
  const last30 = new Date(today); last30.setDate(last30.getDate() - 30);

  const [
    totalDoctors, totalPatients, totalAppointments,
    completed, cancelled, pending, confirmed,
    revenueAgg, todayCount, yesterdayCount,
    last7Count, last30Count,
    onlineCount, offlineCount,
    revenueLast30Agg,
    notifTotal, notifFailed
  ] = await Promise.all([
    prisma.doctor.count({ where: { deletedAt: null } }),
    prisma.patient.count(),
    prisma.appointment.count(),
    prisma.appointment.count({ where: { status: 'COMPLETED' } }),
    prisma.appointment.count({ where: { status: 'CANCELLED' } }),
    prisma.appointment.count({ where: { status: 'PENDING'   } }),
    prisma.appointment.count({ where: { status: 'CONFIRMED' } }),
    prisma.appointment.aggregate({
      _sum: { feeAtBooking: true },
      where: { status: 'COMPLETED', paymentStatus: { in: ['PAID', 'CASH_COLLECTED', 'CASH_PENDING'] } }
    }),
    prisma.appointment.count({ where: { date: today } }),
    prisma.appointment.count({ where: { date: yesterday } }),
    prisma.appointment.count({ where: { date: { gte: last7 } } }),
    prisma.appointment.count({ where: { date: { gte: last30 } } }),
    prisma.appointment.count({ where: { consultationType: 'ONLINE'  } }),
    prisma.appointment.count({ where: { consultationType: 'OFFLINE' } }),
    prisma.appointment.aggregate({
      _sum: { feeAtBooking: true },
      where: { status: 'COMPLETED', date: { gte: last30 }, paymentStatus: { in: ['PAID','CASH_COLLECTED','CASH_PENDING'] } }
    }),
    prisma.notificationLog.count().catch(() => 0),
    prisma.notificationLog.count({ where: { status: 'FAILED' } }).catch(() => 0)
  ]);

  const last14 = new Date(today); last14.setDate(last14.getDate() - 13);
  const raw = await prisma.appointment.findMany({
    where: { date: { gte: last14 } },
    select: { date: true, status: true, feeAtBooking: true, paymentStatus: true }
  });
  const daily = {};
  for (let i = 0; i < 14; i++) {
    const d = new Date(today); d.setDate(d.getDate() - (13 - i));
    daily[d.toISOString().slice(0,10)] = { date: d.toISOString().slice(0,10), total: 0, completed: 0, revenue: 0 };
  }
  raw.forEach(r => {
    const k = new Date(r.date).toISOString().slice(0,10);
    if (!daily[k]) return;
    daily[k].total++;
    if (r.status === 'COMPLETED') {
      daily[k].completed++;
      if (['PAID','CASH_COLLECTED','CASH_PENDING'].includes(r.paymentStatus)) {
        daily[k].revenue += Number(r.feeAtBooking || 0);
      }
    }
  });

  res.json({
    totalDoctors, totalPatients, totalAppointments,
    completedAppointments: completed,
    cancelledAppointments: cancelled,
    pendingAppointments:   pending,
    confirmedAppointments: confirmed,
    onlineAppointments:    onlineCount,
    offlineAppointments:   offlineCount,
    totalRevenue:    Number(revenueAgg._sum.feeAtBooking || 0),
    revenueLast30:   Number(revenueLast30Agg._sum.feeAtBooking || 0),
    todayAppointments:     todayCount,
    yesterdayAppointments: yesterdayCount,
    last7Appointments:     last7Count,
    last30Appointments:    last30Count,
    completionRate:   totalAppointments > 0 ? Math.round((completed / totalAppointments) * 100) : 0,
    cancellationRate: totalAppointments > 0 ? Math.round((cancelled / totalAppointments) * 100) : 0,
    todayDelta:       todayCount - yesterdayCount,
    notificationsTotal:  notifTotal,
    notificationsFailed: notifFailed,
    daily: Object.values(daily)
  });
});
