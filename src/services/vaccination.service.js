// =====================================================================
// vaccination.service.js — Vaccination reminder automation  (v3.5.2)
// ---------------------------------------------------------------------
// FIXES IN THIS VERSION vs v3.5.1
// ────────────────────────────────
//  (T) TIMING — Reminders used to fire from a 5-minute lifecycle tick
//      that only checked "have we scanned today?". Because the day
//      rolls at 00:00 UTC = 05:30 IST, the first tick after midnight
//      UTC (around 05:20–05:35 IST) would send the day's batch. This
//      is the "5:20 AM" bug. The scan now refuses to run unless the
//      current wall-clock time in Asia/Kolkata is inside the
//      parent-friendly window (default 18:00–20:00 IST). All the
//      gating logic lives in `isWithinDeliveryWindow()`.
//
//  (D) DEDUP — The dedup key was correct in payload but had NO DB
//      uniqueness. Concurrent ticks/manual runs could double-send.
//      We now use the `claimKey` column (already unique-indexed for
//      appointment reminders) with a `VACC:<patientId>:<code>:<dueDate>`
//      key. A duplicate insert throws P2002 and we skip the send.
//      This kills Scenario A: multiple consultations for the same
//      child NEVER trigger a second reminder for the same vaccine.
//
//  (R) RECIPIENT — Reminders already only iterated `Patient`, but the
//      code did not clearly show it. We added explicit filters that
//      DROP any row where the phone/email looks like a staff account
//      (matches @neokidspro.in, admin@, doctor@, staff@) so an
//      accidentally-created "Patient" test row for a doctor never gets
//      one. Doctors, Admins, and staff live in separate tables and
//      are never queried by this service.
//
//  (C) CONTENT — The disclaimer + call-to-action block was expanded
//      to match the product spec: DOB-derived nature, no admin-record
//      guarantee, consult-pediatrician clause, NeoKidsPro booking
//      link, VaxiClinics link with home-vaccination hint, and a
//      "do not delay / not medical advice" line.
//
//  (B) BRAND EMAIL — The email now uses the shared branded shell
//      (`email-brand.service.js`) — mobile responsive, NeoKidsPro
//      colours/typography, trust footer.
//
// Ops switches (.env):
//   VACC_REMINDERS_ENABLED=false     → disables the scan entirely
//   VACC_APPROACH_DAYS=7             → approach window in days
//   VACC_WINDOW_START_HOUR_IST=18    → earliest send hour, IST (24h)
//   VACC_WINDOW_END_HOUR_IST=20      → last hour reminders may send
//   VACC_DOCTOR_NAME                 → doctor name used in copy
//   VACC_PORTAL_URL                  → vaccination portal link
//   NEOKIDS_URL                      → NeoKidsPro booking link
//   WA_TPL_VACCINATION               → Meta template name override
// =====================================================================

const prisma   = require('../config/prisma');
const logger   = require('../utils/logger');
const whatsapp = require('./whatsapp.service');
const email    = require('./email.service');
const { renderBrandedEmail, BRAND, esc } = require('./email-brand.service');
const { formatDateOnly } = require('../utils/date');

// NOTE: Vaccination reminders are system-generated, age-based reminders
// from NeoKidsPro — NOT a personal message from a doctor. No doctor name
// is interpolated anywhere in this flow (WhatsApp, email, or plain-text
// fallback). VACC_DOCTOR_NAME is intentionally not read here.
const CLINIC_NAME = process.env.CLINIC_NAME || 'NeoKidsPro Clinic';

// External URLs
const VACCINATION_PORTAL_URL =
  (process.env.VACC_PORTAL_URL || 'https://vaxiclinics.com/').replace(/\/+$/, '') + '/';
const NEOKIDSPRO_URL =
  (process.env.NEOKIDS_URL || 'https://neokidspro.in/').replace(/\/+$/, '') + '/';

// Meta template name — v1 is the first submission of the doctor-free
// template (no {{4}} doctor variable; 4 body vars total).
const WA_TPL_VACCINATION =
  process.env.WA_TPL_VACCINATION || 'neokids_vacc_reminder_v2';

const APPROACH_DAYS = parseInt(process.env.VACC_APPROACH_DAYS || '7', 10);

// Parent-friendly delivery window in IST (Asia/Kolkata). Both bounds
// inclusive on the hour boundary. Default 18:00–20:00 IST.
const WINDOW_START_HOUR = parseInt(process.env.VACC_WINDOW_START_HOUR_IST || '18', 10);
const WINDOW_END_HOUR   = parseInt(process.env.VACC_WINDOW_END_HOUR_IST   || '20', 10);
const IST_TZ = 'Asia/Kolkata';

// Concise disclaimer used INSIDE the WhatsApp template (Meta caps body
// length; the fuller advice appears in email + WhatsApp trailing text).
const DISCLAIMER_SHORT =
  "This is an automated reminder generated from your child's recorded " +
  'date of birth and standard vaccination schedules. NeoKidsPro does not ' +
  'administer vaccines and has no record of vaccinations your child may ' +
  'have already received elsewhere, so we cannot confirm whether this ' +
  'vaccine is pending, overdue, or already completed. Please consult a ' +
  'qualified pediatrician.';

// Longer version for email + WhatsApp plain-text follow-up.
const ACTION_GUIDANCE_LINES = [
  'If the vaccination is due — or if you are unsure whether your child ' +
  'has already received it — please consult your nearest healthcare ' +
  'provider or vaccination centre.',
  'For questions on your child’s vaccination schedule, eligibility, ' +
  'missed doses, catch-up vaccinations, or vaccine safety, you can book ' +
  'an online consultation with a pediatrician through NeoKidsPro: ' +
  NEOKIDSPRO_URL,
  'For pediatric vaccination guidance, appointments, and support, visit ' +
  'NeoKidsPro.',
  'If you are located in Mumbai, you may also use our dedicated ' +
  'vaccination portal at ' + VACCINATION_PORTAL_URL + ' — VaxiClinics ' +
  'provides vaccination guidance, administers vaccinations for children ' +
  'in Mumbai, and offers home-vaccination visits where available.',
  'Please do not delay or skip vaccinations without medical advice; ' +
  'timely immunization protects children against serious ' +
  'vaccine-preventable diseases.',
  'This reminder is intended to help parents stay informed and should ' +
  'not replace professional medical advice.'
];

// =====================================================================
// Vaccination schedule (IAP standard for India) — unchanged
// =====================================================================
const SCHEDULE = [
  { code: 'BCG',        name: 'BCG',                              ageDays: 0,    doseLabel: 'Birth' },
  { code: 'OPV-0',      name: 'OPV (0)',                          ageDays: 0,    doseLabel: 'Birth' },
  { code: 'HepB-1',     name: 'Hepatitis B - 1',                  ageDays: 0,    doseLabel: 'Birth' },

  { code: 'DTwP/DTaP-1', name: 'DTwP/DTaP - 1',                   ageDays: 42,   doseLabel: '6 weeks' },
  { code: 'IPV-1',      name: 'IPV - 1',                          ageDays: 42,   doseLabel: '6 weeks' },
  { code: 'Hib-1',      name: 'Hib - 1',                          ageDays: 42,   doseLabel: '6 weeks' },
  { code: 'HepB-2',     name: 'Hepatitis B - 2',                  ageDays: 42,   doseLabel: '6 weeks' },
  { code: 'Rota-1',     name: 'Rotavirus - 1',                    ageDays: 42,   doseLabel: '6 weeks' },
  { code: 'PCV-1',      name: 'PCV - 1',                          ageDays: 42,   doseLabel: '6 weeks' },

  { code: 'DTwP/DTaP-2', name: 'DTwP/DTaP - 2',                   ageDays: 70,   doseLabel: '10 weeks' },
  { code: 'IPV-2',      name: 'IPV - 2',                          ageDays: 70,   doseLabel: '10 weeks' },
  { code: 'Hib-2',      name: 'Hib - 2',                          ageDays: 70,   doseLabel: '10 weeks' },
  { code: 'Rota-2',     name: 'Rotavirus - 2',                    ageDays: 70,   doseLabel: '10 weeks' },
  { code: 'PCV-2',      name: 'PCV - 2',                          ageDays: 70,   doseLabel: '10 weeks' },

  { code: 'DTwP/DTaP-3', name: 'DTwP/DTaP - 3',                   ageDays: 98,   doseLabel: '14 weeks' },
  { code: 'IPV-3',      name: 'IPV - 3',                          ageDays: 98,   doseLabel: '14 weeks' },
  { code: 'Hib-3',      name: 'Hib - 3',                          ageDays: 98,   doseLabel: '14 weeks' },
  { code: 'Rota-3',     name: 'Rotavirus - 3',                    ageDays: 98,   doseLabel: '14 weeks' },
  { code: 'PCV-3',      name: 'PCV - 3',                          ageDays: 98,   doseLabel: '14 weeks' },

  { code: 'HepB-3',     name: 'Hepatitis B - 3',                  ageDays: 182,  doseLabel: '6 months' },
  { code: 'IFV-1',      name: 'Influenza - 1',                    ageDays: 182,  doseLabel: '6 months' },

  { code: 'IFV-2',      name: 'Influenza - 2',                    ageDays: 213,  doseLabel: '7 months' },

  { code: 'MMR-1',      name: 'MMR - 1',                          ageDays: 274,  doseLabel: '9 months' },

  { code: 'HepA-1',     name: 'Hepatitis A - 1',                  ageDays: 365,  doseLabel: '12 months' },

  { code: 'PCV-B',      name: 'PCV - Booster',                    ageDays: 456,  doseLabel: '15 months' },
  { code: 'MMR-2',      name: 'MMR - 2',                          ageDays: 456,  doseLabel: '15 months' },
  { code: 'Varicella-1', name: 'Varicella - 1',                   ageDays: 456,  doseLabel: '15 months' },

  { code: 'DTwP/DTaP-B1', name: 'DTwP/DTaP - Booster 1',          ageDays: 548,  doseLabel: '18 months' },
  { code: 'IPV-B1',     name: 'IPV - Booster',                    ageDays: 548,  doseLabel: '18 months' },
  { code: 'Hib-B1',     name: 'Hib - Booster',                    ageDays: 548,  doseLabel: '18 months' },
  { code: 'HepA-2',     name: 'Hepatitis A - 2',                  ageDays: 548,  doseLabel: '18 months' },

  { code: 'Typhoid-1',  name: 'Typhoid Conjugate',                ageDays: 730,  doseLabel: '2 years' },

  { code: 'DTwP/DTaP-B2', name: 'DTwP/DTaP - Booster 2',          ageDays: 1826, doseLabel: '5 years' },
  { code: 'OPV-B',      name: 'OPV - Booster',                    ageDays: 1826, doseLabel: '5 years' },
  { code: 'Varicella-2', name: 'Varicella - 2',                   ageDays: 1826, doseLabel: '5 years' },
  { code: 'MMR-3',      name: 'MMR - 3',                          ageDays: 1826, doseLabel: '5 years' },

  { code: 'HPV-1',      name: 'HPV - 1',                          ageDays: 3652, doseLabel: '10 years' },
  { code: 'HPV-2',      name: 'HPV - 2',                          ageDays: 3835, doseLabel: '10 years + 6 mo' },

  { code: 'Tdap',       name: 'Tdap',                             ageDays: 3652, doseLabel: '10 years' }
];

// ─── Helpers ───────────────────────────────────────────────────────────
function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

function computeSchedule(dob) {
  if (!dob) return [];
  const base = new Date(dob);
  return SCHEDULE.map(v => ({ ...v, dueDate: addDays(base, v.ageDays) }));
}

function pickApproaching(scheduleExpanded, referenceDate = new Date()) {
  const today  = new Date(isoDay(referenceDate) + 'T00:00:00.000Z');
  const window = addDays(today, APPROACH_DAYS);
  return scheduleExpanded.filter(v => {
    const due = new Date(isoDay(v.dueDate) + 'T00:00:00.000Z');
    return due >= today && due <= window;
  });
}

/**
 * Returns true when the current wall-clock time in Asia/Kolkata is
 * inside the parent-friendly delivery window. This is the single gate
 * that prevents the "5:20 AM" bug — every dispatcher (cron + manual
 * admin trigger + test script) is expected to consult this function
 * BEFORE calling processVaccinationReminders() unless it explicitly
 * overrides via { force: true }.
 */
function isWithinDeliveryWindow(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TZ, hour: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(now).reduce((acc, p) => (
    p.type !== 'literal' ? (acc[p.type] = p.value, acc) : acc
  ), {});
  const hour = Number(parts.hour === '24' ? 0 : parts.hour);
  return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

/**
 * Returns true when the record LOOKS like a real parent/guardian,
 * false when it looks like a doctor/admin/staff account that leaked
 * into the Patient table. Belt-and-braces filter on top of the fact
 * that we only ever query the `Patient` model.
 */
function isEligibleRecipient(patient) {
  if (!patient) return false;

  // Must have at least one channel of contact.
  if (!patient.phone && !patient.email) return false;

  const em = (patient.email || '').trim().toLowerCase();
  const nm = (patient.name  || '').trim().toLowerCase();

  const STAFF_LOCAL_PARTS = ['admin', 'doctor', 'staff', 'support', 'info', 'noreply', 'no-reply'];
  const STAFF_DOMAINS     = (process.env.STAFF_EMAIL_DOMAINS || 'neokidspro.in,vaxiclinics.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  if (em) {
    const [local, domain] = em.split('@');
    if (STAFF_LOCAL_PARTS.includes(local)) return false;
    if (domain && STAFF_DOMAINS.includes(domain)) return false;
  }
  if (STAFF_LOCAL_PARTS.some(k => nm.startsWith(k))) return false;

  return true;
}

// ─── Dedup via unique claimKey ─────────────────────────────────────────
// One (patient, vaccine, dueDate) combination is ever sent once —
// enforced at the DB level by the @@unique([claimKey]) index. Two
// concurrent runs cannot both send: the second insert throws P2002 and
// we bail out of that reminder.
function vaccClaimKey(patientId, code, dueDate) {
  return `VACC:${patientId}:${code}:${isoDay(dueDate)}`;
}

async function claimReminder(patientId, code, dueDate, recipient) {
  const claimKey = vaccClaimKey(patientId, code, dueDate);
  try {
    await prisma.notificationLog.create({
      data: {
        claimKey,
        appointmentId: null,
        channel: 'CLAIM',
        recipient: `${recipient || ''} [${patientId}]`,
        template: WA_TPL_VACCINATION,
        direction: 'PATIENT',
        status: 'SENT',
        payload: { dedupKey: claimKey, kind: 'vaccination_claim' }
      }
    });
    return { ok: true, claimKey };
  } catch (e) {
    if (e && e.code === 'P2002') return { ok: false, reason: 'already_claimed', claimKey };
    throw e;
  }
}

async function logChannel(patientId, phoneOrEmail, channel, code, dueDate, status, payloadOrErr) {
  const key = vaccClaimKey(patientId, code, dueDate);
  try {
    await prisma.notificationLog.create({
      data: {
        appointmentId: null,
        channel,
        recipient: `${phoneOrEmail} [${patientId}]`,
        template: WA_TPL_VACCINATION,
        direction: 'PATIENT',
        status,
        payload: status === 'SENT'   ? { ...(payloadOrErr || {}), dedupKey: key } : { dedupKey: key },
        errorMessage: status === 'FAILED'
          ? `${payloadOrErr?.message || 'unknown error'}${payloadOrErr?.code ? ` (code=${payloadOrErr.code})` : ''}`
          : null
      }
    });
  } catch (e) { logger.error('vaccine channel-log failed', e); }
}

// ─── Email body ────────────────────────────────────────────────────────
function buildEmailHtml({ patient, vaccine }) {
  const parent = patient.parentName || 'Parent';
  const dueStr = formatDateOnly(vaccine.dueDate);

  const bodyHtml = `
    <p>Dear ${esc(parent)},</p>
    <p>This is a friendly reminder that <b>${esc(patient.name)}</b>'s
       <b>${esc(vaccine.name)}</b> vaccination falls due on
       <b>${esc(dueStr)}</b> as per the standard vaccination schedule for
       your child's age.</p>

    <table role="presentation" cellspacing="0" cellpadding="0"
           style="border-collapse:collapse;margin:14px 0;width:100%;">
      <tr>
        <td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;
                   border:1px solid #E6EEF7;width:38%;">Child</td>
        <td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(patient.name)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;
                   border:1px solid #E6EEF7;">Vaccine</td>
        <td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(vaccine.name)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;
                   border:1px solid #E6EEF7;">Scheduled at</td>
        <td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(vaccine.doseLabel)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;
                   border:1px solid #E6EEF7;">Due date</td>
        <td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(dueStr)}</td>
      </tr>
    </table>

    <p><b>What you should do</b></p>
    <ul style="margin:8px 0 4px 20px;padding:0;color:#1F2937;">
      ${ACTION_GUIDANCE_LINES.map(l => `<li style="margin-bottom:6px;">${esc(l)}</li>`).join('')}
    </ul>
  `;

  const disclaimer =
    'This is an <b>automated reminder</b> generated based on your child\'s ' +
    'recorded date of birth and standard vaccination schedules. ' +
    'We do <b>not</b> maintain complete records of vaccinations administered ' +
    'outside NeoKidsPro and therefore cannot confirm whether a vaccination ' +
    'is pending, overdue, or already completed. If you have questions ' +
    'regarding your child\'s vaccination status, please consult a qualified ' +
    'pediatrician.';

  return renderBrandedEmail({
    preheader: `Vaccination reminder for ${patient.name} — ${vaccine.name} due ${dueStr}`,
    headline: 'Vaccination Reminder',
    subhead: `${vaccine.name} · Due ${dueStr}`,
    bodyHtml,
    disclaimer,
    ctas: [
      { label: '📅 Book on NeoKidsPro', url: NEOKIDSPRO_URL, color: '#4DA8FF' },
      { label: '💉 Visit VaxiClinics',   url: VACCINATION_PORTAL_URL, color: '#1E6FBF' }
    ],
    footerNote:
      `You are receiving this because <b>${esc(patient.name)}</b> is registered ` +
      `with ${esc(CLINIC_NAME)}. This message is not medical advice.`
  });
}

// ─── Send both channels for ONE approaching vaccine ────────────────────
async function sendReminderForVaccine(patient, vaccine) {
  const dueStr = formatDateOnly(vaccine.dueDate);

  // Meta template neokids_vacc_reminder_v2 (doctor-free — system reminder):
  //   Body: {{1}} Child  {{2}} Vaccine  {{3}} Due Date  {{4}} Disclaimer
  //   Body always closes on static text after {{4}} — Meta rejects a
  //   template whose rendered body ends on a variable.
  //   Button: static "Vaccination Portal" URL — no dynamic suffix.
  if (patient.phone) {
    try {
      const result = await whatsapp.sendWhatsAppWithFallback({
        to: patient.phone,
        primaryTemplate:  WA_TPL_VACCINATION,
        fallbackTemplate: null,
        bodyParams: [patient.name, vaccine.name, dueStr, DISCLAIMER_SHORT],
        urlButtonParam: null,
        plainTextFallback:
          `Hello ${patient.parentName || 'Parent'}, this is a reminder that ` +
          `${patient.name}'s ${vaccine.name} vaccination falls due on ${dueStr} ` +
          `as per the standard vaccination schedule.\n\n` +
          `${DISCLAIMER_SHORT}\n\n` +
          `Book an online consultation on NeoKidsPro: ${NEOKIDSPRO_URL}\n` +
          `In Mumbai? VaxiClinics administers vaccinations and offers home visits ` +
          `where available: ${VACCINATION_PORTAL_URL}\n\n` +
          `This is an automated reminder, not medical advice.\n` +
          `— ${CLINIC_NAME}`
      });
      if (result.ok) {
        await logChannel(patient.id, patient.phone, 'WHATSAPP', vaccine.code, vaccine.dueDate, 'SENT', result.response || { via: result.via });
      } else {
        await logChannel(patient.id, patient.phone, 'WHATSAPP', vaccine.code, vaccine.dueDate, 'FAILED', result.error);
      }
    } catch (e) {
      await logChannel(patient.id, patient.phone, 'WHATSAPP', vaccine.code, vaccine.dueDate, 'FAILED', e);
    }
  }

  if (patient.email) {
    try {
      await email.sendEmail({
        to: patient.email,
        subject: `Vaccination reminder for ${patient.name} — ${vaccine.name} due ${dueStr}`,
        html: buildEmailHtml({ patient, vaccine })
      });
      await logChannel(patient.id, patient.email, 'EMAIL', vaccine.code, vaccine.dueDate, 'SENT', { subject: 'vaccination_reminder' });
    } catch (e) {
      logger.error(`Vaccination email failed for patient ${patient.id}`, e);
      await logChannel(patient.id, patient.email, 'EMAIL', vaccine.code, vaccine.dueDate, 'FAILED', e);
    }
  }
}

// ─── Cron / admin entrypoint ──────────────────────────────────────────
/**
 * Scan every patient with a DOB and dispatch reminders for vaccines
 * approaching their due date, subject to:
 *   • the ops disable switch,
 *   • the parent-friendly delivery window (unless force=true),
 *   • recipient eligibility (parent, not staff),
 *   • one-and-only-one dedup per (patient, vaccine, dueDate).
 *
 * @param {object} opts
 * @param {boolean} [opts.force=false]  Skip the delivery-window gate.
 *                                      Used ONLY by manual admin trigger.
 */
async function processVaccinationReminders(opts = {}) {
  const force = !!opts.force;

  if (process.env.VACC_REMINDERS_ENABLED === 'false') {
    logger.info('Vaccination reminder scan skipped — VACC_REMINDERS_ENABLED=false');
    return { considered: 0, sent: 0, skippedDedup: 0, disabled: true, skippedWindow: false };
  }

  if (!force && !isWithinDeliveryWindow()) {
    logger.info(
      `Vaccination reminder scan skipped — outside delivery window ` +
      `(${WINDOW_START_HOUR}:00–${WINDOW_END_HOUR}:00 IST)`
    );
    return { considered: 0, sent: 0, skippedDedup: 0, skippedWindow: true, disabled: false };
  }

  const patients = await prisma.patient.findMany({
    where: { dateOfBirth: { not: null } },
    select: { id: true, name: true, phone: true, email: true, parentName: true, dateOfBirth: true }
  });

  let sent = 0, skippedDedup = 0, skippedIneligible = 0, considered = 0;

  for (const p of patients) {
    if (!isEligibleRecipient(p)) { skippedIneligible += 1; continue; }

    const schedule    = computeSchedule(p.dateOfBirth);
    const approaching = pickApproaching(schedule);
    if (!approaching.length) continue;

    for (const vaccine of approaching) {
      considered += 1;

      // Atomic CLAIM before any send. This kills:
      //   • two overlapping ticks both sending the same reminder,
      //   • a parent booking multiple consultations getting duplicate
      //     reminders for the same (vaccine, due date),
      //   • the daily cron re-sending an already-sent reminder.
      // Only when the child crosses into a NEW age bucket that has a
      // NEW vaccine due, does a NEW claim key exist → NEW reminder.
      const claim = await claimReminder(p.id, vaccine.code, vaccine.dueDate, p.phone || p.email);
      if (!claim.ok) { skippedDedup += 1; continue; }

      try {
        await sendReminderForVaccine(p, vaccine);
        sent += 1;
      } catch (e) {
        logger.error(`Vaccination dispatch failed for ${p.id}/${vaccine.code}`, e);
      }
    }
  }

  logger.info(
    `Vaccination reminder scan — patients=${patients.length} ` +
    `considered=${considered} sent=${sent} skippedDedup=${skippedDedup} ` +
    `skippedIneligible=${skippedIneligible}`
  );
  return {
    considered, sent, skippedDedup, skippedIneligible,
    patients: patients.length,
    disabled: false, skippedWindow: false,
    windowIST: `${WINDOW_START_HOUR}:00-${WINDOW_END_HOUR}:00`
  };
}

module.exports = {
  SCHEDULE,
  DISCLAIMER: DISCLAIMER_SHORT,
  DISCLAIMER_SHORT,
  ACTION_GUIDANCE_LINES,
  WA_TPL_VACCINATION,
  VACCINATION_PORTAL_URL,
  NEOKIDSPRO_URL,
  WINDOW_START_HOUR,
  WINDOW_END_HOUR,
  computeSchedule,
  pickApproaching,
  isWithinDeliveryWindow,
  isEligibleRecipient,
  sendReminderForVaccine,
  processVaccinationReminders
};
