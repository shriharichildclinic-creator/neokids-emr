// =====================================================================
// vaccination.service.js — Vaccination reminder automation
// ---------------------------------------------------------------------
// EXTENSION MODULE — does NOT replace any existing service.
//
// Given a Patient's dateOfBirth, this service:
//   1. Expands the IAP-style vaccination schedule into concrete due dates.
//   2. Picks the reminders that fall inside the "approaching" window
//      (default: 7 days before due date, once per vaccine per window).
//   3. Sends a WhatsApp template reminder + an Email reminder that
//      encourages parents to book a vaccination consultation with
//      Dr. Vishal Parmar (hardcoded inside the Meta template).
//
// It reuses:
//   - whatsapp.service.sendWhatsAppWithFallback  (primary + text fallback)
//   - email.service.sendEmail
//   - NotificationLog table for dedup
// =====================================================================

const prisma   = require('../config/prisma');
const logger   = require('../utils/logger');
const whatsapp = require('./whatsapp.service');
const email    = require('./email.service');
const { formatDateOnly, getTodayDateString } = require('../utils/date');

// Doctor name is now hardcoded inside the Meta-approved template
// (neokids_vaccination_reminder). Kept here ONLY for the email fallback body.
const PROVIDER_DOCTOR_NAME = 'Dr. Vishal Parmar';
const CLINIC_NAME =
  process.env.CLINIC_NAME || 'NeoKidsPro Clinic';

// Static website URL for the WhatsApp "Book Vaccination" button
// (matches the approved Meta template — no dynamic suffix, no parameters).
const VACCINATION_WEBSITE_URL = 'https://vaxiclinics.com/';

const WA_TPL_VACCINATION =
  process.env.WA_TPL_VACCINATION || 'neokids_vaccination_reminder';

// Approaching window: send when due date is within N days from today.
const APPROACH_DAYS = parseInt(process.env.VACC_APPROACH_DAYS || '7', 10);

// =====================================================================
// Vaccination schedule (IAP / IAPCOI standard for India)
// Each entry: { code, name, ageDays, doseLabel }
// ageDays = whole days from Date of Birth.
// =====================================================================
const SCHEDULE = [
  // At birth
  { code: 'BCG',        name: 'BCG',                              ageDays: 0,   doseLabel: 'Birth' },
  { code: 'OPV-0',      name: 'OPV (0)',                          ageDays: 0,   doseLabel: 'Birth' },
  { code: 'HepB-1',     name: 'Hepatitis B - 1',                  ageDays: 0,   doseLabel: 'Birth' },

  // 6 weeks
  { code: 'DTwP/DTaP-1', name: 'DTwP/DTaP - 1',                   ageDays: 42,  doseLabel: '6 weeks' },
  { code: 'IPV-1',      name: 'IPV - 1',                          ageDays: 42,  doseLabel: '6 weeks' },
  { code: 'Hib-1',      name: 'Hib - 1',                          ageDays: 42,  doseLabel: '6 weeks' },
  { code: 'HepB-2',     name: 'Hepatitis B - 2',                  ageDays: 42,  doseLabel: '6 weeks' },
  { code: 'Rota-1',     name: 'Rotavirus - 1',                    ageDays: 42,  doseLabel: '6 weeks' },
  { code: 'PCV-1',      name: 'PCV - 1',                          ageDays: 42,  doseLabel: '6 weeks' },

  // 10 weeks
  { code: 'DTwP/DTaP-2', name: 'DTwP/DTaP - 2',                   ageDays: 70,  doseLabel: '10 weeks' },
  { code: 'IPV-2',      name: 'IPV - 2',                          ageDays: 70,  doseLabel: '10 weeks' },
  { code: 'Hib-2',      name: 'Hib - 2',                          ageDays: 70,  doseLabel: '10 weeks' },
  { code: 'Rota-2',     name: 'Rotavirus - 2',                    ageDays: 70,  doseLabel: '10 weeks' },
  { code: 'PCV-2',      name: 'PCV - 2',                          ageDays: 70,  doseLabel: '10 weeks' },

  // 14 weeks
  { code: 'DTwP/DTaP-3', name: 'DTwP/DTaP - 3',                   ageDays: 98,  doseLabel: '14 weeks' },
  { code: 'IPV-3',      name: 'IPV - 3',                          ageDays: 98,  doseLabel: '14 weeks' },
  { code: 'Hib-3',      name: 'Hib - 3',                          ageDays: 98,  doseLabel: '14 weeks' },
  { code: 'Rota-3',     name: 'Rotavirus - 3',                    ageDays: 98,  doseLabel: '14 weeks' },
  { code: 'PCV-3',      name: 'PCV - 3',                          ageDays: 98,  doseLabel: '14 weeks' },

  // 6 months
  { code: 'HepB-3',     name: 'Hepatitis B - 3',                  ageDays: 182, doseLabel: '6 months' },
  { code: 'IFV-1',      name: 'Influenza - 1',                    ageDays: 182, doseLabel: '6 months' },

  // 7 months
  { code: 'IFV-2',      name: 'Influenza - 2',                    ageDays: 213, doseLabel: '7 months' },

  // 9 months
  { code: 'MMR-1',      name: 'MMR - 1',                          ageDays: 274, doseLabel: '9 months' },

  // 12 months
  { code: 'HepA-1',     name: 'Hepatitis A - 1',                  ageDays: 365, doseLabel: '12 months' },

  // 12-15 months
  { code: 'PCV-B',      name: 'PCV - Booster',                    ageDays: 456, doseLabel: '15 months' },

  // 15 months
  { code: 'MMR-2',      name: 'MMR - 2',                          ageDays: 456, doseLabel: '15 months' },
  { code: 'Varicella-1', name: 'Varicella - 1',                   ageDays: 456, doseLabel: '15 months' },

  // 16-18 months
  { code: 'DTwP/DTaP-B1', name: 'DTwP/DTaP - Booster 1',          ageDays: 548, doseLabel: '18 months' },
  { code: 'IPV-B1',     name: 'IPV - Booster',                    ageDays: 548, doseLabel: '18 months' },
  { code: 'Hib-B1',     name: 'Hib - Booster',                    ageDays: 548, doseLabel: '18 months' },
  { code: 'HepA-2',     name: 'Hepatitis A - 2',                  ageDays: 548, doseLabel: '18 months' },

  // 2 years
  { code: 'Typhoid-1',  name: 'Typhoid Conjugate',                ageDays: 730, doseLabel: '2 years' },

  // 4-6 years
  { code: 'DTwP/DTaP-B2', name: 'DTwP/DTaP - Booster 2',          ageDays: 1826, doseLabel: '5 years' },
  { code: 'OPV-B',      name: 'OPV - Booster',                    ageDays: 1826, doseLabel: '5 years' },
  { code: 'Varicella-2', name: 'Varicella - 2',                   ageDays: 1826, doseLabel: '5 years' },
  { code: 'MMR-3',      name: 'MMR - 3',                          ageDays: 1826, doseLabel: '5 years' },

  // 9-14 years
  { code: 'HPV-1',      name: 'HPV - 1',                          ageDays: 3652, doseLabel: '10 years' },
  { code: 'HPV-2',      name: 'HPV - 2',                          ageDays: 3835, doseLabel: '10 years + 6 mo' },

  // 10-12 years
  { code: 'Tdap',       name: 'Tdap',                             ageDays: 3652, doseLabel: '10 years' }
];

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

// Expand a DOB into all vaccine due dates.
function computeSchedule(dob) {
  if (!dob) return [];
  const base = new Date(dob);
  return SCHEDULE.map(v => ({
    ...v,
    dueDate: addDays(base, v.ageDays)
  }));
}

// Return vaccines whose dueDate is within APPROACH_DAYS days from today.
function pickApproaching(scheduleExpanded, referenceDate = new Date()) {
  const today  = new Date(isoDay(referenceDate) + 'T00:00:00.000Z');
  const window = addDays(today, APPROACH_DAYS);
  return scheduleExpanded.filter(v => {
    const due = new Date(isoDay(v.dueDate) + 'T00:00:00.000Z');
    return due >= today && due <= window;
  });
}

// Logging + dedup
async function alreadySentToday(patientId, code, dueDate) {
  const key = `VACC:${code}:${isoDay(dueDate)}`;
  const row = await prisma.notificationLog.findFirst({
    where: {
      template: 'neokids_vaccination_reminder',
      recipient: { contains: patientId },
      status: 'SENT',
      errorMessage: key
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
        template: 'neokids_vaccination_reminder',
        direction: 'PATIENT',
        status: 'SENT',
        payload: payload || undefined,
        // We stash the dedup key in errorMessage because it's a free-text
        // column in the existing schema — no migration required.
        errorMessage: key
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
        template: 'neokids_vaccination_reminder',
        direction: 'PATIENT',
        status: 'FAILED',
        errorMessage: `${key} | ${err?.message || 'unknown'} (code=${err?.code || '-'})`
      }
    });
  } catch (e) { logger.error('vaccine log-fail failed', e); }
}

// Build the email HTML body
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
      <p>This is a friendly reminder that <b>${escapeHtml(patient.name)}</b>'s next vaccination is due on
        <b>${formatDateOnly(vaccine.dueDate)}</b>.</p>
      <table style="border-collapse:collapse;margin:14px 0;">
        <tr><td style="padding:6px 12px;background:#F1F8FF;font-weight:bold;">Vaccine</td>
            <td style="padding:6px 12px;">${escapeHtml(vaccine.name)}</td></tr>
        <tr><td style="padding:6px 12px;background:#F1F8FF;font-weight:bold;">Scheduled at</td>
            <td style="padding:6px 12px;">${escapeHtml(vaccine.doseLabel)}</td></tr>
        <tr><td style="padding:6px 12px;background:#F1F8FF;font-weight:bold;">Due date</td>
            <td style="padding:6px 12px;">${formatDateOnly(vaccine.dueDate)}</td></tr>
      </table>
      <p>Please book a vaccination consultation with <b>${escapeHtml(doctorName)}</b> so your child stays
        on schedule.</p>
      <p style="margin:22px 0;">
        <a href="${VACCINATION_WEBSITE_URL}"
           style="display:inline-block;padding:12px 22px;background:#4DA8FF;color:#fff;
                  border-radius:8px;text-decoration:none;font-weight:bold;">
          📅 Book Vaccination
        </a>
      </p>
      <p style="font-size:12px;color:#666;">
        If the button doesn't work, open this link in your browser:<br>
        <a href="${VACCINATION_WEBSITE_URL}" style="color:#4DA8FF;word-break:break-all;">${VACCINATION_WEBSITE_URL}</a>
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
      <p style="font-size:12px;color:#888;margin:0;">
        You are receiving this reminder because ${escapeHtml(patient.name)} is registered with ${CLINIC_NAME}.
        Reply STOP to opt-out of vaccination reminders.
      </p>
    </div>
  </div>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// Core: send both channels for ONE approaching vaccine
async function sendReminderForVaccine(patient, vaccine) {
  const doctorName  = PROVIDER_DOCTOR_NAME;
  const dueStr      = formatDateOnly(vaccine.dueDate);

  // ── WhatsApp ──
  // Template: neokids_vaccination_reminder (Meta-approved)
  //   Header:  None
  //   Body:    {{1}} Child Name  {{2}} Vaccine Name  {{3}} Due Date
  //            (Doctor name "Dr. Vishal Parmar" is HARDCODED in the template.)
  //   Button:  Static "Book Vaccination" URL → https://vaxiclinics.com/
  //            (no dynamic suffix, no URL parameters)
  if (patient.phone) {
    try {
      const result = await whatsapp.sendWhatsAppWithFallback({
        to: patient.phone,
        primaryTemplate:  WA_TPL_VACCINATION,
        fallbackTemplate: null,
        bodyParams: [
          patient.name,   // {{1}} Child Name
          vaccine.name,   // {{2}} Vaccine Name
          dueStr          // {{3}} Due Date
        ],
        // Static Visit Website button — no suffix, no dynamic parameters.
        urlButtonParam: null,
        plainTextFallback:
          `Hello ${patient.parentName || 'Parent'}, ${patient.name}'s ${vaccine.name} ` +
          `vaccination is due on ${dueStr}. Book here: ${VACCINATION_WEBSITE_URL} — ${CLINIC_NAME}`
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

  // ── Email ──
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

// Cron entrypoint — scan all patients with DOB and dispatch approaching reminders
async function processVaccinationReminders() {
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

  if (considered || sent) {
    logger.info(`Vaccination reminders — considered=${considered} sent=${sent} skippedDedup=${skippedDedup}`);
  }
  return { considered, sent, skippedDedup };
}

module.exports = {
  SCHEDULE,
  computeSchedule,
  pickApproaching,
  sendReminderForVaccine,
  processVaccinationReminders
};
