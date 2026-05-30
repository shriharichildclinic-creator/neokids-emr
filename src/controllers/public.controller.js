const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { bookAppointmentSchema } = require('../utils/validators');
const slotService = require('../services/slot.service');
const bookingService = require('../services/booking.service');
const { getTodayDateString } = require('../utils/date');

exports.listDoctors = asyncHandler(async (req, res) => {
  const { mode } = req.query;
  const where = { isAvailable: true, deletedAt: null };
  if (mode === 'ONLINE') where.consultationModes = { in: ['ONLINE', 'BOTH'] };
  else if (mode === 'OFFLINE') where.consultationModes = { in: ['OFFLINE', 'BOTH'] };

  const doctors = await prisma.doctor.findMany({
    where,
    select: {
      id: true,
      name: true,
      specialization: true,
      qualification: true,
      experience: true,
      bio: true,
      photoUrl: true,
      consultationModes: true,
      onlineConsultFee: true,
      physicalConsultFee: true,
      slotDuration: true,
      availableFromOnline: true,
      availableToOnline: true,
      availableFromOffline: true,
      availableToOffline: true,
      workingDays: true
    },
    orderBy: { name: 'asc' }
  });
  res.json(doctors);
});

exports.doctorDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doctor = await prisma.doctor.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      specialization: true,
      qualification: true,
      experience: true,
      bio: true,
      photoUrl: true,
      consultationModes: true,
      onlineConsultFee: true,
      physicalConsultFee: true,
      slotDuration: true,
      availableFromOnline: true,
      availableToOnline: true,
      availableFromOffline: true,
      availableToOffline: true,
      workingDays: true,
      isAvailable: true
    }
  });
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  res.json(doctor);
});

exports.getSlots = asyncHandler(async (req, res) => {
  const { doctorId, date, type } = req.query;
  if (!doctorId || !date || !type) {
    return res.status(400).json({ error: 'doctorId, date, and type are required' });
  }
  const slots = await slotService.getLiveSlots(doctorId, date, type);
  res.json({ doctorId, date, type, slots });
});

exports.book = asyncHandler(async (req, res) => {
  const parsed = bookAppointmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });

  // Double-check: backend IST-aware past-date guard (covers API calls bypassing the widget)
  const today = getTodayDateString();
  if (parsed.data.date < today) {
    return res.status(400).json({ error: 'Appointment date cannot be in the past' });
  }

  const result = await bookingService.bookAppointment(parsed.data);
  res.status(201).json(result);
});

exports.appointmentStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const appt = await prisma.appointment.findUnique({
    where: { id },
    include: {
      doctor: { select: { name: true, specialization: true } },
      patient: { select: { name: true, phone: true } }
    }
  });
  if (!appt) return res.status(404).json({ error: 'Not found' });
  res.json(appt);
});