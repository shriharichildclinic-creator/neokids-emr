const fs = require('fs');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  staffPatientCreateSchema,
  receptionistBookSchema,
  staffRescheduleSchema,
  prescriptionSchema,
  medicalCertificateSchema
} = require('../utils/validators');
const { parseDateOnly, parseDateOnlyOrNull, getTodayDateOnly, getTodayDateString, calcAge, buildDailyTrend } = require('../utils/date');
const { findOrCreatePatient } = require('../services/booking.service');
const slotService = require('../services/slot.service');
const staffAccess = require('../services/staffAccess.service');
const staffDocs = require('../services/staff-docs.service');
const audit = require('../services/audit.service');
const notifications = require('../services/notification.service');
const { buildSignedFileUrl } = require('../utils/fileTokens');
const logger = require('../utils/logger');
const { photoUrlFor, deleteOldPhoto } = require('../services/profile-photo.service');
const consultInvoiceSvc = require('../services/consultation-invoice.service');
const revenueSvc = require('../services/revenue.service');
const { COLLECTED_PAYMENT_STATUSES } = require('../utils/payment');

const SALT = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);

async function requireConsultations(req, res) {
  const me = await staffAccess.getReceptionist(req.user.id);
  if (!me) { res.status(401).json({ error: 'Account not found' }); return null; }
  if (me.status !== 'ACTIVE') { res.status(403).json({ error: 'Account is suspended' }); return null; }
  if (!me.canManageConsultations) {
    res.status(403).json({ error: 'Consultation management is not enabled for your account' });
    return null;
  }
  return me;
}

async function requireCertificates(req, res) {
  const me = await requireConsultations(req, res);
  if (!me) return null;
  if (!me.canIssueCertificates) {
    res.status(403).json({ error: 'Certificate issuing is not enabled for your account' });
    return null;
  }
  return me;
}

function actorOf(req, me) {
  return { id: me.id, role: 'RECEPTIONIST', name: me.name };
}

function signConsultInvoiceUrl(invoiceId, user) {
  return buildSignedFileUrl({ kind: 'consultation-invoice', appointmentId: invoiceId, userId: user.id, role: 'RECEPTIONIST' });
}

exports.me = asyncHandler(async (req, res) => {
  const me = await staffAccess.getReceptionist(req.user.id);
  if (!me) return res.status(404).json({ error: 'Not found' });
  const { passwordHash, ...safe } = me;
  res.json(safe);
});

exports.uploadProfileImage = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Profile image file is required' });
  const me = await staffAccess.getReceptionist(req.user.id);
  if (!me) return res.status(404).json({ error: 'Not found' });
  const photoUrl = photoUrlFor(req.file.filename);
  let updated;
  try {
    updated = await prisma.receptionist.update({ where: { id: me.id }, data: { photoUrl } });
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    throw err;
  }
  await deleteOldPhoto(me.photoUrl);
  res.json({ success: true, photoUrl: updated.photoUrl });
});

exports.removeProfileImage = asyncHandler(async (req, res) => {
  const me = await staffAccess.getReceptionist(req.user.id);
  if (!me) return res.status(404).json({ error: 'Not found' });
  await prisma.receptionist.update({ where: { id: me.id }, data: { photoUrl: null } });
  await deleteOldPhoto(me.photoUrl);
  res.json({ success: true });
});

exports.assignments = asyncHandler(async (req, res) => {
  const rows = await staffAccess.getAssignments(req.user.id);
  res.json(rows.map(r => ({
    id: r.id,
    medicalCentre: r.medicalCentre,
    doctor: r.doctor
  })));
});

exports.stats = asyncHandler(async (req, res) => {
  const doctorIds = await staffAccess.getDoctorIds(req.user.id);
  if (!doctorIds.length) {
    return res.json({
      todayAppointments: 0, arrivedToday: 0, pendingToday: 0, invoicesToday: 0, patientsTotal: 0,
      bookedToday: 0, walkinToday: 0, cashCollectedToday: 0, onlineCollectedToday: 0, pendingCollectionToday: 0,
      trend: { today: { appointments: 0, vsYesterday: 0 }, daily: [], thisWeek: { appointments: 0, collected: 0 }, prevWeek: { appointments: 0, collected: 0 } }
    });
  }
  const today = getTodayDateOnly();
  const dayStart = new Date(getTodayDateString() + 'T00:00:00.000Z');
  const CASH_METHODS = ['CASH', 'CARD', 'OTHER'];

  const yesterday = new Date(today); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const last14 = new Date(today); last14.setUTCDate(last14.getUTCDate() - 13);

  const [
    todayCount, arrived, pending, invToday, patients,
    walkinToday, todayInvoices,
    yesterdayCount, fortnightAppts, fortnightCollected
  ] = await Promise.all([
    // OFFLINE-only throughout this block: teleconsultations are booked,
    // paid and invoiced end-to-end by the online flow with no reception
    // step involved, so they're excluded from every reception-facing count
    // and revenue figure rather than just hidden from the appointments list.
    prisma.appointment.count({ where: { doctorId: { in: doctorIds }, consultationType: 'OFFLINE', date: today, status: { not: 'CANCELLED' } } }),
    prisma.appointment.count({ where: { doctorId: { in: doctorIds }, consultationType: 'OFFLINE', date: today, arrivedAt: { not: null } } }),
    prisma.appointment.count({ where: { doctorId: { in: doctorIds }, consultationType: 'OFFLINE', date: today, status: { in: ['PENDING', 'CONFIRMED'] }, arrivedAt: null } }),
    prisma.consultationInvoice.count({ where: { doctorId: { in: doctorIds }, createdAt: { gte: dayStart } } }),
    staffAccess.getPatientScope(req.user.id).then(ids => ids.length),
    // Walk-in / reception in-person bookings today (WALK_IN + legacy CLINIC_RECEPTION).
    prisma.appointment.count({ where: { doctorId: { in: doctorIds }, consultationType: 'OFFLINE', date: today, source: { in: ['WALK_IN', 'CLINIC_RECEPTION'] } } }),
    // Collections figures represent the clinic's overall collections for this
    // receptionist's assigned doctors — not just invoices this receptionist
    // personally generated. A payment collected by another receptionist, or
    // by the doctor directly (see doctor.controller.js markPaid / this
    // file's markPaid, both of which now create the invoice record too),
    // is scoped by doctorId here so it still counts toward these totals —
    // matching how the Invoices tab and Appointments list are already
    // scoped. Includes VOID rows too (cancelled after payment) — the loop
    // below explicitly skips them so a cancelled visit never counts as
    // collected or pending. Restricted to OFFLINE, mirroring every other
    // count in this block — a teleconsultation is never reception-facing
    // "clinic cash", even if a doctor later marks it paid in cash.
    prisma.consultationInvoice.findMany({
      where: { doctorId: { in: doctorIds }, createdAt: { gte: dayStart }, appointment: { is: { consultationType: 'OFFLINE' } } },
      select: { amount: true, status: true, paymentMethod: true }
    }),
    prisma.appointment.count({ where: { doctorId: { in: doctorIds }, consultationType: 'OFFLINE', date: yesterday, status: { not: 'CANCELLED' } } }),
    prisma.appointment.findMany({
      where: { doctorId: { in: doctorIds }, consultationType: 'OFFLINE', date: { gte: last14 }, status: { not: 'CANCELLED' } },
      select: { date: true }
    }),
    // BUG FIX (Doctor Analytics Audit): this used to sum ConsultationInvoice
    // rows keyed by invoice.createdAt — a different table and a different
    // date field than "Overall clinic revenue" (getCashCollectedTotal, which
    // sums Appointment.feeAtBooking keyed by the appointment's own date, and
    // requires cashfreeOrderId: null so gateway revenue is never counted
    // twice). Two queries over two different tables inevitably drift apart —
    // that's exactly why "Collected this week" could show a bigger number
    // than the whole month's "Overall clinic revenue" total. This now reads
    // from the identical Appointment-based source (same fields, same
    // cashfreeOrderId/paymentStatus filters, same OFFLINE scope) as every
    // other clinic-cash figure, keyed by the appointment's date instead of
    // an invoice's creation timestamp — so a week's total can never exceed
    // its containing month's total again, and the two panels always agree.
    prisma.appointment.findMany({
      where: {
        doctorId: { in: doctorIds }, consultationType: 'OFFLINE',
        date: { gte: last14 }, paymentStatus: { in: COLLECTED_PAYMENT_STATUSES },
        cashfreeOrderId: null
        // CONSISTENCY FIX: this used to also exclude status:'CANCELLED'.
        // getCashCollectedTotal (revenue.service.js) — the function this
        // block is explicitly mirroring — deliberately does NOT exclude
        // cancelled appointments: a cancelled-but-not-yet-refunded visit
        // is still real money sitting with the clinic until an explicit
        // refund flips paymentStatus to REFUNDED, and the Admin doctor-
        // card revenue figure (admin.controller.js listDoctors) never
        // excluded it either. Excluding it only here made this week's
        // trend total quietly disagree with both of those for any doctor
        // with a cancelled-after-payment visit in the last 14 days.
      },
      select: { date: true, feeAtBooking: true }
    })
  ]);

  let cashCollectedToday = 0, onlineCollectedToday = 0, pendingCollectionToday = 0;
  for (const inv of todayInvoices) {
    if (inv.status === 'VOID') continue; // cancelled after payment — no longer real revenue or a real pending due
    const amt = Number(inv.amount || 0);
    if (inv.status === 'PAID') {
      if (CASH_METHODS.includes(inv.paymentMethod)) cashCollectedToday += amt;
      else onlineCollectedToday += amt; // UPI / ONLINE
    } else {
      pendingCollectionToday += amt;
    }
  }
  const bookedToday = Math.max(todayCount - walkinToday, 0);

  // 14-day daily series (appointments booked + cash/online collected) for
  // the dashboard's trend sparkline, split into this-week vs last-week
  // totals for a real week-over-week comparison.
  const { daily, thisWeek, prevWeek } = buildDailyTrend({
    start: last14,
    emptyBucket: () => ({ appointments: 0, collected: 0 }),
    sources: [
      { rows: fortnightAppts, dateOf: (a) => a.date, accumulate: (bucket) => { bucket.appointments += 1; } },
      { rows: fortnightCollected, dateOf: (a) => a.date, accumulate: (bucket, a) => { bucket.collected += Number(a.feeAtBooking || 0); } }
    ],
    weekFields: ['appointments', 'collected']
  });
  const thisWeekAppts = thisWeek.appointments, prevWeekAppts = prevWeek.appointments;
  const thisWeekCollected = thisWeek.collected, prevWeekCollected = prevWeek.collected;

  res.json({
    todayAppointments: todayCount,
    arrivedToday: arrived,
    pendingToday: pending,
    invoicesToday: invToday,
    patientsTotal: patients,
    bookedToday,
    walkinToday,
    cashCollectedToday,
    onlineCollectedToday,
    pendingCollectionToday,
    trend: {
      today: { appointments: todayCount, vsYesterday: todayCount - yesterdayCount },
      daily: Object.values(daily).slice(7), // last 7 days, oldest → newest
      thisWeek: { appointments: thisWeekAppts, collected: thisWeekCollected },
      prevWeek: { appointments: prevWeekAppts, collected: prevWeekCollected }
    }
  });
});

// ─── In-person clinic revenue (reception scope only) ───
//
// `stats` above only ever answers "today". Reception previously had no
// month/overall view, so the only cash figures a receptionist could see
// were computed from ConsultationInvoice rows created *today* — a
// different table, different status filter, and a different date field
// than the one powering a doctor's own "My Earnings → Cash Collected
// (Clinic)" card (which sums Appointment.feeAtBooking by appointment
// date, not invoice-creation date). Two different queries over two
// different tables inevitably drift apart, which is exactly the "all
// different figures everywhere" symptom.
//
// SCOPE FIX (Platform-Wide Analytics Audit): this endpoint previously
// called getOverallClinicRevenue(), which folds in every Cashfree/online
// consultation on top of in-person cash, and the panel showed an "Online"
// column. Receptionists only manage in-person/clinic-cash workflow — they
// never touch a teleconsultation or its payment — so a reception-facing
// revenue figure that silently includes online income is out of scope,
// not just mislabeled. This now calls getCashCollectedTotal() and reports
// ONLY its `offlineCash` / `offlineConsultations` fields — the same
// "in-person cash only" figures a doctor's own Earnings page shows for
// themselves — so reception numbers can never disagree with what the
// doctor sees for their own in-person visits. (Any teleconsultation paid
// in cash after the fact still shows up in the DOCTOR's and ADMIN's
// revenue figures via that same function's `onlineCashCollected` field —
// it's just correctly excluded from the receptionist's clinic-cash view.)
exports.revenue = asyncHandler(async (req, res) => {
  const doctorIds = await staffAccess.getDoctorIds(req.user.id);
  const now = new Date();
  const year = parseInt(req.query.year, 10) || now.getUTCFullYear();
  const month = parseInt(req.query.month, 10) || (now.getUTCMonth() + 1);
  if (month < 1 || month > 12) return res.status(400).json({ error: 'Invalid month (1-12)' });

  if (!doctorIds.length) {
    return res.json({
      period: { year, month }, totalRevenue: 0, consultations: 0,
      pendingCollection: { amount: 0, count: 0 }, byDoctor: []
    });
  }

  const [overall, pending] = await Promise.all([
    revenueSvc.getCashCollectedTotal({ doctorId: { in: doctorIds }, year, month }),
    // Same scope (OFFLINE, this receptionist's assigned doctors) and same
    // Appointment.date period as `overall` above — see doc-comment on
    // getPendingCollectionsTotal for why it deliberately mirrors
    // getCashCollectedTotal's table/date source instead of reading off
    // ConsultationInvoice.createdAt.
    revenueSvc.getPendingCollectionsTotal({ doctorId: { in: doctorIds }, year, month })
  ]);

  // Per-doctor breakdown, each computed with the exact same function a
  // doctor would call for themselves — so any one row here is guaranteed
  // identical to what that doctor sees on their own earnings dashboard.
  const doctors = await prisma.doctor.findMany({
    where: { id: { in: doctorIds } },
    select: { id: true, name: true }
  });
  const byDoctor = await Promise.all(doctors.map(async d => {
    const row = await revenueSvc.getCashCollectedTotal({ doctorId: d.id, year, month });
    return {
      doctorId: d.id,
      doctorName: d.name,
      totalRevenue: row.offlineCash,
      consultations: row.offlineConsultations
    };
  }));

  res.json({
    period: { year, month },
    // In-person cash collected only — see scope note above. Reception has
    // no online/teleconsultation revenue in its scope, so "Total Revenue",
    // "In-Person Revenue" and "Cash Collected" are the same figure here by
    // design — the UI presents this as one headline card rather than three
    // duplicate ones. "Online Revenue" is intentionally never returned by
    // this endpoint for the same reason.
    totalRevenue: overall.offlineCash,
    consultations: overall.offlineConsultations,
    // Billed but not yet collected at the desk this period.
    pendingCollection: pending,
    byDoctor
  });
});

exports.slots = asyncHandler(async (req, res) => {
  const { doctorId, date, type } = req.query;
  if (!doctorId || !date || !type) return res.status(400).json({ error: 'doctorId, date and type are required' });
  const assigned = await staffAccess.isAssignedDoctor(req.user.id, doctorId);
  if (!assigned) return res.status(403).json({ error: 'Doctor not assigned to you' });
  const slots = await slotService.getLiveSlots(doctorId, date, type);
  res.json({ doctorId, date, type, slots });
});

// ─── Patients ───
exports.searchPatients = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const scope = await staffAccess.getPatientScope(req.user.id);
  if (!scope.length) return res.json([]);
  const digits = q.replace(/\D/g, '');
  const or = [{ name: { contains: q } }];
  if (digits.length >= 4) or.push({ phone: { contains: digits } });
  const where = { AND: [{ OR: or }, { id: { in: scope } }] };
  const rows = await prisma.patient.findMany({
    where,
    orderBy: [{ name: 'asc' }],
    take: 20
  });
  res.json(rows);
});

exports.registerPatient = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const parsed = staffPatientCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  const patient = await findOrCreatePatient({
    patientName: d.name,
    phone: d.phone,
    email: d.email,
    parentName: d.parentName,
    dateOfBirth: d.dateOfBirth,
    gender: d.gender
  });
  if (d.address) {
    await prisma.patient.update({ where: { id: patient.id }, data: { address: d.address } }).catch(() => null);
    patient.address = d.address;
  }
  const centreId = await staffAccess.primaryCentreId(me.id);
  await staffAccess.recordPatientRegistration({ patientId: patient.id, receptionistId: me.id, medicalCentreId: centreId });
  await audit.log({
    actor: actorOf(req, me), action: 'PATIENT_REGISTERED', entityType: 'PATIENT', entityId: patient.id,
    summary: `Registered patient ${patient.name} (+91 ${patient.phone})`,
    medicalCentreId: centreId
  });
  res.status(201).json(patient);
});

exports.patientHistory = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const doctorIds = await staffAccess.getDoctorIds(me.id);
  const scope = await staffAccess.getPatientScope(me.id);
  if (!scope.includes(req.params.id)) return res.status(404).json({ error: 'Patient not found' });
  const visits = await prisma.appointment.findMany({
    where: { patientId: req.params.id, doctorId: { in: doctorIds } },
    include: {
      prescription: true,
      doctor: { select: { id: true, name: true, specialization: true } }
    },
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
    take: 50
  });
  const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  res.json({
    patient,
    visits: visits.map(v => ({
      id: v.id, date: v.date, startTime: v.startTime, status: v.status,
      consultationType: v.consultationType, primaryProblem: v.primaryProblem,
      source: v.source, paymentStatus: v.paymentStatus,
      doctorName: v.doctor.name, hasPrescription: !!v.prescription
    }))
  });
});

// ─── Appointments ───
exports.listAppointments = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const doctorIds = await staffAccess.getDoctorIds(me.id);
  if (!doctorIds.length) return res.json([]);
  const { status, date, from, to, doctorId, q, billedDate } = req.query;
  const where = { doctorId: { in: doctorIds }, consultationType: 'OFFLINE' };
  if (doctorId && doctorIds.includes(doctorId)) where.doctorId = doctorId;
  if (status) where.status = status;
  // Unpaid-and-expired online bookings, Cashfree order-creation failures,
  // and gateway payment failures all auto-cancel themselves — they never
  // became real bookings, so they're noise, not a real cancellation
  // reception needs to see. Filtered out unconditionally rather than
  // behind a toggle (unless reception explicitly asks to see CANCELLED
  // appointments, in which case showing everything including these is the
  // actual expected behaviour). Matched on status+paymentStatus rather
  // than notes text, since a genuine cancellation never sets paymentStatus
  // to FAILED — this reliably covers every path that produces a phantom row.
  if (status !== 'CANCELLED') {
    where.NOT = { status: 'CANCELLED', paymentStatus: 'FAILED' };
  }
  if (billedDate) {
    // The dashboard's "Collected this week" sparkline buckets a day's
    // total by when the invoice was generated (consultationInvoice.createdAt),
    // not by the appointment's own scheduled date. Reception could tap a
    // bar showing real money collected on, say, Monday and land on an
    // Appointments list filtered by appointment date=Monday that comes back
    // empty — because the appointment behind that invoice had since been
    // rescheduled to a different day (the invoice's createdAt never moves
    // with it). Filtering by the invoice's own created date instead makes
    // "View appointments" always show the visits that actually produced
    // that day's collected figure. Scoped to assigned doctors (not just
    // this receptionist's own invoices), matching the clinic-wide sparkline
    // total it's answering for — a doctor- or colleague-collected payment
    // shows up here too, same as it does in the dashboard figure.
    const start = parseDateOnly(billedDate);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
    where.consultationInvoice = { is: { createdAt: { gte: start, lt: end }, status: 'PAID' } };
  } else {
    if (date) where.date = parseDateOnly(date);
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = parseDateOnly(from);
      if (to)   where.date.lte = parseDateOnly(to);
    }
  }
  if (q && String(q).trim().length >= 2) {
    const term = String(q).trim();
    const digits = term.replace(/\D/g, '');
    where.AND = [{
      OR: [
        { primaryProblem: { contains: term } },
        { patient: { is: { name: { contains: term } } } },
        ...(digits.length >= 4 ? [{ patient: { is: { phone: { contains: digits } } } }] : [])
      ]
    }];
  }
  const rows = await prisma.appointment.findMany({
    where,
    include: {
      patient: true,
      doctor: { select: { id: true, name: true, specialization: true } },
      createdByReceptionist: { select: { id: true, name: true } },
      consultationInvoice: { select: { id: true, invoiceNumber: true, amount: true, status: true } }
    },
    orderBy: [{ date: 'desc' }, { startTime: 'asc' }],
    take: Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 500)
  });
  res.json(rows.map(a => ({
    ...a,
    invoiceUrl: a.invoiceUrl ? buildSignedFileUrl({ kind: 'invoice', appointmentId: a.id, userId: me.id, role: 'RECEPTIONIST' }) : null,
    prescriptionUrl: a.prescriptionUrl ? buildSignedFileUrl({ kind: 'prescription', appointmentId: a.id, userId: me.id, role: 'RECEPTIONIST' }) : null,
    consultationInvoice: a.consultationInvoice ? {
      ...a.consultationInvoice,
      pdfUrl: signConsultInvoiceUrl(a.consultationInvoice.id, me)
    } : null
  })));
});

exports.createAppointment = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const parsed = receptionistBookSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const d = parsed.data;

  const assigned = await staffAccess.isAssignedDoctor(me.id, d.doctorId);
  if (!assigned) return res.status(403).json({ error: 'Doctor not assigned to you' });

  const doctor = await prisma.doctor.findFirst({ where: { id: d.doctorId, deletedAt: null } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  if (doctor.consultationModes !== 'BOTH' && doctor.consultationModes !== d.consultationType) {
    return res.status(400).json({ error: 'Consultation mode not supported by this doctor' });
  }

  let medicalCentreId = d.medicalCentreId || null;
  if (medicalCentreId) {
    const asn = await prisma.receptionistAssignment.findFirst({
      where: { receptionistId: me.id, doctorId: d.doctorId, medicalCentreId }
    });
    if (!asn) return res.status(400).json({ error: 'That doctor is not assigned to you at this clinic' });
  } else {
    medicalCentreId = await staffAccess.centreForDoctor(me.id, d.doctorId);
  }

  let patient;
  if (d.patientId) {
    patient = await prisma.patient.findUnique({ where: { id: d.patientId } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
  } else {
    patient = await findOrCreatePatient({
      patientName: d.patientName, phone: d.phone, email: d.email,
      parentName: d.parentName, dateOfBirth: d.dateOfBirth, gender: d.gender
    });
  }

  const liveSlots = await slotService.getLiveSlots(d.doctorId, d.date, d.consultationType);
  const slot = liveSlots.find(s => s.startTime === d.startTime);
  if (!slot || !slot.available) {
    return res.status(409).json({ error: 'Selected slot is no longer available', code: 'SLOT_TAKEN' });
  }

  const endTime = slotService.minutesToTime(
    slotService.timeToMinutes(d.startTime) + (doctor.slotDuration || 15)
  );
  const feeAtBooking = d.consultationType === 'ONLINE' ? doctor.onlineConsultFee : doctor.physicalConsultFee;

  let appointment;
  try {
    appointment = await prisma.appointment.create({
      data: {
        doctorId: d.doctorId,
        patientId: patient.id,
        primaryProblem: d.primaryProblem,
        date: parseDateOnly(d.date),
        startTime: d.startTime,
        endTime,
        consultationType: d.consultationType,
        feeAtBooking,
        status: 'CONFIRMED',
        paymentStatus: 'CASH_PENDING',
        // Explicit source from the booking form. "Walk-in / Reception" is the
        // single in-person channel (WALK_IN); Phone and Other stay distinct.
        // Legacy CLINIC_RECEPTION rows are still accepted and shown under the
        // merged label. isWalkIn is only a fallback for a stale cached
        // frontend mid-deploy.
        source: d.source || 'WALK_IN',
        medicalCentreId,
        createdByReceptionistId: me.id,
        addedById: me.id,
        addedByRole: 'RECEPTIONIST'
      },
      include: { doctor: true, patient: true }
    });
  } catch (e) {
    if (e && e.code === 'P2002') {
      return res.status(409).json({ error: 'Slot already booked. Please pick another time.', code: 'SLOT_TAKEN' });
    }
    throw e;
  }

  const bookedSource = d.source || 'WALK_IN';
  const sourceLabel = { WALK_IN: 'walk-in / reception', PHONE: 'phone', OTHER: 'other', CLINIC_RECEPTION: 'walk-in / reception' }[bookedSource] || 'walk-in / reception';
  await audit.log({
    actor: actorOf(req, me), action: 'APPOINTMENT_CREATED', entityType: 'APPOINTMENT', entityId: appointment.id,
    summary: `Booked ${patient.name} with Dr. ${doctor.name} on ${d.date} ${d.startTime} (${sourceLabel})`,
    medicalCentreId, doctorId: d.doctorId
  });

  const automation = require('../services/automation.service');
  automation.onPhysicalBookingConfirmed(appointment).catch(e => logger.error('receptionist booking notify failed', e.message));

  res.status(201).json({ appointment, requiresPayment: false });
});

exports.appointmentDetail = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const ok = await staffAccess.canAccessAppointment(me.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Appointment not found' });
  const appt = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: {
      patient: true, doctor: true, prescription: true,
      createdByReceptionist: { select: { id: true, name: true } },
      consultationInvoice: true
    }
  });
  res.json({
    appointment: {
      ...appt,
      invoiceUrl: appt.invoiceUrl ? buildSignedFileUrl({ kind: 'invoice', appointmentId: appt.id, userId: me.id, role: 'RECEPTIONIST' }) : null,
      prescriptionUrl: appt.prescriptionUrl ? buildSignedFileUrl({ kind: 'prescription', appointmentId: appt.id, userId: me.id, role: 'RECEPTIONIST' }) : null,
      consultationInvoice: appt.consultationInvoice ? {
        ...appt.consultationInvoice,
        pdfUrl: signConsultInvoiceUrl(appt.consultationInvoice.id, me)
      } : null
    }
  });
});

exports.reschedule = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const parsed = staffRescheduleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const { date, startTime, reason } = parsed.data;
  if (date < getTodayDateString()) return res.status(400).json({ error: 'Cannot reschedule to a past date' });

  const ok = await staffAccess.canAccessAppointment(me.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Appointment not found' });
  const existing = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: { doctor: true, patient: true }
  });
  if (['COMPLETED', 'CANCELLED'].includes(existing.status)) {
    return res.status(400).json({ error: 'Cannot reschedule a completed or cancelled appointment' });
  }
  const liveSlots = await slotService.getLiveSlots(existing.doctorId, date, existing.consultationType, existing.id);
  const slot = liveSlots.find(s => s.startTime === startTime);
  if (!slot || !slot.available) return res.status(409).json({ error: 'Selected slot is not available for reschedule' });

  const endTime = slotService.minutesToTime(slotService.timeToMinutes(startTime) + (existing.doctor.slotDuration || 15));
  // The availability check above and this write aren't atomic — a second
  // booking/reschedule for the same doctor+date+startTime can slip in
  // between them. The @@unique([doctorId, date, startTime]) constraint is
  // the real guard; catch its violation here the same way createAppointment
  // does, so the loser gets a friendly 409 instead of an unhandled 500.
  let updated;
  try {
    updated = await prisma.appointment.update({
      where: { id: existing.id },
      data: {
        date: parseDateOnly(date), startTime, endTime,
        rescheduleReason: reason, rescheduledAt: new Date(),
        status: (existing.paymentStatus === 'PAID' || existing.consultationType === 'OFFLINE') ? 'CONFIRMED' : 'PENDING'
      },
      include: { doctor: true, patient: true }
    });
  } catch (e) {
    if (e && e.code === 'P2002') {
      return res.status(409).json({ error: 'Slot already booked. Please pick another time.', code: 'SLOT_TAKEN' });
    }
    throw e;
  }
  await audit.log({
    actor: actorOf(req, me), action: 'APPOINTMENT_RESCHEDULED', entityType: 'APPOINTMENT', entityId: existing.id,
    summary: `Rescheduled ${existing.patient.name} to ${date} ${startTime} (${reason})`,
    medicalCentreId: existing.medicalCentreId, doctorId: existing.doctorId
  });
  const automation = require('../services/automation.service');
  automation.onAppointmentRescheduled(updated).catch(e => logger.error('receptionist reschedule notify failed', e.message));
  res.json(updated);
});

exports.cancel = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const reason = String((req.body && req.body.reason) || '').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'A cancellation reason (min 3 chars) is required' });
  const ok = await staffAccess.canAccessAppointment(me.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Appointment not found' });
  const appt = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: { doctor: true, patient: true }
  });
  if (appt.status === 'COMPLETED') return res.status(400).json({ error: 'Cannot cancel a completed appointment' });
  if (appt.status === 'CANCELLED') return res.status(409).json({ error: 'Appointment is already cancelled', code: 'ALREADY_CANCELLED' });

  const updated = await prisma.appointment.update({
    where: { id: appt.id },
    data: { status: 'CANCELLED', notes: reason, cancelledAt: new Date() },
    include: { doctor: true, patient: true }
  });
  // An invoice already generated for this appointment (cash/card collected
  // at the desk) is no longer valid once the visit itself is cancelled —
  // void it so it stops counting toward "collected today" and the trend.
  // The original PAID/PENDING record is preserved (not deleted) for the
  // audit trail; VOID just excludes it from every revenue calculation.
  await prisma.consultationInvoice.updateMany({
    where: { appointmentId: appt.id, status: { in: ['PAID', 'PENDING'] } },
    data: { status: 'VOID' }
  });
  await audit.log({
    actor: actorOf(req, me), action: 'APPOINTMENT_CANCELLED', entityType: 'APPOINTMENT', entityId: appt.id,
    summary: `Cancelled ${appt.patient.name} with Dr. ${appt.doctor.name} (${reason})`,
    medicalCentreId: appt.medicalCentreId, doctorId: appt.doctorId
  });
  const cancelMsg = `${appt.patient.name}'s appointment on ${String(appt.date).slice(0, 10)} at ${appt.startTime} was cancelled by ${me.name} at reception (${reason}).`;
  await notifications.create({
    userType: 'DOCTOR', userId: appt.doctorId,
    type: 'APPOINTMENT_CANCELLED', title: 'Appointment cancelled',
    message: cancelMsg,
    iconUrl: me.photoUrl || null,
    entityType: 'APPOINTMENT', entityId: appt.id
  }).catch(() => {});
  await notifications.create({
    userType: 'ADMIN', userId: null,
    type: 'APPOINTMENT_CANCELLED', title: 'Appointment cancelled by reception',
    message: cancelMsg,
    iconUrl: me.photoUrl || null,
    entityType: 'APPOINTMENT', entityId: appt.id
  }).catch(() => {});
  const automation = require('../services/automation.service');
  automation.onAppointmentCancelled(updated, reason).catch(e => logger.error('receptionist cancel notify failed', e.message));
  res.json(updated);
});

exports.markArrived = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const ok = await staffAccess.canAccessAppointment(me.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Appointment not found' });
  const existing = await prisma.appointment.findUnique({ where: { id: req.params.id } });
  if (['CANCELLED'].includes(existing.status)) return res.status(400).json({ error: 'Cannot mark a cancelled appointment as arrived' });
  const updated = await prisma.appointment.update({
    where: { id: req.params.id },
    data: { arrivedAt: new Date() }
  });
  await audit.log({
    actor: actorOf(req, me), action: 'PATIENT_ARRIVED', entityType: 'APPOINTMENT', entityId: existing.id,
    summary: 'Marked patient arrival',
    medicalCentreId: existing.medicalCentreId, doctorId: existing.doctorId
  });
  res.json(updated);
});

// Explicit, staff-initiated cash collection — the only way a CASH_PENDING
// appointment becomes CASH_COLLECTED. Neither completing a consultation nor
// the auto-complete cron flips this on its own; someone actually collecting
// the money has to say so. Also issues the ConsultationInvoice in the same
// action (see consultation-invoice.service.js) so a payment marked collected
// here is never disconnected from the revenue figures reception sees.
exports.markPaid = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const ok = await staffAccess.canAccessAppointment(me.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Appointment not found' });
  const appt = await prisma.appointment.findUnique({ where: { id: req.params.id }, include: { doctor: true, patient: true, consultationInvoice: true } });
  if (appt.paymentStatus !== 'CASH_PENDING') {
    return res.status(400).json({ error: 'Only a cash-pending appointment can be marked as paid' });
  }
  // Race-safe: only the caller that actually flips CASH_PENDING →
  // CASH_COLLECTED goes on to create the invoice — if a doctor and this
  // receptionist (or two reception tabs) both tap "mark paid" on the same
  // appointment at once, exactly one invoice gets created, not two.
  const flipped = await prisma.appointment.updateMany({
    where: { id: appt.id, paymentStatus: 'CASH_PENDING' },
    data: { paymentStatus: 'CASH_COLLECTED' }
  });
  if (flipped.count === 0) {
    const already = await prisma.appointment.findUnique({ where: { id: appt.id } });
    return res.json({ ...already, invoice: null });
  }
  await audit.log({
    actor: actorOf(req, me), action: 'APPOINTMENT_MARKED_PAID', entityType: 'APPOINTMENT', entityId: appt.id,
    summary: `Marked cash collected for ${appt.patient.name} with Dr. ${appt.doctor.name}`,
    medicalCentreId: appt.medicalCentreId, doctorId: appt.doctorId
  });
  const invoiceResult = await consultInvoiceSvc.issueInvoiceForAppointment(appt, actorOf(req, me));
  const updated = await prisma.appointment.findUnique({ where: { id: appt.id } });
  res.json({ ...updated, invoice: invoiceResult.skipped ? null : invoiceResult.invoice });
});

// ─── Consultation invoices ───
exports.generateInvoice = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const { receptionistInvoiceSchema } = require('../utils/validators');
  const parsed = receptionistInvoiceSchema.safeParse({ ...req.body, appointmentId: req.params.id });
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const d = parsed.data;

  const ok = await staffAccess.canAccessAppointment(me.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Appointment not found' });
  const appt = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: { patient: true, doctor: true, consultationInvoice: true }
  });
  if (appt.status === 'CANCELLED') {
    return res.status(400).json({ error: 'Cannot generate an invoice for a cancelled appointment' });
  }
  if (appt.consultationInvoice) {
    return res.json({
      invoice: { ...appt.consultationInvoice, pdfUrl: signConsultInvoiceUrl(appt.consultationInvoice.id, me) },
      existing: true
    });
  }
  // This appointment was booked and paid online (Cashfree) and already has
  // a real invoice PDF from the automated confirmation flow — generating a
  // second one here would double-count the same payment in clinic revenue.
  if (appt.invoiceUrl) {
    return res.status(400).json({
      error: 'This visit was already paid and invoiced online when it was booked — no reception invoice is needed.',
      invoiceUrl: appt.invoiceUrl
    });
  }

  const feeAtBooking = Number(appt.feeAtBooking);
  let amount = (d.amount !== undefined && d.amount !== null) ? d.amount : feeAtBooking;
  if (d.amount !== undefined && d.amount !== null && Math.abs(d.amount - feeAtBooking) > 0.01) {
    if (d.amount > feeAtBooking) {
      return res.status(400).json({ error: `Amount cannot exceed the doctor's consultation fee (₹${feeAtBooking.toFixed(2)})` });
    }
    if (!d.notes || !d.notes.trim()) {
      return res.status(400).json({ error: 'A note is required when the invoice amount differs from the consultation fee' });
    }
  }

  const result = await consultInvoiceSvc.issueInvoiceForAppointment(appt, actorOf(req, me), {
    amount, paymentMethod: d.paymentMethod, notes: d.notes
  });
  // DEFENSIVE: result.invoice should always be set here (issueInvoiceForAppointment
  // either returns a real invoice or throws), but this used to be reached with
  // invoice: null on a rare race outcome and crash reading .id off it, which is
  // what reception saw as "Internal Server Error". Never let a missing invoice
  // crash the request again — surface it as a normal retryable error instead.
  if (!result.invoice) {
    return res.status(409).json({ error: 'Could not confirm the invoice — please try again.' });
  }
  if (result.skipped) {
    // Someone else (another reception tab, or the doctor tapping "mark
    // paid" at the same moment) won the race and already created it.
    return res.json({
      invoice: { ...result.invoice, pdfUrl: signConsultInvoiceUrl(result.invoice.id, me) },
      existing: true
    });
  }
  res.status(201).json({ invoice: result.invoice, pdfUrl: result.pdfUrl });
});

exports.listInvoices = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const doctorIds = await staffAccess.getDoctorIds(me.id);
  const { from, to, q, doctorId } = req.query;
  const where = { doctorId: { in: doctorIds } };
  if (doctorId && doctorIds.includes(doctorId)) where.doctorId = doctorId;
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
      appointment: { include: { patient: { select: { id: true, name: true, phone: true } }, doctor: { select: { id: true, name: true } } } },
      medicalCentre: true
    },
    orderBy: { createdAt: 'desc' },
    take: 300
  });
  res.json(rows.map(r => ({ ...r, pdfUrl: signConsultInvoiceUrl(r.id, me) })));
});

exports.invoiceDetail = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const inv = await prisma.consultationInvoice.findUnique({
    where: { id: req.params.id },
    include: {
      appointment: { include: { patient: true, doctor: true } },
      medicalCentre: true,
      receptionist: { select: { id: true, name: true } }
    }
  });
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const assigned = await staffAccess.isAssignedDoctor(me.id, inv.doctorId);
  if (!assigned) return res.status(404).json({ error: 'Invoice not found' });
  res.json({ ...inv, pdfUrl: signConsultInvoiceUrl(inv.id, me) });
});

exports.sendInvoice = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const inv = await prisma.consultationInvoice.findUnique({ where: { id: req.params.id } });
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const assigned = await staffAccess.isAssignedDoctor(me.id, inv.doctorId);
  if (!assigned) return res.status(404).json({ error: 'Invoice not found' });
  const channels = Array.isArray(req.body && req.body.channels) ? req.body.channels : ['whatsapp', 'email'];
  const delivery = await staffDocs.deliverConsultationInvoice(inv.id, { channels, user: me });
  await audit.log({
    actor: actorOf(req, me), action: 'INVOICE_SENT', entityType: 'CONSULTATION_INVOICE', entityId: inv.id,
    summary: `Sent invoice ${inv.invoiceNumber} via ${channels.join('+')}`,
    medicalCentreId: inv.medicalCentreId, doctorId: inv.doctorId
  });
  res.json({ success: true, delivery });
});

// ─── Prescriptions (front desk enters on doctor's behalf) ───
exports.createPrescription = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const parsed = prescriptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const ok = await staffAccess.canAccessAppointment(me.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Appointment not found' });
  const appt = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: { patient: true, doctor: true, prescription: true }
  });
  if (appt.status === 'CANCELLED') return res.status(400).json({ error: 'Cannot prescribe on a cancelled appointment' });

  const data = {
    ...parsed.data,
    medications: parsed.data.medications,
    followUpDate: parseDateOnlyOrNull(parsed.data.followUpDate)
  };
  const rx = await prisma.prescription.upsert({
    where: { appointmentId: appt.id },
    update: data,
    create: { appointmentId: appt.id, ...data, createdById: me.id, createdByRole: 'RECEPTIONIST' }
  });
  const automation = require('../services/automation.service');
  automation.onPrescriptionCreated(appt, rx).catch(e => logger.error('receptionist prescription notify failed', e.message));
  const pharmacyUserIds = await staffAccess.getPharmacyUserIdsForDoctor(appt.doctorId).catch(() => []);
  for (const pharmacyUserId of pharmacyUserIds) {
    await notifications.create({
      userType: 'PHARMACY', userId: pharmacyUserId,
      type: 'PRESCRIPTION_CREATED', title: 'New prescription to dispense',
      message: `${me.name} added a prescription for ${appt.patient.name} (Dr. ${appt.doctor.name}) — ready to dispense.`,
      iconUrl: appt.doctor.photoUrl || null,
      entityType: 'PRESCRIPTION', entityId: rx.id
    }).catch(() => {});
  }
  await audit.log({
    actor: actorOf(req, me), action: 'PRESCRIPTION_CREATED', entityType: 'PRESCRIPTION', entityId: rx.id,
    summary: `Added prescription for ${appt.patient.name} (on behalf of Dr. ${appt.doctor.name})`,
    medicalCentreId: appt.medicalCentreId, doctorId: appt.doctorId
  });
  res.json({
    success: true,
    prescription: rx,
    pdfUrl: buildSignedFileUrl({ kind: 'prescription', appointmentId: appt.id, userId: me.id, role: 'RECEPTIONIST' })
  });
});

exports.appointmentPrescription = asyncHandler(async (req, res) => {
  const me = await requireConsultations(req, res);
  if (!me) return;
  const ok = await staffAccess.canAccessAppointment(me.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Appointment not found' });
  const appt = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: { prescription: true, patient: true, doctor: true }
  });
  if (!appt || !appt.prescription) return res.status(404).json({ error: 'No prescription on this appointment yet' });
  res.json({
    prescription: appt.prescription,
    pdfUrl: buildSignedFileUrl({ kind: 'prescription', appointmentId: appt.id, userId: me.id, role: 'RECEPTIONIST' }),
    patient: { id: appt.patient.id, name: appt.patient.name, phone: appt.patient.phone, email: appt.patient.email }
  });
});

// ─── Medical certificates (issued in the doctor's name) ───
exports.listCertificates = asyncHandler(async (req, res) => {
  const me = await requireCertificates(req, res);
  if (!me) return;
  const doctorIds = await staffAccess.getDoctorIds(me.id);
  const rows = await prisma.medicalCertificate.findMany({
    where: { doctorId: { in: doctorIds } },
    include: {
      patient: { select: { id: true, name: true, phone: true, email: true } },
      doctor: { select: { id: true, name: true, specialization: true } },
      appointment: { select: { id: true, date: true, startTime: true, consultationType: true } }
    },
    orderBy: { issuedAt: 'desc' },
    take: 200
  });
  res.json(rows.map(c => ({
    ...c,
    pdfUrl: buildSignedFileUrl({ kind: 'certificate', appointmentId: c.id, userId: me.id, role: 'RECEPTIONIST' })
  })));
});

exports.certificateDetail = asyncHandler(async (req, res) => {
  const me = await requireCertificates(req, res);
  if (!me) return;
  const doctorIds = await staffAccess.getDoctorIds(me.id);
  const cert = await prisma.medicalCertificate.findFirst({
    where: { id: req.params.id, doctorId: { in: doctorIds } },
    include: { patient: true, doctor: true, appointment: true }
  });
  if (!cert) return res.status(404).json({ error: 'Certificate not found' });
  res.json({ ...cert, pdfUrl: buildSignedFileUrl({ kind: 'certificate', appointmentId: cert.id, userId: me.id, role: 'RECEPTIONIST' }) });
});

async function issueCertificateInternal(req, res, me, body) {
  const parsed = medicalCertificateSchema.safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const d = parsed.data;

  let appointment = null;
  let patient = null;
  let doctor = null;

  if (d.appointmentId) {
    const ok = await staffAccess.canAccessAppointment(me.id, d.appointmentId);
    if (!ok) return res.status(404).json({ error: 'Appointment not found' });
    appointment = await prisma.appointment.findUnique({
      where: { id: d.appointmentId },
      include: { patient: true, doctor: true }
    });
    patient = appointment.patient;
    doctor = appointment.doctor;
  } else {
    if (!d.doctorId) return res.status(400).json({ error: 'doctorId is required for a standalone certificate' });
    const assigned = await staffAccess.isAssignedDoctor(me.id, d.doctorId);
    if (!assigned) return res.status(403).json({ error: 'Doctor not assigned to you' });
    doctor = await prisma.doctor.findFirst({ where: { id: d.doctorId, deletedAt: null } });
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
    patient = await prisma.patient.findUnique({ where: { id: d.patientId } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    const linked = await staffAccess.patientHasDoctorLink(patient.id, doctor.id);
    if (!linked) return res.status(403).json({ error: 'This patient has no visit history with the selected doctor' });
  }

  const certSvc = require('./certificate.controller')._internal;
  const certDates = require('../services/certificate-date.service');
  const dates = certDates.normalizeCertificateDates(d || {});
  const durationType = d.durationType === 'SINGLE_DAY' ? 'SINGLE_DAY' : 'DATE_RANGE';
  const ageStr = calcAge(patient.dateOfBirth) || null;

  const cert = await prisma.medicalCertificate.create({
    data: {
      certificateNumber: certSvc.nextCertNumber(),
      appointmentId: appointment ? appointment.id : null,
      patientId: patient.id,
      doctorId: doctor.id,
      templateKey: d.templateKey || 'GENERAL',
      diagnosis: d.diagnosis || null,
      reason: d.reason,
      restDays: d.restDays ?? null,
      durationType,
      certificateDate: durationType === 'SINGLE_DAY' ? (d.certificateDate ? parseDateOnly(d.certificateDate) : null) : null,
      fromDate: durationType === 'DATE_RANGE' ? dates.fromDate : null,
      toDate: durationType === 'DATE_RANGE' ? dates.toDate : null,
      additionalNotes: d.additionalNotes || null,
      consultationType: appointment ? (appointment.consultationType || null) : (d.consultationType || 'OFFLINE'),
      patientNameSnapshot: patient.name,
      patientAgeSnapshot: ageStr,
      patientGenderSnapshot: patient.gender || null,
      issuedById: me.id,
      issuedByRole: 'RECEPTIONIST'
    },
    include: { appointment: true }
  });

  const delivery = await certSvc.deliverCertificate({ ...cert, patient, doctor }, {
    sendWhatsapp: req.body.sendWhatsapp !== false,
    sendEmail: req.body.sendEmail !== false
  });

  await audit.log({
    actor: actorOf(req, me), action: 'CERTIFICATE_ISSUED', entityType: 'CERTIFICATE', entityId: cert.id,
    summary: `Issued ${cert.templateKey} certificate for ${patient.name} in Dr. ${doctor.name}'s name`,
    medicalCentreId: appointment ? appointment.medicalCentreId : null, doctorId: doctor.id
  });

  const fresh = await prisma.medicalCertificate.findUnique({ where: { id: cert.id } });
  return res.status(201).json({
    ...fresh,
    pdfUrl: buildSignedFileUrl({ kind: 'certificate', appointmentId: cert.id, userId: me.id, role: 'RECEPTIONIST' }),
    delivery
  });
}

exports.issueCertificate = asyncHandler(async (req, res) => {
  const me = await requireCertificates(req, res);
  if (!me) return;
  return issueCertificateInternal(req, res, me, req.body);
});

exports.issueCertificateForAppointment = asyncHandler(async (req, res) => {
  const me = await requireCertificates(req, res);
  if (!me) return;
  return issueCertificateInternal(req, res, me, { ...(req.body || {}), appointmentId: req.params.id });
});

exports.sendCertificate = asyncHandler(async (req, res) => {
  const me = await requireCertificates(req, res);
  if (!me) return;
  const doctorIds = await staffAccess.getDoctorIds(me.id);
  const existing = await prisma.medicalCertificate.findFirst({
    where: { id: req.params.id, doctorId: { in: doctorIds } }
  });
  if (!existing) return res.status(404).json({ error: 'Certificate not found' });
  const channels = Array.isArray(req.body && req.body.channels) ? req.body.channels : ['whatsapp', 'email'];
  const delivery = await require('./certificate.controller')._internal.deliverCertificate(existing, {
    sendWhatsapp: channels.includes('whatsapp'),
    sendEmail: channels.includes('email')
  });
  res.json({ success: true, delivery });
});

exports._passwordHash = (pw) => bcrypt.hash(pw, SALT);