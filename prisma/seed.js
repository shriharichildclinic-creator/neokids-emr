require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// The seed must never bake in defaults like "ChangeMe@123" /
// "Doctor@123". Anyone running `npm run seed` against a fresh DB used to
// get known credentials. Now both passwords are required env vars, and
// the seed refuses to run if either is missing or too weak.
function requirePassword(envKey) {
  const value = process.env[envKey];
  if (!value || value.trim().length < 8) {
    console.error(
      `\n✗ ${envKey} is required and must be at least 8 characters.\n` +
      `  Set it in .env before running the seed. See .env.example.\n`
    );
    process.exit(1);
  }
  // Reject the known-leaked defaults outright.
  const banned = new Set(['ChangeMe@123', 'Doctor@123']);
  if (banned.has(value)) {
    console.error(
      `\n✗ ${envKey} is set to a known-leaked default password.\n` +
      `  Pick a fresh password and try again.\n`
    );
    process.exit(1);
  }
  return value;
}

async function main() {
  const SALT = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@neokidspro.in';
  const adminPwd = requirePassword('ADMIN_PASSWORD');
  const adminHash = await bcrypt.hash(adminPwd, SALT);

  await prisma.admin.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: adminHash,
      name: 'Super Admin',
      // Force a password change on first login as a second layer of defence.
      mustChangePassword: true
    }
  });

  const doctorEmail = 'dr.sharma@neokidspro.in';
  const doctorPwd = requirePassword('DOCTOR_SEED_PASSWORD');
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
      // Force a password change on first login.
      mustChangePassword: true
    }
  });

  // Print the email only — never echo the password back.
  console.log(`✓ Admin seeded: ${adminEmail}`);
  console.log(`✓ Doctor seeded: ${doctorEmail}`);
  console.log('\nSeed complete. Both users must change their password on first login.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });