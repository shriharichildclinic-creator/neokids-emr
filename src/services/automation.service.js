// =====================================================================
// automation.service.js — Bug 3 + Bug 4 hardened version
// =====================================================================
// Bug 3: onPrescriptionCreated now returns the PDF result so the controller
//        can echo pdfUrl/filename to the doctor UI. New resendPrescription()
//        exported for the manual re-send button.
// Bug 4: onAppointmentRescheduled now uses sendWhatsAppWithFallback() —
//        primary template names are env-configurable, with an automatic
//        fallback to the booking-confirmation template (which we KNOW is
//        approved), and finally a plain-text fallback. Doctor also gets a
//        WhatsApp notification (was previously silent).
// =====================================================================
const prisma  = require('../config/prisma');
const logger  = require('../utils/logger');
const whatsapp = require('./whatsapp.service');
const email    = require('./email.service');
const pdf      = require('./pdf.service');
const meet     = require('./googleMeet.service');
const { formatDateOnly, getTodayDateString, getCurrentTimeMinutes } = require('../utils/date');
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
function getDirectionsUrlSuffix(doctor) {
  if (doctor.clinicMapUrl) {
    const m = doctor.clinicMapUrl.match(/maps\.google\.com\/(?:maps\/search\/)?(.*)$/);
    if (m) return m[1] || encodeURIComponent(doctor.clinicName || 'NeoKidsPro Clinic');
    return doctor.clinicMapUrl.replace(/^\/+/, '');
  }
  const q = [doctor.clinicName, doctor.clinicAddress].filter(Boolean).join(' ');
  return q ? encodeURIComponent(q) : encodeURIComponent('NeoKidsPro Clinic');
}
function getMeetUrlSuffix(link) {
  if (!link) return 'new';
  const m = link.match(/meet\.google\.com\/(.+)$/);
  return m ? m[1] : link;
}
function getMeetCodeForBody(link) {
  if (!link) return 'pending';
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
 * Bug 4 — send with fallback. Tries primary template, then optional fallback,
 * then optional plain text. Logs the WINNING attempt as SENT and any failed
 * attempts as FAILED (so doctors can see in the audit trail what actually
 * went out).
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
    // If we ended up on fallback/text, log the primary's failure for transparency.
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
// 2. PHYSICAL BOOKING CONFIRMED
// ═════════════════════════════════════════════════════════════════
async function onPhysicalBookingConfirmed(appointment) {
  const a = appointment;
  const clinic = getClinicNameForBody(a.doctor);
  const dirSuffix = getDirectionsUrlSuffix(a.doctor);

  await safeWa({
    appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
    templateName: 'neokids_booking_confirms_offline_v2',
    bodyParams: [clinic, a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime), Number(a.feeAtBooking).toFixed(0)],
    urlButtonParam: dirSuffix
  });

  if (a.doctor.phone) {
    await safeWa({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      templateName: 'doctor_new_booking_offline',
      bodyParams: [a.doctor.name, a.patient.name, fmtDate(a.date), fmtTime(a.startTime), a.primaryProblem.slice(0, 60)]
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
// 3. ONLINE BOOKING CONFIRMED (PAID)
// ═════════════════════════════════════════════════════════════════
async function onOnlineBookingConfirmed(appointment) {
  const a = appointment;
  let meetLink   = a.meetLink || null;
  let meetEventId = a.meetEventId || null;
  let invoiceUrl = a.invoiceUrl || null;
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

  await prisma.appointment.update({
    where: { id: a.id },
    data: { meetLink, meetEventId, invoiceUrl }
  });

  const meetSuffix = getMeetUrlSuffix(meetLink);
  const apptShort  = a.id.slice(0, 8).toUpperCase();

  await safeWa({
    appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
    templateName: 'neokids_online_appt_confirm_v2',
    bodyParams: [a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime), apptShort, Number(a.feeAtBooking).toFixed(0)],
    urlButtonParam: meetSuffix
  });

  if (a.doctor.phone) {
    await safeWa({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      templateName: 'doctor_new_booking_online',
      bodyParams: [a.doctor.name, a.patient.name, fmtDate(a.date), fmtTime(a.startTime), a.primaryProblem.slice(0, 60)],
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
    await safeEmail({
      appointmentId: a.id, recipient: a.doctor.email, template: 'ONLINE_CONFIRMED_DOCTOR', direction: 'DOCTOR',
      messageFactory: () => email.sendEmail({
        to: a.doctor.email,
        subject: `New online consultation: ${a.patient.name} on ${fmtDate(a.date)}`,
        html: `<h2>New Online Booking</h2>
               <p>Dr. ${a.doctor.name}, a paid online consultation has been booked.</p>
               <ul>
                 <li>Patient: ${a.patient.name} (+91 ${a.patient.phone})</li>
                 <li>Date: ${fmtDate(a.date)} ${fmtTime(a.startTime)}</li>
                 <li>Problem: ${a.primaryProblem}</li>
                 ${meetLink ? `<li><a href="${meetLink}">Join Meeting</a></li>` : ''}
               </ul>`
      })
    });
  }
}

// ═════════════════════════════════════════════════════════════════
// 4. APPOINTMENT RESCHEDULED  — Bug 4 fix
// ═════════════════════════════════════════════════════════════════
async function onAppointmentRescheduled(appointment) {
  const a = appointment;
  let meetLink    = a.meetLink;
  let meetEventId = a.meetEventId;

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
  const reason   = a.rescheduleReason || 'Doctor unavailable';

  // ── Env-driven template names with sensible defaults ──
  // Why: in the original code the rescheduler used template names that were
  // never registered with Meta (no "neokids_" prefix), so Meta returned
  // code 132001 "template does not exist" and the WhatsApp went silent
  // while the email path still ran. Now:
  //   1. We try the env-configured template (or the "neokids_*" default).
  //   2. We fall back to the corresponding booking-confirm template — known
  //      to be approved — re-using its body slots.
  //   3. Final fallback: plain text (works inside the 24h customer-care
  //      window after the patient last messaged us).
  const tplOnlinePrimary   = process.env.WA_TPL_RESCHEDULE_ONLINE   || 'neokids_reschedule_online_v2';
  const tplOnlineFallback  = process.env.WA_TPL_RESCHEDULE_ONLINE_FALLBACK  || 'neokids_online_appt_confirm_v2';
  const tplOfflinePrimary  = process.env.WA_TPL_RESCHEDULE_OFFLINE  || 'neokids_reschedule_offline';
  const tplOfflineFallback = process.env.WA_TPL_RESCHEDULE_OFFLINE_FALLBACK || 'neokids_booking_confirms_offline_v2';

  // ── PATIENT WhatsApp ──
  if (isOnline) {
    const apptShort = a.id.slice(0, 8).toUpperCase();
    await safeWaWithFallback({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      primaryTemplate:  tplOnlinePrimary,
      fallbackTemplate: tplOnlineFallback,
      bodyParams: [
        // For primary (reschedule template) — keep [meetCode, name, doctor, date, time, reason]
        // For fallback (online_appt_confirm_v2) — slot count matches:
        //   [patient, doctor, date, time, apptShort, fee] — we pass the same
        //   positional list because the FALLBACK template re-confirms the new
        //   booking. We choose params that read sensibly under EITHER template.
        a.patient.name,
        a.doctor.name,
        fmtDate(a.date),
        fmtTime(a.startTime),
        apptShort,
        Number(a.feeAtBooking || 0).toFixed(0)
      ],
      urlButtonParam: getMeetUrlSuffix(meetLink),
      plainTextFallback:
        `Hello ${a.patient.name}, your online consultation with Dr. ${a.doctor.name} has been rescheduled to ` +
        `${fmtDate(a.date)} at ${fmtTime(a.startTime)}. Reason: ${reason}. ` +
        (meetLink ? `Join: ${meetLink}` : '') + ' — NeoKidsPro'
    });
  } else {
    await safeWaWithFallback({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      primaryTemplate:  tplOfflinePrimary,
      fallbackTemplate: tplOfflineFallback,
      bodyParams: [
        getClinicNameForBody(a.doctor),
        a.patient.name,
        a.doctor.name,
        fmtDate(a.date),
        fmtTime(a.startTime),
        Number(a.feeAtBooking || 0).toFixed(0)
      ],
      urlButtonParam: getDirectionsUrlSuffix(a.doctor),
      plainTextFallback:
        `Hello ${a.patient.name}, your in-clinic visit with Dr. ${a.doctor.name} has been rescheduled to ` +
        `${fmtDate(a.date)} at ${fmtTime(a.startTime)}. Reason: ${reason}. — NeoKidsPro`
    });
  }

  // ── DOCTOR WhatsApp (Bug 4 — was silent before) ──
  if (a.doctor.phone) {
    const docTplPrimary  = process.env.WA_TPL_RESCHEDULE_DOCTOR
      || (isOnline ? 'doctor_new_booking_online' : 'doctor_new_booking_offline');
    await safeWaWithFallback({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      primaryTemplate:  docTplPrimary,
      fallbackTemplate: null,
      bodyParams: [a.doctor.name, a.patient.name, fmtDate(a.date), fmtTime(a.startTime), `Rescheduled: ${reason}`.slice(0, 60)],
      urlButtonParam: isOnline ? getMeetUrlSuffix(meetLink) : getDirectionsUrlSuffix(a.doctor),
      plainTextFallback:
        `Dr. ${a.doctor.name}, the appointment with ${a.patient.name} has been rescheduled to ` +
        `${fmtDate(a.date)} ${fmtTime(a.startTime)}. Reason: ${reason}. — NeoKidsPro`
    });
  }

  // ── Emails (unchanged) ──
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
               <p>Reason: ${reason}</p>
               ${meetLink && isOnline ? `<p>New Meet link: <a href="${meetLink}">${meetLink}</a></p>` : ''}`
      })
    });
  }
  if (a.doctor.email) {
    await safeEmail({
      appointmentId: a.id, recipient: a.doctor.email, template: 'RESCHEDULED_DOCTOR', direction: 'DOCTOR',
      messageFactory: () => email.sendEmail({
        to: a.doctor.email,
        subject: `Rescheduled: ${a.patient.name} → ${fmtDate(a.date)} ${fmtTime(a.startTime)}`,
        html: `<p>Dr. ${a.doctor.name}, the following appointment was rescheduled:</p>
               <ul><li>Patient: ${a.patient.name}</li>
                   <li>New date/time: ${fmtDate(a.date)} ${fmtTime(a.startTime)}</li>
                   <li>Reason: ${reason}</li></ul>`
      })
    });
  }
}

// ═════════════════════════════════════════════════════════════════
// 5. APPOINTMENT CANCELLED
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
               ${reason ? `<p>Reason: ${reason}</p>` : ''}`
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
    await safeWaWithFallback({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      primaryTemplate: process.env.WA_TPL_CANCELLATION || 'cancellation_notice',
      fallbackTemplate: null,
      bodyParams: [a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime)],
      plainTextFallback:
        `Hello ${a.patient.name}, your appointment with Dr. ${a.doctor.name} on ` +
        `${fmtDate(a.date)} ${fmtTime(a.startTime)} has been cancelled.` +
        (reason ? ` Reason: ${reason}.` : '') + ' — NeoKidsPro'
    }).catch(() => null);
  }
}

// ═════════════════════════════════════════════════════════════════
// 6. PRESCRIPTION SAVED  — Bug 3
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
  return pdfRes;
}

/**
 * Bug 3 — explicit "Resend prescription" entry point used by the doctor UI.
 * Does NOT regenerate revenue, does NOT change status, just re-emails.
 */
async function resendPrescription(appointment, prescription) {
  if (!appointment.patient.email) throw new Error('Patient has no email on file');

  // Make sure the PDF file actually exists; regenerate quietly if missing.
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

  return pdfRes;
}

// ═════════════════════════════════════════════════════════════════
// 7. 30-MINUTE REMINDERS
// ═════════════════════════════════════════════════════════════════
async function processReminders() {
  const todayStr   = getTodayDateString();
  const today      = new Date(`${todayStr}T12:00:00.000Z`);
  const nowMinutes = getCurrentTimeMinutes();

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

    const meetCode   = getMeetCodeForBody(meetLink);
    const meetSuffix = getMeetUrlSuffix(meetLink);
    const dirSuffix  = getDirectionsUrlSuffix(a.doctor);
    const clinic     = getClinicNameForBody(a.doctor);
    const typeLabel  = isOnline ? 'Online' : 'In-Clinic';

    if (isOnline) {
      await safeWa({
        appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
        templateName: 'neokids_reminder_online_v2',
        bodyParams: [meetCode, a.patient.name, a.doctor.name, fmtTime(a.startTime), typeLabel],
        urlButtonParam: meetSuffix
      });
    } else {
      await safeWa({
        appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
        templateName: 'neokids_reminder_offline_v2',
        bodyParams: [clinic, a.patient.name, a.doctor.name, fmtTime(a.startTime), typeLabel],
        urlButtonParam: dirSuffix
      });
    }

    if (a.doctor.phone) {
      if (isOnline) {
        await safeWa({
          appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
          templateName: 'doctor_reminder_online',
          bodyParams: [meetCode, a.doctor.name, a.patient.name, fmtTime(a.startTime)],
          urlButtonParam: meetSuffix
        });
      } else {
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
// 8. FOLLOW-UP RECALLS (unchanged from previous fix)
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
  resendPrescription,         // Bug 3
  processReminders,
  processFollowUpRecalls
};
