const { z } = require('zod');
const { getTodayDateString } = require('./date');

const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian phone number (10 digits, starts 6-9, no +91)');
const strongPassword = z.string().min(8).regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, 'Password must contain letters and numbers');
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Helper: treat empty strings & whitespace-only as undefined so .optional() really works
const optStr = z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string());

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

const createDoctorSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email(),
  password: z.preprocess(
    v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    strongPassword.optional()
  ),
  phone: z.preprocess(
    v => (typeof v === 'string' ? v.replace(/\D/g, '').replace(/^91/, '') : v),
    phoneSchema
  ),
  specialization: optStr.optional(),
  qualification: optStr.optional(),
  experience: z.preprocess(
    v => (v === '' || v === null || v === undefined ? 0 : Number(v)),
    z.number().int().min(0)
  ).optional(),
  bio: optStr.optional(),
  consultationModes: z.enum(['ONLINE', 'OFFLINE', 'BOTH']).optional(),
  onlineConsultFee: z.preprocess(
    v => (v === '' || v === null || v === undefined ? 0 : Number(v)),
    z.number().nonnegative()
  ).optional(),
  physicalConsultFee: z.preprocess(
    v => (v === '' || v === null || v === undefined ? 0 : Number(v)),
    z.number().nonnegative()
  ).optional()
});

// Bug 2 — Admin Update Doctor uses .partial(), so omitting email entirely
// is valid. The frontend was sending `email: ''` because the disabled input
// is excluded from FormData, then the `email: (raw.email || '').trim()...`
// substituted empty string, which fails .email(). The fix is on the
// frontend: do not include `email` in the payload when editing.
const updateDoctorByAdminSchema = createDoctorSchema.partial().extend({
  isAvailable: z.boolean().optional()
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

const clinicSettingsSchema = z.object({
  clinicName: z.string().trim().min(2, 'Clinic name is required'),
  clinicAddress: optStr.optional(),
  clinicMapUrl: optStr.optional(),
  clinicLat: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().min(-90).max(90).optional()
  ),
  clinicLng: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().min(-180).max(180).optional()
  )
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
  consultationType: z.enum(['ONLINE', 'OFFLINE']),
  tncAccepted: z.boolean().refine(v => v === true, { message: 'You must accept the Terms & Conditions' })
})
  .refine(d => d.date >= getTodayDateString(), { message: 'Appointment date cannot be in the past', path: ['date'] })
  .refine(d => d.dateOfBirth <= getTodayDateString(), { message: 'Date of birth cannot be in the future', path: ['dateOfBirth'] })
  .refine(d => {
    const dob = new Date(d.dateOfBirth + 'T00:00:00.000Z');
    const eighteenAgo = new Date();
    eighteenAgo.setUTCFullYear(eighteenAgo.getUTCFullYear() - 18);
    return dob >= eighteenAgo;
  }, { message: 'This is a pediatric clinic — patient must be under 18 years old', path: ['dateOfBirth'] });

const prescriptionSchema = z.object({
  weight: optStr.optional(),
  height: optStr.optional(),
  pastHistory: optStr.optional(),
  chiefComplaint: z.string().min(2),
  diagnosis: z.string().min(2),
  allergies: optStr.optional(),
  investigations: optStr.optional(),
  medications: z.array(z.object({
    name: z.string().min(1),
    dose: z.string().min(1),
    frequency: z.string().min(1),
    duration: z.string().min(1),
    instructions: optStr.optional()
  })).min(1, 'At least one medication is required'),
  advice: optStr.optional(),
  followUpDate: dateSchema.optional().or(z.literal(''))
});

// Additional Issue 3 — reject reschedules into the past at the validator
// layer as well as the controller (defense in depth).
const rescheduleSchema = z.object({
  date: dateSchema,
  startTime: timeSchema,
  reason: z.string().min(3)
})
  .refine(d => d.date >= getTodayDateString(), { message: 'Cannot reschedule to a past date', path: ['date'] });

const forgotPasswordSchema = z.object({ email: z.string().email() });

const resetPasswordSchema = z.object({
  token: z.string().min(20),
  password: strongPassword,
  confirmPassword: strongPassword
}).refine(d => d.password === d.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(6),
  newPassword: strongPassword,
  confirmPassword: strongPassword
}).refine(d => d.newPassword === d.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

module.exports = {
  loginSchema,
  createDoctorSchema,
  updateDoctorByAdminSchema,
  updateDoctorAvailabilitySchema,
  updateDoctorFeesSchema,
  clinicSettingsSchema,
  bookAppointmentSchema,
  prescriptionSchema,
  rescheduleSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema
};
