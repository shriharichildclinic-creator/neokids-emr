// Manual end-to-end test for vaccination reminders.
//
// Usage:
//   node scripts/test-vaccination-reminders.js
//
// What it does:
//   1. Prints the effective config (template, portal URL, provider, window).
//   2. Scans every patient with a DOB, expands the schedule, and lists the
//      vaccines currently inside the approach window.
//   3. Runs the real dispatch (WhatsApp + Email) for those vaccines.
//      With WA_PROVIDER=MOCK and no SMTP_HOST nothing leaves the server —
//      everything is logged so you can verify params against the Meta
//      template. Set WA_PROVIDER=META + META_* creds for a live send.
//   4. Prints the NotificationLog rows written during this run.
require('dotenv').config();
const prisma = require('../src/config/prisma');
const vacc   = require('../src/services/vaccination.service');

(async () => {
  const runStart = new Date();
  console.log('── Vaccination reminder test run ──────────────────────');
  console.log('Template        :', vacc.WA_TPL_VACCINATION);
  console.log('Portal URL      :', vacc.VACCINATION_PORTAL_URL);
  console.log('WA_PROVIDER     :', (process.env.WA_PROVIDER || 'MOCK').toUpperCase());
  console.log('META configured :', !!(process.env.META_PHONE_NUMBER_ID && process.env.META_ACCESS_TOKEN));
  console.log('SMTP configured :', !!process.env.SMTP_HOST);
  console.log('Approach window :', (process.env.VACC_APPROACH_DAYS || '7') + ' days');
  console.log('Enabled         :', process.env.VACC_REMINDERS_ENABLED !== 'false');
  console.log('────────────────────────────────────────────────────────');

  const patients = await prisma.patient.findMany({
    where: { dateOfBirth: { not: null } },
    select: { id: true, name: true, phone: true, email: true, parentName: true, dateOfBirth: true }
  });
  console.log(`Patients with DOB: ${patients.length}`);

  for (const p of patients) {
    const approaching = vacc.pickApproaching(vacc.computeSchedule(p.dateOfBirth));
    if (!approaching.length) continue;
    console.log(`\n• ${p.name} (DOB ${p.dateOfBirth.toISOString().slice(0, 10)}) phone=${p.phone || '—'} email=${p.email || '—'}`);
    for (const v of approaching) {
      console.log(`    → ${v.name} [${v.code}] due ${v.dueDate.toISOString().slice(0, 10)} (${v.doseLabel})`);
    }
  }

  console.log('\n── Dispatching (respects NotificationLog dedup) ───────');
  const result = await vacc.processVaccinationReminders();
  console.log('Result:', result);

  const logs = await prisma.notificationLog.findMany({
    where: { template: vacc.WA_TPL_VACCINATION, createdAt: { gte: runStart } },
    orderBy: { createdAt: 'asc' },
    select: { channel: true, recipient: true, status: true, errorMessage: true }
  });
  console.log(`\n── NotificationLog rows from this run (${logs.length}) ──`);
  for (const l of logs) {
    console.log(`  [${l.status}] ${l.channel} → ${l.recipient}${l.errorMessage ? ` — ${l.errorMessage}` : ''}`);
  }

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('Test run failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
