// =====================================================================
// vaccination.service.js — Vaccination reminder automation
// ---------------------------------------------------------------------
// Given a Patient's dateOfBirth, this service:
//   1. Expands the IAP vaccination schedule into concrete due dates.
//   2. Picks the reminders whose due date falls inside the "approaching"
//      window (default: 7 days from today, once per vaccine per due date).
//   3. Sends a WhatsApp template reminder + an Email reminder.
//
// Reuses:
//   - whatsapp.service.sendWhatsAppWithFallback  (primary + text fallback)
//   - email.service.sendEmail
//   - NotificationLog table for dedup and delivery auditing
//
// Ops switches (.env):
//   VACC_REMINDERS_ENABLED=false   → disables the scan entirely
//   VACC_APPROACH_DAYS=7           → approach window in days
//   VACC_DOCTOR_NAME               → doctor name used in email copy
//   VACC_PORTAL_URL                → vaccination portal link
//   WA_TPL_VACCINATION             → Meta template name override
// =====================================================================

const prisma   = require('../config/prisma');
const logger   = require('../utils/logger');
const whatsapp = require('./whatsapp.service');
const email    = require('./email.service');
const { formatDateOnly } = require('../utils/date');

const PROVIDER_DOCTOR_NAME = process.env.VACC_DOCTOR_NAME || 'Dr. Vishal Parmar';
const CLINIC_NAME = process.env.CLINIC_NAME || 'NeoKidsPro Clinic';

// Vaccination Portal used by the email CTA and the WhatsApp static button.
const VACCINATION_PORTAL_URL =
  (process.env.VACC_PORTAL_URL || 'https://vaxiclinics.com/').replace(/\/+$/, '') + '/';

const WA_TPL_VACCINATION =
  process.env.WA_TPL_VACCINATION || 'neokids_vacc_reminder_v2';

const APPROACH_DAYS = parseInt(process.env.VACC_APPROACH_DAYS || '7', 10);

// Mandatory disclaimer shown in every vaccination reminder. The EMR does
// NOT track administered doses — reminders are age/schedule derived only.
const DISCLAIMER =
  'We do not have information regarding which vaccinations have already been ' +
  'administered to your child. This reminder is generated based on your ' +
  "child's age and standard vaccination schedules and should not be " +
  'considered confirmation that a vaccine is pending. Please consult your ' +
  'pediatrician. Visit the Vaccination Portal for appointments or more information.';

// =====================================================================
// Vaccination schedule (IAP standard for India)
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

// ─── Logging + dedup ───
// One (patient, vaccine, dueDate) combination is ever sent once; the dedup
// key travels inside the payload JSON, never in errorMessage.
async function alreadySentToday(patientId, code, dueDate) {
  const key = `VACC:${code}:${isoDay(dueDate)}`;
  const row = await prisma.notificationLog.findFirst({
    where: {
      template: WA_TPL_VACCINATION,
      recipient: { contains: patientId },
      status: 'SENT',
      payload: { path: '$.dedupKey', equals: key }
    }
  });
  return !!row;
}
async function logSent(patientId, phoneOrEmail, channel, code, dueDate, payload) {
  const key = `VACC:${code}:${isoDay(dueDate)}`;
  try {
    await prisma.notificationLog.create({
      data: {
        appointmentId: null,
        channel,
        recipient: `${phoneOrEmail} [${patientId}]`,
        template: WA_TPL_VACCINATION,
        direction: 'PATIENT',
        status: 'SENT',
        payload: { ...(payload || {}), dedupKey: key },
        errorMessage: null
      }
    });
  } catch (e) { logger.error('vaccine log failed', e); }
}
async function logFailed(patientId, phoneOrEmail, channel, code, dueDate, err) {
  const key = `VACC:${code}:${isoDay(dueDate)}`;
  try {
    await prisma.notificationLog.create({
      data: {
        appointmentId: null,
        channel,
        recipient: `${phoneOrEmail} [${patientId}]`,
        template: WA_TPL_VACCINATION,
        direction: 'PATIENT',
        status: 'FAILED',
        payload: { dedupKey: key },
        errorMessage: `${err?.message || 'unknown error'}${err?.code ? ` (code=${err.code})` : ''}`
      }
    });
  } catch (e) { logger.error('vaccine log-fail failed', e); }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function buildEmailHtml({ patient, vaccine, doctorName }) {
  const parent = patient.parentName || 'Parent';
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.55;max-width:600px;">
    <div style="background:#4DA8FF;color:#fff;padding:18px 24px;border-radius:10px 10px 0 0;">
      <h2 style="margin:0;font-size:20px;">Vaccination Reminder</h2>
      <p style="margin:4px 0 0;font-size:13px;opacity:.9;">${CLINIC_NAME}</p>
    </div>
    <div style="border:1px solid #e6eef7;border-top:none;padding:22px 24px;border-radius:0 0 10px 10px;background:#fff;">
      <p>Dear ${escapeHtml(parent)},</p>
      <p>This is a friendly reminder that <b>${escapeHtml(patient.name)}</b>'s next vaccination
        (<b>${escapeHtml(vaccine.name)}</b>) falls due on <b>${formatDateOnly(vaccine.dueDate)}</b>
        as per the standard vaccination schedule for your child's age.</p>
      <table style="border-collapse:collapse;margin:14px 0;">
        <tr><td style="padding:6px 12px;background:#F1F8FF;font-weight:bold;">Vaccine</td>
            <td style="padding:6px 12px;">${escapeHtml(vaccine.name)}</td></tr>
        <tr><td style="padding:6px 12px;background:#F1F8FF;font-weight:bold;">Scheduled at</td>
            <td style="padding:6px 12px;">${escapeHtml(vaccine.doseLabel)}</td></tr>
        <tr><td style="padding:6px 12px;background:#F1F8FF;font-weight:bold;">Due date</td>
            <td style="padding:6px 12px;">${formatDateOnly(vaccine.dueDate)}</td></tr>
      </table>
      <div style="background:#FFF8E6;border:1px solid #F2E3B3;border-radius:8px;padding:12px 14px;font-size:12.5px;color:#6b5b21;margin:16px 0;">
        ${escapeHtml(DISCLAIMER)}
      </div>
      <p>To book a vaccination consultation with <b>${escapeHtml(doctorName)}</b>, or for more
        information, please visit the Vaccination Portal:</p>
      <p style="margin:22px 0;">
        <a href="${VACCINATION_PORTAL_URL}"
           style="display:inline-block;padding:12px 22px;background:#4DA8FF;color:#fff;
                  border-radius:8px;text-decoration:none;font-weight:bold;">
          📅 Visit the Vaccination Portal
        </a>
      </p>
      <p style="font-size:12px;color:#666;">
        If the button doesn't work, open this link in your browser:<br>
        <a href="${VACCINATION_PORTAL_URL}" style="color:#4DA8FF;word-break:break-all;">${VACCINATION_PORTAL_URL}</a>
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
      <p style="font-size:12px;color:#888;margin:0;">
        You are receiving this reminder because ${escapeHtml(patient.name)} is registered with ${CLINIC_NAME}.
        Reply STOP to opt-out of vaccination reminders.
      </p>
    </div>
  </div>`;
}

// Core: send both channels for ONE approaching vaccine
async function sendReminderForVaccine(patient, vaccine) {
  const doctorName = PROVIDER_DOCTOR_NAME;
  const dueStr     = formatDateOnly(vaccine.dueDate);

  // Meta template neokids_vacc_reminder_v2 (see docs/META_WHATSAPP_TEMPLATES.md):
  //   Body: {{1}} Child  {{2}} Vaccine  {{3}} Due Date  {{4}} Doctor  {{5}} Disclaimer
  //   Button: static "Vaccination Portal" URL — no dynamic suffix.
  if (patient.phone) {
    try {
      const result = await whatsapp.sendWhatsAppWithFallback({
        to: patient.phone,
        primaryTemplate:  WA_TPL_VACCINATION,
        fallbackTemplate: null,
        bodyParams: [patient.name, vaccine.name, dueStr, doctorName, DISCLAIMER],
        urlButtonParam: null,
        plainTextFallback:
          `Hello ${patient.parentName || 'Parent'}, this is a reminder that ${patient.name}'s ` +
          `${vaccine.name} vaccination falls due on ${dueStr} as per the standard schedule. ` +
          `${DISCLAIMER} Portal: ${VACCINATION_PORTAL_URL} — ${CLINIC_NAME}`
      });
      if (result.ok) {
        await logSent(patient.id, patient.phone, 'WHATSAPP', vaccine.code, vaccine.dueDate, result.response || { via: result.via });
      } else {
        await logFailed(patient.id, patient.phone, 'WHATSAPP', vaccine.code, vaccine.dueDate, result.error);
      }
    } catch (e) {
      await logFailed(patient.id, patient.phone, 'WHATSAPP', vaccine.code, vaccine.dueDate, e);
    }
  }

  if (patient.email) {
    try {
      await email.sendEmail({
        to: patient.email,
        subject: `Vaccination reminder for ${patient.name} — ${vaccine.name} due ${dueStr}`,
        html: buildEmailHtml({ patient, vaccine, doctorName })
      });
      await logSent(patient.id, patient.email, 'EMAIL', vaccine.code, vaccine.dueDate, { subject: 'vaccination_reminder' });
    } catch (e) {
      logger.error(`Vaccination email failed for patient ${patient.id}`, e);
      await logFailed(patient.id, patient.email, 'EMAIL', vaccine.code, vaccine.dueDate, e);
    }
  }
}

// Cron entrypoint — scan all patients with a DOB and dispatch reminders.
async function processVaccinationReminders() {
  if (process.env.VACC_REMINDERS_ENABLED === 'false') {
    logger.info('Vaccination reminder scan skipped — VACC_REMINDERS_ENABLED=false');
    return { considered: 0, sent: 0, skippedDedup: 0, disabled: true };
  }

  const patients = await prisma.patient.findMany({
    where: { dateOfBirth: { not: null } },
    select: { id: true, name: true, phone: true, email: true, parentName: true, dateOfBirth: true }
  });

  let sent = 0, skippedDedup = 0, considered = 0;

  for (const p of patients) {
    const schedule    = computeSchedule(p.dateOfBirth);
    const approaching = pickApproaching(schedule);
    if (!approaching.length) continue;

    for (const vaccine of approaching) {
      considered += 1;
      const already = await alreadySentToday(p.id, vaccine.code, vaccine.dueDate);
      if (already) { skippedDedup += 1; continue; }
      await sendReminderForVaccine(p, vaccine);
      sent += 1;
    }
  }

  // Always logged (even when zero) so "did the scan run today?" is
  // answerable from the logs without guesswork.
  logger.info(
    `Vaccination reminder scan — patients=${patients.length} considered=${considered} ` +
    `sent=${sent} skippedDedup=${skippedDedup}`
  );
  return { considered, sent, skippedDedup, patients: patients.length };
}

module.exports = {
  SCHEDULE,
  DISCLAIMER,
  WA_TPL_VACCINATION,
  VACCINATION_PORTAL_URL,
  computeSchedule,
  pickApproaching,
  sendReminderForVaccine,
  processVaccinationReminders
};
