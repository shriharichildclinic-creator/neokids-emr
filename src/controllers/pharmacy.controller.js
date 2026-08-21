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
const { findOrCreatePatient } = require('../services/booking.service');

function roleOf(req) {
  return req.user.role === 'PHARMACY' ? 'PHARMACY' : 'RECEPTIONIST';
}

async function loadPharmacyActor(req, res) {
  const u = await staffAccess.getPharmacyUser(req.user.id);
  if (!u) { res.status(401).json({ error: 'Account not found' }); return null; }
  if (u.status !== 'ACTIVE') { res.status(403).json({ error: 'Account is suspended' }); return null; }
  if (!u.medicalCentreId) { res.status(403).json({ error: 'Your account has no clinic assigned — contact an admin' }); return null; }
  const centreIds = [u.medicalCentreId];
  return { user: u, role: 'PHARMACY', centreId: u.medicalCentreId, centreIds, name: u.name };
}

async function loadReceptionistActor(req, res, { requirePharmacy = false, requireConsultations = true } = {}) {
  const u = await staffAccess.getReceptionist(req.user.id);
  if (!u) { res.status(401).json({ error: 'Account not found' }); return null; }
  if (u.status !== 'ACTIVE') { res.status(403).json({ error: 'Account is suspended' }); return null; }
  if (requirePharmacy && !u.canManagePharmacy) {
    res.status(403).json({ error: 'Pharmacy management is not enabled for your account' });
    return null;
  }
  if (requireConsultations && !u.canManageConsultations) {
    res.status(403).json({ error: 'Consultation management is not enabled for your account' });
    return null;
  }
  if (!u.canManageConsultations && !u.canManagePharmacy) {
    res.status(403).json({ error: 'No billing or consultation access is enabled for your account' });
    return null;
  }
  const centreIds = await staffAccess.getCentreIds(u.id);
  if (!centreIds.length) { res.status(403).json({ error: 'Your account has no clinic assigned — contact an admin' }); return null; }
  const primary = await staffAccess.primaryCentreId(u.id);
  return { user: u, role: 'RECEPTIONIST', centreId: primary, centreIds, name: u.name };
}

// Pharma operations (inventory, stock, prescriptions) — receptionists need the
// explicit "can manage pharmacy" permission.
async function resolveActor(req, res) {
  const role = roleOf(req);
  if (role === 'PHARMACY') return loadPharmacyActor(req, res);
  return loadReceptionistActor(req, res, { requirePharmacy: true });
}

// Unified billing (PHARMACY / CONSULT / SERVICE) — a receptionist bills as long
// as the account is active; no pharmacy permission required for non-medicine
// line items. Pharmacy users always pass through.
async function resolveBillingActor(req, res) {
  const role = roleOf(req);
  if (role === 'PHARMACY') return loadPharmacyActor(req, res);
  return loadReceptionistActor(req, res, { requireConsultations: false });
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

function num(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }

// A medicine must never silently ring up at ₹0. Resolve the effective selling
// price as sellingPrice, falling back to MRP when the item was saved with a
// blank selling price (the historical ₹0.00 display bug).
function effectiveSellingPrice(item) {
  const selling = num(item && item.sellingPrice);
  if (selling > 0) return selling;
  return num(item && item.mrp);
}

// Validation-only pass: every inventory line must have enough stock and must
// carry the inventory's own identifying name when no explicit name is given.
function normaliseLines(d, stockMap) {
  return d.items.map(line => {
    const stock = line.itemId ? stockMap.get(line.itemId) : null;
    const unitPrice = line.unitPrice !== undefined && line.unitPrice !== null
      ? num(line.unitPrice)
      : (stock ? effectiveSellingPrice(stock) : 0);
    return {
      itemId: line.itemId || null,
      name: line.name || (stock ? stock.name : ''),
      quantity: line.quantity,
      unitPrice,
      total: Math.round(unitPrice * line.quantity * 100) / 100
    };
  });
}

function assertStockAvailable(computed, stockMap) {
  for (const line of computed) {
    if (!line.itemId) continue;
    const stock = stockMap.get(line.itemId);
    if (!stock) throw Object.assign(new Error(`Medicine "${line.name}" is not available in your inventory`), { statusCode: 400 });
    if (stock.stock < line.quantity) {
      throw Object.assign(new Error(`Insufficient stock for ${stock.name} (have ${stock.stock}, need ${line.quantity})`), { statusCode: 400 });
    }
  }
}

function totalsOf(computed, d) {
  const subtotal = Math.round(computed.reduce((s, i) => s + i.total, 0) * 100) / 100;
  const discount = num(d.discount);
  const tax = num(d.tax);
  if (discount > subtotal) {
    throw Object.assign(new Error(`Discount (₹${discount.toFixed(2)}) cannot exceed the bill subtotal (₹${subtotal.toFixed(2)})`), { statusCode: 400 });
  }
  const total = Math.round(Math.max(0, subtotal - discount + tax) * 100) / 100;
  return { subtotal, discount, tax, total };
}

function loadItemsByBillIds(itemIds) {
  if (!itemIds.length) return Promise.resolve(new Map());
  return prisma.pharmacyItem.findMany({ where: { id: { in: itemIds } } }).then(rows => new Map(rows.map(r => [r.id, r])));
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
  const itemWhere = { isActive: true, medicalCentreId: { in: actor.centreIds } };
  const billWhere = { createdAt: { gte: todayStart }, medicalCentreId: { in: actor.centreIds } };

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
  const scope = await staffAccess.getPharmacyPatientScope(actor.user.id);
  if (!scope.length) return res.json([]);
  const digits = q.replace(/\D/g, '');
  const or = [{ name: { contains: q } }];
  if (digits.length >= 4) or.push({ phone: { contains: digits } });
  const rows = await prisma.patient.findMany({
    where: { AND: [{ OR: or }, { id: { in: scope } }] },
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
  const where = { isActive: true, medicalCentreId: { in: actor.centreIds } };
  if (q && String(q).trim()) where.name = { contains: String(q).trim() };
  if (lowStock === '1') where.stock = { lte: 10 };
  const rows = await prisma.pharmacyItem.findMany({
    where,
    orderBy: { name: 'asc' },
    take: 500
  });
  // Surface the effective price so the UI can show a non-zero default even
  // when sellingPrice itself is historically 0 (falls back to MRP).
  res.json(rows.map(r => ({ ...r, sellingPrice: num(effectiveSellingPrice(r)) })));
});

exports.createItem = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req, res);
  if (!actor) return;
  const parsed = pharmacyItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const d = parsed.data;
  const sellingPrice = (d.sellingPrice !== undefined && d.sellingPrice !== null && num(d.sellingPrice) > 0)
    ? num(d.sellingPrice)
    : num(d.mrp);
  const item = await prisma.pharmacyItem.create({
    data: {
      name: d.name,
      batchNumber: d.batchNumber || null,
      unit: d.unit || 'strip',
      mrp: d.mrp ?? 0,
      purchasePrice: d.purchasePrice ?? 0,
      sellingPrice,
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
  if (existing.medicalCentreId && !actor.centreIds.includes(existing.medicalCentreId)) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const data = {
    ...(d.name !== undefined && { name: d.name }),
    ...(d.batchNumber !== undefined && { batchNumber: d.batchNumber || null }),
    ...(d.unit !== undefined && { unit: d.unit || 'strip' }),
    ...(d.mrp !== undefined && { mrp: d.mrp }),
    ...(d.purchasePrice !== undefined && { purchasePrice: d.purchasePrice }),
    ...(d.stock !== undefined && { stock: d.stock }),
    ...(d.expiryDate !== undefined && { expiryDate: parseDateOnlyOrNull(d.expiryDate) }),
    ...(d.manufacturer !== undefined && { manufacturer: d.manufacturer || null }),
    ...(d.isActive !== undefined && { isActive: d.isActive })
  };
  if (d.sellingPrice !== undefined || d.mrp !== undefined) {
    const nextSelling = d.sellingPrice !== undefined && num(d.sellingPrice) > 0
      ? num(d.sellingPrice)
      : effectiveSellingPrice({ sellingPrice: d.sellingPrice !== undefined ? d.sellingPrice : existing.sellingPrice, mrp: d.mrp !== undefined ? d.mrp : existing.mrp });
    data.sellingPrice = nextSelling;
  }
  const updated = await prisma.pharmacyItem.update({ where: { id: existing.id }, data });
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
  if (existing.medicalCentreId && !actor.centreIds.includes(existing.medicalCentreId)) {
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
  if (existing.medicalCentreId && !actor.centreIds.includes(existing.medicalCentreId)) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const updated = await prisma.pharmacyItem.update({ where: { id: existing.id }, data: { isActive: false } });
  await audit.log({
    actor: { id: actor.user.id, role: actor.role, name: actor.name },
    action: 'PHARMACY_ITEM_DEACTIVATED', entityType: 'PHARMACY_ITEM', entityId: updated.id,
    summary: `Removed medicine ${updated.name}`,
    medicalCentreId: updated.medicalCentreId
  });
  res.json({ success: true });
});

// ─── Bills (unified: PHARMACY / CONSULT / SERVICE) ───
exports.listBills = asyncHandler(async (req, res) => {
  const actor = await resolveBillingActor(req, res);
  if (!actor) return;
  const { from, to, q, status, billType } = req.query;
  const where = { medicalCentreId: { in: actor.centreIds } };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from + 'T00:00:00.000Z');
    if (to)   where.createdAt.lte = new Date(to + 'T23:59:59.999Z');
  }
  if (status && ['DRAFT', 'PAID'].includes(String(status))) where.status = String(status);
  if (billType && ['PHARMACY', 'CONSULT', 'SERVICE'].includes(String(billType))) where.billType = String(billType);
  if (q && String(q).trim().length >= 2) {
    const term = String(q).trim();
    where.OR = [
      { billNumber: { contains: term } },
      { customerName: { contains: term } },
      { patient: { is: { name: { contains: term } } } }
    ];
  }
  const rows = await prisma.pharmacyBill.findMany({
    where,
    include: { items: true, medicalCentre: true, doctor: { select: { id: true, name: true } }, patient: true },
    orderBy: { createdAt: 'desc' },
    take: 300
  });
  res.json(rows.map(r => ({ ...r, pdfUrl: signBillUrl(r.id, actor) })));
});

exports.createBill = asyncHandler(async (req, res) => {
  const actor = await resolveBillingActor(req, res);
  if (!actor) return;
  const parsed = pharmacyBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const d = parsed.data;

  // Optional patient link: use an existing patient, or quick-create a walk-in
  // from name + phone. Never forces a patient record.
  let patient = null;
  if (d.patientId) {
    patient = await prisma.patient.findUnique({ where: { id: d.patientId } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
  } else if (d.customerName && d.customerPhone) {
    try {
      patient = await findOrCreatePatient({ patientName: d.customerName, phone: d.customerPhone });
    } catch (_) {
      patient = null;
    }
  }

  let doctorId = d.doctorId || null;
  if (doctorId) {
    const doctorIds = await actorDoctorIds(actor);
    if (!doctorIds.includes(doctorId)) return res.status(403).json({ error: 'Doctor not assigned to you' });
  }
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

  const billType = d.billType || (d.prescriptionId ? 'PHARMACY' : 'SERVICE');
  if (billType === 'PHARMACY' && !d.prescriptionId && !d.items.some(i => i.itemId)) {
    // A pharmacy bill may still contain manual OTC lines; no hard block.
  }

  const itemIds = [...new Set(d.items.map(i => i.itemId).filter(Boolean))];
  const stockMap = await loadItemsByBillIds(itemIds);
  const computed = normaliseLines(d, stockMap);
  assertStockAvailable(computed, stockMap);
  const totals = totalsOf(computed, d);
  const billNumber = await staffDocs.nextBillNumber();
  const centreId = d.medicalCentreId && actor.centreIds.includes(d.medicalCentreId)
    ? d.medicalCentreId
    : actor.centreId;

  const bill = await prisma.$transaction(async (tx) => {
    for (const line of computed) {
      if (line.itemId) {
        const dec = await tx.pharmacyItem.updateMany({
          where: { id: line.itemId, stock: { gte: line.quantity } },
          data: { stock: { decrement: line.quantity } }
        });
        if (dec.count === 0) {
          const stock = stockMap.get(line.itemId);
          const err = new Error(`Insufficient stock for ${stock ? stock.name : line.name} — it may have just been sold in another bill`);
          err.statusCode = 409;
          throw err;
        }
      }
    }
    return tx.pharmacyBill.create({
      data: {
        billNumber,
        billType,
        medicalCentreId: centreId,
        patientId: patient ? patient.id : null,
        prescriptionId: d.prescriptionId || null,
        doctorId,
        createdById: actor.user.id,
        createdByRole: actor.role,
        customerName: (patient && patient.name) || d.customerName || 'Walk-in customer',
        customerPhone: (patient && patient.phone) || d.customerPhone || null,
        subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax, total: totals.total,
        paymentMethod: d.paymentMethod || 'CASH',
        status: 'DRAFT',
        notes: d.notes || null,
        items: { create: computed }
      },
      include: { items: true }
    });
  });

  const stored = await staffDocs.generateAndStoreBillPdf(bill.id, { id: actor.user.id, role: actor.role });
  await audit.log({
    actor: { id: actor.user.id, role: actor.role, name: actor.name },
    action: 'PHARMACY_BILL_CREATED', entityType: 'PHARMACY_BILL', entityId: bill.id,
    summary: `Created ${billType} bill ${billNumber} (₹${totals.total.toFixed(2)}, ${computed.length} item${computed.length === 1 ? '' : 's'})`,
    medicalCentreId: centreId, doctorId
  });
  res.status(201).json({ bill: stored.bill, pdfUrl: stored.signedUrl });
});

exports.billDetail = asyncHandler(async (req, res) => {
  const actor = await resolveBillingActor(req, res);
  if (!actor) return;
  const bill = await prisma.pharmacyBill.findUnique({
    where: { id: req.params.id },
    include: { items: true, medicalCentre: true, doctor: { select: { id: true, name: true, specialization: true } }, patient: true }
  });
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.medicalCentreId && !actor.centreIds.includes(bill.medicalCentreId)) {
    return res.status(404).json({ error: 'Bill not found' });
  }
  res.json({ ...bill, pdfUrl: signBillUrl(bill.id, actor) });
});

async function loadBillWithAccess(actor, id) {
  const bill = await prisma.pharmacyBill.findUnique({
    where: { id },
    include: { items: true, doctor: { select: { id: true, name: true, specialization: true } }, patient: true, medicalCentre: true }
  });
  if (!bill) return { error: { status: 404, message: 'Bill not found' } };
  if (bill.medicalCentreId && !actor.centreIds.includes(bill.medicalCentreId)) {
    return { error: { status: 404, message: 'Bill not found' } };
  }
  return { bill };
}

exports.updateBill = asyncHandler(async (req, res) => {
  const actor = await resolveBillingActor(req, res);
  if (!actor) return;
  const { bill, error } = await loadBillWithAccess(actor, req.params.id);
  if (error) return res.status(error.status).json({ error: error.message });
  if (bill.status !== 'DRAFT') {
    return res.status(409).json({ error: 'Only unpaid (draft) bills can be edited' });
  }

  const parsed = pharmacyBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const d = parsed.data;

  let patient = null;
  if (d.patientId) {
    patient = await prisma.patient.findUnique({ where: { id: d.patientId } });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
  } else if (d.customerName && d.customerPhone) {
    try { patient = await findOrCreatePatient({ patientName: d.customerName, phone: d.customerPhone }); } catch (_) { patient = null; }
  }

  let doctorId = d.doctorId || null;
  if (doctorId) {
    const doctorIds = await actorDoctorIds(actor);
    if (!doctorIds.includes(doctorId)) return res.status(403).json({ error: 'Doctor not assigned to you' });
  }

  const itemIds = [...new Set(d.items.map(i => i.itemId).filter(Boolean))];
  const stockMap = await loadItemsByBillIds(itemIds);
  const computed = normaliseLines(d, stockMap);
  assertStockAvailable(computed, stockMap);
  const totals = totalsOf(computed, d);

  const previousItems = bill.items.map(i => ({ itemId: i.itemId, name: i.name, quantity: i.quantity, unitPrice: num(i.unitPrice), total: num(i.total) }));
  const previousSnapshot = { subtotal: num(bill.subtotal), discount: num(bill.discount), tax: num(bill.tax), total: num(bill.total), items: previousItems, doctorId: bill.doctorId, patientId: bill.patientId };

  const updates = await prisma.$transaction(async (tx) => {
    // Release stock held by the previous draft, then re-reserve for the new set.
    const oldItemIds = [...new Set(previousItems.map(i => i.itemId).filter(Boolean))];
    for (const itemId of oldItemIds) {
      const qty = previousItems.filter(i => i.itemId === itemId).reduce((s, i) => s + i.quantity, 0);
      await tx.pharmacyItem.updateMany({ where: { id: itemId }, data: { stock: { increment: qty } } });
    }
    for (const line of computed) {
      if (line.itemId) {
        const dec = await tx.pharmacyItem.updateMany({
          where: { id: line.itemId, stock: { gte: line.quantity } },
          data: { stock: { decrement: line.quantity } }
        });
        if (dec.count === 0) {
          const stock = stockMap.get(line.itemId);
          const err = new Error(`Insufficient stock for ${stock ? stock.name : line.name}`);
          err.statusCode = 409;
          throw err;
        }
      }
    }
    await tx.pharmacyBillItem.deleteMany({ where: { billId: bill.id } });
    const editRecord = { at: new Date().toISOString(), by: `${actor.role}:${actor.user.id}`, previous: previousSnapshot };
    const edits = Array.isArray(bill.edits) ? bill.edits.slice(-19).concat(editRecord) : [editRecord];
    return tx.pharmacyBill.update({
      where: { id: bill.id },
      data: {
        patientId: patient ? patient.id : null,
        doctorId,
        customerName: (patient && patient.name) || d.customerName || bill.customerName || 'Walk-in customer',
        customerPhone: (patient && patient.phone) || d.customerPhone || null,
        prescriptionId: d.prescriptionId !== undefined ? (d.prescriptionId || null) : bill.prescriptionId,
        billType: d.billType || bill.billType,
        subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax, total: totals.total,
        paymentMethod: d.paymentMethod || bill.paymentMethod,
        notes: d.notes !== undefined ? (d.notes || null) : bill.notes,
        editedAt: new Date(),
        editedById: actor.user.id,
        editedByRole: actor.role,
        editCount: (bill.editCount || 0) + 1,
        edits,
        items: { create: computed }
      },
      include: { items: true }
    });
  });

  const stored = await staffDocs.generateAndStoreBillPdf(updates.id, { id: actor.user.id, role: actor.role });
  await audit.log({
    actor: { id: actor.user.id, role: actor.role, name: actor.name },
    action: 'PHARMACY_BILL_UPDATED', entityType: 'PHARMACY_BILL', entityId: bill.id,
    summary: `Edited ${bill.billType} bill ${bill.billNumber} (edit #${updates.editCount})`,
    medicalCentreId: bill.medicalCentreId, doctorId
  });
  res.json({ bill: stored.bill, pdfUrl: stored.signedUrl });
});

exports.markPaid = asyncHandler(async (req, res) => {
  const actor = await resolveBillingActor(req, res);
  if (!actor) return;
  const { bill, error } = await loadBillWithAccess(actor, req.params.id);
  if (error) return res.status(error.status).json({ error: error.message });
  if (bill.status === 'PAID') return res.json({ bill: { ...bill, pdfUrl: signBillUrl(bill.id, actor) }, existing: true });

  const updated = await prisma.pharmacyBill.update({
    where: { id: bill.id },
    data: {
      status: 'PAID',
      paidAt: new Date(),
      paidById: actor.user.id,
      paidByRole: actor.role,
      paymentMethod: req.body && req.body.paymentMethod ? req.body.paymentMethod : bill.paymentMethod
    },
    include: { items: true }
  });

  const stored = await staffDocs.generateAndStoreBillPdf(updated.id, { id: actor.user.id, role: actor.role });
  await audit.log({
    actor: { id: actor.user.id, role: actor.role, name: actor.name },
    action: 'PHARMACY_BILL_PAID', entityType: 'PHARMACY_BILL', entityId: bill.id,
    summary: `Marked ${bill.billType} bill ${bill.billNumber} as paid (₹${num(bill.total).toFixed(2)})`,
    medicalCentreId: bill.medicalCentreId, doctorId: bill.doctorId
  });
  res.json({ bill: stored.bill, pdfUrl: stored.signedUrl });
});

exports.sendBill = asyncHandler(async (req, res) => {
  const actor = await resolveBillingActor(req, res);
  if (!actor) return;
  const { bill, error } = await loadBillWithAccess(actor, req.params.id);
  if (error) return res.status(error.status).json({ error: error.message });
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
