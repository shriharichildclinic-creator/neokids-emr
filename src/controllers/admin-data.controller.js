// =====================================================================
// admin-data.controller.js — permanent ("hard") deletion of a patient or
// doctor and every record that references them.
//
// This is a normal, authenticated Admin-only endpoint (same JWT + role
// check as every other /api/admin/* route) — there is nothing "secret"
// about it. It is kept in its own controller/view ("Data Management")
// rather than the regular Doctors/Patients screens because the action is
// irreversible and should never be one accidental click away from the
// everyday edit/deactivate buttons.
//
// Doctor.hardDelete (admin.controller.js) already exists but REFUSES to
// run if the doctor has any appointments — the right default for real
// staff. This controller is for the opposite case: wiping a doctor or
// patient AND everything attached to them (appointments, prescriptions,
// certificates, invoices, settlements) in one shot, e.g. to remove mock/
// test data or to fulfil a parent's data-deletion request. Every purge is
// audit-logged BEFORE the rows are deleted, so who deleted what and when
// survives even though the underlying data does not.
// =====================================================================
const prisma = require('../config/prisma');
const bcrypt = require('bcryptjs');
const { asyncHandler } = require('../middleware/errorHandler');
const audit = require('../services/audit.service');

function adminActor(req) {
  return { id: req.user.id, role: 'ADMIN', name: req.user.email };
}

// A permanent delete is irreversible, so it requires the acting admin to
// re-enter their own password — a stolen/left-open session alone is not
// enough to wipe a patient or doctor. Checked fresh against the DB on every
// call rather than trusting anything from the JWT.
async function verifyAdminPassword(req, res) {
  const password = req.body && req.body.confirmPassword;
  if (!password) {
    res.status(400).json({ error: 'Your admin password is required to confirm a permanent deletion' });
    return false;
  }
  const admin = await prisma.admin.findUnique({ where: { id: req.user.id } });
  const ok = admin && await bcrypt.compare(password, admin.passwordHash);
  if (!ok) {
    res.status(401).json({ error: 'Incorrect password' });
    return false;
  }
  return true;
}

exports.search = asyncHandler(async (req, res) => {
  const type = String(req.query.type || '').toUpperCase();
  const q = String(req.query.q || '').trim();
  if (!['PATIENT', 'DOCTOR'].includes(type)) {
    return res.status(400).json({ error: 'type must be PATIENT or DOCTOR' });
  }
  if (q.length < 2) return res.json([]);

  if (type === 'DOCTOR') {
    const rows = await prisma.doctor.findMany({
      where: { OR: [{ name: { contains: q } }, { email: { contains: q } }, { phone: { contains: q } }] },
      select: { id: true, name: true, email: true, phone: true, deletedAt: true },
      take: 20,
      orderBy: { name: 'asc' }
    });
    return res.json(rows.map(d => ({ ...d, status: d.deletedAt ? 'Deactivated' : 'Active' })));
  }

  const rows = await prisma.patient.findMany({
    where: {
      OR: [
        { name: { contains: q } },
        { phone: { contains: q } },
        { email: { contains: q } },
        { parentName: { contains: q } }
      ]
    },
    select: { id: true, name: true, phone: true, email: true, parentName: true },
    take: 20,
    orderBy: { name: 'asc' }
  });
  res.json(rows);
});

// Read-only drill-down shown before a permanent delete, so admin can see
// what's actually attached to a record instead of just its name/phone.
exports.patientDetail = asyncHandler(async (req, res) => {
  const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const [appointmentCount, invoiceCount, certificateCount, prescriptionCount, recentAppointments] = await Promise.all([
    prisma.appointment.count({ where: { patientId: patient.id } }),
    prisma.consultationInvoice.count({ where: { patientId: patient.id } }),
    prisma.medicalCertificate.count({ where: { patientId: patient.id } }),
    prisma.prescription.count({ where: { appointment: { is: { patientId: patient.id } } } }),
    prisma.appointment.findMany({
      where: { patientId: patient.id },
      select: { id: true, date: true, startTime: true, status: true, doctor: { select: { name: true } } },
      orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
      take: 5
    })
  ]);

  res.json({
    patient,
    counts: { appointments: appointmentCount, invoices: invoiceCount, certificates: certificateCount, prescriptions: prescriptionCount },
    recentAppointments
  });
});

exports.doctorDetail = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.params.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  const [appointmentCount, invoiceCount, certificateCount, settlementCount, previousRecordCount, recentAppointments] = await Promise.all([
    prisma.appointment.count({ where: { doctorId: doctor.id } }),
    prisma.consultationInvoice.count({ where: { doctorId: doctor.id } }),
    prisma.medicalCertificate.count({ where: { doctorId: doctor.id } }),
    prisma.doctorSettlement.count({ where: { doctorId: doctor.id } }),
    prisma.previousRecord.count({ where: { doctorId: doctor.id } }),
    prisma.appointment.findMany({
      where: { doctorId: doctor.id },
      select: { id: true, date: true, startTime: true, status: true, patient: { select: { name: true } } },
      orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
      take: 5
    })
  ]);

  const { passwordHash, ...safeDoctor } = doctor;
  res.json({
    doctor: { ...safeDoctor, status: doctor.deletedAt ? 'Deactivated' : 'Active' },
    counts: { appointments: appointmentCount, invoices: invoiceCount, certificates: certificateCount, settlements: settlementCount, previousRecords: previousRecordCount },
    recentAppointments
  });
});

exports.purgePatient = asyncHandler(async (req, res) => {
  if (!(await verifyAdminPassword(req, res))) return;
  const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  // Resolve appointmentIds and run every delete inside the SAME
  // transaction so a concurrently-created appointment can't slip in
  // between the lookup and the deletes (which would otherwise abort the
  // transaction on a foreign-key violation with no useful error).
  await prisma.$transaction(async (tx) => {
    const appointmentIds = (await tx.appointment.findMany({
      where: { patientId: patient.id }, select: { id: true }
    })).map(a => a.id);

    await tx.prescription.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
    await tx.notificationLog.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
    await tx.consultationInvoice.deleteMany({ where: { patientId: patient.id } });
    await tx.medicalCertificate.deleteMany({ where: { patientId: patient.id } });
    await tx.appointment.deleteMany({ where: { patientId: patient.id } });
    // PreviousRecord.patientId and PharmacyBill.patientId are onDelete:SetNull
    // in the schema — those rows survive with the link cleared, which is
    // correct (a historical record / an old bill isn't "the patient's data"
    // in the same sense once the account it's linked to is gone).
    await tx.patient.delete({ where: { id: patient.id } });
  });

  // Logged only after the deletion has actually committed — logging
  // beforehand would leave a permanent audit entry claiming the purge
  // succeeded even if the transaction above had failed and rolled back.
  await audit.log({
    actor: adminActor(req),
    action: 'PATIENT_PERMANENTLY_DELETED',
    entityType: 'PATIENT',
    entityId: patient.id,
    summary: `Permanently deleted patient ${patient.name} (${patient.phone})`,
    meta: { name: patient.name, phone: patient.phone, email: patient.email, reason: req.body && req.body.reason }
  });

  res.json({ success: true, message: `${patient.name} and all related records were permanently deleted.` });
});

exports.purgeDoctor = asyncHandler(async (req, res) => {
  if (!(await verifyAdminPassword(req, res))) return;
  const doctor = await prisma.doctor.findUnique({ where: { id: req.params.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  // Resolve appointmentIds and run every delete inside the SAME
  // transaction so a concurrently-created appointment can't slip in
  // between the lookup and the deletes (which would otherwise abort the
  // transaction on a foreign-key violation with no useful error).
  await prisma.$transaction(async (tx) => {
    const appointmentIds = (await tx.appointment.findMany({
      where: { doctorId: doctor.id }, select: { id: true }
    })).map(a => a.id);

    await tx.prescription.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
    await tx.notificationLog.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
    await tx.consultationInvoice.deleteMany({ where: { doctorId: doctor.id } });
    await tx.medicalCertificate.deleteMany({ where: { doctorId: doctor.id } });
    await tx.doctorSettlement.deleteMany({ where: { doctorId: doctor.id } });
    // PreviousRecord.doctorId is required with no cascade — must go before
    // the doctor row or the delete fails on a foreign-key constraint.
    // Its attachments cascade automatically (onDelete:Cascade on recordId).
    await tx.previousRecord.deleteMany({ where: { doctorId: doctor.id } });
    await tx.appointment.deleteMany({ where: { doctorId: doctor.id } });
    // ReceptionistAssignment, PharmacyUserDoctor and DoctorKyc are all
    // onDelete:Cascade on doctorId in the schema — deleted automatically
    // when the doctor row goes.
    await tx.doctor.delete({ where: { id: doctor.id } });
  });

  // Logged only after the deletion has actually committed — logging
  // beforehand would leave a permanent audit entry claiming the purge
  // succeeded even if the transaction above had failed and rolled back.
  await audit.log({
    actor: adminActor(req),
    action: 'DOCTOR_PERMANENTLY_DELETED',
    entityType: 'DOCTOR',
    entityId: doctor.id,
    summary: `Permanently deleted doctor ${doctor.name} (${doctor.email})`,
    meta: { name: doctor.name, email: doctor.email, phone: doctor.phone, reason: req.body && req.body.reason }
  });

  res.json({ success: true, message: `Dr. ${doctor.name} and all related records were permanently deleted.` });
});
