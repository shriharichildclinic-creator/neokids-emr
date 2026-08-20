const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  createReceptionistSchema, updateReceptionistSchema,
  medicalCentreSchema, updateMedicalCentreSchema,
  createPharmacyUserSchema, updatePharmacyUserSchema
} = require('../utils/validators');
const { createPasswordToken, revokeActivePasswordTokens } = require('../services/token.service');
const { _helpers: authHelpers } = require('./auth.controller');
const audit = require('../services/audit.service');
const { buildSignedFileUrl } = require('../utils/fileTokens');

const SALT = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);
const TOKEN_TTL_MINUTES = parseInt(process.env.PASSWORD_TOKEN_TTL_MINUTES || '60', 10);

function flattenZod(err) {
  const flat = err.flatten();
  const lines = [];
  for (const [k, msgs] of Object.entries(flat.fieldErrors || {})) {
    (msgs || []).forEach(m => lines.push(`${k}: ${m}`));
  }
  (flat.formErrors || []).forEach(m => lines.push(m));
  return lines.length ? lines.join(' | ') : 'Invalid input';
}

function randomPassword() {
  return `Neo${Math.random().toString(36).slice(2, 6)}${Date.now().toString().slice(-4)}`;
}

function adminActor(req) {
  return { id: req.user.id, role: 'ADMIN', name: req.user.email };
}

async function sendStaffInvite({ user, userType, roleLabel }) {
  await revokeActivePasswordTokens(userType, user.id, ['INVITE', 'RESET']);
  const { rawToken } = await createPasswordToken({
    userType, userId: user.id, purpose: 'INVITE', expiresInMinutes: TOKEN_TTL_MINUTES
  });
  let inviteLink;
  let emailDelivered = false;
  try {
    inviteLink = await authHelpers.sendPasswordEmail({
      to: user.email, name: user.name, rawToken, purpose: 'INVITE'
    });
    emailDelivered = !!process.env.SMTP_HOST;
  } catch (e) {
    console.error(`${roleLabel} invite email failed:`, e.message);
    inviteLink = authHelpers.buildPasswordLink(rawToken);
  }
  return { inviteLink, emailDelivered };
}

async function assertOfflineDoctors(doctorIds) {
  const ids = [...new Set(doctorIds)];
  const doctors = await prisma.doctor.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, consultationModes: true, isAvailable: true }
  });
  if (doctors.length !== ids.length) {
    throw Object.assign(new Error('One or more selected doctors were not found'), { statusCode: 400 });
  }
  const notOffline = doctors.filter(d => d.consultationModes === 'ONLINE');
  if (notOffline.length) {
    throw Object.assign(
      new Error(`Only doctors available for offline consultations can be assigned: ${notOffline.map(d => d.name).join(', ')}`),
      { statusCode: 400 }
    );
  }
  return doctors;
}

async function assertCentres(centreIds) {
  const ids = [...new Set(centreIds)];
  const centres = await prisma.medicalCentre.findMany({
    where: { id: { in: ids } },
    select: { id: true }
  });
  if (centres.length !== ids.length) {
    throw Object.assign(new Error('One or more selected medical centres were not found'), { statusCode: 400 });
  }
}

// ═══════════════ MEDICAL CENTRES ═══════════════
exports.createCentre = asyncHandler(async (req, res) => {
  const parsed = medicalCentreSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: flattenZod(parsed.error), details: parsed.error.flatten() });
  const centre = await prisma.medicalCentre.create({ data: parsed.data });
  await audit.log({ actor: adminActor(req), action: 'CENTRE_CREATED', entityType: 'MEDICAL_CENTRE', entityId: centre.id, summary: `Created clinic ${centre.name}` });
  res.status(201).json(centre);
});

exports.listCentres = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.active === '1') where.isActive = true;
  const rows = await prisma.medicalCentre.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { receptionistAssignments: true, appointments: true, pharmacyUsers: true } }
    }
  });
  res.json(rows);
});

exports.updateCentre = asyncHandler(async (req, res) => {
  const parsed = updateMedicalCentreSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: flattenZod(parsed.error), details: parsed.error.flatten() });
  const existing = await prisma.medicalCentre.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Medical centre not found' });
  const updated = await prisma.medicalCentre.update({ where: { id: req.params.id }, data: parsed.data });
  await audit.log({ actor: adminActor(req), action: 'CENTRE_UPDATED', entityType: 'MEDICAL_CENTRE', entityId: updated.id, summary: `Updated clinic ${updated.name}` });
  res.json(updated);
});

exports.deleteCentre = asyncHandler(async (req, res) => {
  const updated = await prisma.medicalCentre.update({
    where: { id: req.params.id },
    data: { isActive: false }
  });
  await audit.log({ actor: adminActor(req), action: 'CENTRE_DEACTIVATED', entityType: 'MEDICAL_CENTRE', entityId: updated.id, summary: `Deactivated clinic ${updated.name}` });
  res.json({ success: true, message: 'Medical centre deactivated' });
});

// ═══════════════ RECEPTIONISTS ═══════════════
exports.createReceptionist = asyncHandler(async (req, res) => {
  const parsed = createReceptionistSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: flattenZod(parsed.error), details: parsed.error.flatten() });
  const d = parsed.data;

  const exists = await prisma.receptionist.findUnique({ where: { email: d.email } });
  if (exists && !exists.deletedAt) return res.status(409).json({ error: 'A receptionist with this email already exists' });

  await assertOfflineDoctors(d.assignments.map(a => a.doctorId));
  await assertCentres(d.assignments.map(a => a.medicalCentreId));

  const initialPassword = d.password || randomPassword();
  const passwordHash = await bcrypt.hash(initialPassword, SALT);

  const receptionist = await prisma.receptionist.create({
    data: {
      name: d.name,
      phone: d.phone,
      email: d.email,
      passwordHash,
      status: d.status || 'ACTIVE',
      canManageConsultations: d.canManageConsultations !== false,
      canManagePharmacy: !!d.canManagePharmacy,
      canIssueCertificates: !!d.canIssueCertificates,
      mustChangePassword: true,
      assignments: {
        create: d.assignments.map(a => ({ doctorId: a.doctorId, medicalCentreId: a.medicalCentreId }))
      }
    },
    include: { assignments: { include: { doctor: { select: { id: true, name: true } }, medicalCentre: true } } }
  });

  const { inviteLink, emailDelivered } = await sendStaffInvite({ user: receptionist, userType: 'RECEPTIONIST', roleLabel: 'Receptionist' });
  await audit.log({
    actor: adminActor(req), action: 'RECEPTIONIST_CREATED', entityType: 'RECEPTIONIST', entityId: receptionist.id,
    summary: `Created receptionist ${receptionist.name} with ${receptionist.assignments.length} assignment(s)`
  });

  const { passwordHash: _, ...safe } = receptionist;
  res.status(201).json({
    ...safe,
    inviteSent: emailDelivered,
    invitePreviewUrl: inviteLink,
    inviteExpiresInMinutes: TOKEN_TTL_MINUTES
  });
});

exports.listReceptionists = asyncHandler(async (req, res) => {
  const rows = await prisma.receptionist.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      assignments: {
        include: {
          doctor: { select: { id: true, name: true, specialization: true, clinicName: true, registrationNumber: true } },
          medicalCentre: { select: { id: true, name: true, city: true } }
        }
      }
    }
  });
  res.json(rows.map(({ passwordHash, ...r }) => r));
});

exports.getReceptionist = asyncHandler(async (req, res) => {
  const r = await prisma.receptionist.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      assignments: {
        include: {
          doctor: { select: { id: true, name: true, specialization: true, clinicName: true, registrationNumber: true } },
          medicalCentre: true
        }
      }
    }
  });
  if (!r) return res.status(404).json({ error: 'Receptionist not found' });
  const { passwordHash, ...safe } = r;
  res.json(safe);
});

exports.updateReceptionist = asyncHandler(async (req, res) => {
  const parsed = updateReceptionistSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: flattenZod(parsed.error), details: parsed.error.flatten() });
  const d = parsed.data;
  const existing = await prisma.receptionist.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!existing) return res.status(404).json({ error: 'Receptionist not found' });

  if (d.assignments) {
    await assertOfflineDoctors(d.assignments.map(a => a.doctorId));
    await assertCentres(d.assignments.map(a => a.medicalCentreId));
  }

  const data = {
    ...(d.name !== undefined && { name: d.name }),
    ...(d.phone !== undefined && { phone: d.phone }),
    ...(d.status !== undefined && { status: d.status }),
    ...(d.canManageConsultations !== undefined && { canManageConsultations: d.canManageConsultations }),
    ...(d.canManagePharmacy !== undefined && { canManagePharmacy: d.canManagePharmacy }),
    ...(d.canIssueCertificates !== undefined && { canIssueCertificates: d.canIssueCertificates })
  };
  if (d.password) {
    data.passwordHash = await bcrypt.hash(d.password, SALT);
    data.mustChangePassword = true;
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (d.assignments) {
      await tx.receptionistAssignment.deleteMany({ where: { receptionistId: existing.id } });
      await tx.receptionistAssignment.createMany({
        data: d.assignments.map(a => ({ receptionistId: existing.id, doctorId: a.doctorId, medicalCentreId: a.medicalCentreId }))
      });
    }
    return tx.receptionist.update({
      where: { id: existing.id },
      data,
      include: { assignments: { include: { doctor: { select: { id: true, name: true } }, medicalCentre: true } } }
    });
  });

  await audit.log({
    actor: adminActor(req), action: 'RECEPTIONIST_UPDATED', entityType: 'RECEPTIONIST', entityId: updated.id,
    summary: `Updated receptionist ${updated.name}${d.password ? ' (password reset)' : ''}${d.status ? ` · status=${d.status}` : ''}`
  });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

exports.deleteReceptionist = asyncHandler(async (req, res) => {
  const updated = await prisma.receptionist.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), status: 'SUSPENDED' }
  });
  await revokeActivePasswordTokens('RECEPTIONIST', req.params.id, ['INVITE', 'RESET']);
  await audit.log({ actor: adminActor(req), action: 'RECEPTIONIST_DEACTIVATED', entityType: 'RECEPTIONIST', entityId: updated.id, summary: `Deactivated receptionist ${updated.name}` });
  res.json({ success: true, message: 'Receptionist deactivated' });
});

// ═══════════════ PHARMACY USERS ═══════════════
exports.createPharmacyUser = asyncHandler(async (req, res) => {
  const parsed = createPharmacyUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: flattenZod(parsed.error), details: parsed.error.flatten() });
  const d = parsed.data;

  const exists = await prisma.pharmacyUser.findUnique({ where: { email: d.email } });
  if (exists && !exists.deletedAt) return res.status(409).json({ error: 'A pharmacy user with this email already exists' });

  await assertOfflineDoctors(d.doctorIds);
  if (d.medicalCentreId) await assertCentres([d.medicalCentreId]);

  const initialPassword = d.password || randomPassword();
  const passwordHash = await bcrypt.hash(initialPassword, SALT);

  const user = await prisma.pharmacyUser.create({
    data: {
      name: d.name,
      phone: d.phone,
      email: d.email,
      passwordHash,
      status: d.status || 'ACTIVE',
      medicalCentreId: d.medicalCentreId || null,
      mustChangePassword: true,
      doctors: { create: d.doctorIds.map(id => ({ doctorId: id })) }
    },
    include: { doctors: { include: { doctor: { select: { id: true, name: true } } } }, medicalCentre: true }
  });

  const { inviteLink, emailDelivered } = await sendStaffInvite({ user, userType: 'PHARMACY', roleLabel: 'Pharmacy user' });
  await audit.log({
    actor: adminActor(req), action: 'PHARMACY_USER_CREATED', entityType: 'PHARMACY_USER', entityId: user.id,
    summary: `Created pharmacy user ${user.name} with ${user.doctors.length} doctor assignment(s)`
  });

  const { passwordHash: _, ...safe } = user;
  res.status(201).json({
    ...safe,
    inviteSent: emailDelivered,
    invitePreviewUrl: inviteLink,
    inviteExpiresInMinutes: TOKEN_TTL_MINUTES
  });
});

exports.listPharmacyUsers = asyncHandler(async (req, res) => {
  const rows = await prisma.pharmacyUser.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      medicalCentre: { select: { id: true, name: true, city: true } },
      doctors: { include: { doctor: { select: { id: true, name: true, specialization: true, clinicName: true } } } }
    }
  });
  res.json(rows.map(({ passwordHash, ...r }) => r));
});

exports.getPharmacyUser = asyncHandler(async (req, res) => {
  const u = await prisma.pharmacyUser.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      medicalCentre: true,
      doctors: { include: { doctor: { select: { id: true, name: true, specialization: true, clinicName: true } } } }
    }
  });
  if (!u) return res.status(404).json({ error: 'Pharmacy user not found' });
  const { passwordHash, ...safe } = u;
  res.json(safe);
});

exports.updatePharmacyUser = asyncHandler(async (req, res) => {
  const parsed = updatePharmacyUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: flattenZod(parsed.error), details: parsed.error.flatten() });
  const d = parsed.data;
  const existing = await prisma.pharmacyUser.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!existing) return res.status(404).json({ error: 'Pharmacy user not found' });

  if (d.doctorIds) await assertOfflineDoctors(d.doctorIds);
  if (d.medicalCentreId) await assertCentres([d.medicalCentreId]);

  const data = {
    ...(d.name !== undefined && { name: d.name }),
    ...(d.phone !== undefined && { phone: d.phone }),
    ...(d.status !== undefined && { status: d.status }),
    ...(d.medicalCentreId !== undefined && { medicalCentreId: d.medicalCentreId })
  };
  if (d.password) {
    data.passwordHash = await bcrypt.hash(d.password, SALT);
    data.mustChangePassword = true;
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (d.doctorIds) {
      await tx.pharmacyUserDoctor.deleteMany({ where: { pharmacyUserId: existing.id } });
      await tx.pharmacyUserDoctor.createMany({
        data: d.doctorIds.map(id => ({ pharmacyUserId: existing.id, doctorId: id }))
      });
    }
    return tx.pharmacyUser.update({
      where: { id: existing.id },
      data,
      include: { doctors: { include: { doctor: { select: { id: true, name: true } } } }, medicalCentre: true }
    });
  });

  await audit.log({
    actor: adminActor(req), action: 'PHARMACY_USER_UPDATED', entityType: 'PHARMACY_USER', entityId: updated.id,
    summary: `Updated pharmacy user ${updated.name}`
  });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

exports.deletePharmacyUser = asyncHandler(async (req, res) => {
  const updated = await prisma.pharmacyUser.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), status: 'SUSPENDED' }
  });
  await revokeActivePasswordTokens('PHARMACY', req.params.id, ['INVITE', 'RESET']);
  await audit.log({ actor: adminActor(req), action: 'PHARMACY_USER_DEACTIVATED', entityType: 'PHARMACY_USER', entityId: updated.id, summary: `Deactivated pharmacy user ${updated.name}` });
  res.json({ success: true, message: 'Pharmacy user deactivated' });
});

// ═══════════════ PHARMACY BILLS (admin read-only oversight) ═══════════════
exports.listPharmacyBillsAdmin = asyncHandler(async (req, res) => {
  const { centreId, from, to, q } = req.query;
  const where = {};
  if (centreId) where.medicalCentreId = centreId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from + 'T00:00:00.000Z');
    if (to)   where.createdAt.lte = new Date(to + 'T23:59:59.999Z');
  }
  if (q && String(q).trim().length >= 2) {
    const term = String(q).trim();
    where.OR = [
      { billNumber: { contains: term } },
      { customerName: { contains: term } }
    ];
  }
  const rows = await prisma.pharmacyBill.findMany({
    where,
    include: { items: true, medicalCentre: true, doctor: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 500)
  });
  res.json(rows.map(r => ({
    ...r,
    pdfUrl: buildSignedFileUrl({ kind: 'pharmacy-invoice', appointmentId: r.id, userId: req.user.id, role: req.user.role })
  })));
});