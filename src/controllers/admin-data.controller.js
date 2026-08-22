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
const { asyncHandler } = require('../middleware/errorHandler');
const audit = require('../services/audit.service');

function adminActor(req) {
  return { id: req.user.id, role: 'ADMIN', name: req.user.email };
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

exports.purgePatient = asyncHandler(async (req, res) => {
  const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  await audit.log({
    actor: adminActor(req),
    action: 'PATIENT_PERMANENTLY_DELETED',
    entityType: 'PATIENT',
    entityId: patient.id,
    summary: `Permanently deleted patient ${patient.name} (${patient.phone})`,
    meta: { name: patient.name, phone: patient.phone, email: patient.email, reason: req.body && req.body.reason }
  });

  const appointmentIds = (await prisma.appointment.findMany({
    where: { patientId: patient.id }, select: { id: true }
  })).map(a => a.id);

  await prisma.$transaction([
    prisma.prescription.deleteMany({ where: { appointmentId: { in: appointmentIds } } }),
    prisma.notificationLog.deleteMany({ where: { appointmentId: { in: appointmentIds } } }),
    prisma.consultationInvoice.deleteMany({ where: { patientId: patient.id } }),
    prisma.medicalCertificate.deleteMany({ where: { patientId: patient.id } }),
    prisma.appointment.deleteMany({ where: { patientId: patient.id } }),
    // PreviousRecord.patientId and PharmacyBill.patientId are onDelete:SetNull
    // in the schema — those rows survive with the link cleared, which is
    // correct (a historical record / an old bill isn't "the patient's data"
    // in the same sense once the account it's linked to is gone).
    prisma.patient.delete({ where: { id: patient.id } })
  ]);

  res.json({ success: true, message: `${patient.name} and all related records were permanently deleted.` });
});

exports.purgeDoctor = asyncHandler(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.params.id } });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  await audit.log({
    actor: adminActor(req),
    action: 'DOCTOR_PERMANENTLY_DELETED',
    entityType: 'DOCTOR',
    entityId: doctor.id,
    summary: `Permanently deleted doctor ${doctor.name} (${doctor.email})`,
    meta: { name: doctor.name, email: doctor.email, phone: doctor.phone, reason: req.body && req.body.reason }
  });

  const appointmentIds = (await prisma.appointment.findMany({
    where: { doctorId: doctor.id }, select: { id: true }
  })).map(a => a.id);

  await prisma.$transaction([
    prisma.prescription.deleteMany({ where: { appointmentId: { in: appointmentIds } } }),
    prisma.notificationLog.deleteMany({ where: { appointmentId: { in: appointmentIds } } }),
    prisma.consultationInvoice.deleteMany({ where: { doctorId: doctor.id } }),
    prisma.medicalCertificate.deleteMany({ where: { doctorId: doctor.id } }),
    prisma.doctorSettlement.deleteMany({ where: { doctorId: doctor.id } }),
    // PreviousRecord.doctorId is required with no cascade — must go before
    // the doctor row or the delete fails on a foreign-key constraint.
    // Its attachments cascade automatically (onDelete:Cascade on recordId).
    prisma.previousRecord.deleteMany({ where: { doctorId: doctor.id } }),
    prisma.appointment.deleteMany({ where: { doctorId: doctor.id } }),
    // ReceptionistAssignment, PharmacyUserDoctor and DoctorKyc are all
    // onDelete:Cascade on doctorId in the schema — deleted automatically
    // when the doctor row goes.
    prisma.doctor.delete({ where: { id: doctor.id } })
  ]);

  res.json({ success: true, message: `Dr. ${doctor.name} and all related records were permanently deleted.` });
});
