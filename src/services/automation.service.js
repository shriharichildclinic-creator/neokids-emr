// automation.service.js
//
// Notification automation for the appointment lifecycle: booking
// confirmations, reminders, reschedules, cancellations, and
// prescription/invoice/certificate delivery over email + WhatsApp.
//
// Meta WhatsApp template shapes (body params, URL button):
//   reschedule_online_v2                    5 body, Meet URL
//   neokids_reminder_online_v2              4 body, Meet URL
//   neokids_reminder_offline_v2             4 body, Maps URL
//   neokids_booking_confirms_offline_v2     5 body, Maps URL
//   reschedule_offline                      5 body, Maps URL
//   cancellation_notice_v2                  5 body, no button (reason as {{5}})
//   doctor_new_booking_offline              5 body, no button
//   doctor_new_booking_online_v2            5 body, Meet URL
//   doctor_reminder_offline                 3 body, no button
//   neokids_online_appt_confirm_v2          6 body, Meet URL
//   doctor_reminder_online                  3 body, Meet URL
//
// Reschedules deliberately do NOT fall back to a booking-confirm
// template — the body shapes differ and it reads as "new booking" to
// the recipient. The fallback chain for reschedules is:
//   primary template -> plain text (24h window) -> email (always runs)
//
// Default template is now cancellation_notice_v2, which carries the
// reason as its 5th body param ({{5}}), so it goes through in one
// message. If WA_TPL_CANCELLATION is overridden to a non-"_v2" name
// (i.e. the old 4-var cancellation_notice), the code below falls back
// to sending the reason as a plain-text follow-up inside the 24h window.

const prisma   = require('../config/prisma');
const logger   = require('../utils/logger');
const whatsapp = require('./whatsapp.service');
const waMedia  = require('./whatsapp-media.service');
const email    = require('./email.service');
const { renderBrandedEmail, esc } = require('./email-brand.service');
const pdf      = require('./pdf.service');
const meet     = require('./googleMeet.service');
const { formatDateOnly, getTodayDateString, getCurrentTimeMinutes, parseDateOnly } = require('../utils/date');
const { timeToMinutes } = require('./slot.service');
const { incrementDoctorRevenue } = require('./lifecycle.service');

function fmtDate(d) { return formatDateOnly(d); }
function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}
function getClinicNameForBody(doctor) { return doctor.clinicName || 'NeoKidsPro Clinic'; }
/**
 * "Get Directions" button in neokids_booking_confirms_offline_v2.
 *
 * The Meta WhatsApp template defines the button URL as:
 *     https://www.google.com/maps/search/{{1}}
 * so the variable we send is the *suffix only* (the URL-encoded query that
 * goes after `/search/`). It must NEVER be a full URL — if we pass a full
 * "https://www.google.com/maps/..." string, Meta concatenates it to the
 * base and the patient ends up at:
 *     https://www.google.com/maps/search/https://www.google.com/maps/...
 * which 404s or opens a useless search.
 *
 * The previous implementation only handled `maps.google.com` hosts and
 * silently fell through to `clinicMapUrl.replace(/^\/+/, '')` (i.e. the
 * full URL) for any other host — including the very common
 * `www.google.com/maps/...`, `maps.app.goo.gl/...` and `goo.gl/maps/...`
 * formats that admins routinely paste into the clinic profile. That is
 * exactly the broken-button case the bug report describes.
 *
 * This rewrite ALWAYS returns a safe, URL-encoded suffix:
 *   1. If `clinicMapUrl` contains a recognisable Google Maps query
 *      (`?q=`, `/maps/search/`, `/maps/place/`, `/maps/dir//`), we extract
 *      that query string, decode it, and re-encode it. The result is a
 *      plain URL-encoded place name, never a URL.
 *   2. Otherwise (shortlinks like goo.gl, opaque coordinates, anything we
 *      can't parse safely), we fall back to encoding the clinic name +
 *      address. The clinic location data is required at booking time, so
 *      this fallback always produces a usable search.
 *   3. Final fallback: encoded clinic name only.
 */
function getDirectionsUrlSuffix(doctor) {
  const safeEncode = (s) => encodeURIComponent(String(s).trim()).replace(/%20/g, '+');

  const clinicFallback = () => {
    const q = [doctor.clinicName, doctor.clinicAddress].filter(Boolean).join(' ').trim();
    return q ? safeEncode(q) : safeEncode(doctor.clinicName || 'NeoKidsPro Clinic');
  };

  const raw = (doctor.clinicMapUrl || '').trim();
  if (!raw) return clinicFallback();

  // Shortlinks (goo.gl, maps.app.goo.gl, bit.ly, etc.) — we can't safely
  // expand them without a network call, and Meta won't follow them inside
  // the template button. Fall back to encoding the clinic location text.
  if (/^https?:\/\/(?:[a-z0-9-]+\.)?(?:goo\.gl|bit\.ly|tinyurl\.com)\b/i.test(raw)) {
    return clinicFallback();
  }

  try {
    // Accept both full URLs and bare paths.
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://www.google.com/${raw.replace(/^\/+/, '')}`);

    // ?q=...  (any Google Maps variant)
    const qParam = u.searchParams.get('q');
    if (qParam) return safeEncode(qParam);

    // /maps/search/<query>   or   /maps/place/<query>
    let m = u.pathname.match(/\/maps\/(?:search|place)\/([^/]+)/i);
    if (m && m[1]) {
      try { return safeEncode(decodeURIComponent(m[1].replace(/\+/g, ' '))); }
      catch { return safeEncode(m[1]); }
    }

    // /maps/dir//<destination>
    m = u.pathname.match(/\/maps\/dir\/\/([^/]+)/i);
    if (m && m[1]) {
      try { return safeEncode(decodeURIComponent(m[1].replace(/\+/g, ' '))); }
      catch { return safeEncode(m[1]); }
    }

    // Anything else (e.g. bare lat/lng `@12.34,56.78,15z`) — fall back to
    // the clinic location text instead of returning a URL.
  } catch (_) {
    /* fall through */
  }
  return clinicFallback();
}
function getMeetUrlSuffix(link) {
  if (!link) return 'new';
  const m = link.match(/meet\.google\.com\/(.+)$/);
  return m ? m[1] : link;
}
function buildIsoRange(a) {
  const dateStr = new Date(a.date).toISOString().slice(0, 10);
  return { startISO: `${dateStr}T${a.startTime}:00+05:30`, endISO: `${dateStr}T${a.endTime}:00+05:30` };
}

async function logNotification(data) {
  try { await prisma.notificationLog.create({ data }); }
  catch (e) { logger.error('Log notif failed', e); }
}

async function safeWa({ appointmentId, to, direction, templateName, bodyParams, urlButtonParam, headerParams }) {
  try {
    const r = await whatsapp.sendWhatsApp({ to, templateName, bodyParams, urlButtonParam, headerParams });
    await logNotification({ appointmentId, channel: 'WHATSAPP', recipient: to, template: templateName, direction, status: 'SENT', payload: r || undefined });
  } catch (e) {
    await logNotification({
      appointmentId, channel: 'WHATSAPP', recipient: to, template: templateName, direction,
      status: 'FAILED',
      errorMessage: `${e.message}${e.code ? ` (code=${e.code}${e.subcode ? `/${e.subcode}` : ''})` : ''}`
    });
  }
}

/**
 * Send with strict primary + plain-text fallback only.
 *
 * IMPORTANT:
 * `fallbackTemplate` is preserved for compatibility but you SHOULD pass
 * `null`. A booking-confirm template is NOT a valid fallback for a
 * reschedule because the wording is wrong and the patient gets a "new
 * booking" message after a reschedule. The plain-text fallback is the
 * correct safety net (works inside the 24h customer-care window).
 */
async function safeWaWithFallback({
  appointmentId, to, direction,
  primaryTemplate, fallbackTemplate,
  bodyParams, urlButtonParam, headerParams,
  plainTextFallback
}) {
  const result = await whatsapp.sendWhatsAppWithFallback({
    to, primaryTemplate, fallbackTemplate,
    bodyParams, urlButtonParam, headerParams, plainTextFallback
  });

  if (result.ok) {
    if (result.via !== 'primary' && result.primaryError) {
      await logNotification({
        appointmentId, channel: 'WHATSAPP', recipient: to, template: primaryTemplate, direction,
        status: 'FAILED',
        errorMessage: `Primary failed: ${result.primaryError.message} (code=${result.primaryError.code}${result.primaryError.subcode ? `/${result.primaryError.subcode}` : ''})`
      });
    }
    const sentTemplate =
      result.via === 'primary'  ? primaryTemplate :
      result.via === 'fallback' ? fallbackTemplate :
      result.via === 'text'     ? `${primaryTemplate}__text_fallback` :
      result.via === 'mock'     ? primaryTemplate : primaryTemplate;
    await logNotification({
      appointmentId, channel: 'WHATSAPP', recipient: to, template: sentTemplate, direction,
      status: 'SENT', payload: result.response || { via: result.via }
    });
    return result;
  }

  await logNotification({
    appointmentId, channel: 'WHATSAPP', recipient: to, template: primaryTemplate, direction,
    status: 'FAILED',
    errorMessage: result.error
      ? `${result.error.message} (code=${result.error.code}${result.error.subcode ? `/${result.error.subcode}` : ''})`
      : 'Unknown WhatsApp send failure'
  });
  return result;
}

async function safeEmail({ appointmentId, recipient, template, direction, messageFactory }) {
  try {
    await messageFactory();
    await logNotification({ appointmentId, channel: 'EMAIL', recipient, template, direction, status: 'SENT' });
  } catch (error) {
    logger.error(`Email failed for ${template}`, error);
    await logNotification({ appointmentId, channel: 'EMAIL', recipient, template, direction, status: 'FAILED', errorMessage: error.message });
  }
}

// ═════════════════════════════════════════════════════════════════
// 2. PHYSICAL BOOKING CONFIRMED — FIX (A): 5 body params, not 6
// ═════════════════════════════════════════════════════════════════
async function onPhysicalBookingConfirmed(appointment) {
  const a = appointment;
  const dirSuffix = getDirectionsUrlSuffix(a.doctor);

  // Walk-ins are registered by reception while the patient is standing
  // at the desk — the patient-facing WhatsApp confirmation exists to get
  // someone THERE (it carries a Maps directions button), which is moot
  // when they've already arrived. Skipped for the in-person channel
  // (WALK_IN, plus legacy CLINIC_RECEPTION which now maps to it); Phone
  // and Other still get the confirmation. The doctor's new-booking
  // WhatsApp below fires either way, since the doctor still needs to know
  // a patient was added to their queue.
  const isInPerson = a.source === 'WALK_IN' || a.source === 'CLINIC_RECEPTION';
  if (!isInPerson) {
    // Meta template neokids_booking_confirms_offline_v2:
    //   {{1}} Patient Name  {{2}} Doctor Name  {{3}} Date  {{4}} Time  {{5}} Fee
    // (URL button takes Maps suffix as its single param)
    await safeWa({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      templateName: 'neokids_booking_confirms_offline_v2',
      bodyParams: [
        a.patient.name,
        a.doctor.name,
        fmtDate(a.date),
        fmtTime(a.startTime),
        Number(a.feeAtBooking).toFixed(0)
      ],
      urlButtonParam: dirSuffix
    });
  }

  if (a.doctor.phone) {
    // Meta template doctor_new_booking_offline: 5 body vars
    //   {{1}} Doctor  {{2}} Patient  {{3}} Date  {{4}} Time  {{5}} Reason
    await safeWa({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      templateName: 'doctor_new_booking_offline',
      bodyParams: [a.doctor.name, a.patient.name, fmtDate(a.date), fmtTime(a.startTime), (a.primaryProblem || '').slice(0, 60)]
    });
  }

  if (a.patient.email) {
    const mapLink = a.doctor.clinicMapUrl || `https://www.google.com/maps/search/${dirSuffix}`;
    await safeEmail({
      appointmentId: a.id, recipient: a.patient.email, template: 'PHYSICAL_CONFIRMED', direction: 'PATIENT',
      messageFactory: () => email.sendEmail({
        to: a.patient.email,
        subject: 'Your appointment is confirmed - NeoKidsPro',
        html: renderBrandedEmail({
          preheader: `Your in-clinic visit with Dr. ${a.doctor.name} is confirmed for ${fmtDate(a.date)}.`,
          headline: 'Appointment Confirmed',
          subhead: `Dr. ${esc(a.doctor.name)} · ${esc(fmtDate(a.date))} at ${esc(fmtTime(a.startTime))}`,
          bodyHtml: `
            <p>Dear ${esc(a.patient.name)},</p>
            <p>Your in-clinic visit is confirmed. Here are the details:</p>
            <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:14px 0;width:100%;">
              ${a.doctor.clinicName ? `<tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;width:38%;">Clinic</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(a.doctor.clinicName)}</td></tr>` : ''}
              ${a.doctor.clinicAddress ? `<tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Address</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(a.doctor.clinicAddress)}</td></tr>` : ''}
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Fee</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">₹${Number(a.feeAtBooking).toFixed(2)} (payable at clinic)</td></tr>
            </table>
          `,
          ctas: [{ label: '📍 Get Directions', url: mapLink }]
        })
      })
    });
  }

  if (a.doctor.email) {
    await safeEmail({
      appointmentId: a.id, recipient: a.doctor.email, template: 'PHYSICAL_CONFIRMED_DOCTOR', direction: 'DOCTOR',
      messageFactory: () => email.sendEmail({
        to: a.doctor.email,
        subject: `New in-clinic booking: ${a.patient.name} on ${fmtDate(a.date)}`,
        html: renderBrandedEmail({
          preheader: `${a.patient.name} has booked an in-clinic visit on ${fmtDate(a.date)}.`,
          headline: 'New Booking',
          subhead: `Dr. ${esc(a.doctor.name)}`,
          bodyHtml: `
            <p><b>${esc(a.patient.name)}</b> has booked an in-clinic visit.</p>
            <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:14px 0;width:100%;">
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;width:38%;">Date</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(fmtDate(a.date))} ${esc(fmtTime(a.startTime))}</td></tr>
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Phone</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">+91 ${esc(a.patient.phone)}</td></tr>
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Problem</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(a.primaryProblem)}</td></tr>
            </table>
          `
        })
      })
    });
  }
}

// ═════════════════════════════════════════════════════════════════
// 3. ONLINE BOOKING CONFIRMED (PAID)  — unchanged param shape (6/6 ok)
// ═════════════════════════════════════════════════════════════════
async function onOnlineBookingConfirmed(appointment) {
  const a = appointment;
  let meetLink    = a.meetLink || null;
  let meetEventId = a.meetEventId || null;
  let invoiceUrl  = a.invoiceUrl || null;
  let invoiceFilepath = null;

  try {
    const { startISO, endISO } = buildIsoRange(a);
    const meetRes = await meet.createMeetLink({
      summary: `NeoKidsPro Consultation - ${a.patient.name}`,
      description: `Online consultation with Dr. ${a.doctor.name}\nReason: ${a.primaryProblem}`,
      startISO, endISO,
      doctorEmail: a.doctor.email,
      patientEmail: a.patient.email
    });
    meetLink    = meetRes.meetLink;
    meetEventId = meetRes.eventId || meetEventId;
  } catch (e) { logger.error('Meet link generation failed', e); }

  try {
    const inv = await pdf.generateInvoice(a);
    invoiceUrl = inv.url;
    invoiceFilepath = inv.filepath;
  } catch (e) { logger.error('Invoice generation failed', e); }

  // ── NEW: WhatsApp Invoice PDF share (Meta Cloud API) ──
  // Runs alongside the existing email attachment path below.
  if (invoiceFilepath && a.patient.phone) {
    try {
      const r = await waMedia.sendInvoicePdf({
        appointment: a, filepath: invoiceFilepath, publicUrl: invoiceUrl
      });
      await logNotification({
        appointmentId: a.id, channel: 'WHATSAPP', recipient: a.patient.phone,
        template: process.env.WA_TPL_INVOICE_PDF || 'neokids_invoice_pdf',
        direction: 'PATIENT', status: 'SENT', payload: r || undefined
      });
    } catch (e) {
      logger.error(`WA invoice PDF failed for ${a.id}: ${e.message}`);
      await logNotification({
        appointmentId: a.id, channel: 'WHATSAPP', recipient: a.patient.phone,
        template: process.env.WA_TPL_INVOICE_PDF || 'neokids_invoice_pdf',
        direction: 'PATIENT', status: 'FAILED',
        errorMessage: `${e.message}${e.code ? ` (code=${e.code})` : ''}`
      });
    }
  }

  await prisma.appointment.update({
    where: { id: a.id },
    data: { meetLink, meetEventId, invoiceUrl }
  });

  const meetSuffix = getMeetUrlSuffix(meetLink);
  const apptShort  = a.id.slice(0, 8).toUpperCase();

  // Meta template neokids_online_appt_confirm_v2: 6 body, 1 URL btn
  //   {{1}} Patient  {{2}} Doctor  {{3}} Date  {{4}} Time  {{5}} ApptID  {{6}} Fee
  await safeWa({
    appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
    templateName: 'neokids_online_appt_confirm_v2',
    bodyParams: [a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime), apptShort, Number(a.feeAtBooking).toFixed(0)],
    urlButtonParam: meetSuffix
  });

  if (a.doctor.phone) {
    // Meta template doctor_new_booking_online_v2: 5 body, 1 URL btn
    await safeWa({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      templateName: 'doctor_new_booking_online_v2',
      bodyParams: [a.doctor.name, a.patient.name, fmtDate(a.date), fmtTime(a.startTime), (a.primaryProblem || '').slice(0, 60)],
      urlButtonParam: meetSuffix
    });
  }

  if (a.patient.email) {
    await safeEmail({
      appointmentId: a.id, recipient: a.patient.email, template: 'ONLINE_CONFIRMED', direction: 'PATIENT',
      messageFactory: () => email.sendEmail({
        to: a.patient.email,
        subject: 'Your online consultation is confirmed - NeoKidsPro',
        html: renderBrandedEmail({
          preheader: `Your online consultation with Dr. ${a.doctor.name} is confirmed for ${fmtDate(a.date)}.`,
          headline: 'Consultation Confirmed',
          subhead: `Dr. ${esc(a.doctor.name)} · ${esc(fmtDate(a.date))} at ${esc(fmtTime(a.startTime))}`,
          bodyHtml: `
            <p>Dear ${esc(a.patient.name)},</p>
            <p>Your online consultation is confirmed. Your invoice is attached to this email.</p>
          `,
          ctas: meetLink ? [{ label: '🎥 Join Meeting', url: meetLink }] : []
        }),
        attachments: invoiceFilepath ? [{ filename: `invoice_${apptShort}.pdf`, path: invoiceFilepath }] : []
      })
    });
  }

  if (a.doctor.email) {
    // UI/UX Improvement 1 — the doctor notification previously rendered the
    // Meet URL as a plain `<a>Join Meeting</a>` link inside an <li>, while
    // the patient version above uses a prominent rounded button. Doctors
    // reported missing the link entirely on mobile. We now use the same
    // styled "Join Consultation" CTA — matched pixel-for-pixel to the
    // patient's button (padding:10px 18px; background:#4DA8FF;
    // border-radius:8px) — hoisted out of the bullet list so it is a
    // primary action, plus an in-text fallback link for email clients
    // that strip inline styles.
    await safeEmail({
      appointmentId: a.id, recipient: a.doctor.email, template: 'ONLINE_CONFIRMED_DOCTOR', direction: 'DOCTOR',
      messageFactory: () => email.sendEmail({
        to: a.doctor.email,
        subject: `New online consultation: ${a.patient.name} on ${fmtDate(a.date)}`,
        html: renderBrandedEmail({
          preheader: `A paid online consultation with ${a.patient.name} has been booked.`,
          headline: 'New Online Booking',
          subhead: `Dr. ${esc(a.doctor.name)}`,
          bodyHtml: `
            <p>A paid online consultation has been booked.</p>
            <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:14px 0;width:100%;">
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;width:38%;">Patient</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(a.patient.name)} (+91 ${esc(a.patient.phone)})</td></tr>
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Date</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(fmtDate(a.date))} ${esc(fmtTime(a.startTime))}</td></tr>
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Problem</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(a.primaryProblem)}</td></tr>
            </table>
          `,
          ctas: meetLink ? [{ label: '🎥 Join Consultation', url: meetLink }] : [],
          footerNote: meetLink ? `If the button doesn't work, open this link: <a href="${meetLink}" style="color:#1E6FBF;word-break:break-all;">${esc(meetLink)}</a>` : ''
        })
      })
    });
  }
}

// ═════════════════════════════════════════════════════════════════
// 4. APPOINTMENT RESCHEDULED  — FIX (D)(E)(F)
//    - Real Meta names: `reschedule_online_v2`, `reschedule_offline`
//    - bodyParams: [Patient, Doctor, NewDate, NewTime, Reason]
//    - No booking-confirm fallback (it caused wrong UX)
//    - Doctor reschedule WA via plain text only (no Meta template yet)
//    - Doctor email NOW contains the new Meet link
// ═════════════════════════════════════════════════════════════════
async function onAppointmentRescheduled(appointment) {
  const a = appointment;
  let meetLink    = a.meetLink;
  let meetEventId = a.meetEventId;

  // Production decision: for ONLINE reschedules we ALWAYS regenerate
  // the Meet link. Reusing the old link causes calendar/timezone
  // inconsistencies and silently breaks accept/decline notifications
  // on the doctor side. The same regenerated link is then sent to
  // BOTH parties (patient WhatsApp + email, doctor email).
  if (a.consultationType === 'ONLINE') {
    if (meetEventId) {
      await meet.deleteMeetEvent(meetEventId).catch(e => logger.warn('Old meet delete failed', e.message));
    }
    try {
      const { startISO, endISO } = buildIsoRange(a);
      const res = await meet.createMeetLink({
        summary: `[RESCHEDULED] NeoKidsPro Consultation - ${a.patient.name}`,
        description: `Rescheduled consultation with Dr. ${a.doctor.name}`,
        startISO, endISO,
        doctorEmail: a.doctor.email,
        patientEmail: a.patient.email
      });
      meetLink    = res.meetLink;
      meetEventId = res.eventId || null;
      await prisma.appointment.update({ where: { id: a.id }, data: { meetLink, meetEventId } });
    } catch (e) { logger.error('Reschedule meet failed', e); }
  }

  const isOnline = a.consultationType === 'ONLINE';
  const reason   = (a.rescheduleReason || 'Doctor unavailable').slice(0, 200);

  // Env-overridable template names — DEFAULTS MATCH META EXACTLY.
  // If you ever rename templates in Meta, override here instead of code.
  const tplOnlinePrimary  = process.env.WA_TPL_RESCHEDULE_ONLINE  || 'reschedule_online_v2';
  const tplOfflinePrimary = process.env.WA_TPL_RESCHEDULE_OFFLINE || 'reschedule_offline';

  // ── PATIENT WhatsApp ──
  // Both reschedule templates have identical body shape (5 vars):
  //   {{1}} Patient  {{2}} Doctor  {{3}} New Date  {{4}} New Time  {{5}} Reason
  // URL button param:
  //   online  → Meet code (after meet.google.com/)
  //   offline → Maps suffix
  const patientBodyParams = [
    a.patient.name,
    a.doctor.name,
    fmtDate(a.date),
    fmtTime(a.startTime),
    reason
  ];

  if (isOnline) {
    await safeWaWithFallback({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      primaryTemplate:  tplOnlinePrimary,
      fallbackTemplate: null,                                // NO booking-confirm fallback
      bodyParams:       patientBodyParams,
      urlButtonParam:   getMeetUrlSuffix(meetLink),
      plainTextFallback:
        `Hello ${a.patient.name}, your online consultation with Dr. ${a.doctor.name} has been rescheduled to ` +
        `${fmtDate(a.date)} at ${fmtTime(a.startTime)}. Reason: ${reason}. ` +
        (meetLink ? `Join: ${meetLink}` : '') + ' — NeoKidsPro'
    });
  } else {
    await safeWaWithFallback({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      primaryTemplate:  tplOfflinePrimary,
      fallbackTemplate: null,                                // NO booking-confirm fallback
      bodyParams:       patientBodyParams,
      urlButtonParam:   getDirectionsUrlSuffix(a.doctor),
      plainTextFallback:
        `Hello ${a.patient.name}, your in-clinic visit with Dr. ${a.doctor.name} has been rescheduled to ` +
        `${fmtDate(a.date)} at ${fmtTime(a.startTime)}. Reason: ${reason}. — NeoKidsPro`
    });
  }

  // ── DOCTOR WhatsApp ──
  // There is NO Meta-approved doctor-reschedule template (#9/#11 are
  // reminders, #7/#8 are new-booking). We deliberately do NOT use the
  // new-booking templates here — sending the doctor a "new booking"
  // message after a reschedule is what caused the reported regression.
  // We use plain text only, which works inside the 24h customer-care
  // window (doctors message us routinely, so this is virtually always
  // open). Plus the doctor still gets the email below.
  if (a.doctor.phone) {
    await safeWaWithFallback({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      primaryTemplate: process.env.WA_TPL_RESCHEDULE_DOCTOR || null,   // future template
      fallbackTemplate: null,
      bodyParams: null,
      urlButtonParam: null,
      plainTextFallback:
        `Dr. ${a.doctor.name}, the appointment with ${a.patient.name} has been rescheduled to ` +
        `${fmtDate(a.date)} ${fmtTime(a.startTime)}. Reason: ${reason}.` +
        (isOnline && meetLink ? ` New Meet link: ${meetLink}` : '') +
        ' — NeoKidsPro'
    });
  }

  // ── Emails ──
  if (a.patient.email) {
    await safeEmail({
      appointmentId: a.id, recipient: a.patient.email, template: 'RESCHEDULED', direction: 'PATIENT',
      messageFactory: () => email.sendEmail({
        to: a.patient.email,
        subject: 'Appointment Rescheduled - NeoKidsPro',
        html: renderBrandedEmail({
          preheader: `Your appointment with Dr. ${a.doctor.name} has been rescheduled to ${fmtDate(a.date)}.`,
          headline: 'Appointment Rescheduled',
          subhead: `Dr. ${esc(a.doctor.name)} · New time: ${esc(fmtDate(a.date))} at ${esc(fmtTime(a.startTime))}`,
          bodyHtml: `
            <p>Dear ${esc(a.patient.name)},</p>
            <p>Your appointment has been rescheduled to the date and time above.</p>
            <p><b>Reason:</b> ${esc(reason)}</p>
          `,
          ctas: (meetLink && isOnline) ? [{ label: '🎥 Join New Meeting', url: meetLink }] : [],
          footerNote: (meetLink && isOnline) ? `New Meet link: <a href="${meetLink}" style="color:#1E6FBF;word-break:break-all;">${esc(meetLink)}</a>` : ''
        })
      })
    });
  }
  if (a.doctor.email) {
    // FIX (F): doctor email now contains the new Meet link, identical
    // to the patient's. This was previously missing.
    await safeEmail({
      appointmentId: a.id, recipient: a.doctor.email, template: 'RESCHEDULED_DOCTOR', direction: 'DOCTOR',
      messageFactory: () => email.sendEmail({
        to: a.doctor.email,
        subject: `Rescheduled: ${a.patient.name} → ${fmtDate(a.date)} ${fmtTime(a.startTime)}`,
        html: renderBrandedEmail({
          preheader: `${a.patient.name}'s appointment was rescheduled to ${fmtDate(a.date)}.`,
          headline: 'Appointment Rescheduled',
          subhead: `Dr. ${esc(a.doctor.name)}`,
          bodyHtml: `
            <p>The following appointment was rescheduled:</p>
            <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:14px 0;width:100%;">
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;width:38%;">Patient</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(a.patient.name)}</td></tr>
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">New date/time</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(fmtDate(a.date))} ${esc(fmtTime(a.startTime))}</td></tr>
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Reason</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(reason)}</td></tr>
            </table>
          `,
          ctas: (meetLink && isOnline) ? [{ label: '🎥 Open Meet', url: meetLink }] : []
        })
      })
    });
  }
}

// ═════════════════════════════════════════════════════════════════
// 5. APPOINTMENT CANCELLED — FIX (G)
//    Template `cancellation_notice` is 4-var. Reason cannot fit in v1.
//    We send the template (so it works outside the 24h window) AND
//    then a plain-text follow-up that includes the reason. Once you
//    publish `cancellation_notice_v2` in Meta with 5 vars, set
//    WA_TPL_CANCELLATION=cancellation_notice_v2 and the reason will
//    travel as the 5th body param of the template itself.
// ═════════════════════════════════════════════════════════════════
async function onAppointmentCancelled(appointment, reason) {
  const a = appointment;
  if (a.meetEventId) {
    await meet.deleteMeetEvent(a.meetEventId).catch(e => logger.warn('Cancel meet delete failed', e.message));
  }

  if (a.patient.email) {
    await safeEmail({
      appointmentId: a.id, recipient: a.patient.email, template: 'CANCELLED', direction: 'PATIENT',
      messageFactory: () => email.sendEmail({
        to: a.patient.email,
        subject: 'Appointment Cancelled - NeoKidsPro',
        html: renderBrandedEmail({
          preheader: `Your appointment with Dr. ${a.doctor.name} on ${fmtDate(a.date)} has been cancelled.`,
          headline: 'Appointment Cancelled',
          subhead: `Dr. ${esc(a.doctor.name)} · ${esc(fmtDate(a.date))} at ${esc(fmtTime(a.startTime))}`,
          bodyHtml: `
            <p>Dear ${esc(a.patient.name)},</p>
            <p>Your appointment above has been cancelled.</p>
            ${reason ? `<p><b>Reason:</b> ${esc(reason)}</p>` : ''}
          `
        })
      })
    });
  }
  if (a.doctor.email) {
    await safeEmail({
      appointmentId: a.id, recipient: a.doctor.email, template: 'CANCELLED_DOCTOR', direction: 'DOCTOR',
      messageFactory: () => email.sendEmail({
        to: a.doctor.email,
        subject: `Cancelled: ${a.patient.name} on ${fmtDate(a.date)}`,
        html: renderBrandedEmail({
          preheader: `${a.patient.name}'s appointment on ${fmtDate(a.date)} was cancelled.`,
          headline: 'Appointment Cancelled',
          subhead: `Dr. ${esc(a.doctor.name)}`,
          bodyHtml: `
            <p>The following appointment was cancelled:</p>
            <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:14px 0;width:100%;">
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;width:38%;">Patient</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(a.patient.name)}</td></tr>
              <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Date/time</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(fmtDate(a.date))} ${esc(fmtTime(a.startTime))}</td></tr>
              ${reason ? `<tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Reason</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(reason)}</td></tr>` : ''}
            </table>
          `
        })
      })
    });
  }
  if (a.patient.phone) {
    const cancelTpl = process.env.WA_TPL_CANCELLATION || 'cancellation_notice_v2';

    // Detect whether the configured template is the 5-var v2 or 4-var v1.
    const isV2 = /_v2$/.test(cancelTpl);
    const bodyParams = isV2
      ? [a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime), (reason || 'Not specified').slice(0, 200)]
      : [a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime)];

    await safeWaWithFallback({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      primaryTemplate:  cancelTpl,
      fallbackTemplate: null,
      bodyParams,
      plainTextFallback:
        `Hello ${a.patient.name}, your appointment with Dr. ${a.doctor.name} on ` +
        `${fmtDate(a.date)} ${fmtTime(a.startTime)} has been cancelled.` +
        (reason ? ` Reason: ${reason}.` : '') + ' — NeoKidsPro'
    }).catch(() => null);

    // If we're still on the v1 template, ALSO push the reason as a
    // plain-text session message so the patient sees WHY it was
    // cancelled. This only works inside the 24h customer-care window;
    // if it falls back/fails it's logged but does not error the cancel.
    if (!isV2 && reason) {
      try {
        await whatsapp.sendWhatsApp({
          to: a.patient.phone,
          templateName: null,            // intentionally session text
          body: `Reason for cancellation: ${reason}\n\n— NeoKidsPro`
        });
      } catch (e) {
        logger.warn(`[cancel] plain-text reason follow-up failed: ${e.message}`);
        // Note: sendWhatsApp without templateName logs in MOCK mode and throws
        // META_TEMPLATE_MISSING in META mode. We use the dedicated text path:
      }
      // Use the dedicated text helper for production runs.
      try {
        const wa = require('./whatsapp.service');
        if (wa.sendWhatsAppWithFallback) {
          await wa.sendWhatsAppWithFallback({
            to: a.patient.phone,
            primaryTemplate: null,
            fallbackTemplate: null,
            plainTextFallback: `Reason for cancellation: ${reason} — NeoKidsPro`
          });
        }
      } catch (_) {}
    }
  }
}

// ═════════════════════════════════════════════════════════════════
// 6. PRESCRIPTION SAVED
//
// Generates the PDF and finalizes the appointment (status/revenue).
// Deliberately does NOT email or WhatsApp anything — the doctor
// chooses the delivery channel explicitly afterwards via
// deliverPrescription() / POST /doctor/appointments/:id/prescription/send.
// ═════════════════════════════════════════════════════════════════
async function onPrescriptionCreated(appointment, prescription) {
  const pdfRes = await pdf.generatePrescription(appointment, prescription);

  const wasAlreadyCompleted = appointment.status === 'COMPLETED';

  await prisma.appointment.update({
    where: { id: appointment.id },
    data: {
      prescriptionUrl: pdfRes.url,
      ...(wasAlreadyCompleted ? {} : { status: 'COMPLETED', completedAt: new Date() })
    }
  });

  if (!wasAlreadyCompleted) {
    await incrementDoctorRevenue(appointment.doctorId, appointment.feeAtBooking, appointment.paymentStatus);
  }

  return pdfRes;
}

// ═════════════════════════════════════════════════════════════════
// 6b. PRESCRIPTION DELIVERY — explicit, doctor-initiated
//
// Called only after the doctor picks a channel in the "Send
// Prescription" modal (Email / WhatsApp / Both). Regenerates the PDF
// if it has drifted, then attempts each requested channel
// independently so a failure on one never blocks the other. Returns
// a per-channel status so the controller can report accurate
// success/partial/failure messages back to the doctor.
// ═════════════════════════════════════════════════════════════════
async function deliverPrescription(appointment, prescription, { email: wantsEmail, whatsapp: wantsWhatsapp }) {
  const pdfRes = await pdf.generatePrescription(appointment, prescription);

  if (!appointment.prescriptionUrl || appointment.prescriptionUrl !== pdfRes.url) {
    await prisma.appointment.update({ where: { id: appointment.id }, data: { prescriptionUrl: pdfRes.url } });
  }

  const result = { email: 'skipped', whatsapp: 'skipped' };

  if (wantsEmail) {
    try {
      await email.sendEmail({
        to: appointment.patient.email,
        subject: 'Your prescription from NeoKidsPro',
        html: renderBrandedEmail({
          preheader: `Your prescription from Dr. ${appointment.doctor.name} is attached.`,
          headline: 'Your Prescription',
          subhead: `Dr. ${esc(appointment.doctor.name)}`,
          bodyHtml: `
            <p>Dear ${esc(appointment.patient.name)},</p>
            <p>Please find your prescription attached to this email as a PDF.</p>
          `
        }),
        attachments: [{ filename: pdfRes.filename, path: pdfRes.filepath }]
      });
      await logNotification({
        appointmentId: appointment.id, channel: 'EMAIL', recipient: appointment.patient.email,
        template: 'PRESCRIPTION', direction: 'PATIENT', status: 'SENT'
      });
      result.email = 'sent';
    } catch (e) {
      logger.error(`Prescription email failed for ${appointment.id}: ${e.message}`);
      await logNotification({
        appointmentId: appointment.id, channel: 'EMAIL', recipient: appointment.patient.email,
        template: 'PRESCRIPTION', direction: 'PATIENT', status: 'FAILED', errorMessage: e.message
      });
      result.email = 'failed';
      result.emailError = e.message;
    }
  }

  if (wantsWhatsapp) {
    try {
      const r = await waMedia.sendPrescriptionPdf({
        appointment, filepath: pdfRes.filepath, publicUrl: pdfRes.url
      });
      await logNotification({
        appointmentId: appointment.id, channel: 'WHATSAPP',
        recipient: appointment.patient.phone,
        template: process.env.WA_TPL_PRESCRIPTION_PDF || 'neokids_prescription_pdf',
        direction: 'PATIENT', status: 'SENT', payload: r || undefined
      });
      result.whatsapp = 'sent';
    } catch (e) {
      logger.error(`Prescription WhatsApp failed for ${appointment.id}: ${e.message}`);
      await logNotification({
        appointmentId: appointment.id, channel: 'WHATSAPP',
        recipient: appointment.patient.phone,
        template: process.env.WA_TPL_PRESCRIPTION_PDF || 'neokids_prescription_pdf',
        direction: 'PATIENT', status: 'FAILED',
        errorMessage: `${e.message}${e.code ? ` (code=${e.code})` : ''}`
      });
      result.whatsapp = 'failed';
      result.whatsappError = e.message;
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Medical certificate delivery (WhatsApp + email).
// Mirrors onPrescriptionCreated: PDF is already generated by the caller
// (certificate.controller.deliverCertificate); this function owns the two
// notification channels. Each channel is independently best-effort and
// logged to NotificationLog; a WhatsApp failure never blocks the email.
//
// Meta template: medical_certificate_ready (see docs/META_WHATSAPP_TEMPLATES.md)
//   {{1}} patient name · {{2}} doctor/clinic name · {{3}} certificate date
// Email contract (per product spec):
//   Subject: Medical Certificate – {{Doctor Name}}
//   Body: Hello {{Patient Name}}, your medical certificate has been
//         generated and is attached to this email.
// ─────────────────────────────────────────────────────────────────────
async function onCertificateIssued({ certificate, pdfRes, sendWhatsapp = true, sendEmail = true }) {
  const dayjs   = require('dayjs');
  const patient = certificate.patient;
  const doctor  = certificate.doctor;
  const certDate = dayjs(certificate.certificateDate || certificate.fromDate || certificate.issuedAt).format('DD MMM YYYY');
  const doctorLabel = `Dr. ${doctor.name}`;
  const delivery = { whatsapp: 'skipped', email: 'skipped' };

  if (sendEmail) {
    if (patient.email) {
      await safeEmail({
        appointmentId: certificate.appointmentId || null,
        recipient: patient.email, template: 'MEDICAL_CERTIFICATE', direction: 'PATIENT',
        messageFactory: () => email.sendEmail({
          to: patient.email,
          subject: `Medical Certificate – ${doctorLabel}`,
          html: renderBrandedEmail({
            preheader: `Your medical certificate from ${doctorLabel} is attached.`,
            headline: 'Medical Certificate',
            subhead: doctorLabel,
            bodyHtml: `
              <p>Hello ${esc(patient.name)},</p>
              <p>Your medical certificate has been generated and is attached to this email as a PDF.</p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:14px 0;width:100%;">
                <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;width:38%;">Certificate ID</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(certificate.certificateNumber)}</td></tr>
                <tr><td style="padding:8px 12px;background:#F1F8FF;font-weight:bold;border:1px solid #E6EEF7;">Date</td><td style="padding:8px 12px;border:1px solid #E6EEF7;">${esc(certDate)}</td></tr>
              </table>
            `,
            footerNote: `Regards,<br>${esc(doctorLabel)}`
          }),
          attachments: [{ filename: pdfRes.filename, path: pdfRes.filepath }]
        })
      });
      delivery.email = 'sent';
    } else {
      delivery.email = 'no_email';
    }
  }

  if (sendWhatsapp && patient.phone) {
    const tpl = process.env.WA_TPL_CERTIFICATE_PDF || 'medical_certificate_ready';
    try {
      const r = await waMedia.sendCertificatePdf({
        certificate, doctor, patient, filepath: pdfRes.filepath
      });
      await logNotification({
        appointmentId: certificate.appointmentId || null, channel: 'WHATSAPP',
        recipient: patient.phone, template: tpl, direction: 'PATIENT',
        status: 'SENT', payload: r || undefined
      });
      delivery.whatsapp = 'sent';
    } catch (e) {
      logger.error(`WA certificate PDF failed for ${certificate.id}: ${e.message}`);
      await logNotification({
        appointmentId: certificate.appointmentId || null, channel: 'WHATSAPP',
        recipient: patient.phone, template: tpl, direction: 'PATIENT',
        status: 'FAILED',
        errorMessage: `${e.message}${e.code ? ` (code=${e.code})` : ''}`
      });
      delivery.whatsapp = 'failed';
      delivery.whatsappError = e.message;
    }
  }

  return delivery;
}

// ═════════════════════════════════════════════════════════════════
// 7. 30-MINUTE REMINDERS — FIX (B)(C)
//    All four reminder templates now receive EXACTLY the right number
//    of body params. Previously the patient reminders received 5 into
//    a 4-var template (132000) and the doctor online reminder received
//    4 into a 3-var template (132000).
// ═════════════════════════════════════════════════════════════════
async function processReminders() {
  const todayStr   = getTodayDateString();
  const nowMinutes = getCurrentTimeMinutes();

  // Bug fix — `Appointment.date` is a Prisma `@db.Date`, which Prisma
  // normalises to midnight (00:00:00.000Z). The previous query compared
  // against a NOON (`T12:00:00.000Z`) Date, so the equality filter never
  // matched any row and NO 30-minute appointment reminders were ever
  // sent. `parseDateOnly` returns the correct midnight-UTC boundary.
  const today = parseDateOnly(todayStr);

  const appts = await prisma.appointment.findMany({
    where: { date: today, status: 'CONFIRMED' },
    include: { doctor: true, patient: true }
  });

  for (const a of appts) {
    const startMinutes = timeToMinutes(a.startTime);
    const delta = startMinutes - nowMinutes;
    // FIX (audit finding #7): the old window was delta ∈ [28,33] — five
    // one-minute ticks. The cron runs every 5 min, so any tick that ran
    // even slightly late (or an appointment booked inside the window)
    // fell through the gap and the patient never got a reminder. The
    // window is now [15,45] minutes: every CONFIRMED appointment crosses
    // it for ~30 minutes (≈6 consecutive ticks), and the atomic claim
    // below guarantees exactly one send. Env-tunable without a redeploy.
    const winMin = parseInt(process.env.REMINDER_WINDOW_MIN_MINUTES || '15', 10);
    const winMax = parseInt(process.env.REMINDER_WINDOW_MAX_MINUTES || '45', 10);
    if (delta < winMin || delta > winMax) continue;

    // FIX (audit finding #6): the old dedup was read-then-write (TOCTOU):
    // two overlapping cron ticks could both see "no SENT log" and both
    // send. We now atomically CLAIM the reminder by inserting a SENT
    // marker row keyed to this appointment+template-group BEFORE sending.
    // The create relies on the @@unique([appointmentId, template, channel,
    // direction]) constraint below; the loser gets P2002 and skips. If
    // the actual send then throws, safeWa logs a FAILED row but the claim
    // stands — a missed reminder is recoverable manually, a duplicate
    // spam to a patient is not.
    // The claim is a single non-null `claimKey` (unique-indexed) so the
    // dedup works on MySQL, where NULLs in a composite unique key are
    // treated as distinct and would NOT have prevented the double-send.
    const claimKey = `reminder_claim_${a.id}_${a.consultationType}`;
    try {
      await prisma.notificationLog.create({
        data: {
          claimKey,
          appointmentId: a.id,
          channel: 'WHATSAPP',
          recipient: a.patient.phone,
          template: `__reminder_claim__${a.consultationType}`,
          direction: 'PATIENT',
          status: 'SENT'
        }
      });
    } catch (e) {
      if (e && e.code === 'P2002') continue;  // already claimed by another tick
      throw e;
    }

    const isOnline = a.consultationType === 'ONLINE';

    let meetLink = a.meetLink;
    let meetEventId = a.meetEventId;
    if (isOnline && !meetLink) {
      try {
        const { startISO, endISO } = buildIsoRange(a);
        const res = await meet.createMeetLink({
          summary: `NeoKidsPro Consultation - ${a.patient.name}`,
          description: `Online consultation with Dr. ${a.doctor.name}\nReason: ${a.primaryProblem}`,
          startISO, endISO,
          doctorEmail: a.doctor.email,
          patientEmail: a.patient.email
        });
        meetLink = res.meetLink;
        meetEventId = res.eventId || null;
        await prisma.appointment.update({ where: { id: a.id }, data: { meetLink, meetEventId } });
      } catch (e) {
        logger.warn(`Reminder: skipping ${a.id} — no meet link and regeneration failed`);
        continue;
      }
    }

    const meetSuffix = getMeetUrlSuffix(meetLink);
    const dirSuffix  = getDirectionsUrlSuffix(a.doctor);
    const typeLabel  = isOnline ? 'Online Consultation' : 'In-Clinic Visit';

    if (isOnline) {
      // Meta template neokids_reminder_online_v2: 4 body, 1 URL btn (Meet)
      //   {{1}} Patient  {{2}} Doctor  {{3}} Time  {{4}} Type
      await safeWa({
        appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
        templateName: 'neokids_reminder_online_v2',
        bodyParams: [a.patient.name, a.doctor.name, fmtTime(a.startTime), typeLabel],
        urlButtonParam: meetSuffix
      });
    } else {
      // Meta template neokids_reminder_offline_v2: 4 body, 1 URL btn (Maps)
      //   {{1}} Patient  {{2}} Doctor  {{3}} Time  {{4}} Type
      await safeWa({
        appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
        templateName: 'neokids_reminder_offline_v2',
        bodyParams: [a.patient.name, a.doctor.name, fmtTime(a.startTime), typeLabel],
        urlButtonParam: dirSuffix
      });
    }

    if (a.doctor.phone) {
      if (isOnline) {
        // Meta template doctor_reminder_online: 3 body, 1 URL btn (Meet)
        //   {{1}} Doctor  {{2}} Patient  {{3}} Time
        await safeWa({
          appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
          templateName: 'doctor_reminder_online',
          bodyParams: [a.doctor.name, a.patient.name, fmtTime(a.startTime)],
          urlButtonParam: meetSuffix
        });
      } else {
        // Meta template doctor_reminder_offline: 3 body, 0 btn
        await safeWa({
          appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
          templateName: 'doctor_reminder_offline',
          bodyParams: [a.doctor.name, a.patient.name, fmtTime(a.startTime)]
        });
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════
// 8. FOLLOW-UP RECALLS (unchanged)
// ═════════════════════════════════════════════════════════════════
async function hasReachedTerminalAttemptState(appointmentId, template) {
  const MAX_FAILED = parseInt(process.env.FOLLOWUP_MAX_FAILED_RETRIES || '3', 10);
  const rows = await prisma.notificationLog.groupBy({
    by: ['status'],
    where: { appointmentId, template },
    _count: { status: true }
  });
  let sent = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    if (r.status === 'SENT')    sent    = r._count.status;
    if (r.status === 'SKIPPED') skipped = r._count.status;
    if (r.status === 'FAILED')  failed  = r._count.status;
  }
  if (sent > 0)             return { terminal: true, reason: 'already_sent' };
  if (skipped > 0)          return { terminal: true, reason: 'already_skipped' };
  if (failed >= MAX_FAILED) return { terminal: true, reason: 'max_failed_retries' };
  return { terminal: false, failedCount: failed };
}

async function processFollowUpRecalls() {
  if (process.env.FOLLOWUP_VERBOSE === 'true') {
    logger.info('Follow-up recall cron tick starting');
  }
  const todayStr     = getTodayDateString();
  const today        = new Date(`${todayStr}T00:00:00.000Z`);
  const tomorrow     = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const candidates = await prisma.prescription.findMany({
    where: { followUpDate: { in: [tomorrow, sevenDaysAgo] } },
    include: { appointment: { include: { patient: true, doctor: true } } }
  });
  if (!candidates.length) return 0;

  const PUBLIC_URL = (process.env.PUBLIC_BOOKING_URL || process.env.APP_URL ||
                     `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

  let sent = 0, suppressedRebook = 0, suppressedDedup = 0, skippedNoContact = 0;

  for (const rx of candidates) {
    try {
      const a = rx.appointment;
      if (!a || !a.patient) continue;

      const alreadyRebooked = await prisma.appointment.findFirst({
        where: {
          id: { not: a.id },
          patientId: a.patientId,
          doctorId: a.doctorId,
          createdAt: { gt: a.completedAt || a.createdAt },
          status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] }
        },
        select: { id: true }
      });
      if (alreadyRebooked) { suppressedRebook += 1; continue; }

      const followUpDay = new Date(rx.followUpDate);
      const kind = followUpDay.getTime() === tomorrow.getTime() ? 'PRE' : 'POST';
      const template = `neokids_followup_recall_${kind}`;

      const state = await hasReachedTerminalAttemptState(a.id, template);
      if (state.terminal) { suppressedDedup += 1; continue; }

      const bookingLink = `${PUBLIC_URL}/assets/booking-widget.html?doctor=${encodeURIComponent(a.doctorId)}&recall=${encodeURIComponent(rx.id)}`;
      const subject = kind === 'PRE'
        ? `Reminder: Dr. ${a.doctor.name} recommended a follow-up tomorrow`
        : `Follow-up due — please re-book with Dr. ${a.doctor.name}`;
      const parentName = escapeForHtml(a.patient.parentName || a.patient.name);
      const bodyHtml = kind === 'PRE'
        ? `<p>Dear ${parentName},</p>
           <p>Dr. <b>${escapeForHtml(a.doctor.name)}</b> recommended a follow-up for <b>${escapeForHtml(a.patient.name)}</b>
              on <b>${escapeForHtml(fmtDate(rx.followUpDate))}</b>.</p>
           <p>Please pick a convenient slot.</p>`
        : `<p>Dear ${parentName},</p>
           <p>We noticed that <b>${escapeForHtml(a.patient.name)}</b>'s follow-up with Dr. <b>${escapeForHtml(a.doctor.name)}</b>
              (recommended for ${escapeForHtml(fmtDate(rx.followUpDate))}) has not been booked yet.</p>
           <p>If symptoms persisted or you have any concerns, please book a slot below.</p>`;

      if (a.patient.email) {
        await safeEmail({
          appointmentId: a.id, recipient: a.patient.email, template, direction: 'PATIENT',
          messageFactory: () => email.sendEmail({
            to: a.patient.email,
            subject,
            html: renderBrandedEmail({
              preheader: subject,
              headline: kind === 'PRE' ? 'Follow-up Tomorrow' : 'Follow-up Due',
              subhead: `Dr. ${esc(a.doctor.name)} · ${esc(fmtDate(rx.followUpDate))}`,
              bodyHtml,
              ctas: [{ label: 'Book Follow-up', url: bookingLink }],
              footerNote: `If the button doesn't work, copy this link: <a href="${bookingLink}" style="color:#1E6FBF;word-break:break-all;">${esc(bookingLink)}</a>`
            })
          })
        });
        sent += 1;
      } else {
        await logNotification({
          appointmentId: a.id, channel: 'EMAIL', recipient: '(none)', template, direction: 'PATIENT',
          status: 'SKIPPED', errorMessage: 'No patient email on file — manual nudge required'
        });
        skippedNoContact += 1;
      }
    } catch (innerErr) {
      logger.error(`Follow-up recall failed for rx=${rx.id}`, innerErr);
    }
  }
  if (sent || suppressedRebook || suppressedDedup || skippedNoContact) {
    logger.info(
      `Follow-up recalls — sent=${sent} rebookSuppressed=${suppressedRebook} ` +
      `dedupSuppressed=${suppressedDedup} skippedNoContact=${skippedNoContact}`
    );
  }
  return sent;
}

// Kept as an alias — call sites below were written against this name.
// Both point at the exact same escaper now (single source of truth in
// email-brand.service.js), so there is no behavior difference.
const escapeForHtml = esc;

module.exports = {
  onPhysicalBookingConfirmed,
  onOnlineBookingConfirmed,
  onAppointmentRescheduled,
  onAppointmentCancelled,
  onPrescriptionCreated,
  deliverPrescription,
  onCertificateIssued,
  processReminders,
  processFollowUpRecalls
};