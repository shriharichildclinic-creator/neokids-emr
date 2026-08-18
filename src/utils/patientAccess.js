// =====================================================================
// patientAccess.js — Patient Linking security audit
// ---------------------------------------------------------------------
// Central definition of "this patient is one of MY patients" for a
// doctor. A doctor is considered to have a legitimate relationship with
// a patient if any of the following exist between them:
//   * an Appointment  (booked, walk-in, or historical/manual)
//   * a PreviousRecord the doctor themselves authored for that patient
//   * a MedicalCertificate the doctor themselves issued for that patient
//
// Every doctor-facing endpoint that looks up, searches, links, or acts
// on a Patient row by id/phone MUST run through this check before
// returning or using that patient's data. Before this fix, several
// endpoints (search, phone lookup, patient history, certificate/
// previous-record creation) trusted any patientId the client sent, or
// searched the full cross-clinic patient directory — letting a doctor
// see or act on patients who had never been under their care. Admin
// routes are unaffected: admins are meant to see every patient.
// =====================================================================
const prisma = require('../config/prisma');

async function doctorOwnsPatient(doctorId, patientId) {
  if (!doctorId || !patientId) return false;
  const [appt, rec, cert] = await Promise.all([
    prisma.appointment.findFirst({ where: { doctorId, patientId }, select: { id: true } }),
    prisma.previousRecord.findFirst({ where: { doctorId, patientId, deletedAt: null }, select: { id: true } }),
    prisma.medicalCertificate.findFirst({ where: { doctorId, patientId }, select: { id: true } }),
  ]);
  return Boolean(appt || rec || cert);
}

// Bulk version for list endpoints (search, phone lookup) so we don't
// run three queries per candidate row.
async function myPatientIdSet(doctorId) {
  const [appts, recs, certs] = await Promise.all([
    prisma.appointment.findMany({ where: { doctorId }, select: { patientId: true }, distinct: ['patientId'] }),
    prisma.previousRecord.findMany({ where: { doctorId, deletedAt: null, patientId: { not: null } }, select: { patientId: true }, distinct: ['patientId'] }),
    prisma.medicalCertificate.findMany({ where: { doctorId }, select: { patientId: true }, distinct: ['patientId'] }),
  ]);
  const ids = new Set();
  appts.forEach(a => ids.add(a.patientId));
  recs.forEach(r => r.patientId && ids.add(r.patientId));
  certs.forEach(c => c.patientId && ids.add(c.patientId));
  return ids;
}

module.exports = { doctorOwnsPatient, myPatientIdSet };
