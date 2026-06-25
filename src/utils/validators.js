const { z } = require('zod');
const { getTodayDateString } = require('./date');

const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian phone number (10 digits, starts 6-9, no +91)');
const strongPassword = z.string().min(8).regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, 'Password must contain letters and numbers');

// Issue #16 — the old regex /^\d{2}:\d{2}$/ happily accepted '25:99', '99:99',
// even '00:60'. We now constrain HH to 00-23 and MM to 00-59. Anything else
// is rejected by the validator, so PUT /api/doctor/availability with a junk
// time can't slip into the DB any more.
const timeSchema = z.string().regex(
  /^([01]\d|2[0-3]):[0-5]\d$/,
  'Time must be HH:MM (00:00–23:59)'
);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Issue #17 — workingDays was z.string().optional() with no enum check.
// We now:
//   1. accept comma-separated string OR array of day codes
//   2. validate every token against the canonical 3-letter enum
//   3. normalize: trim, uppercase, dedupe, preserve weekly order
// Bad input ("FAKEDAY,MON" or typo "MOM") is rejected with a clear error
// instead of being saved as-is and silently breaking the slot generator.
const DAY_CODES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const DAY_ORDER = Object.fromEntries(DAY_CODES.map((d, i) => [d, i]));

const workingDaysSchema = z.preprocess(
  (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const raw = Array.isArray(v) ? v : String(v).split(',');
    return raw.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  },
  z.array(z.enum(DAY_CODES, {
    errorMap: () => ({ message: `workingDays entries must be one of ${DAY_CODES.join(', ')}` })
  }))
   .min(1, 'workingDays cannot be empty')
   .max(7, 'workingDays has at most 7 entries')
   .transform((arr) => {
     // dedupe + weekly order; emit as comma string for backwards compat
     // with the existing slot.service which splits on ','.
     const uniq = Array.from(new Set(arr));
     uniq.sort((a, b) => DAY_ORDER[a] - DAY_ORDER[b]);
     return uniq.join(',');
   })
).optional();

// Helper: treat empty strings & whitespace-only as undefined so .optional() really works
const optStr = z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string());

// ── Issue 10 — stored-XSS hardening ──
// Reject any string that contains HTML tags or unsafe sequences. This is
// the server-side defense in depth; the WordPress widget escapes too.
// We block angle brackets and the javascript: URL scheme outright — a
// doctor's name has no legitimate reason to contain either.
const HTML_TAG_RE = /<[^>]*>|<\/?[a-z][\s\S]*?>/i;
const NUL_RE      = /\u0000/;
const safeText = (label = 'field') =>
  z.string()
    .refine(v => !HTML_TAG_RE.test(v),
      { message: `${label} must not contain HTML tags` })
    .refine(v => !/javascript:/i.test(v),
      { message: `${label} must not contain script URLs` })
    .refine(v => !NUL_RE.test(v),
      { message: `${label} must not contain control characters` });

const safeOptStr = (label = 'field') =>
  z.preprocess(
    v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    safeText(label).optional()
  );

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

// Issues 5 & 6 — strict validation for GET /api/public/slots query string.
// - doctorId must be a UUID (not just any non-empty string)
// - date must be YYYY-MM-DD AND not in the past
// - type must be exactly 'ONLINE' or 'OFFLINE' (was silently coerced before)
const slotQuerySchema = z.object({
  doctorId: z.string().uuid({ message: 'doctorId must be a valid UUID' }),
  date: dateSchema,
  type: z.enum(['ONLINE', 'OFFLINE'], {
    errorMap: () => ({ message: "type must be 'ONLINE' or 'OFFLINE'" })
  })
}).refine(d => d.date >= getTodayDateString(), {
  message: 'date cannot be in the past',
  path: ['date']
});


// Base shape (no cross-field refinement) so `.partial()` stays composable.
const doctorShape = {
  // Issue 10 — name is rendered verbatim into the WordPress widget HTML.
  // Refuse HTML tags / script URLs at the validator layer so the public
  // listing can never contain executable markup, regardless of frontend bugs.
  name: z.string()
    .trim()
    .min(2)
    .max(120)
    .pipe(safeText('name')),
  email: z.string().trim().toLowerCase().email(),
  password: z.preprocess(
    v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    strongPassword.optional()
  ),
  phone: z.preprocess(
    v => (typeof v === 'string' ? v.replace(/\D/g, '').replace(/^91/, '') : v),
    phoneSchema
  ),
  specialization: safeOptStr('specialization'),
  qualification: safeOptStr('qualification'),
  experience: z.preprocess(
    v => (v === '' || v === null || v === undefined ? 0 : Number(v)),
    z.number().int().min(0)
  ).optional(),
  bio: safeOptStr('bio'),
  consultationModes: z.enum(['ONLINE', 'OFFLINE', 'BOTH']).optional(),
  onlineConsultFee: z.preprocess(
    v => (v === '' || v === null || v === undefined ? 0 : Number(v)),
    z.number().nonnegative()
  ).optional(),
  physicalConsultFee: z.preprocess(
    v => (v === '' || v === null || v === undefined ? 0 : Number(v)),
    z.number().nonnegative()
  ).optional(),

  // Revenue Management
  clinicSharePercent: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().min(0).max(100)
  ).optional(),

  doctorSharePercent: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().min(0).max(100)
  ).optional(),

  tdsPercent: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().min(0).max(100)
  ).optional()
};

// Shared cross-field rule
const shareSumRule = (d) => {
  if (d.clinicSharePercent == null && d.doctorSharePercent == null) {
    return true;
  }

  const c = Number(d.clinicSharePercent ?? 0);
  const x = Number(d.doctorSharePercent ?? 0);

  return Math.abs((c + x) - 100) < 0.01;
};

const shareSumErr = {
  message: 'clinicSharePercent + doctorSharePercent must equal 100',
  path: ['doctorSharePercent']
};

const createDoctorSchema =
  z.object(doctorShape).refine(shareSumRule, shareSumErr);

// Bug 2 — Admin Update Doctor uses .partial(), so omitting email entirely
// is valid. The share-sum rule is re-applied separately.
const updateDoctorByAdminSchema = z
  .object(doctorShape)
  .partial()
  .extend({
    isAvailable: z.boolean().optional()
  })
  .refine(shareSumRule, shareSumErr);
// Issue #16 helper — minutes-since-midnight, used for start-before-end.
const _toMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

// Issue #16 — strict availability validator:
//   * times must be real HH:MM (timeSchema is now tight)
//   * start must be strictly before end (per consultation mode)
//   * if only one side of a pair is provided, that's still accepted
//     (a partial update legitimately changes one bound at a time)
//
// Issue #17 — workingDays now uses the workingDaysSchema enum validator,
// so 'FAKEDAY,MON' or a typo'd 'MOM' is rejected here, before it can
// dirty the DB or silently break the slot generator.
const updateDoctorAvailabilitySchema = z.object({
  availableFromOnline:  timeSchema.optional().or(z.literal('')),
  availableToOnline:    timeSchema.optional().or(z.literal('')),
  availableFromOffline: timeSchema.optional().or(z.literal('')),
  availableToOffline:   timeSchema.optional().or(z.literal('')),
  workingDays:          workingDaysSchema,
  slotDuration:         z.number().int().min(5).max(120).optional(),
  isAvailable:          z.boolean().optional()
})
  .refine(d => {
    if (!d.availableFromOnline || !d.availableToOnline) return true;
    return _toMin(d.availableFromOnline) < _toMin(d.availableToOnline);
  }, {
    message: 'availableFromOnline must be earlier than availableToOnline',
    path: ['availableToOnline']
  })
  .refine(d => {
    if (!d.availableFromOffline || !d.availableToOffline) return true;
    return _toMin(d.availableFromOffline) < _toMin(d.availableToOffline);
  }, {
    message: 'availableFromOffline must be earlier than availableToOffline',
    path: ['availableToOffline']
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
  slotQuerySchema,
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