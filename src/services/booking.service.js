const prisma = require('../config/prisma');
const { minutesToTime, timeToMinutes, getLiveSlots } = require('./slot.service');
const automation = require('./automation.service');
const cashfreeService = require('./cashfree.service');
const { parseDateOnly, parseDateOnlyOrNull } = require('../utils/date');
const { expirePendingAppointments } = require('./appointment-state.service');

const UNPAID_BOOKING_EXPIRY_MINUTES = parseInt(process.env.UNPAID_BOOKING_EXPIRY_MINUTES || '15', 10);

async function bookAppointment(input) {
  const {
    doctorId,
    patientName,
    phone,
    email,
    parentName,
    dateOfBirth,
    gender,
    primaryProblem,
    date,
    startTime,
    consultationType
  } = input;

  await expirePendingAppointments();

  const doctor = await prisma.doctor.findFirst({ where: { id: doctorId, deletedAt: null } });
  if (!doctor) throw Object.assign(new Error('Doctor not found'), { statusCode: 404 });
  if (!doctor.isAvailable) throw Object.assign(new Error('Doctor not available'), { statusCode: 400 });

  if (doctor.consultationModes !== 'BOTH' && doctor.consultationModes !== consultationType) {
    throw Object.assign(new Error('Consultation mode not supported by this doctor'), { statusCode: 400 });
  }

  const liveSlots = await getLiveSlots(doctorId, date, consultationType);
  const selectedSlot = liveSlots.find((slot) => slot.startTime === startTime);
  if (!selectedSlot || !selectedSlot.available) {
    throw Object.assign(new Error('Selected slot is no longer available'), { statusCode: 409 });
  }

  const startMin = timeToMinutes(startTime);
  const endTime = minutesToTime(startMin + (doctor.slotDuration || 15));
  const feeAtBooking = consultationType === 'ONLINE' ? doctor.onlineConsultFee : doctor.physicalConsultFee;

  const patient = await prisma.patient.upsert({
    where: { phone },
    update: {
      name: patientName,
      email: email || null,
      parentName,
      dateOfBirth: parseDateOnlyOrNull(dateOfBirth),
      gender
    },
    create: {
      name: patientName,
      phone,
      email: email || null,
      parentName,
      dateOfBirth: parseDateOnlyOrNull(dateOfBirth),
      gender
    }
  });

  const appointmentDate = parseDateOnly(date);
  const expiresAt = consultationType === 'ONLINE'
    ? new Date(Date.now() + UNPAID_BOOKING_EXPIRY_MINUTES * 60 * 1000)
    : null;

  let appointment;
  try {
    appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId: patient.id,
        primaryProblem,
        date: appointmentDate,
        startTime,
        endTime,
        consultationType,
        feeAtBooking,
        status: consultationType === 'OFFLINE' ? 'CONFIRMED' : 'PENDING',
        paymentStatus: 'UNPAID',
        expiresAt
      },
      include: { doctor: true, patient: true }
    });
  } catch (e) {
    if (e.code === 'P2002') {
      throw Object.assign(new Error('Slot already booked. Please pick another time.'), { statusCode: 409 });
    }
    throw e;
  }

  if (consultationType === 'OFFLINE') {
    await automation.onPhysicalBookingConfirmed(appointment);
    return { appointment, requiresPayment: false };
  }

  const order = await cashfreeService.createOrder({
    orderId: `appt_${appointment.id}`,
    amount: Number(feeAtBooking),
    currency: 'INR',
    customer: {
      customerId: patient.id,
      customerName: patientName,
      customerEmail: email || 'no-reply@neokidspro.in',
      customerPhone: phone
    },
    orderNote: `Consultation booking for Dr. ${doctor.name}`,
    orderTags: { appointmentId: appointment.id, consultationType }
  });

  await prisma.appointment.update({
    where: { id: appointment.id },
    data: { cashfreeOrderId: order.order_id }
  });

  return {
    appointment,
    requiresPayment: true,
    cashfree: {
      orderId: order.order_id,
      paymentSessionId: order.payment_session_id,
      amount: order.order_amount,
      currency: order.order_currency,
      environment: cashfreeService.getMode(),
      expiresAt
    }
  };
}

async function confirmOnlineBooking(appointmentId, cashfreePaymentId) {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { doctor: true, patient: true }
  });
  if (!appt) throw new Error('Appointment not found');
  if (appt.paymentStatus === 'PAID') return appt;
  if (appt.status === 'CANCELLED') return appt;

  const updated = await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
      cashfreePaymentId,
      expiresAt: null
    },
    include: { doctor: true, patient: true }
  });

  await automation.onOnlineBookingConfirmed(updated);
  return updated;
}

module.exports = { bookAppointment, confirmOnlineBooking };
