// Manual end-to-end test for vaccination reminders.  (v3.5.2)
//
// Usage:
//   node scripts/test-vaccination-reminders.js               → respects the
//                                                            delivery window
//   node scripts/test-vaccination-reminders.js --force       → ignore window
//
// What it does:
//   1. Prints the effective config (template, portal URL, provider, window).
//   2. Reports whether the current time is INSIDE the parent-friendly IST
//      delivery window (default 18:00–20:00 IST).
//   3. Scans every patient with a DOB, expands the schedule, and lists the
//      vaccines currently inside the approach window.
//   4. Runs the real dispatch (WhatsApp + Email) for those vaccines. With
//      WA_PROVIDER=MOCK and no SMTP_HOST nothing leaves the server — every
//      send is logged so you can verify params against the Meta template.
//   5. Prints the NotificationLog rows written during this run.
//
// Notes on dedup:
//   • The service creates a `CLAIM` row in NotificationLog with a unique
//     claimKey = VACC:<patientId>:<vaccineCode>:<dueDate>. A duplicate
//     claim throws P2002 and the reminder is skipped.
//   • Run this script twice back-to-back: the 2nd run MUST report
//     skippedDedup > 0 and no new SENT rows. That proves Scenario A
//     (parent books multiple consultations → still ONE reminder).
require('dotenv').config();
const prisma = require('../src/config/prisma');
const vacc   = require('../src/services/vaccination.service');

(async () => {
  const runStart = new Date();
  const force = process.argv.includes('--force');

  console.log('── Vaccination reminder test run ──────────────────────');
  console.log('Template          :', vacc.WA_TPL_VACCINATION);
  console.log('Portal URL        :', vacc.VACCINATION_PORTAL_URL);
  console.log('NeoKidsPro URL    :', vacc.NEOKIDSPRO_URL);
  console.log('Delivery window   :', `${vacc.WINDOW_START_HOUR}:00–${vacc.WINDOW_END_HOUR}:00 IST`);
  console.log('In window now     :', vacc.isWithinDeliveryWindow());
  console.log('Force flag        :', force);
  console.log('WA_PROVIDER       :', (process.env.WA_PROVIDER || 'MOCK').toUpperCase());
  console.log('META configured   :', !!(process.env.META_PHONE_NUMBER_ID && process.env.META_ACCESS_TOKEN));
  console.log('SMTP configured   :', !!process.env.SMTP_HOST);
  console.log('Approach window   :', (process.env.VACC_APPROACH_DAYS || '7') + ' days');
  console.log('Enabled           :', process.env.VACC_REMINDERS_ENABLED !== 'false');
  console.log('────────────────────────────────────────────────────────');

  const patients = await prisma.patient.findMany({
    where: { dateOfBirth: { not: null } },
    select: { id: true, name: true, phone: true, email: true, parentName: true, dateOfBirth: true }
  });
  console.log(`Patients with DOB: ${patients.length}`);

  let eligible = 0, ineligible = 0;
  for (const p of patients) {
    const eligibleP = vacc.isEligibleRecipient(p);
    if (!eligibleP) { ineligible += 1; continue; }
    const approaching = vacc.pickApproaching(vacc.computeSchedule(p.dateOfBirth));
    if (!approaching.length) continue;
    eligible += 1;
    console.log(`\n• ${p.name} (DOB ${p.dateOfBirth.toISOString().slice(0, 10)}) phone=${p.phone || '—'} email=${p.email || '—'}`);
    for (const v of approaching) {
      console.log(`    → ${v.name} [${v.code}] due ${v.dueDate.toISOString().slice(0, 10)} (${v.doseLabel})`);
    }
  }
  console.log(`\nRecipient filter — eligible: ${eligible}, skipped (staff/no-contact): ${ineligible}`);

  console.log('\n── Dispatching (respects NotificationLog dedup) ───────');
  const result = await vacc.processVaccinationReminders({ force });
  console.log('Result:', result);

  const logs = await prisma.notificationLog.findMany({
    where: { template: vacc.WA_TPL_VACCINATION, createdAt: { gte: runStart } },
    orderBy: { createdAt: 'asc' },
    select: { channel: true, recipient: true, status: true, errorMessage: true, claimKey: true }
  });
  console.log(`\n── NotificationLog rows from this run (${logs.length}) ──`);
  for (const l of logs) {
    const tag = l.claimKey ? ` claim=${l.claimKey}` : '';
    console.log(`  [${l.status}] ${l.channel} → ${l.recipient}${tag}${l.errorMessage ? ` — ${l.errorMessage}` : ''}`);
  }

  console.log('\n────────── Second-run duplicate check ──────────');
  console.log('Re-running processVaccinationReminders() to prove dedup…');
  const runStart2 = new Date();
  const result2 = await vacc.processVaccinationReminders({ force });
  console.log('Result (2nd run):', result2);
  const dup = await prisma.notificationLog.findMany({
    where: { template: vacc.WA_TPL_VACCINATION, status: 'SENT', createdAt: { gte: runStart2 } },
    select: { channel: true, recipient: true }
  });
  console.log(`New SENT rows in 2nd run: ${dup.length}  (must be 0)`);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('Test run failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
