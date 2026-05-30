require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const SALT = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@neokidspro.in';
  const adminPwd = process.env.ADMIN_PASSWORD || 'ChangeMe@123';
  const adminHash = await bcrypt.hash(adminPwd, SALT);

  await prisma.admin.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: adminHash,
      name: 'Super Admin',
      mustChangePassword: false
    }
  });

  const doctorEmail = 'dr.sharma@neokidspro.in';
  const doctorPwd = 'Doctor@123';
  const doctorHash = await bcrypt.hash(doctorPwd, SALT);

  await prisma.doctor.upsert({
    where: { email: doctorEmail },
    update: {},
    create: {
      name: 'Anjali Sharma',
      email: doctorEmail,
      passwordHash: doctorHash,
      phone: '9876543210',
      specialization: 'Pediatrician',
      qualification: 'MBBS, MD (Pediatrics)',
      experience: 12,
      bio: 'Specialist in newborn care, vaccinations, and childhood illnesses.',
      consultationModes: 'BOTH',
      onlineConsultFee: 500,
      physicalConsultFee: 800,
      availableFromOnline: '10:00',
      availableToOnline: '13:00',
      availableFromOffline: '16:00',
      availableToOffline: '20:00',
      workingDays: 'MON,TUE,WED,THU,FRI,SAT',
      slotDuration: 15,
      isAvailable: true,
      mustChangePassword: false
    }
  });

  console.log(`✓ Admin: ${adminEmail} / ${adminPwd}`);
  console.log(`✓ Doctor: ${doctorEmail} / ${doctorPwd}`);
  console.log('\nSeed complete! Login at /admin or /doctor');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
