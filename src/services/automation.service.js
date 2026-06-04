const prisma  = require('../config/prisma');
const logger  = require('../utils/logger');
const whatsapp = require('./whatsapp.service');
const email    = require('./email.service');
const pdf      = require('./pdf.service');
const meet     = require('./googleMeet.service');
const { formatDateOnly, getTodayDateString, getCurrentTimeMinutes } = require('../utils/date');
const { timeToMinutes } = require('./slot.service');

// ─────────── helpers ───────────
function fmtDate(d) { return formatDateOnly(d); }
function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

// Returns the dynamic suffix for the "Get Directions" URL button
// (Meta templates have base url "https://maps.google.com/" and accept {{1}})
function getDirectionsUrlSuffix(doctor) {
  if (doctor.clinicMapUrl) {
    // If admin pasted a full https://maps.google.com/... URL, extract everything after .com/
    const m = doctor.clinicMapUrl.match(/maps\.google\.com\/(.*)$/);
    if (m) return m[1];
    // If admin pasted only the suffix, use as-is
    return doctor.clinicMapUrl.replace(/^\/+/, '');
  }
  // Fallback — search by clinic name + address
  const query = [doctor.clinicName, doctor.clinicAddress].filter(Boolean).join(' ');
  return query ? `?q=${encodeURIComponent(query)}` : `?q=${encodeURIComponent('NeoKidsPro Clinic')}`;
}

// Returns the dynamic suffix for the "Join Meeting" URL button
// (Meta templates have base url "https://meet.google.com/" and accept {{1}})
function getMeetUrlSuffix(meetLink) {
  if (!meetLink) return 'new';
  const m = meetLink.match(/meet\.google\.com\/(.+)$/);
  return m ? m[1] : meetLink;
}

function getPrescriptionUrlSuffix(appointmentId) {
  return appointmentId.slice(0, 8); // template is https://neokidspro.com/pr{{1}}
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

// ═════════════════════════════════════════════════════════════════
// 1. ADMIN CREATES DOCTOR → welcome email + WhatsApp with invite link
// ═════════════════════════════════════════════════════════════════
async function onDoctorCreated({ doctor, inviteLink }) {
  // Email (was already sent by auth.controller.sendPasswordEmail in admin.controller; we add WA here)
  if (doctor.email) {
    await safeEmail({
      appointmentId: null, recipient: doctor.email, template: 'doctor_welcome', direction: 'DOCTOR',
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
  if (doctor.phone) {
    // doctor_welcome template body: "Welcome to NeoKidsPro, Dr. {{1}}! Your account has been created. Click the button below to set your password and start using the EMR."
    // button: URL dynamic https://neokidspro.in/{{1}} — pass token-bearing path as the dynamic suffix
    const suffix = inviteLink.replace(/^https?:\/\/[^/]+\/?/, ''); // everything after the host
    await safeWa({
      appointmentId: null, to: doctor.phone, direction: 'DOCTOR',
      templateName: 'doctor_welcome',
      bodyParams: [doctor.name],
      urlButtonParam: suffix
    });
  }
}

// ═════════════════════════════════════════════════════════════════
// 2. PATIENT BOOKS OFFLINE → patient + doctor confirmations
// ═════════════════════════════════════════════════════════════════
async function onPhysicalBookingConfirmed(appointment) {
  const a = appointment;
  const dirSuffix = getDirectionsUrlSuffix(a.doctor);

  // — PATIENT — template: neokids_booking_confirms_offline
  await safeWa({
    appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
    templateName: 'neokids_booking_confirms_offline',
    bodyParams: [a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime), Number(a.feeAtBooking).toFixed(0)],
    urlButtonParam: dirSuffix
  });

  // — DOCTOR — template: doctor_new_booking_offline
  if (a.doctor.phone) {
    await safeWa({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      templateName: 'doctor_new_booking_offline',
      bodyParams: [a.doctor.name, a.patient.name, fmtDate(a.date), fmtTime(a.startTime), a.primaryProblem.slice(0, 60)]
    });
  }

  // — PATIENT EMAIL —
  if (a.patient.email) {
    const mapLink = a.doctor.clinicMapUrl || `https://maps.google.com/${dirSuffix}`;
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

  // — DOCTOR EMAIL —
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
// 3. PATIENT BOOKS ONLINE & PAYS → meet link + invoice + 4 notifications
// ═════════════════════════════════════════════════════════════════
async function onOnlineBookingConfirmed(appointment) {
  const a = appointment;
  let meetLink = a.meetLink || null;
  let invoiceUrl = a.invoiceUrl || null;
  let invoiceFilepath = null;

  try {
    const meetRes = await meet.createMeetLink({
      summary: `NeoKidsPro Consultation - ${a.patient.name}`,
      description: `Online consultation with Dr. ${a.doctor.name}\nReason: ${a.primaryProblem}`,
      startISO: `${new Date(a.date).toISOString().slice(0, 10)}T${a.startTime}:00+05:30`,
      endISO:   `${new Date(a.date).toISOString().slice(0, 10)}T${a.endTime}:00+05:30`,
      attendees: [a.doctor.email, a.patient.email].filter(Boolean)
    });
    meetLink = meetRes.meetLink;
  } catch (e) { logger.error('Meet link generation failed', e); }

  try {
    const inv = await pdf.generateInvoice(a);
    invoiceUrl = inv.url;
    invoiceFilepath = inv.filepath;
  } catch (e) { logger.error('Invoice generation failed', e); }

  await prisma.appointment.update({ where: { id: a.id }, data: { meetLink, invoiceUrl } });
  // NOTE: revenue/consults increment is intentionally NOT here — Bug 9: counted only on actual completion

  const meetSuffix = getMeetUrlSuffix(meetLink);

  // — PATIENT WhatsApp — template: neokids_online_confirm
  await safeWa({
    appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
    templateName: 'neokids_online_confirm',
    bodyParams: [a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime), Number(a.feeAtBooking).toFixed(0)],
    urlButtonParam: meetSuffix
  });

  // — DOCTOR WhatsApp — template: doctor_new_booking_online
  if (a.doctor.phone) {
    await safeWa({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      templateName: 'doctor_new_booking_online',
      bodyParams: [a.doctor.name, a.patient.name, fmtDate(a.date), fmtTime(a.startTime), a.primaryProblem.slice(0, 60)],
      urlButtonParam: meetSuffix
    });
  }

  // — PATIENT EMAIL with Meet link + invoice attached —
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
        attachments: invoiceFilepath ? [{ filename: `invoice_${a.id.slice(0,8)}.pdf`, path: invoiceFilepath }] : []
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
// 4. APPOINTMENT RESCHEDULED → both sides
// ═════════════════════════════════════════════════════════════════
async function onAppointmentRescheduled(appointment) {
  const a = appointment;
  let meetLink = a.meetLink;

  if (a.consultationType === 'ONLINE') {
    try {
      const res = await meet.createMeetLink({
        summary: `[RESCHEDULED] NeoKidsPro Consultation - ${a.patient.name}`,
        description: `Rescheduled consultation with Dr. ${a.doctor.name}`,
        startISO: `${new Date(a.date).toISOString().slice(0, 10)}T${a.startTime}:00+05:30`,
        endISO:   `${new Date(a.date).toISOString().slice(0, 10)}T${a.endTime}:00+05:30`,
        attendees: [a.doctor.email, a.patient.email].filter(Boolean)
      });
      meetLink = res.meetLink;
      await prisma.appointment.update({ where: { id: a.id }, data: { meetLink } });
    } catch (e) { logger.error('Reschedule meet failed', e); }
  }

  const isOnline = a.consultationType === 'ONLINE';
  const reason = a.rescheduleReason || 'Doctor unavailable';

  // — PATIENT WA — template: reschedule_online (online) or reschedule_offline (offline)
  await safeWa({
    appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
    templateName: isOnline ? 'reschedule_online' : 'reschedule_offline',
    bodyParams: [a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime), reason],
    urlButtonParam: isOnline ? getMeetUrlSuffix(meetLink) : getDirectionsUrlSuffix(a.doctor)
  });

  // — DOCTOR WA — template: doctor_reschedule
  if (a.doctor.phone) {
    await safeWa({
      appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
      templateName: 'doctor_reschedule',
      bodyParams: [a.doctor.name, a.patient.name, fmtDate(a.date), fmtTime(a.startTime), reason]
    });
  }

  // — EMAILS —
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
// 5. APPOINTMENT CANCELLED → email to both (no WA template required by spec)
// ═════════════════════════════════════════════════════════════════
async function onAppointmentCancelled(appointment, reason) {
  const a = appointment;
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
  // Optional WA — only fire if you register a 'cancellation_notice' template
  if (a.patient.phone) {
    await safeWa({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      templateName: 'cancellation_notice',
      bodyParams: [a.patient.name, a.doctor.name, fmtDate(a.date), fmtTime(a.startTime)]
    }).catch(() => null); // never break flow if template not registered yet
  }
}

// ═════════════════════════════════════════════════════════════════
// 6. PRESCRIPTION SAVED → patient WA + email with PDF attached
// ═════════════════════════════════════════════════════════════════
async function onPrescriptionCreated(appointment, prescription) {
  const pdfRes = await pdf.generatePrescription(appointment, prescription);
  await prisma.appointment.update({
    where: { id: appointment.id },
    data: { prescriptionUrl: pdfRes.url, status: 'COMPLETED', completedAt: new Date() }
  });

  // Build a short body line so the {{3}} variable in neokids_prescription template carries meds summary
  const medsSummary = (prescription.medications || [])
    .slice(0, 3)
    .map(m => `${m.name} ${m.dose || ''}`.trim())
    .join(', ') || 'See attached PDF';

  await safeWa({
    appointmentId: appointment.id, to: appointment.patient.phone, direction: 'PATIENT',
    templateName: 'neokids_prescription',
    bodyParams: [appointment.patient.name, appointment.doctor.name, medsSummary],
    urlButtonParam: getPrescriptionUrlSuffix(appointment.id) // URL template: https://neokidspro.com/pr{{1}}
  });

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
// 7. 30-MINUTE REMINDERS → both sides
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
      where: { appointmentId: a.id, template: { in: ['neokids_reminder_online', 'neokids_reminder_offline', 'doctor_reminder_online', 'doctor_reminder_offline'] }, status: 'SENT' }
    });
    if (sent) continue;

    const isOnline = a.consultationType === 'ONLINE';
    const patientTpl = isOnline ? 'neokids_reminder_online' : 'neokids_reminder_offline';
    const doctorTpl  = isOnline ? 'doctor_reminder_online' : 'doctor_reminder_offline';
    const btnSuffix  = isOnline ? getMeetUrlSuffix(a.meetLink) : getDirectionsUrlSuffix(a.doctor);

    // — PATIENT — neokids_reminder_{online|offline}({{1}}=name {{2}}=doctor {{3}}=time {{4}}=type)
    await safeWa({
      appointmentId: a.id, to: a.patient.phone, direction: 'PATIENT',
      templateName: patientTpl,
      bodyParams: [a.patient.name, a.doctor.name, fmtTime(a.startTime), isOnline ? 'Online' : 'In-Clinic'],
      urlButtonParam: btnSuffix
    });

    // — DOCTOR —
    if (a.doctor.phone) {
      await safeWa({
        appointmentId: a.id, to: a.doctor.phone, direction: 'DOCTOR',
        templateName: doctorTpl,
        bodyParams: [a.doctor.name, a.patient.name, fmtTime(a.startTime), isOnline ? 'Online' : 'In-Clinic'],
        urlButtonParam: isOnline ? getMeetUrlSuffix(a.meetLink) : undefined
      });
    }
  }
}

module.exports = {
  onDoctorCreated,
  onPhysicalBookingConfirmed,
  onOnlineBookingConfirmed,
  onAppointmentRescheduled,
  onAppointmentCancelled,
  onPrescriptionCreated,
  processReminders
};
