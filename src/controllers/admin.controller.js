const fs = require('fs');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { createDoctorSchema, updateDoctorByAdminSchema, flattenZod, randomPassword } = require('../utils/validators');
const { asyncHandler } = require('../middleware/errorHandler');
const { sendStaffInvite } = require('../services/invite.service');
const { parseDateOnly, getTodayDateOnly } = require('../utils/date');
const { COLLECTED_PAYMENT_STATUSES, PENDING_PAYMENT_STATUSES } = require('../utils/payment');
const { photoUrlFor, deleteOldPhoto } = require('../services/profile-photo.service');

const SALT = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);

exports.createDoctor = asyncHandler(async (req, res) => {
  const parsed = createDoctorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: flattenZod(parsed.error), details: parsed.error.flatten() });
  }

  const { password, ...rest } = parsed.data;
  const exists = await prisma.doctor.findUnique({ where: { email: rest.email } });
  if (exists && !exists.deletedAt) return res.status(409).json({ error: 'A doctor with this email already exists' });

  // A password is always generated and stored so the doctor account is
  // never left without valid credentials, but onboarding is driven by
  // the invite link below rather than by sharing this password directly.
  // `mustChangePassword` stays true so the doctor is prompted to set
  // their own password the first time they use the link.
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

  // No invite email is sent here — creating the account and inviting the
  // doctor to activate it are separate, admin-controlled steps. The admin
  // sends (or resends) the invite from the doctor list via sendDoctorInvite.
  const { passwordHash: _, ...safe } = doctor;
  res.status(201).json({ ...safe, inviteSent: false });
});

exports.sendDoctorInvite = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  const { inviteLink, emailDelivered, expiresInMinutes } = await sendStaffInvite({
    user: doctor, userType: 'DOCTOR', roleLabel: 'Doctor'
  });

  res.json({
    inviteSent: emailDelivered,
    // Always returned so the admin can hand the link over manually if
    // the invite email doesn't arrive. Same link that was emailed;
    // treat it as a one-time secret.
    invitePreviewUrl: inviteLink,
    inviteExpiresInMinutes: expiresInMinutes
  });
});

// Admin-set profile photo — optional; a doctor can still set their own via
// PUT /api/doctor/profile-image. Mirrors that handler exactly, just scoped
// to req.params.id instead of the doctor's own session.
exports.uploadDoctorProfileImage = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Profile image file is required' });
  const doctor = await prisma.doctor.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  const photoUrl = photoUrlFor(req.file.filename);
  let updated;
  try {
    updated = await prisma.doctor.update({ where: { id: doctor.id }, data: { photoUrl } });
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    throw err;
  }
  await deleteOldPhoto(doctor.photoUrl);
  res.json({ success: true, photoUrl: updated.photoUrl });
});

exports.removeDoctorProfileImage = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  await prisma.doctor.update({ where: { id: doctor.id }, data: { photoUrl: null } });
  await deleteOldPhoto(doctor.photoUrl);
  res.json({ success: true });
});

// Admin's own profile photo (self-service, same shape as Doctor's).
exports.uploadOwnProfileImage = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Profile image file is required' });
  const me = await prisma.admin.findUnique({ where: { id: req.user.id } });
  if (!me) return res.status(404).json({ error: 'Not found' });
  const photoUrl = photoUrlFor(req.file.filename);
  let updated;
  try {
    updated = await prisma.admin.update({ where: { id: me.id }, data: { photoUrl } });
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    throw err;
  }
  await deleteOldPhoto(me.photoUrl);
  res.json({ success: true, photoUrl: updated.photoUrl });
});

exports.removeOwnProfileImage = asyncHandler(async (req, res) => {
  const me = await prisma.admin.findUnique({ where: { id: req.user.id } });
  if (!me) return res.status(404).json({ error: 'Not found' });
  await prisma.admin.update({ where: { id: me.id }, data: { photoUrl: null } });
  await deleteOldPhoto(me.photoUrl);
  res.json({ success: true });
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
      registrationNumber: true, availableFromOffline: true, availableToOffline: true,
     isAvailable: true, mustChangePassword: true, consults: true, revenue: true,

// Revenue Management
clinicSharePercent: true,
doctorSharePercent: true,
tdsPercent: true,
canAddPreviousRecords: true,

photoUrl: true,
createdAt: true
    }
  });
  res.json(doctors);
});

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

// Soft delete = Deactivate
exports.deleteDoctor = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.doctor.update({
    where: { id },
    data: { isAvailable: false, deletedAt: new Date() }
  });
  res.json({ success: true, message: 'Doctor deactivated' });
});

// Hard delete = only if no appointments
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
  // Auto-cancelled (unpaid-expired) appointments are noise in active
  // listings, so the UI excludes them by default.
  if (String(req.query.excludeAutoCancelled || '') === '1') {
    where.NOT = { status: 'CANCELLED', paymentStatus: 'FAILED', notes: { contains: 'Auto-cancelled' } };
  }
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

// Admin-initiated refund for a cancelled, genuinely-Cashfree-paid
// appointment. Deliberately admin-only (real money leaving the clinic's
// Cashfree account) — reception can cancel an appointment, but refunding
// it back to the parent is a separate, more consequential action.
exports.refundAppointment = asyncHandler(async (req, res) => {
  const cashfree = require('../services/cashfree.service');
  const audit = require('../services/audit.service');

  const appt = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: { patient: true, doctor: { select: { name: true } } }
  });
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (appt.status !== 'CANCELLED') {
    return res.status(400).json({ error: 'Only a cancelled appointment can be refunded' });
  }
  if (appt.paymentStatus !== 'PAID' || !appt.cashfreeOrderId) {
    return res.status(400).json({ error: 'This appointment has no genuine Cashfree payment to refund' });
  }
  if (appt.refundId) {
    return res.status(409).json({ error: 'This appointment was already refunded', code: 'ALREADY_REFUNDED' });
  }

  // Deterministic (not random) so a retried request after a timeout can't
  // double-refund — Cashfree dedupes retries that reuse the same refund_id.
  const refundId = `refund_${appt.id}`;
  const refund = await cashfree.createRefund({
    orderId: appt.cashfreeOrderId,
    refundId,
    refundAmount: Number(appt.feeAtBooking),
    refundNote: (req.body && req.body.reason) || undefined
  });

  const updated = await prisma.appointment.update({
    where: { id: appt.id },
    data: { paymentStatus: 'REFUNDED', refundId: refund.cf_refund_id || refundId, refundedAt: new Date() }
  });

  await audit.log({
    actor: { id: req.user.id, role: 'ADMIN', name: req.user.email },
    action: 'APPOINTMENT_REFUNDED',
    entityType: 'APPOINTMENT',
    entityId: appt.id,
    summary: `Refunded ₹${Number(appt.feeAtBooking).toFixed(2)} to ${appt.patient.name} for the cancelled appointment with Dr. ${appt.doctor.name}`,
    doctorId: appt.doctorId
  });

  res.json(updated);
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
    // "Revenue" = collected only, matching revenueBySource.totalCollected
    // below — CASH_PENDING is billed but not yet received, so it must
    // never be blended into the headline revenue figure.
    prisma.appointment.aggregate({
      _sum: { feeAtBooking: true },
      where: { status: 'COMPLETED', paymentStatus: { in: COLLECTED_PAYMENT_STATUSES } }
    }),
    prisma.appointment.count({ where: { date: today } }),
    prisma.appointment.count({ where: { date: yesterday } }),
    prisma.appointment.count({ where: { date: { gte: last7 } } }),
    prisma.appointment.count({ where: { date: { gte: last30 } } }),
    prisma.appointment.count({ where: { consultationType: 'ONLINE'  } }),
    prisma.appointment.count({ where: { consultationType: 'OFFLINE' } }),
    prisma.appointment.aggregate({
      _sum: { feeAtBooking: true },
      where: { status: 'COMPLETED', date: { gte: last30 }, paymentStatus: { in: COLLECTED_PAYMENT_STATUSES } }
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
    daily[d.toISOString().slice(0,10)] = { date: d.toISOString().slice(0,10), total: 0, completed: 0, revenue: 0, pending: 0 };
  }
  // "revenue" here must mean the same thing it means in revenueBySource
  // below — money actually collected — or the dashboard ends up showing
  // two different numbers both labeled "revenue". Billed-but-uncollected
  // (CASH_PENDING) is tracked separately as `pending`, never folded in.
  raw.forEach(r => {
    const k = new Date(r.date).toISOString().slice(0,10);
    if (!daily[k]) return;
    daily[k].total++;
    if (r.status === 'COMPLETED') {
      daily[k].completed++;
      const amount = Number(r.feeAtBooking || 0);
      if (COLLECTED_PAYMENT_STATUSES.includes(r.paymentStatus)) daily[k].revenue += amount;
      else if (PENDING_PAYMENT_STATUSES.includes(r.paymentStatus)) daily[k].pending += amount;
    }
  });

  // Revenue by source, split into collected vs pending. Consultation revenue
  // is separated into online (Cashfree) and in-clinic (offline); pharmacy
  // revenue comes from paid pharmacy bills. Collected = money received;
  // pending = billed but not yet collected — never blended into one figure.
  const COLLECTED = COLLECTED_PAYMENT_STATUSES;
  const [
    onlineCollectedAgg, offlineCollectedAgg,
    onlinePendingAgg, offlinePendingAgg,
    pharmacyPaidAgg, pharmacyDraftAgg,
    outstandingInvoices
  ] = await Promise.all([
    prisma.appointment.aggregate({ _sum: { feeAtBooking: true }, where: { status: 'COMPLETED', consultationType: 'ONLINE',  paymentStatus: { in: COLLECTED } } }),
    prisma.appointment.aggregate({ _sum: { feeAtBooking: true }, where: { status: 'COMPLETED', consultationType: 'OFFLINE', paymentStatus: { in: COLLECTED } } }),
    prisma.appointment.aggregate({ _sum: { feeAtBooking: true }, where: { status: 'COMPLETED', consultationType: 'ONLINE',  paymentStatus: 'CASH_PENDING' } }),
    prisma.appointment.aggregate({ _sum: { feeAtBooking: true }, where: { status: 'COMPLETED', consultationType: 'OFFLINE', paymentStatus: 'CASH_PENDING' } }),
    prisma.pharmacyBill.aggregate({ _sum: { total: true }, where: { status: 'PAID' } }).catch(() => ({ _sum: { total: 0 } })),
    prisma.pharmacyBill.aggregate({ _sum: { total: true }, where: { status: 'DRAFT' } }).catch(() => ({ _sum: { total: 0 } })),
    prisma.consultationInvoice.count({ where: { status: 'PENDING' } }).catch(() => 0)
  ]);
  const onlineRev   = Number(onlineCollectedAgg._sum.feeAtBooking || 0);
  const offlineRev  = Number(offlineCollectedAgg._sum.feeAtBooking || 0);
  const pharmacyRev = Number(pharmacyPaidAgg._sum.total || 0);
  const revenueBySource = {
    online:   { collected: onlineRev,  pending: Number(onlinePendingAgg._sum.feeAtBooking || 0) },
    offline:  { collected: offlineRev, pending: Number(offlinePendingAgg._sum.feeAtBooking || 0) },
    pharmacy: { collected: pharmacyRev, pending: Number(pharmacyDraftAgg._sum.total || 0) },
    totalCollected: onlineRev + offlineRev + pharmacyRev,
    outstandingInvoices
  };

  // Booking channel split — "online" consultationType above means video vs
  // in-person visit; this is a different axis entirely: who actually made
  // the booking. `source` defaults to NEOKIDSPRO for a patient booking
  // straight through the public website/booking-widget (booking.service.js
  // never sets it), while every reception-created booking sets an explicit
  // WALK_IN/PHONE/OTHER (or legacy CLINIC_RECEPTION) value — see
  // receptionist.controller.js createAppointment. MANUAL rows are
  // historical/imported records, not a live booking channel, so they're
  // reported separately rather than folded into either bucket.
  const RECEPTION_SOURCES = ['WALK_IN', 'PHONE', 'OTHER', 'CLINIC_RECEPTION'];
  const [
    websiteCount, receptionCount, manualCount,
    websiteRevenueAgg, receptionRevenueAgg
  ] = await Promise.all([
    prisma.appointment.count({ where: { source: 'NEOKIDSPRO' } }),
    prisma.appointment.count({ where: { source: { in: RECEPTION_SOURCES } } }),
    prisma.appointment.count({ where: { source: 'MANUAL' } }),
    prisma.appointment.aggregate({ _sum: { feeAtBooking: true }, where: { source: 'NEOKIDSPRO', status: 'COMPLETED', paymentStatus: { in: COLLECTED } } }),
    prisma.appointment.aggregate({ _sum: { feeAtBooking: true }, where: { source: { in: RECEPTION_SOURCES }, status: 'COMPLETED', paymentStatus: { in: COLLECTED } } })
  ]);
  const bookingSource = {
    website:   { count: websiteCount,   revenue: Number(websiteRevenueAgg._sum.feeAtBooking || 0) },
    reception: { count: receptionCount, revenue: Number(receptionRevenueAgg._sum.feeAtBooking || 0) },
    manual:    { count: manualCount }
  };

  res.json({
    revenueBySource,
    bookingSource,
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

// ────────────────────────────────────────────────────────────────────
// v4.0.0 — Doctors available for offline consultations (receptionist &
// pharmacy assignment pickers). Returns the clinic/registration details
// the front desk needs verbatim from the doctor's own account/admin data.
// ────────────────────────────────────────────────────────────────────
exports.availableOfflineDoctors = asyncHandler(async (req, res) => {
  const doctors = await prisma.doctor.findMany({
    where: { deletedAt: null, isAvailable: true, consultationModes: { in: ['OFFLINE', 'BOTH'] } },
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, email: true, phone: true,
      specialization: true, qualification: true, registrationNumber: true,
      clinicName: true, clinicAddress: true, clinicMapUrl: true,
      physicalConsultFee: true, onlineConsultFee: true, slotDuration: true,
      workingDays: true, availableFromOffline: true, availableToOffline: true,
      consultationModes: true, photoUrl: true
    }
  });
  res.json(doctors);
});

// v4.0.0 — Consultation invoices issued by receptionists (read-only admin).
exports.consultationInvoices = asyncHandler(async (req, res) => {
  const { doctorId, centreId, from, to, q } = req.query;
  const where = {};
  if (doctorId) where.doctorId = doctorId;
  if (centreId) where.medicalCentreId = centreId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from + 'T00:00:00.000Z');
    if (to)   where.createdAt.lte = new Date(to + 'T23:59:59.999Z');
  }
  if (q && String(q).trim().length >= 2) {
    const term = String(q).trim();
    where.OR = [
      { invoiceNumber: { contains: term } },
      { appointment: { is: { patient: { is: { name: { contains: term } } } } } }
    ];
  }
  const rows = await prisma.consultationInvoice.findMany({
    where,
    include: {
      appointment: { include: {
        patient: { select: { id: true, name: true, phone: true } },
        doctor:  { select: { id: true, name: true, specialization: true } }
      } },
      medicalCentre: true,
      receptionist: { select: { id: true, name: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 500)
  });
  const { buildSignedFileUrl } = require('../utils/fileTokens');
  res.json(rows.map(r => ({
    ...r,
    pdfUrl: buildSignedFileUrl({ kind: 'consultation-invoice', appointmentId: r.id, userId: req.user.id, role: req.user.role })
  })));
});

// NeoKidsPro online-booking invoices. Online consultations are booked and
// paid by the patient through the public flow; their invoice PDF lives on
// the appointment (invoiceUrl) rather than in the ConsultationInvoice table,
// so admins previously had no place to see or re-share them. This surfaces
// every paid online booking with a re-signed, admin-scoped invoice URL,
// using the same filter surface (doctorId / centreId / from / to / q) as the
// reception invoices for consistent invoice access across billing sources.
exports.onlineInvoices = asyncHandler(async (req, res) => {
  const { doctorId, from, to, q } = req.query;
  const where = {
    source: 'NEOKIDSPRO',
    OR: [
      { cashfreePaymentId: { not: null } },
      { invoiceUrl: { not: null } }
    ]
  };
  if (doctorId) where.doctorId = doctorId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from + 'T00:00:00.000Z');
    if (to)   where.createdAt.lte = new Date(to + 'T23:59:59.999Z');
  }
  const andQ = [];
  if (q && String(q).trim().length >= 2) {
    const term = String(q).trim();
    andQ.push({ OR: [
      { patient: { is: { name: { contains: term } } } },
      { patient: { is: { phone: { contains: term.replace(/\D/g, '') } } } }
    ] });
  }
  const finalWhere = andQ.length ? { AND: [where, ...andQ] } : where;
  const rows = await prisma.appointment.findMany({
    where: finalWhere,
    select: {
      id: true, date: true, startTime: true, createdAt: true,
      feeAtBooking: true, paymentStatus: true, cashfreePaymentId: true, invoiceUrl: true,
      patient: { select: { id: true, name: true, phone: true, email: true } },
      doctor:  { select: { id: true, name: true, specialization: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 500)
  });
  const { buildSignedFileUrl } = require('../utils/fileTokens');
  res.json(rows.map(r => ({
    id: r.id,
    invoiceNumber: `INV-${r.id.slice(0, 8).toUpperCase()}`,
    date: r.date,
    startTime: r.startTime,
    createdAt: r.createdAt,
    amount: r.feeAtBooking,
    paymentStatus: r.paymentStatus,
    paymentId: r.cashfreePaymentId || null,
    patient: r.patient,
    doctor: r.doctor,
    pdfUrl: buildSignedFileUrl({ kind: 'invoice', appointmentId: r.id, userId: req.user.id, role: req.user.role })
  })));
});

// v4.0.0 — Staff audit trail (who created/modified what).
exports.auditTrail = asyncHandler(async (req, res) => {
  const { role, action, actorId, from, to, q } = req.query;
  const where = {};
  if (role)    where.actorRole = role;
  if (action)  where.action = action;
  if (actorId) where.actorId = actorId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from + 'T00:00:00.000Z');
    if (to)   where.createdAt.lte = new Date(to + 'T23:59:59.999Z');
  }
  if (q && String(q).trim().length >= 2) {
    const term = String(q).trim();
    where.OR = [
      { actorName: { contains: term } },
      { summary:   { contains: term } },
      { entityId:  { contains: term } }
    ];
  }
  const take = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
  const skip = (page - 1) * take;
  const [rows, totalCount] = await Promise.all([
    prisma.staffAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
    prisma.staffAuditLog.count({ where })
  ]);
  res.json({
    rows, page, limit: take, total: totalCount,
    totalPages: Math.max(Math.ceil(totalCount / take), 1),
    hasMore: skip + rows.length < totalCount
  });
});

// Manually trigger the vaccination reminder scan (bypasses the daily guard).
// Used for end-to-end testing and for verifying WhatsApp/Email wiring.
// By default this respects the parent-friendly delivery window (18:00–20:00 IST);
// pass ?force=1 (or { force: true } in the body) to override it for QA.
exports.runVaccinationReminders = asyncHandler(async (req, res) => {
  const vacc = require('../services/vaccination.service');
  const force = String(req.query.force || req.body?.force || '').toLowerCase() === '1'
              || String(req.query.force || req.body?.force || '').toLowerCase() === 'true';
  const result = await vacc.processVaccinationReminders({ force });
  res.json({
    ok: true,
    template: vacc.WA_TPL_VACCINATION,
    portalUrl: vacc.VACCINATION_PORTAL_URL,
    neokidsUrl: vacc.NEOKIDSPRO_URL,
    deliveryWindowIST: `${vacc.WINDOW_START_HOUR}:00-${vacc.WINDOW_END_HOUR}:00`,
    forced: force,
    waProvider: (process.env.WA_PROVIDER || 'MOCK').toUpperCase(),
    smtpConfigured: !!process.env.SMTP_HOST,
    metaConfigured: !!(process.env.META_PHONE_NUMBER_ID && process.env.META_ACCESS_TOKEN),
    enabled: process.env.VACC_REMINDERS_ENABLED !== 'false',
    ...result
  });
});
