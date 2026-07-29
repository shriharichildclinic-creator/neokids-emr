// =====================================================================
// automation.service.js — FORENSIC FIX v3 (2026-06)
// =====================================================================
// All template names and bodyParams are now exactly matched against the
// Meta WhatsApp template inventory ("Whtasapp Templates (1).pdf"):
//
//   #1  reschedule_online_v2                  — 5 body, 1 URL btn   (Meet)
//   #2  neokids_reminder_online_v2            — 4 body, 1 URL btn   (Meet)
//   #3  neokids_reminder_offline_v2           — 4 body, 1 URL btn   (Maps)
//   #4  neokids_booking_confirms_offline_v2   — 5 body, 1 URL btn   (Maps)
//   #5  reschedule_offline                    — 5 body, 1 URL btn   (Maps)
//   #6  cancellation_notice                   — 4 body, 0 btn
//   #7  doctor_new_booking_offline            — 5 body, 0 btn
//   #8  doctor_new_booking_online_v2             — 5 body, 1 URL btn   (Meet)
//   #9  doctor_reminder_offline               — 3 body, 0 btn
//   #10 neokids_online_appt_confirm_v2        — 6 body, 1 URL btn   (Meet)
//   #11 doctor_reminder_online                — 3 body, 1 URL btn   (Meet)
//
// CRITICAL BUG FIXES vs previous version
// ──────────────────────────────────────
//  A) onPhysicalBookingConfirmed was sending 6 body params (clinic +
//     patient + doctor + date + time + fee) into a Meta template that
//     defines exactly 5 — Meta rejected every send with code 132000
//     "Number of parameters does not match the expected number of params"
//     and patients silently never got the WhatsApp confirmation.
//     Fix: drop the leading `clinic` param. The directions-URL still
//     carries the clinic in the button suffix.
//
//  B) processReminders was sending 5 params into the 4-param reminder
//     templates (leading meetCode/clinic), 132000 again. Fix: drop the
//     leading extra param. The Meet/Maps code stays in the URL button
//     param, which is exactly what the template defines.
//
//  C) processReminders for doctor_reminder_online was sending 4 params
//     into a 3-param template. Fix: drop the leading meetCode param.
//
//  D) onAppointmentRescheduled used template names with a `neokids_`
//     prefix (`neokids_reschedule_online_v2`, `neokids_reschedule_offline`)
//     that do NOT exist in Meta. Real Meta names are `reschedule_online_v2`
//     and `reschedule_offline`. Meta returned 132001 "Template name does
//     not exist in the translation". The old fallback chain then routed
//     the reschedule to the BOOKING-CONFIRM template, which is why the
//     patient received a "new booking" message after a reschedule.
//     Fix:
//       • Default primary templates now exactly match Meta.
//       • Removed booking-confirm templates from the fallback chain.
//         Booking-confirm and reschedule have DIFFERENT body shapes,
//         and re-using booking-confirm misled the patient into thinking
//         a brand new booking was created. The chain is now:
//             primary template  →  plain text (no booking re-confirm)
//         If even the plain text fails (outside 24h window), we log it,
//         and the email path still runs as a guaranteed second channel.
//       • bodyParams are now exactly 5 in template order:
//             [Patient, Doctor, NewDate, NewTime, Reason]
//         which matches both reschedule_online_v2 and reschedule_offline.
//
//  E) Doctor reschedule notification used to fall back to the doctor
//     NEW-booking templates (doctor_new_booking_*), which made the
//     doctor see a "new booking" message after a reschedule. Removed.
//     There is no Meta-approved doctor-reschedule template yet, so we
//     send a plain-text WhatsApp inside the 24h window (which is the
//     normal state for an active doctor) plus the existing email.
//
//  F) Reschedule email to doctor previously did NOT contain the new
//     Meet link. Fix: include the regenerated Meet link.
//
//  G) Cancellation template (`cancellation_notice`) has 4 body vars by
//     design (Patient, Doctor, Date, Time) — no reason placeholder. The
//     CODE side is correct. The REASON cannot fit into v1 of this Meta
//     template; we now ALSO send the reason via plain-text fallback (it
//     runs inside the 24h customer-care window after the template
//     send) so the patient always sees the reason. A v2 Meta template
//     `cancellation_notice_v2` with a 5th `{{5}}=Reason` placeholder
//     should be created and is documented in docs/META_TEMPLATE_FIXES.md.
//     Once created, set WA_TPL_CANCELLATION=cancellation_notice_v2 and
//     the code already passes `reason` as the 5th body param.
//
// REGRESSION IMPACT
// ─────────────────
//  • Offline booking flow: WhatsApp confirmations now succeed. No
//    other code path was depending on the spurious leading `clinic`
//    parameter. Email path unchanged.
//  • Online booking flow: unchanged (template was already 6/6).
//  • Reminders: param shape is now correct for all four reminder
//    templates. The dedup query at the top of processReminders still
//    keys on the same template list, so we still send at most one
//    reminder per appointment.
//  • Reschedule flow: patient now receives the RESCHEDULE template
//    (not a booking-confirm). Doctor now receives a reschedule plain
//    text (instead of a misleading new-booking). Email content for the
//    doctor now includes the new Meet link.
//  • Cancellation flow: patient still receives the 4-param Meta
//    template (so existing acceptance/legal flow is unaffected) PLUS
//    a plain-text reason. If you bump WA_TPL_CANCELLATION to v2 the
//    reason is delivered via template only.
// =====================================================================
const prisma   = require('../config/prisma');
const logger   = require('../utils/logger');
const whatsapp = require('./whatsapp.service');
const waMedia  = require('./whatsapp-media.service');   // NEW — WhatsApp PDF sharing
const email    = require('./email.service');
const pdf      = require('./pdf.service');
const meet     = require('./googleMeet.service');
const { formatDateOnly, getTodayDateString, getCurrentTimeMinutes, parseDateOnly } = require('../utils/date');
const { timeToMinutes } = require('./slot.service');
const { incrementDoctorRevenue } = require('./lifecycle.service');

// ─── helpers ───
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
 * Bug 2 fix — "Get Directions" button in neokids_booking_confirms_offline_v2.
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
 * IMPORTANT (Bug 4 / reschedule fix):
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
// 1. ADMIN CREATES DOCTOR
// ═════════════════════════════════════════════════════════════════
async function onDoctorCreated({ doctor, inviteLink }) {
  if (doctor.email) {
    await safeEmail({
      appointmentId: null, recipient: doctor.email, template: 'doctor_welcome_email', direction: 'DOCTOR',
      messageFactory: () => email.sendEmail({
        to: doctor.email,
        subject: 'Welcome to NeoKidsPro — set your password',
        html: `<h2>Welcome Dr. ${doctor.name}</h2>
               <p>Your NeoKidsPro EMR account has been created by the clinic admin.</p>
               <p><a href="${inviteLink}">Click here to set your password and log in</a></p>
               <p>This invite expires soon — please use it as soon as possible.</p>`
      })
    });
  }
}

// ═════════════════════════════════════════════════════════════════
// 2. PHYSICAL BOOKING CONFIRMED — FIX (A): 5 body params, not 6
// ═════════════════════════════════════════════════════════════════
async function onPhysicalBookingConfirmed(appointment) {
  const a = appointment;
  const dirSuffix = getDirectionsUrlSuffix(a.doctor);

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
        html: `<h2>Appointment Confirmed</h2>
               <p>Dear ${a.patient.name},</p>
               <p>Your in-clinic visit with <strong>Dr. ${a.doctor.name}</strong> is confirmed for
               <strong>${fmtDate(a.date)}</strong> at <strong>${fmtTime(a.startTime)}</strong>.</p>
               ${a.doctor.clinicName ? `<p><strong>Clinic:</strong> ${a.doctor.clinicName}</p>` : ''}
               ${a.doctor.clinicAddress ? `<p><strong>Address:</strong> ${a.doctor.clinicAddress}</p>` : ''}
               <p><a href="${mapLink}" style="display:inline-block;padding:10px 18px;background:#4DA8FF;color:#fff;border-radius:8px;text-decoration:none">📍 Get Directions</a></p>
               <p>Fee: ₹${Number(a.feeAtBooking).toFixed(2)} (payable at clinic)</p>`
      })
    });
  }

  if (a.doctor.email) {
    await safeEmail({
      appointmentId: a.id, recipient: a.doctor.email, template: 'PHYSICAL_CONFIRMED_DOCTOR', direction: 'DOCTOR',
      messageFactory: () => email.sendEmail({
        to: a.doctor.email,
        subject: `New in-clinic booking: ${a.patient.name} on ${fmtDate(a.date)}`,
        html: `<h2>New Booking</h2>
               <p>Dr. ${a.doctor.name},</p>
               <p><strong>${a.patient.name}</strong> has booked an in-clinic visit.</p>
               <ul>
                 <li>Date: ${fmtDate(a.date)} ${fmtTime(a.startTime)}</li>
                 <li>Phone: +91 ${a.patient.phone}</li>
                 <li>Problem: ${a.primaryProblem}</li>
               </ul>`
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
      startISO, endISO
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
        html: `<h2>Consultation Confirmed</h2>
               <p>Dear ${a.patient.name},</p>
               <p>Your online consultation with <strong>Dr. ${a.doctor.name}</strong> on
               <strong>${fmtDate(a.date)}</strong> at <strong>${fmtTime(a.startTime)}</strong> is confirmed.</p>
               ${meetLink ? `<p><a href="${meetLink}" style="display:inline-block;padding:10px 18px;background:#4DA8FF;color:#fff;border-radius:8px;text-decoration:none">🎥 Join Meeting</a></p>` : ''}
               <p>Invoice is attached.</p>`,
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
        html: `<h2>New Online Booking</h2>
               <p>Dr. ${a.doctor.name}, a paid online consultation has been booked.</p>
               <ul style="margin:0 0 14px 18px; padding:0;">
                 <li>Patient: ${a.patient.name} (+91 ${a.patient.phone})</li>
                 <li>Date: ${fmtDate(a.date)} ${fmtTime(a.startTime)}</li>
                 <li>Problem: ${a.primaryProblem}</li>
               </ul>
               ${meetLink ? `
                 <p style="margin:18px 0;">
                   <a href="${meetLink}"
                      style="display:inline-block;padding:10px 18px;background:#4DA8FF;color:#fff;border-radius:8px;text-decoration:none">
                     🎥 Join Consultation
                   </a>
                 </p>
                 <p style="font-size:.85rem;color:#666;">
                   If the button doesn’t work, open this link in your browser:<br>
                   <a href="${meetLink}" style="color:#4DA8FF;word-break:break-all;">${meetLink}</a>
                 </p>
               ` : ''}`
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
        startISO, endISO
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
        html: `<h2>Appointment Rescheduled</h2>
               <p>Dear ${a.patient.name},</p>
               <p>Your appointment with <strong>Dr. ${a.doctor.name}</strong> has been rescheduled to
               <strong>${fmtDate(a.date)}</strong> at <strong>${fmtTime(a.startTime)}</strong>.</p>
               <p><b>Reason:</b> ${reason}</p>
               ${meetLink && isOnline ? `<p><a href="${meetLink}" style="display:inline-block;padding:10px 18px;background:#4DA8FF;color:#fff;border-radius:8px;text-decoration:none">🎥 Join New Meet</a></p>
               <p style="font-size:.85rem;color:#666;">New Meet link: <a href="${meetLink}">${meetLink}</a></p>` : ''}`
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
        html: `<p>Dr. ${a.doctor.name}, the following appointment was rescheduled:</p>
               <ul>
                 <li><b>Patient:</b> ${a.patient.name}</li>
                 <li><b>New date/time:</b> ${fmtDate(a.date)} ${fmtTime(a.startTime)}</li>
                 <li><b>Reason:</b> ${reason}</li>
                 ${meetLink && isOnline ? `<li><b>New Meet link:</b> <a href="${meetLink}">${meetLink}</a></li>` : ''}
               </ul>
               ${meetLink && isOnline ? `<p><a href="${meetLink}" style="display:inline-block;padding:10px 18px;background:#4DA8FF;color:#fff;border-radius:8px;text-decoration:none">🎥 Open Meet</a></p>` : ''}`
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
        html: `<p>Dear ${a.patient.name}, your appointment with Dr. ${a.doctor.name} on ${fmtDate(a.date)} ${fmtTime(a.startTime)} has been cancelled.</p>
               ${reason ? `<p><b>Reason:</b> ${reason}</p>` : ''}`
      })
    });
  }
  if (a.doctor.email) {
    await safeEmail({
      appointmentId: a.id, recipient: a.doctor.email, template: 'CANCELLED_DOCTOR', direction: 'DOCTOR',
      messageFactory: () => email.sendEmail({
        to: a.doctor.email,
        subject: `Cancelled: ${a.patient.name} on ${fmtDate(a.date)}`,
        html: `<p>Dr. ${a.doctor.name}, the following appointment was cancelled:</p>
               <ul><li>Patient: ${a.patient.name}</li>
                   <li>${fmtDate(a.date)} ${fmtTime(a.startTime)}</li>
                   ${reason ? `<li>Reason: ${reason}</li>` : ''}</ul>`
      })
    });
  }
  if (a.patient.phone) {
    const cancelTpl = process.env.WA_TPL_CANCELLATION || 'cancellation_notice';

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
// 6. PRESCRIPTION SAVED  — unchanged (kept for completeness)
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

  if (appointment.patient.email) {
    await safeEmail({
      appointmentId: appointment.id, recipient: appointment.patient.email, template: 'PRESCRIPTION', direction: 'PATIENT',
      messageFactory: () => email.sendEmail({
        to: appointment.patient.email,
        subject: 'Your prescription from NeoKidsPro',
        html: `<h2>Your Prescription</h2>
               <p>Dear ${appointment.patient.name},</p>
               <p>Please find your prescription from Dr. ${appointment.doctor.name} attached.</p>`,
        attachments: [{ filename: pdfRes.filename, path: pdfRes.filepath }]
      })
    });
  }

  // ── NEW: WhatsApp Prescription PDF share (Meta Cloud API) ──
  // Preserves the existing email flow above. Runs after email so a
  // WhatsApp failure never blocks the email delivery.
  if (appointment.patient.phone) {
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
    } catch (e) {
      logger.error(`WA prescription PDF failed for ${appointment.id}: ${e.message}`);
      await logNotification({
        appointmentId: appointment.id, channel: 'WHATSAPP',
        recipient: appointment.patient.phone,
        template: process.env.WA_TPL_PRESCRIPTION_PDF || 'neokids_prescription_pdf',
        direction: 'PATIENT', status: 'FAILED',
        errorMessage: `${e.message}${e.code ? ` (code=${e.code})` : ''}`
      });
    }
  }

  return pdfRes;
}

async function resendPrescription(appointment, prescription) {
  if (!appointment.patient.email) throw new Error('Patient has no email on file');

  let pdfRes;
  try {
    pdfRes = await pdf.generatePrescription(appointment, prescription);
    if (!appointment.prescriptionUrl || appointment.prescriptionUrl !== pdfRes.url) {
      await prisma.appointment.update({ where: { id: appointment.id }, data: { prescriptionUrl: pdfRes.url } });
    }
  } catch (e) {
    logger.error('resendPrescription: PDF regen failed', e);
    throw e;
  }

  await safeEmail({
    appointmentId: appointment.id, recipient: appointment.patient.email,
    template: 'PRESCRIPTION_RESEND', direction: 'PATIENT',
    messageFactory: () => email.sendEmail({
      to: appointment.patient.email,
      subject: 'Your prescription from NeoKidsPro (resend)',
      html: `<h2>Your Prescription</h2>
             <p>Dear ${appointment.patient.name},</p>
             <p>As requested by Dr. ${appointment.doctor.name}, your prescription is attached again.</p>`,
      attachments: [{ filename: pdfRes.filename, path: pdfRes.filepath }]
    })
  });

  // ── NEW: re-share on WhatsApp as well ──
  if (appointment.patient.phone) {
    try {
      await waMedia.sendPrescriptionPdf({
        appointment, filepath: pdfRes.filepath, publicUrl: pdfRes.url
      });
      await logNotification({
        appointmentId: appointment.id, channel: 'WHATSAPP',
        recipient: appointment.patient.phone,
        template: (process.env.WA_TPL_PRESCRIPTION_PDF || 'neokids_prescription_pdf') + '__resend',
        direction: 'PATIENT', status: 'SENT'
      });
    } catch (e) {
      await logNotification({
        appointmentId: appointment.id, channel: 'WHATSAPP',
        recipient: appointment.patient.phone,
        template: (process.env.WA_TPL_PRESCRIPTION_PDF || 'neokids_prescription_pdf') + '__resend',
        direction: 'PATIENT', status: 'FAILED',
        errorMessage: `${e.message}${e.code ? ` (code=${e.code})` : ''}`
      });
    }
  }

  return pdfRes;
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
    if (delta < 28 || delta > 33) continue;

    const sent = await prisma.notificationLog.findFirst({
      where: {
        appointmentId: a.id,
        template: {
          in: [
            'neokids_reminder_online',  'neokids_reminder_offline',
            'neokids_reminder_online_v2','neokids_reminder_offline_v2',
            'doctor_reminder_online',   'doctor_reminder_offline'
          ]
        },
        status: 'SENT'
      }
    });
    if (sent) continue;

    const isOnline = a.consultationType === 'ONLINE';

    let meetLink = a.meetLink;
    let meetEventId = a.meetEventId;
    if (isOnline && !meetLink) {
      try {
        const { startISO, endISO } = buildIsoRange(a);
        const res = await meet.createMeetLink({
          summary: `NeoKidsPro Consultation - ${a.patient.name}`,
          description: `Online consultation with Dr. ${a.doctor.name}\nReason: ${a.primaryProblem}`,
          startISO, endISO
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
      const bodyHtml = kind === 'PRE'
        ? `<p>Dear ${escapeForHtml(a.patient.parentName || a.patient.name)},</p>
           <p>Dr. <b>${escapeForHtml(a.doctor.name)}</b> recommended a follow-up for <b>${escapeForHtml(a.patient.name)}</b>
              on <b>${fmtDate(rx.followUpDate)}</b>.</p>
           <p>Please pick a convenient slot:</p>
           <p><a href="${bookingLink}" style="background:#4DA8FF;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">Book follow-up</a></p>
           <p style="color:#888;font-size:12px;">If the button does not work, copy this link: ${bookingLink}</p>`
        : `<p>Dear ${escapeForHtml(a.patient.parentName || a.patient.name)},</p>
           <p>We noticed that <b>${escapeForHtml(a.patient.name)}</b>'s follow-up with Dr. <b>${escapeForHtml(a.doctor.name)}</b>
              (recommended for ${fmtDate(rx.followUpDate)}) has not been booked yet.</p>
           <p>If symptoms persisted or you have any concerns, please book a slot here:</p>
           <p><a href="${bookingLink}" style="background:#4DA8FF;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">Book follow-up</a></p>
           <p style="color:#888;font-size:12px;">If the button does not work, copy this link: ${bookingLink}</p>`;

      if (a.patient.email) {
        await safeEmail({
          appointmentId: a.id, recipient: a.patient.email, template, direction: 'PATIENT',
          messageFactory: () => email.sendEmail({ to: a.patient.email, subject, html: bodyHtml })
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

function escapeForHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

module.exports = {
  onDoctorCreated,
  onPhysicalBookingConfirmed,
  onOnlineBookingConfirmed,
  onAppointmentRescheduled,
  onAppointmentCancelled,
  onPrescriptionCreated,
  resendPrescription,
  processReminders,
  processFollowUpRecalls
};