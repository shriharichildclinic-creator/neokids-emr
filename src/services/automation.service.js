const prisma  = require('../config/prisma');
const logger  = require('../utils/logger');
const whatsapp = require('./whatsapp.service');
const email    = require('./email.service');
const pdf      = require('./pdf.service');
const meet     = require('./googleMeet.service');
const { formatDateOnly, getTodayDateString, getCurrentTimeMinutes } = require('../utils/date');
const { timeToMinutes } = require('./slot.service');
const { incrementDoctorRevenue } = require('./lifecycle.service');

// ─────────── helpers ───────────
function fmtDate(d) { return formatDateOnly(d); }
function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

function getClinicNameForBody(doctor) {
  return doctor.clinicName || 'NeoKidsPro Clinic';
}

function getDirectionsUrlSuffix(doctor) {
  if (doctor.clinicMapUrl) {
    const m = doctor.clinicMapUrl.match(/maps\.google\.com\/(?:maps\/search\/)?(.*)$/);
    if (m) return m[1] || encodeURIComponent(doctor.clinicName || 'NeoKidsPro Clinic');
    return doctor.clinicMapUrl.replace(/^\/+/, '');
  }
  const query = [doctor.clinicName, doctor.clinicAddress].filter(Boolean).join(' ');
  return query ? encodeURIComponent(query) : encodeURIComponent('NeoKidsPro Clinic');
}

function getMeetUrlSuffix(meetLink) {
  if (!meetLink) return 'new';
  const m = meetLink.match(/meet\.google\.com\/(.+)$/);
  return m ? m[1] : meetLink;
}

function getMeetCodeForBody(meetLink) {
  if (!meetLink) return 'pending';
  const m = meetLink.match(/meet\.google\.com\/(.+)$/);
  return m ? m[1] : meetLink;
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
    await logNotification({ appointmentId, channel: 'WHATSAPP', recipient: to, template: templateName, direction, status: 'FAILED', errorMessage: e.message });
  }
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

// Build the start/end ISO strings used when (re)creating a Meet event.
function buildIsoRange(a) {
  const dateStr = new Date(a.date).toISOString().slice(0, 10);
  return {
    startISO: `${dateStr}T${a.startTime}:00+05:30`,
    endISO:   `${dateStr}T${a.endTime}:00+05:30`
  };
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
  // WhatsApp welcome intentionally still disabled until template+domain ready.
}

// ═════════════════════════════════════════════════════════════════
// 2. PATIENT BOOKS OFFLINE
// ═════════════════════════════════════════════════════════════════
async function onPhysicalBookingConfirmed(appointment) {
  const a = appointment;
  const clinic = getClinicNameForBody(a.doctor);
  const dirSuffix = getDirectionsUrlSuffix(a.doctor);

  await safeWa({
    appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
    templateName: 'neokids_booking_confirms_offline_v2',
    bodyParams: [
      clinic,
      a.patient.name,
      a.doctor.name,
      fmtDate(a.date),
      fmtTime(a.startTime),
      Number(a.feeAtBooking).toFixed(0)
    ],
    urlButtonParam: dirSuffix
  });

  if (a.doctor.phone) {
    await safeWa({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      templateName: 'doctor_new_booking_offline',
      bodyParams: [
        a.doctor.name,
        a.patient.name,
        fmtDate(a.date),
        fmtTime(a.startTime),
        a.primaryProblem.slice(0, 60)
      ]
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
// 3. PATIENT BOOKS ONLINE & PAYS
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
      // Bug 4 — DO NOT pass attendees. Calendar must not invite anyone.
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

  // — PATIENT —
  await safeWa({
    appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
    templateName: 'neokids_online_appt_confirm_v2',
    bodyParams: [
      a.patient.name,
      a.doctor.name,
      fmtDate(a.date),
      fmtTime(a.startTime),
      apptShort,
      Number(a.feeAtBooking).toFixed(0)
    ],
    urlButtonParam: meetSuffix
  });

  // — DOCTOR —
  if (a.doctor.phone) {
    await safeWa({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      templateName: 'doctor_new_booking_online',
      bodyParams: [
        a.doctor.name,
        a.patient.name,
        fmtDate(a.date),
        fmtTime(a.startTime),
        a.primaryProblem.slice(0, 60)
      ],
      urlButtonParam: meetSuffix
    });
  }

  // — PATIENT EMAIL with invoice attachment + Meet link —
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

  // — DOCTOR EMAIL —
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
// 4. APPOINTMENT RESCHEDULED
// ═════════════════════════════════════════════════════════════════
async function onAppointmentRescheduled(appointment) {
  const a = appointment;
  let meetLink    = a.meetLink;
  let meetEventId = a.meetEventId;

  if (a.consultationType === 'ONLINE') {
    // Bug 4 + Additional Issue 8 — delete the previous calendar event
    // before creating a fresh one, otherwise the admin's calendar fills
    // up with dead "RESCHEDULED" entries.
    if (meetEventId) {
      await meet.deleteMeetEvent(meetEventId).catch(e => logger.warn('Old meet delete failed', e.message));
    }
    try {
      const { startISO, endISO } = buildIsoRange(a);
      const res = await meet.createMeetLink({
        summary: `[RESCHEDULED] NeoKidsPro Consultation - ${a.patient.name}`,
        description: `Rescheduled consultation with Dr. ${a.doctor.name}`,
        startISO, endISO
        // Bug 4 — no attendees, no calendar invites.
      });
      meetLink    = res.meetLink;
      meetEventId = res.eventId || null;
      await prisma.appointment.update({ where: { id: a.id }, data: { meetLink, meetEventId } });
    } catch (e) { logger.error('Reschedule meet failed', e); }
  }

  const isOnline = a.consultationType === 'ONLINE';
  const reason   = a.rescheduleReason || 'Doctor unavailable';

  if (isOnline) {
    await safeWa({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      templateName: 'reschedule_online_v2',
      bodyParams: [
        getMeetCodeForBody(meetLink),
        a.patient.name,
        a.doctor.name,
        fmtDate(a.date),
        fmtTime(a.startTime),
        reason
      ],
      urlButtonParam: getMeetUrlSuffix(meetLink)
    });
  } else {
    await safeWa({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      templateName: 'reschedule_offline',
      bodyParams: [
        getClinicNameForBody(a.doctor),
        a.patient.name,
        a.doctor.name,
        fmtDate(a.date),
        fmtTime(a.startTime),
        reason
      ],
      urlButtonParam: getDirectionsUrlSuffix(a.doctor)
    });
  }

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

  // Additional Issue 8 — if the appointment had a Meet event, clean it up
  // from Google Calendar (with sendUpdates: 'none', so no email goes out).
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
    await safeWa({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      templateName: 'cancellation_notice',
      bodyParams: [a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime)]
    }).catch(() => null);
  }
}

// ═════════════════════════════════════════════════════════════════
// 6. PRESCRIPTION SAVED
// ═════════════════════════════════════════════════════════════════
async function onPrescriptionCreated(appointment, prescription) {
  const pdfRes = await pdf.generatePrescription(appointment, prescription);

  // Additional Issue 2 — only flip status AND credit revenue if the
  // appointment was not already COMPLETED. Re-saving a prescription on
  // an already-completed appointment must NOT double-credit the doctor.
  const wasAlreadyCompleted = appointment.status === 'COMPLETED';

  await prisma.appointment.update({
    where: { id: appointment.id },
    data: {
      prescriptionUrl: pdfRes.url,
      ...(wasAlreadyCompleted ? {} : { status: 'COMPLETED', completedAt: new Date() })
    }
  });

  if (!wasAlreadyCompleted) {
    await incrementDoctorRevenue(
      appointment.doctorId,
      appointment.feeAtBooking,
      appointment.paymentStatus
    );
  }

  // WhatsApp DISABLED until neokids_prescription_notify template is approved.

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

    // Additional Issue 11 — if this is an online appointment with no meetLink,
    // try to regenerate one. If that ALSO fails, skip the patient reminder
    // (we would otherwise send them a broken https://meet.google.com/pending).
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

    const meetCode    = getMeetCodeForBody(meetLink);
    const meetSuffix  = getMeetUrlSuffix(meetLink);
    const dirSuffix   = getDirectionsUrlSuffix(a.doctor);
    const clinic      = getClinicNameForBody(a.doctor);
    const typeLabel   = isOnline ? 'Online' : 'In-Clinic';

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
// 8. FOLLOW-UP RECALLS  (Bug 3 — Soft Recall workflow)
// ─────────────────────────────────────────────────────────────────
// Daily-ish job. Finds prescriptions whose followUpDate is TOMORROW
// or T+7 days after, and sends ONE reminder per (prescriptionId, kind)
// to the patient with a pre-filled booking link.
//
//   - Does NOT auto-create an appointment.
//   - Does NOT consume a doctor slot.
//   - Patient self-books via the prefill link.
//
// Idempotency: NotificationLog with template='neokids_followup_recall'
// and a kind suffix is checked before sending. The job is safe to run
// every 5 minutes — at most one email per recall.
// ═════════════════════════════════════════════════════════════════
/**
 * Bug 1 fix — Strict idempotency for follow-up recalls.
 *
 * A reminder is considered "terminal" (must not be retried) when ANY of:
 *   - a SENT log row exists for (appointmentId, template)
 *   - a SKIPPED log row exists for (appointmentId, template)
 *   - the number of FAILED log rows for (appointmentId, template) has
 *     reached FOLLOWUP_MAX_FAILED_RETRIES (default 3).
 *
 * This single helper replaces the previous SENT-only check that caused
 * SKIPPED rows to spam every cron tick (issues #2, #3) and FAILED rows
 * to resend indefinitely (issue #1).
 */
async function hasReachedTerminalAttemptState(appointmentId, template) {
  const MAX_FAILED = parseInt(process.env.FOLLOWUP_MAX_FAILED_RETRIES || '3', 10);

  // One round-trip: group by status for this (appointmentId, template).
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

  if (sent > 0)                return { terminal: true, reason: 'already_sent' };
  if (skipped > 0)             return { terminal: true, reason: 'already_skipped' };
  if (failed >= MAX_FAILED)    return { terminal: true, reason: 'max_failed_retries' };
  return { terminal: false, failedCount: failed };
}

async function processFollowUpRecalls() {
  // Bug 1 fix — promote console.log → logger.debug, gate on env flag.
  if (process.env.FOLLOWUP_VERBOSE === 'true') {
    logger.info('Follow-up recall cron tick starting');
  }

  const todayStr     = getTodayDateString();
  const today        = new Date(`${todayStr}T00:00:00.000Z`);
  const tomorrow     = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const candidates = await prisma.prescription.findMany({
    where: {
      followUpDate: { in: [tomorrow, sevenDaysAgo] }
    },
    include: {
      appointment: {
        include: { patient: true, doctor: true }
      }
    }
  });

  if (!candidates.length) return 0;

  const PUBLIC_URL = (process.env.PUBLIC_BOOKING_URL
                   || process.env.APP_URL
                   || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

  let sent = 0;
  let suppressedRebook = 0;
  let suppressedDedup = 0;
  let skippedNoContact = 0;

  for (const rx of candidates) {
    // Bug 1 fix — never let one bad row kill the whole batch.
    try {
      const a = rx.appointment;
      if (!a || !a.patient) continue;

      // Bug 1 fix (Flaw C) — explicitly exclude the appointment being processed
      // and exclude EXPIRED for defensive correctness.
      const alreadyRebooked = await prisma.appointment.findFirst({
        where: {
          id:        { not: a.id },
          patientId: a.patientId,
          doctorId:  a.doctorId,
          createdAt: { gt: a.completedAt || a.createdAt },
          status:    { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] }
        },
        select: { id: true }
      });
      if (alreadyRebooked) { suppressedRebook += 1; continue; }

      const followUpDay = new Date(rx.followUpDate);
      const kind = followUpDay.getTime() === tomorrow.getTime() ? 'PRE' : 'POST';
      const template = `neokids_followup_recall_${kind}`;

      // Bug 1 fix (Flaw A) — strict idempotency: SENT or SKIPPED is terminal,
      // FAILED is retried at most FOLLOWUP_MAX_FAILED_RETRIES times.
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
          appointmentId: a.id,
          recipient: a.patient.email,
          template,
          direction: 'PATIENT',
          messageFactory: () => email.sendEmail({
            to: a.patient.email,
            subject,
            html: bodyHtml
          })
        });
        sent += 1;
      } else {
        // Bug 1 fix (Flaw B) — log SKIPPED exactly ONCE. Because dedup now
        // treats SKIPPED as terminal, this row will never be re-written.
        await logNotification({
          appointmentId: a.id,
          channel: 'EMAIL',
          recipient: '(none)',
          template,
          direction: 'PATIENT',
          status: 'SKIPPED',
          errorMessage: 'No patient email on file — manual nudge required'
        });
        skippedNoContact += 1;
      }
    } catch (innerErr) {
      logger.error(`Follow-up recall failed for rx=${rx.id}`, innerErr);
      // continue to next prescription — never abort the batch
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


// Small local helper — we don't want to add a runtime dep just for HTML escaping.
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
  processReminders,
  processFollowUpRecalls          // Bug 3
};

