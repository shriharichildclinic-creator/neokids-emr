const prisma = require('../config/prisma');

async function getReceptionist(id) {
  return prisma.receptionist.findFirst({ where: { id, deletedAt: null } });
}

async function getAssignments(receptionistId) {
  return prisma.receptionistAssignment.findMany({
    where: { receptionistId },
    include: {
      doctor: {
        select: {
          id: true, name: true, email: true, phone: true, specialization: true,
          qualification: true, registrationNumber: true, clinicName: true,
          clinicAddress: true, clinicMapUrl: true, physicalConsultFee: true,
          onlineConsultFee: true, slotDuration: true, workingDays: true,
          availableFromOffline: true, availableToOffline: true,
          availableFromOnline: true, availableToOnline: true, isAvailable: true
        }
      },
      medicalCentre: true
    }
  });
}

async function getDoctorIds(receptionistId) {
  const rows = await prisma.receptionistAssignment.findMany({
    where: { receptionistId },
    select: { doctorId: true }
  });
  return [...new Set(rows.map(r => r.doctorId))];
}

async function getCentreIds(receptionistId) {
  const rows = await prisma.receptionistAssignment.findMany({
    where: { receptionistId },
    select: { medicalCentreId: true }
  });
  return [...new Set(rows.map(r => r.medicalCentreId))];
}

async function primaryCentreId(receptionistId) {
  const row = await prisma.receptionistAssignment.findFirst({
    where: { receptionistId },
    select: { medicalCentreId: true },
    orderBy: { createdAt: 'asc' }
  });
  return row ? row.medicalCentreId : null;
}

async function centreForDoctor(receptionistId, doctorId) {
  const row = await prisma.receptionistAssignment.findFirst({
    where: { receptionistId, doctorId },
    select: { medicalCentreId: true }
  });
  return row ? row.medicalCentreId : null;
}

async function isAssignedDoctor(receptionistId, doctorId) {
  const row = await prisma.receptionistAssignment.findFirst({
    where: { receptionistId, doctorId },
    select: { id: true }
  });
  return !!row;
}

async function canAccessAppointment(receptionistId, appointmentId) {
  const appt = await prisma.appointment.findFirst({
    where: { id: appointmentId },
    select: { doctorId: true }
  });
  if (!appt) return false;
  return isAssignedDoctor(receptionistId, appt.doctorId);
}

async function getPatientScope(receptionistId) {
  const doctorIds = await getDoctorIds(receptionistId);
  if (!doctorIds.length) return [];
  const [appts, certs] = await Promise.all([
    prisma.appointment.findMany({
      where: { doctorId: { in: doctorIds } },
      select: { patientId: true },
      distinct: ['patientId']
    }),
    prisma.medicalCertificate.findMany({
      where: { doctorId: { in: doctorIds } },
      select: { patientId: true },
      distinct: ['patientId']
    })
  ]);
  const ids = new Set();
  appts.forEach(a => ids.add(a.patientId));
  certs.forEach(c => ids.add(c.patientId));
  return [...ids];
}

async function getPharmacyUser(id) {
  return prisma.pharmacyUser.findFirst({ where: { id, deletedAt: null } });
}

async function getPharmacyDoctorIds(pharmacyUserId) {
  const rows = await prisma.pharmacyUserDoctor.findMany({
    where: { pharmacyUserId },
    select: { doctorId: true }
  });
  return [...new Set(rows.map(r => r.doctorId))];
}

async function getPharmacyAssignments(pharmacyUserId) {
  return prisma.pharmacyUserDoctor.findMany({
    where: { pharmacyUserId },
    include: {
      doctor: {
        select: {
          id: true, name: true, specialization: true, qualification: true,
          registrationNumber: true, clinicName: true, clinicAddress: true
        }
      }
    }
  });
}

async function patientHasDoctorLink(patientId, doctorId) {
  const [appt, cert] = await Promise.all([
    prisma.appointment.findFirst({ where: { patientId, doctorId }, select: { id: true } }),
    prisma.medicalCertificate.findFirst({ where: { patientId, doctorId }, select: { id: true } })
  ]);
  return !!(appt || cert);
}

async function getPharmacyPatientScope(pharmacyUserId) {
  const doctorIds = await getPharmacyDoctorIds(pharmacyUserId);
  if (!doctorIds.length) return [];
  const [appts, certs] = await Promise.all([
    prisma.appointment.findMany({
      where: { doctorId: { in: doctorIds } },
      select: { patientId: true },
      distinct: ['patientId']
    }),
    prisma.medicalCertificate.findMany({
      where: { doctorId: { in: doctorIds } },
      select: { patientId: true },
      distinct: ['patientId']
    })
  ]);
  const ids = new Set();
  appts.forEach(a => ids.add(a.patientId));
  certs.forEach(c => ids.add(c.patientId));
  return [...ids];
}

module.exports = {
  getReceptionist,
  getAssignments,
  getDoctorIds,
  getCentreIds,
  primaryCentreId,
  centreForDoctor,
  isAssignedDoctor,
  canAccessAppointment,
  getPatientScope,
  patientHasDoctorLink,
  getPharmacyUser,
  getPharmacyDoctorIds,
  getPharmacyAssignments,
  getPharmacyPatientScope
};