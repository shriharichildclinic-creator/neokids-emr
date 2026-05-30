const { z } = require('zod');

const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian phone number');
const strongPassword = z.string().min(8).regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, 'Password must contain letters and numbers');
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

const createDoctorSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: strongPassword.optional().or(z.literal('')),
  phone: phoneSchema,
  specialization: z.string().optional(),
  qualification: z.string().optional(),
  experience: z.number().int().min(0).optional(),
  bio: z.string().optional(),
  consultationModes: z.enum(['ONLINE', 'OFFLINE', 'BOTH']).optional(),
  onlineConsultFee: z.number().nonnegative().optional(),
  physicalConsultFee: z.number().nonnegative().optional()
});

const updateDoctorAvailabilitySchema = z.object({
  availableFromOnline: timeSchema.optional().or(z.literal('')),
  availableToOnline: timeSchema.optional().or(z.literal('')),
  availableFromOffline: timeSchema.optional().or(z.literal('')),
  availableToOffline: timeSchema.optional().or(z.literal('')),
  workingDays: z.string().optional(),
  slotDuration: z.number().int().min(5).max(120).optional(),
  isAvailable: z.boolean().optional()
});

const updateDoctorFeesSchema = z.object({
  onlineConsultFee: z.number().nonnegative().optional(),
  physicalConsultFee: z.number().nonnegative().optional()
});

const bookAppointmentSchema = z.object({
  doctorId: z.string().uuid(),
  patientName: z.string().min(2),
  phone: phoneSchema,
  email: z.string().email().optional().or(z.literal('')),
  parentName: z.string().min(2, 'Parent name is required'),
  dateOfBirth: dateSchema,
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
  primaryProblem: z.string().min(3),
  date: dateSchema,
  startTime: timeSchema,
  consultationType: z.enum(['ONLINE', 'OFFLINE'])
});

const prescriptionSchema = z.object({
  chiefComplaint: z.string().min(2),
  diagnosis: z.string().min(2),
  allergies: z.string().optional(),
  investigations: z.string().optional(),
  medications: z.array(z.object({
    name: z.string().min(1),
    dose: z.string().min(1),
    frequency: z.string().min(1),
    duration: z.string().min(1),
    instructions: z.string().optional()
  })).min(1, 'At least one medication is required'),
  advice: z.string().optional(),
  followUpDate: dateSchema.optional()
});

const rescheduleSchema = z.object({
  date: dateSchema,
  startTime: timeSchema,
  reason: z.string().min(3)
});

const forgotPasswordSchema = z.object({
  email: z.string().email()
});

const resetPasswordSchema = z.object({
  token: z.string().min(20),
  password: strongPassword,
  confirmPassword: strongPassword
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword']
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(6),
  newPassword: strongPassword,
  confirmPassword: strongPassword
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword']
});

module.exports = {
  loginSchema,
  createDoctorSchema,
  updateDoctorAvailabilitySchema,
  updateDoctorFeesSchema,
  bookAppointmentSchema,
  prescriptionSchema,
  rescheduleSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema
};
