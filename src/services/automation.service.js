const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const whatsapp = require('./whatsapp.service');
const email = require('./email.service');
const pdf = require('./pdf.service');
const meet = require('./googleMeet.service');
const { formatDateOnly, getTodayDateString, getCurrentTimeMinutes } = require('../utils/date');
const { timeToMinutes } = require('./slot.service');

function fmtDate(d) {
  return formatDateOnly(d);
}

async function logNotification(data) {
  try {
    await prisma.notificationLog.create({ data });
  } catch (e) {
    logger.error('Log notif failed', e);
  }
}

async function safeEmail({ appointmentId, recipient, template, messageFactory }) {
  try {
    await messageFactory();
    await logNotification({ appointmentId, channel: 'EMAIL', recipient, template, status: 'SENT' });
  } catch (error) {
    logger.error(`Email failed for ${template}`, error);
    await logNotification({ appointmentId, channel: 'EMAIL', recipient, template, status: 'FAILED', errorMessage: error.message });
  }
}

async function onPhysicalBookingConfirmed(appointment) {
  const a = appointment;
  const msg = `🏥 *Booking Confirmed - NeoKidsPro*\n\n` +
    `Dear ${a.patient.name},\n\n` +
    `Your visit with *Dr. ${a.doctor.name}* is confirmed:\n\n` +
    `📅 ${fmtDate(a.date)}\n` +
    `⏰ ${a.startTime}\n` +
    `📍 In-clinic visit\n` +
    `💰 Fee: ₹${Number(a.feeAtBooking).toFixed(2)} (pay at clinic)\n\n` +
    `Please arrive 10 minutes early. Reply HELP for support.\n\n— NeoKidsPro`;

  await Promise.all([
    whatsapp.sendWhatsApp({ to: a.patient.phone, body: msg })
      .then((r) => logNotification({ appointmentId: a.id, channel: 'WHATSAPP', recipient: a.patient.phone, template: 'PHYSICAL_CONFIRMED', status: 'SENT', payload: r }))
      .catch((e) => logNotification({ appointmentId: a.id, channel: 'WHATSAPP', recipient: a.patient.phone, template: 'PHYSICAL_CONFIRMED', status: 'FAILED', errorMessage: e.message })),
    a.patient.email && safeEmail({
      appointmentId: a.id,
      recipient: a.patient.email,
      template: 'PHYSICAL_CONFIRMED',
      messageFactory: () => email.sendEmail({
        to: a.patient.email,
        subject: 'Your appointment is confirmed - NeoKidsPro',
        html: `<h2>Appointment Confirmed</h2><p>Dear ${a.patient.name},</p>
               <p>Your in-clinic visit with <strong>Dr. ${a.doctor.name}</strong> is confirmed for
               <strong>${fmtDate(a.date)}</strong> at <strong>${a.startTime}</strong>.</p>
               <p>Fee: ₹${Number(a.feeAtBooking).toFixed(2)} (payable at clinic)</p>
               <p>— NeoKidsPro</p>`
      })
    })
  ]);
}

async function onOnlineBookingConfirmed(appointment) {
  const a = appointment;
  let meetLink = null;
  let invoiceUrl = null;

  try {
    const meetRes = await meet.createMeetLink({
      summary: `NeoKidsPro Consultation - ${a.patient.name}`,
      description: `Online consultation with Dr. ${a.doctor.name}\nReason: ${a.primaryProblem}`,
      startISO: `${new Date(a.date).toISOString().slice(0, 10)}T${a.startTime}:00+05:30`,
      endISO: `${new Date(a.date).toISOString().slice(0, 10)}T${a.endTime}:00+05:30`,
      attendees: [a.doctor.email, a.patient.email].filter(Boolean)
    });
    meetLink = meetRes.meetLink;
  } catch (e) {
    logger.error('Meet link generation failed', e);
  }

  try {
    const inv = await pdf.generateInvoice(a);
    invoiceUrl = inv.url;
  } catch (e) {
    logger.error('Invoice generation failed', e);
  }

  await prisma.appointment.update({ where: { id: a.id }, data: { meetLink, invoiceUrl } });
  await prisma.doctor.update({
    where: { id: a.doctorId },
    data: { consults: { increment: 1 }, revenue: { increment: a.feeAtBooking } }
  });

  const msg = `✅ *Booking Confirmed - NeoKidsPro*\n\n` +
    `Dear ${a.patient.name}, payment received!\n\n` +
    `Your *online* consultation with *Dr. ${a.doctor.name}*:\n` +
    `📅 ${fmtDate(a.date)}\n⏰ ${a.startTime}\n` +
    `💰 ₹${Number(a.feeAtBooking).toFixed(2)} (Paid)\n\n` +
    (meetLink ? `🎥 Join: ${meetLink}\n\n` : '') +
    (invoiceUrl ? `🧾 Invoice: ${process.env.API_URL || ''}${invoiceUrl}\n\n` : '') +
    `You will receive a reminder 30 minutes before your consultation.\n\n— NeoKidsPro`;

  await whatsapp.sendWhatsApp({ to: a.patient.phone, body: msg })
    .then((r) => logNotification({ appointmentId: a.id, channel: 'WHATSAPP', recipient: a.patient.phone, template: 'ONLINE_CONFIRMED', status: 'SENT', payload: r }))
    .catch((e) => logNotification({ appointmentId: a.id, channel: 'WHATSAPP', recipient: a.patient.phone, template: 'ONLINE_CONFIRMED', status: 'FAILED', errorMessage: e.message }));

  if (a.patient.email) {
    await safeEmail({
      appointmentId: a.id,
      recipient: a.patient.email,
      template: 'ONLINE_CONFIRMED',
      messageFactory: () => email.sendEmail({
        to: a.patient.email,
        subject: 'Your online consultation is confirmed - NeoKidsPro',
        html: `<h2>Consultation Confirmed</h2>
               <p>Dear ${a.patient.name},</p>
               <p>Your online consultation with <strong>Dr. ${a.doctor.name}</strong> on
               <strong>${fmtDate(a.date)}</strong> at <strong>${a.startTime}</strong> is confirmed.</p>
               ${meetLink ? `<p>Join here: <a href="${meetLink}">${meetLink}</a></p>` : ''}
               ${invoiceUrl ? `<p><a href="${process.env.API_URL || ''}${invoiceUrl}">Download Invoice</a></p>` : ''}
               <p>— NeoKidsPro</p>`
      })
    });
  }
}

async function onAppointmentRescheduled(appointment) {
  const a = appointment;
  let meetLink = a.meetLink;

  if (a.consultationType === 'ONLINE') {
    try {
      const res = await meet.createMeetLink({
        summary: `[RESCHEDULED] NeoKidsPro Consultation - ${a.patient.name}`,
        description: `Rescheduled consultation with Dr. ${a.doctor.name}`,
        startISO: `${new Date(a.date).toISOString().slice(0, 10)}T${a.startTime}:00+05:30`,
        endISO: `${new Date(a.date).toISOString().slice(0, 10)}T${a.endTime}:00+05:30`,
        attendees: [a.doctor.email, a.patient.email].filter(Boolean)
      });
      meetLink = res.meetLink;
      await prisma.appointment.update({ where: { id: a.id }, data: { meetLink } });
    } catch (e) {
      logger.error('Reschedule meet failed', e);
    }
  }

  const msg = `🔄 *Appointment Rescheduled*\n\n` +
    `Dear ${a.patient.name},\n` +
    `Your appointment with *Dr. ${a.doctor.name}* has been rescheduled.\n\n` +
    `📅 New Date: ${fmtDate(a.date)}\n⏰ New Time: ${a.startTime}\n` +
    `📝 Reason: ${a.rescheduleReason || 'Doctor unavailable'}\n` +
    (meetLink && a.consultationType === 'ONLINE' ? `\n🎥 New Meet link: ${meetLink}\n` : '') +
    `\nApologies for the inconvenience.\n— NeoKidsPro`;

  await whatsapp.sendWhatsApp({ to: a.patient.phone, body: msg })
    .then(() => logNotification({ appointmentId: a.id, channel: 'WHATSAPP', recipient: a.patient.phone, template: 'RESCHEDULED', status: 'SENT' }))
    .catch((e) => logNotification({ appointmentId: a.id, channel: 'WHATSAPP', recipient: a.patient.phone, template: 'RESCHEDULED', status: 'FAILED', errorMessage: e.message }));

  if (a.patient.email) {
    await safeEmail({
      appointmentId: a.id,
      recipient: a.patient.email,
      template: 'RESCHEDULED',
      messageFactory: () => email.sendEmail({
        to: a.patient.email,
        subject: 'Appointment Rescheduled - NeoKidsPro',
        html: `<h2>Appointment Rescheduled</h2>
               <p>Dear ${a.patient.name},</p>
               <p>Your appointment with <strong>Dr. ${a.doctor.name}</strong> has been rescheduled to
               <strong>${fmtDate(a.date)}</strong> at <strong>${a.startTime}</strong>.</p>
               <p>Reason: ${a.rescheduleReason || 'Doctor unavailable'}</p>
               ${meetLink && a.consultationType === 'ONLINE' ? `<p>New Meet link: <a href="${meetLink}">${meetLink}</a></p>` : ''}
               <p>— NeoKidsPro</p>`
      })
    });
  }
}

async function onPrescriptionCreated(appointment, prescription) {
  const pdfRes = await pdf.generatePrescription(appointment, prescription);
  await prisma.appointment.update({
    where: { id: appointment.id },
    data: { prescriptionUrl: pdfRes.url, status: 'COMPLETED', completedAt: new Date() }
  });

  const msg = `📋 *Your Prescription is Ready*\n\n` +
    `Dear ${appointment.patient.name},\n` +
    `Dr. ${appointment.doctor.name} has issued your prescription.\n\n` +
    `Download here: ${process.env.API_URL || ''}${pdfRes.url}\n\n` +
    (prescription.followUpDate ? `📅 Follow-up: ${fmtDate(prescription.followUpDate)}\n` : '') +
    `\nGet well soon! — NeoKidsPro`;

  await whatsapp.sendWhatsApp({
    to: appointment.patient.phone,
    body: msg,
    mediaUrl: `${process.env.API_URL || ''}${pdfRes.url}`
  }).then(() => logNotification({ appointmentId: appointment.id, channel: 'WHATSAPP', recipient: appointment.patient.phone, template: 'PRESCRIPTION', status: 'SENT' }))
    .catch((e) => logNotification({ appointmentId: appointment.id, channel: 'WHATSAPP', recipient: appointment.patient.phone, template: 'PRESCRIPTION', status: 'FAILED', errorMessage: e.message }));

  if (appointment.patient.email) {
    await safeEmail({
      appointmentId: appointment.id,
      recipient: appointment.patient.email,
      template: 'PRESCRIPTION',
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

async function processReminders() {
  const todayStr = getTodayDateString();
  const today = new Date(`${todayStr}T12:00:00.000Z`);
  const nowMinutes = getCurrentTimeMinutes();

  const appts = await prisma.appointment.findMany({
    where: {
      date: today,
      status: 'CONFIRMED'
    },
    include: { doctor: true, patient: true }
  });

  for (const a of appts) {
    const startMinutes = timeToMinutes(a.startTime);
    const delta = startMinutes - nowMinutes;
    if (delta >= 28 && delta <= 33) {
      const sent = await prisma.notificationLog.findFirst({
        where: { appointmentId: a.id, template: 'REMINDER_30' }
      });
      if (sent) continue;

      const msg = `⏰ *Reminder - NeoKidsPro*\n\n` +
        `Dear ${a.patient.name}, your appointment with *Dr. ${a.doctor.name}* is in 30 minutes.\n` +
        `⏰ ${a.startTime}\n` +
        (a.consultationType === 'ONLINE' && a.meetLink ? `🎥 Join: ${a.meetLink}\n` : '📍 In-clinic\n') +
        `\nSee you soon!`;
      await whatsapp.sendWhatsApp({ to: a.patient.phone, body: msg })
        .then(() => logNotification({ appointmentId: a.id, channel: 'WHATSAPP', recipient: a.patient.phone, template: 'REMINDER_30', status: 'SENT' }))
        .catch((e) => logNotification({ appointmentId: a.id, channel: 'WHATSAPP', recipient: a.patient.phone, template: 'REMINDER_30', status: 'FAILED', errorMessage: e.message }));
    }
  }
}

module.exports = {
  onPhysicalBookingConfirmed,
  onOnlineBookingConfirmed,
  onAppointmentRescheduled,
  onPrescriptionCreated,
  processReminders
};
