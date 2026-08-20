const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  pharmacyItemSchema, updatePharmacyItemSchema, pharmacyStockSchema, pharmacyBillSchema
} = require('../utils/validators');
const staffAccess = require('../services/staffAccess.service');
const staffDocs = require('../services/staff-docs.service');
const audit = require('../services/audit.service');
const { buildSignedFileUrl } = require('../utils/fileTokens');
const { parseDateOnlyOrNull, getTodayDateString } = require('../utils/date');

function roleOf(req) {
  return req.user.role === 'PHARMACY' ? 'PHARMACY' : 'RECEPTIONIST';
}

async function resolveActor(req, res) {
  const role = roleOf(req);
  if (role === 'PHARMACY') {
    const u = await staffAccess.getPharmacyUser(req.user.id);
    if (!u) { res.status(401).json({ error: 'Account not found' }); return null; }
    if (u.status !== 'ACTIVE') { res.status(403).json({ error: 'Account is suspended' }); return null; }
    return { user: u, role, centreId: u.medicalCentreId || null, name: u.name };
  }
  const u = await staffAccess.getReceptionist(req.user.id);
  if (!u) { res.status(401).json({ error: 'Account not found' }); return null; }
  if (u.status !== 'ACTIVE') { res.status(403).json({ error: 'Account is suspended' }); return null; }
  if (!u.canManagePharmacy) { res.status(403).json({ error: 'Pharmacy management is not enabled for your account' }); return null; }
  const centreId = await staffAccess.primaryCentreId(u.id);
  return { user: u, role, centreId, name: u.name };
}

async function actorDoctorIds(actor) {
  if (actor.role === 'PHARMACY') return staffAccess.getPharmacyDoctorIds(actor.user.id);
  return staffAccess.getDoctorIds(actor.user.id);
}

function signBillUrl(billId, actor) {
  return buildSignedFileUrl({
    kind: 'pharmacy-invoice',
    appointmentId: billId,
    userId: actor.user.id,
    role: actor.role
  });
}

// ─── Profile / assignments / stats ───
exports.me = asyncHandler(async (req, res) => {
  const u = await staffAccess.getPharmacyUser(req.user.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { passwordHash, ...safe } = u;
  res.json(safe);
});

exports.assignments = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  if (actor.role === 'PHARMACY') {
    const rows = await staffAccess.getPharmacyAssignments(actor.user.id);
    const centre = actor.centreId ? await prisma.medicalCentre.findUnique({ where: { id: actor.centreId } }) : null;
    return res.json({ medicalCentre: centre, doctors: rows.map(r => r.doctor) });
  }
  const rows = await staffAccess.getAssignments(actor.user.id);
  res.json({ medicalCentre: null, doctors: rows.map(r => r.doctor) });
});

exports.stats = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const todayStart = new Date(getTodayDateString() + 'T00:00:00.000Z');
  const itemWhere = { isActive: true };
  if (actor.centreId) itemWhere.medicalCentreId = actor.centreId;
  const billWhere = { createdAt: { gte: todayStart } };
  if (actor.centreId) billWhere.medicalCentreId = actor.centreId;

  const [totalItems, lowStock, todayBills, todayRevenue, expiring] = await Promise.all([
    prisma.pharmacyItem.count({ where: itemWhere }),
    prisma.pharmacyItem.count({ where: { ...itemWhere, stock: { lte: 10 } } }),
    prisma.pharmacyBill.count({ where: billWhere }),
    prisma.pharmacyBill.aggregate({ _sum: { total: true }, where: billWhere }),
    prisma.pharmacyItem.count({
      where: { ...itemWhere, expiryDate: { not: null, lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } }
    })
  ]);
  res.json({
    totalItems, lowStock, todayBills,
    todayRevenue: Number(todayRevenue._sum.total || 0),
    expiringSoon: expiring
  });
});

// ─── Prescriptions (OFFLINE, assigned doctors) ───
exports.myPrescriptions = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const doctorIds = await actorDoctorIds(actor);
  if (!doctorIds.length) return res.json([]);
  const { q, dispensed } = req.query;

  const where = {
    appointment: {
      doctorId: { in: doctorIds },
      consultationType: 'OFFLINE'
    }
  };
  const rows = await prisma.prescription.findMany({
    where,
    include: {
      appointment: {
        include: {
          patient: { select: { id: true, name: true, phone: true, gender: true, dateOfBirth: true } },
          doctor: { select: { id: true, name: true, specialization: true } }
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 200
  });

  const rxIds = rows.map(r => r.id);
  const bills = rxIds.length
    ? await prisma.pharmacyBill.findMany({
        where: { prescriptionId: { in: rxIds } },
        select: { prescriptionId: true, id: true, billNumber: true, total: true }
      })
    : [];
  const billedMap = new Map(bills.map(b => [b.prescriptionId, b]));

  let out = rows.map(rx => ({
    id: rx.id,
    appointmentId: rx.appointmentId,
    createdAt: rx.createdAt,
    chiefComplaint: rx.chiefComplaint,
    diagnosis: rx.diagnosis,
    medications: rx.medications,
    createdByRole: rx.createdByRole || (rx.source === 'MANUAL' ? 'RECEPTIONIST' : 'DOCTOR'),
    createdById: rx.createdById || null,
    dispensed: billedMap.has(rx.id),
    bill: billedMap.get(rx.id) || null,
    patient: rx.appointment.patient,
    doctor: rx.appointment.doctor,
    visitDate: rx.appointment.date
  }));

  if (dispensed === 'yes') out = out.filter(r => r.dispensed);
  if (dispensed === 'no')  out = out.filter(r => !r.dispensed);
  if (q && String(q).trim().length >= 2) {
    const term = String(q).trim().toLowerCase();
    out = out.filter(r =>
      (r.patient.name || '').toLowerCase().includes(term) ||
      (r.doctor.name || '').toLowerCase().includes(term) ||
      (r.diagnosis || '').toLowerCase().includes(term)
    );
  }
  res.json(out);
});

exports.searchPatients = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const digits = q.replace(/\D/g, '');
  const or = [{ name: { contains: q } }];
  if (digits.length >= 4) or.push({ phone: { contains: digits } });
  const rows = await prisma.patient.findMany({
    where: { OR: or },
    orderBy: [{ name: 'asc' }],
    take: 20
  });
  res.json(rows);
});

// ─── Inventory ───
exports.listItems = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const { q, lowStock } = req.query;
  const where = { isActive: true };
  if (actor.centreId) where.medicalCentreId = actor.centreId;
  if (q && String(q).trim()) where.name = { contains: String(q).trim() };
  if (lowStock === '1') where.stock = { lte: 10 };
  const rows = await prisma.pharmacyItem.findMany({
    where,
    orderBy: { name: 'asc' },
    take: 500
  });
  res.json(rows);
});

exports.createItem = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const parsed = pharmacyItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  const item = await prisma.pharmacyItem.create({
    data: {
      name: d.name,
      batchNumber: d.batchNumber || null,
      unit: d.unit || 'strip',
      mrp: d.mrp ?? 0,
      purchasePrice: d.purchasePrice ?? 0,
      sellingPrice: d.sellingPrice ?? 0,
      stock: d.stock ?? 0,
      expiryDate: parseDateOnlyOrNull(d.expiryDate),
      manufacturer: d.manufacturer || null,
      medicalCentreId: d.medicalCentreId || actor.centreId || null
    }
  });
  await audit.log({
    actor: { id: actor.user.id, role: actor.role, name: actor.name },
    action: 'PHARMACY_ITEM_CREATED', entityType: 'PHARMACY_ITEM', entityId: item.id,
    summary: `Added medicine ${item.name} (stock ${item.stock})`,
    medicalCentreId: item.medicalCentreId
  });
  res.status(201).json(item);
});

exports.updateItem = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const parsed = updatePharmacyItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  const existing = await prisma.pharmacyItem.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  if (actor.centreId && existing.medicalCentreId && existing.medicalCentreId !== actor.centreId) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const updated = await prisma.pharmacyItem.update({
    where: { id: existing.id },
    data: {
      ...(d.name !== undefined && { name: d.name }),
      ...(d.batchNumber !== undefined && { batchNumber: d.batchNumber || null }),
      ...(d.unit !== undefined && { unit: d.unit || 'strip' }),
      ...(d.mrp !== undefined && { mrp: d.mrp }),
      ...(d.purchasePrice !== undefined && { purchasePrice: d.purchasePrice }),
      ...(d.sellingPrice !== undefined && { sellingPrice: d.sellingPrice }),
      ...(d.stock !== undefined && { stock: d.stock }),
      ...(d.expiryDate !== undefined && { expiryDate: parseDateOnlyOrNull(d.expiryDate) }),
      ...(d.manufacturer !== undefined && { manufacturer: d.manufacturer || null }),
      ...(d.isActive !== undefined && { isActive: d.isActive })
    }
  });
  await audit.log({
    actor: { id: actor.user.id, role: actor.role, name: actor.name },
    action: 'PHARMACY_ITEM_UPDATED', entityType: 'PHARMACY_ITEM', entityId: updated.id,
    summary: `Updated medicine ${updated.name}`,
    medicalCentreId: updated.medicalCentreId
  });
  res.json(updated);
});

exports.adjustStock = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const parsed = pharmacyStockSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const existing = await prisma.pharmacyItem.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  if (actor.centreId && existing.medicalCentreId && existing.medicalCentreId !== actor.centreId) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const next = existing.stock + parsed.data.delta;
  if (next < 0) return res.status(400).json({ error: 'Stock cannot go below zero' });
  const updated = await prisma.pharmacyItem.update({
    where: { id: existing.id },
    data: { stock: next }
  });
  await audit.log({
    actor: { id: actor.user.id, role: actor.role, name: actor.name },
    action: 'PHARMACY_STOCK_ADJUSTED', entityType: 'PHARMACY_ITEM', entityId: updated.id,
    summary: `Adjusted ${updated.name} stock by ${parsed.data.delta} → ${next}${parsed.data.reason ? ` (${parsed.data.reason})` : ''}`,
    medicalCentreId: updated.medicalCentreId
  });
  res.json(updated);
});

exports.deactivateItem = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const existing = await prisma.pharmacyItem.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  const updated = await prisma.pharmacyItem.update({ where: { id: existing.id }, data: { isActive: false } });
  await audit.log({
    actor: { id: actor.user.id, role: actor.role, name: actor.name },
    action: 'PHARMACY_ITEM_DEACTIVATED', entityType: 'PHARMACY_ITEM', entityId: updated.id,
    summary: `Removed medicine ${updated.name}`,
    medicalCentreId: updated.medicalCentreId
  });
  res.json({ success: true });
});

// ─── Bills ───
exports.listBills = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const { from, to, q } = req.query;
  const where = {};
  if (actor.centreId) where.medicalCentreId = actor.centreId;
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
    take: 300
  });
  res.json(rows.map(r => ({ ...r, pdfUrl: signBillUrl(r.id, actor) })));
});

exports.createBill = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const parsed = pharmacyBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const d = parsed.data;

  let patient = null;
  if (d.patientId) {
    patient = await prisma.patient.findUnique({ where: { id: d.patientId } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
  }

  let doctorId = d.doctorId || null;
  if (d.prescriptionId) {
    const rx = await prisma.prescription.findUnique({
      where: { id: d.prescriptionId },
      include: { appointment: { include: { patient: true, doctor: true } } }
    });
    if (rx) {
      doctorId = doctorId || rx.appointment.doctorId;
      if (!patient) patient = rx.appointment.patient;
    }
  }

  const itemIds = d.items.map(i => i.itemId).filter(Boolean);
  const stockRows = itemIds.length
    ? await prisma.pharmacyItem.findMany({ where: { id: { in: itemIds } } })
    : [];
  const stockMap = new Map(stockRows.map(s => [s.id, s]));

  for (const line of d.items) {
    if (line.itemId) {
      const stock = stockMap.get(line.itemId);
      if (stock && stock.stock < line.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${stock.name} (have ${stock.stock}, need ${line.quantity})` });
      }
    }
  }

  const computed = d.items.map(line => {
    const stock = line.itemId ? stockMap.get(line.itemId) : null;
    const unitPrice = line.unitPrice !== undefined && line.unitPrice !== null
      ? Number(line.unitPrice)
      : (stock ? Number(stock.sellingPrice) : 0);
    return {
      itemId: line.itemId || null,
      name: line.name,
      quantity: line.quantity,
      unitPrice,
      total: Math.round(unitPrice * line.quantity * 100) / 100
    };
  });

  const subtotal = computed.reduce((s, i) => s + i.total, 0);
  const discount = Number(d.discount || 0);
  const tax = Number(d.tax || 0);
  const total = Math.round(Math.max(0, subtotal - discount + tax) * 100) / 100;
  const billNumber = await staffDocs.nextBillNumber();
  const centreId = d.medicalCentreId || actor.centreId || null;

  const bill = await prisma.$transaction(async (tx) => {
    const created = await tx.pharmacyBill.create({
      data: {
        billNumber,
        medicalCentreId: centreId,
        patientId: patient ? patient.id : null,
        prescriptionId: d.prescriptionId || null,
        doctorId,
        createdById: actor.user.id,
        createdByRole: actor.role,
        customerName: (patient && patient.name) || d.customerName || 'Walk-in customer',
        customerPhone: (patient && patient.phone) || d.customerPhone || null,
        subtotal, discount, tax, total,
        paymentMethod: d.paymentMethod || 'CASH',
        status: 'PAID',
        notes: d.notes || null,
        items: { create: computed }
      },
      include: { items: true }
    });
    for (const line of computed) {
      if (line.itemId) {
        await tx.pharmacyItem.update({
          where: { id: line.itemId },
          data: { stock: { decrement: line.quantity } }
        });
      }
    }
    return created;
  });

  const stored = await staffDocs.generateAndStoreBillPdf(bill.id, { id: actor.user.id, role: actor.role });
  await audit.log({
    actor: { id: actor.user.id, role: actor.role, name: actor.name },
    action: 'PHARMACY_BILL_CREATED', entityType: 'PHARMACY_BILL', entityId: bill.id,
    summary: `Created bill ${billNumber} (₹${total.toFixed(2)}, ${computed.length} item${computed.length === 1 ? '' : 's'})`,
    medicalCentreId: centreId, doctorId
  });
  res.status(201).json({ bill: stored.bill, pdfUrl: stored.signedUrl });
});

exports.billDetail = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const bill = await prisma.pharmacyBill.findUnique({
    where: { id: req.params.id },
    include: { items: true, medicalCentre: true, doctor: true, patient: true }
  });
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (actor.centreId && bill.medicalCentreId && bill.medicalCentreId !== actor.centreId) {
    return res.status(404).json({ error: 'Bill not found' });
  }
  res.json({ ...bill, pdfUrl: signBillUrl(bill.id, actor) });
});

exports.sendBill = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const bill = await prisma.pharmacyBill.findUnique({ where: { id: req.params.id } });
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const channels = Array.isArray(req.body && req.body.channels) ? req.body.channels : ['whatsapp', 'email'];
  const delivery = await staffDocs.deliverPharmacyBill(bill.id, { channels, user: { id: actor.user.id, role: actor.role } });
  await audit.log({
    actor: { id: actor.user.id, role: actor.role, name: actor.name },
    action: 'PHARMACY_BILL_SENT', entityType: 'PHARMACY_BILL', entityId: bill.id,
    summary: `Sent bill ${bill.billNumber} via ${channels.join('+')}`,
    medicalCentreId: bill.medicalCentreId
  });
  res.json({ success: true, delivery });
});