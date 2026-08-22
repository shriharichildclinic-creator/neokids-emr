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
const { parseDateOnly, parseDateOnlyOrNull, getTodayDateOnly, getTodayDateString, calcAge } = require('../utils/date');
const { findOrCreatePatient } = require('../services/booking.service');
const slotService = require('../services/slot.service');
const staffAccess = require('../services/staffAccess.service');
const staffDocs = require('../services/staff-docs.service');
const audit = require('../services/audit.service');
const { buildSignedFileUrl } = require('../utils/fileTokens');
const logger = require('../utils/logger');
const { photoUrlFor, deleteOldPhoto } = require('../services/profile-photo.service');

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
  await deleteOldPhoto(me.photoUrl);
  const photoUrl = photoUrlFor(req.file.filename);
  const updated = await prisma.receptionist.update({ where: { id: me.id }, data: { photoUrl } });
  res.json({ success: true, photoUrl: updated.photoUrl });
});

exports.removeProfileImage = asyncHandler(async (req, res) => {
  const me = await staffAccess.getReceptionist(req.user.id);
  if (!me) return res.status(404).json({ error: 'Not found' });
  await deleteOldPhoto(me.photoUrl);
  await prisma.receptionist.update({ where: { id: me.id }, data: { photoUrl: null } });
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
  const last7  = new Date(today); last7.setUTCDate(last7.getUTCDate() - 6);
  const last14 = new Date(today); last14.setUTCDate(last14.getUTCDate() - 13);

  const [
    todayCount, arrived, pending, invToday, patients,
    walkinToday, todayInvoices,
    yesterdayCount, fortnightAppts, fortnightInvoices
  ] = await Promise.all([
    prisma.appointment.count({ where: { doctorId: { in: doctorIds }, date: today, status: { not: 'CANCELLED' } } }),
    prisma.appointment.count({ where: { doctorId: { in: doctorIds }, date: today, arrivedAt: { not: null } } }),
    prisma.appointment.count({ where: { doctorId: { in: doctorIds }, date: today, status: { in: ['PENDING', 'CONFIRMED'] }, arrivedAt: null } }),
    prisma.consultationInvoice.count({ where: { receptionistId: req.user.id, createdAt: { gte: dayStart } } }),
    staffAccess.getPatientScope(req.user.id).then(ids => ids.length),
    // Walk-in / reception in-person bookings today (WALK_IN + legacy CLINIC_RECEPTION).
    prisma.appointment.count({ where: { doctorId: { in: doctorIds }, date: today, source: { in: ['WALK_IN', 'CLINIC_RECEPTION'] } } }),
    // This receptionist's invoices today, to split collected cash vs online.
    prisma.consultationInvoice.findMany({
      where: { receptionistId: req.user.id, createdAt: { gte: dayStart } },
      select: { amount: true, status: true, paymentMethod: true }
    }),
    prisma.appointment.count({ where: { doctorId: { in: doctorIds }, date: yesterday, status: { not: 'CANCELLED' } } }),
    prisma.appointment.findMany({
      where: { doctorId: { in: doctorIds }, date: { gte: last14 }, status: { not: 'CANCELLED' } },
      select: { date: true }
    }),
    prisma.consultationInvoice.findMany({
      where: { receptionistId: req.user.id, createdAt: { gte: last14 }, status: 'PAID' },
      select: { createdAt: true, amount: true }
    })
  ]);

  let cashCollectedToday = 0, onlineCollectedToday = 0, pendingCollectionToday = 0;
  for (const inv of todayInvoices) {
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
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const daily = {};
  for (let i = 0; i < 14; i++) {
    const d = new Date(last14); d.setUTCDate(d.getUTCDate() + i);
    daily[dayKey(d)] = { date: dayKey(d), appointments: 0, collected: 0 };
  }
  for (const a of fortnightAppts) {
    const bucket = daily[dayKey(a.date)];
    if (bucket) bucket.appointments += 1;
  }
  for (const inv of fortnightInvoices) {
    const bucket = daily[dayKey(inv.createdAt)];
    if (bucket) bucket.collected += Number(inv.amount || 0);
  }
  const last7Key = dayKey(last7);
  let thisWeekAppts = 0, prevWeekAppts = 0, thisWeekCollected = 0, prevWeekCollected = 0;
  for (const bucket of Object.values(daily)) {
    if (bucket.date >= last7Key) { thisWeekAppts += bucket.appointments; thisWeekCollected += bucket.collected; }
    else                         { prevWeekAppts += bucket.appointments; prevWeekCollected += bucket.collected; }
  }

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
  const { status, date, from, to, doctorId, q } = req.query;
  const where = { doctorId: { in: doctorIds } };
  if (doctorId && doctorIds.includes(doctorId)) where.doctorId = doctorId;
  if (status) where.status = status;
  if (date) where.date = parseDateOnly(date);
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = parseDateOnly(from);
    if (to)   where.date.lte = parseDateOnly(to);
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
  const liveSlots = await slotService.getLiveSlots(existing.doctorId, date, existing.consultationType);
  const slot = liveSlots.find(s => s.startTime === startTime);
  if (!slot || !slot.available) return res.status(409).json({ error: 'Selected slot is not available for reschedule' });

  const endTime = slotService.minutesToTime(slotService.timeToMinutes(startTime) + (existing.doctor.slotDuration || 15));
  const updated = await prisma.appointment.update({
    where: { id: existing.id },
    data: {
      date: parseDateOnly(date), startTime, endTime,
      rescheduleReason: reason, rescheduledAt: new Date(),
      status: (existing.paymentStatus === 'PAID' || existing.consultationType === 'OFFLINE') ? 'CONFIRMED' : 'PENDING'
    },
    include: { doctor: true, patient: true }
  });
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
  await audit.log({
    actor: actorOf(req, me), action: 'APPOINTMENT_CANCELLED', entityType: 'APPOINTMENT', entityId: appt.id,
    summary: `Cancelled ${appt.patient.name} with Dr. ${appt.doctor.name} (${reason})`,
    medicalCentreId: appt.medicalCentreId, doctorId: appt.doctorId
  });
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
  if (appt.consultationInvoice) {
    return res.json({
      invoice: { ...appt.consultationInvoice, pdfUrl: signConsultInvoiceUrl(appt.consultationInvoice.id, me) },
      existing: true
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
  const invoiceNumber = await staffDocs.nextInvoiceNumber();
  let invoice;
  try {
    invoice = await prisma.consultationInvoice.create({
      data: {
        invoiceNumber,
        appointmentId: appt.id,
        doctorId: appt.doctorId,
        patientId: appt.patientId,
        receptionistId: me.id,
        medicalCentreId: appt.medicalCentreId,
        amount,
        status: 'PAID',
        paymentMethod: d.paymentMethod || 'CASH',
        notes: d.notes || null
      }
    });
  } catch (e) {
    if (e && e.code === 'P2002') {
      const existing = await prisma.consultationInvoice.findUnique({ where: { appointmentId: appt.id } });
      return res.json({ invoice: { ...existing, pdfUrl: signConsultInvoiceUrl(existing.id, me) }, existing: true });
    }
    throw e;
  }

  await prisma.appointment.update({
    where: { id: appt.id },
    data: { paymentStatus: appt.paymentStatus === 'CASH_PENDING' ? 'CASH_COLLECTED' : appt.paymentStatus }
  }).catch(() => null);

  const stored = await staffDocs.generateAndStoreInvoicePdf(invoice.id, me);
  await audit.log({
    actor: actorOf(req, me), action: 'INVOICE_GENERATED', entityType: 'CONSULTATION_INVOICE', entityId: invoice.id,
    summary: `Generated invoice ${invoiceNumber} (₹${Number(amount).toFixed(2)}) for ${appt.patient.name}`,
    medicalCentreId: appt.medicalCentreId, doctorId: appt.doctorId
  });
  res.status(201).json({ invoice: stored.invoice, pdfUrl: stored.signedUrl });
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