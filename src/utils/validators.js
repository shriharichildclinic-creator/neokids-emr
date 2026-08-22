const { z } = require('zod');
const { getTodayDateString } = require('./date');

const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian phone number (10 digits, starts 6-9, no +91)');

// Strips digits down to a plain 10-digit Indian mobile number. Only removes
// a leading "91" when the caller actually included a country code (12
// digits total, e.g. a pasted "+91 9876543210") — a bare
// replace(/^91/,'') would also mangle any valid 10-digit number that
// simply starts with 91, e.g. "9177211867" -> "77211867" (8 digits, then
// fails validation). This bit ourselves twice (doctor + receptionist/
// pharmacy schemas both had the naive version independently).
function stripPhoneCountryCode(v) {
  if (typeof v !== 'string') return v;
  const d = v.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : d;
}
const strongPassword = z.string().min(8).regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, 'Password must contain letters and numbers');

const timeSchema = z.string().regex(
  /^([01]\d|2[0-3]):[0-5]\d$/,
  'Time must be HH:MM (00:00–23:59)'
);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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
     const uniq = Array.from(new Set(arr));
     uniq.sort((a, b) => DAY_ORDER[a] - DAY_ORDER[b]);
     return uniq.join(',');
   })
).optional();

const optStr = z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string());

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


const doctorShape = {
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
  phone: z.preprocess(stripPhoneCountryCode, phoneSchema),
  specialization: safeOptStr('specialization'),
  qualification: safeOptStr('qualification'),
  experience: z.preprocess(
    v => (v === '' || v === null || v === undefined ? 0 : Number(v)),
    z.number().int().min(0)
  ).optional(),
  bio: safeOptStr('bio'),
  // Feature 3 — doctor registration number (used on medical certificates)
  registrationNumber: safeOptStr('registrationNumber'),
  consultationModes: z.enum(['ONLINE', 'OFFLINE', 'BOTH']).optional(),
  onlineConsultFee: z.preprocess(
    v => (v === '' || v === null || v === undefined ? 0 : Number(v)),
    z.number().nonnegative()
  ).optional(),
  physicalConsultFee: z.preprocess(
    v => (v === '' || v === null || v === undefined ? 0 : Number(v)),
    z.number().nonnegative()
  ).optional(),

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
  ).optional(),
  canAddPreviousRecords: z.preprocess(
    v => (typeof v === 'string' ? ['true','1','yes','on'].includes(v.toLowerCase()) : !!v),
    z.boolean()
  ).optional()
};

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

const updateDoctorByAdminSchema = z
  .object(doctorShape)
  .partial()
  .extend({
    isAvailable: z.boolean().optional()
  })
  .refine(shareSumRule, shareSumErr);

const _toMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

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

// Consultation-mode-aware validation.
// Doctors are configured as ONLINE-only, OFFLINE-only or BOTH (hybrid).
// Availability / fees settings that belong to a mode the doctor does NOT
// offer are ignored (rejected) so stale values can't be saved by accident.
const updateDoctorAvailabilitySchemaForMode = (modes) => {
  const m = String(modes || 'BOTH').toUpperCase();
  return updateDoctorAvailabilitySchema.superRefine((d, ctx) => {
    if (m === 'OFFLINE' && (d.availableFromOnline || d.availableToOnline)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Online availability does not apply to an offline-only doctor', path: ['availableFromOnline'] });
    }
    if (m === 'ONLINE' && (d.availableFromOffline || d.availableToOffline)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'In-person availability does not apply to an online-only doctor', path: ['availableFromOffline'] });
    }
  });
};

const updateDoctorFeesSchema = z.object({
  onlineConsultFee: z.number().nonnegative().optional(),
  physicalConsultFee: z.number().nonnegative().optional()
});

const updateDoctorFeesSchemaForMode = (modes) => {
  const m = String(modes || 'BOTH').toUpperCase();
  return updateDoctorFeesSchema.superRefine((d, ctx) => {
    if (m === 'OFFLINE' && d.onlineConsultFee !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Online consultation fee does not apply to an offline-only doctor', path: ['onlineConsultFee'] });
    }
    if (m === 'ONLINE' && d.physicalConsultFee !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'In-person consultation fee does not apply to an online-only doctor', path: ['physicalConsultFee'] });
    }
  });
};

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

// Multi-specialty expansion.
// NeoKidsPro is pediatric-first but no longer pediatric-only: the platform
// now also serves general physicians, gynecologists and other specialties,
// so patients may be children, teenagers, adults or elderly.
//   * DOB has NO upper-age bound anymore (only "not in the future").
//     The old hard under-18 ceiling is removed.
//   * parentName is optional in general. It becomes REQUIRED only when the
//     supplied DOB makes the patient a minor (< 18 years old) — a child
//     cannot be registered without a parent/guardian contact, but an adult
//     can book on their own. Sibling/family grouping (patients sharing a
//     phone) is untouched by this change.
const bookAppointmentSchema = z.object({
  doctorId: z.string().uuid(),
  patientName: z.string().min(2).max(120).pipe(safeText('patientName')),
  phone: phoneSchema,
  email: z.string().email().optional().or(z.literal('')),
  parentName: z.preprocess(
    v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(2, 'Parent name must be at least 2 characters').max(120).pipe(safeText('parentName')).optional()
  ),
  dateOfBirth: dateSchema,
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
  primaryProblem: z.string().min(3).max(500).pipe(safeText('primaryProblem')),
  // Only meaningful for an in-clinic visit — the booking form only shows/
  // sends these when consultationType is OFFLINE, but accepted here as
  // plain optional numbers rather than mode-conditionally required, since
  // a parent may not have a scale/tape measure handy either way.
  heightCm: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().positive().max(250)
  ).optional(),
  weightKg: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().positive().max(150)
  ).optional(),
  date: dateSchema,
  startTime: timeSchema,
  consultationType: z.enum(['ONLINE', 'OFFLINE']),
  tncAccepted: z.boolean().refine(v => v === true, { message: 'You must accept the Terms & Conditions' })
})
  .refine(d => d.date >= getTodayDateString(), { message: 'Appointment date cannot be in the past', path: ['date'] })
  .refine(d => d.dateOfBirth <= getTodayDateString(), { message: 'Date of birth cannot be in the future', path: ['dateOfBirth'] })
  .refine(d => {
    // Parent/guardian required only for minors; optional for adults.
    const dob = new Date(d.dateOfBirth + 'T00:00:00.000Z');
    const eighteenAgo = new Date();
    eighteenAgo.setUTCFullYear(eighteenAgo.getUTCFullYear() - 18);
    const isMinor = dob >= eighteenAgo;
    return !isMinor || !!d.parentName;
  }, { message: 'Parent / guardian name is required for patients under 18 years old', path: ['parentName'] });

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

// ─────────────────────────────────────────────────────────────────────
// Feature 1 — Historical Appointment
//
// Distinct from bookAppointmentSchema because:
//   - date MAY be in the past (that's the entire point)
//   - startTime is optional (older paper records may not have one)
//   - patientId may be supplied directly to link to an existing patient
//     (Smart Patient Matching flow)
//   - tncAccepted / cashfree fields don't apply
// ─────────────────────────────────────────────────────────────────────
const historicalAppointmentSchema = z.object({
  // Link mode 1: supply existing patient id.
  patientId: z.string().uuid().optional(),

  // Link mode 2: identify patient by demographics (fallback / new record).
  patientName: z.string().min(2).optional(),
  phone: phoneSchema.optional(),
  email: z.string().email().optional().or(z.literal('')),
  parentName: safeOptStr('parentName'),
  dateOfBirth: dateSchema.optional().or(z.literal('')),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),

  // Confirmation flag — set by client after resolving a phone/name conflict.
  // If phone matches existing patient with different name and this is
  // false, the endpoint returns 409 with matching candidates.
  linkConfirmed: z.boolean().optional(),

  // Historical appointment fields.
  doctorId: z.string().uuid(),
  date: dateSchema,
  startTime: timeSchema.optional().or(z.literal('')),
  consultationType: z.enum(['ONLINE', 'OFFLINE']),
  reasonForVisit: z.string().min(2).max(2000),
  diagnosis: safeOptStr('diagnosis'),
  notes: safeOptStr('notes'),
  followUpDate: dateSchema.optional().or(z.literal(''))
}).refine(
  d => !!d.patientId || (!!d.patientName && !!d.phone),
  { message: 'Either patientId or (patientName + phone) is required', path: ['patientId'] }
);

// ─────────────────────────────────────────────────────────────────────
// Feature 1B — Previous Records (doctor-only clinical history entries)
// ─────────────────────────────────────────────────────────────────────
const previousRecordSchema = z.object({
  patientId: z.string().uuid(),
  recordDate: dateSchema,
  diagnosis: safeOptStr('diagnosis'),
  notes: safeOptStr('notes'),
  treatment: safeOptStr('treatment'),
  medications: safeOptStr('medications')
});

const drawnSignatureSchema = z.object({
  dataUrl: z.string().min(50).max(2_000_000).refine(v => /^data:image\/png;base64,/i.test(v), {
    // PNG only — SVG is an active content type and is no longer accepted.
    message: 'dataUrl must be a base64 PNG image'
  })
});

// ─────────────────────────────────────────────────────────────────────
// Feature 2 — Medical Certificate
// ─────────────────────────────────────────────────────────────────────
// Base object (no .refine() chains) — kept separate so both the "create"
// and "update" schemas can be derived from it. z.object(...).refine(...)
// returns a ZodEffects wrapper which has NO .partial() method; calling
// .partial() on it throws at request-time and was the root cause of the
// "Update Certificate" 500 (see medicalCertificateUpdateSchema below).
const medicalCertificateBaseSchema = z.object({
  // If issued from an appointment, we snapshot patient info from it.
  appointmentId: z.string().uuid().optional(),

  // If issued standalone, caller must pass patientId directly.
  patientId: z.string().uuid().optional(),

  // Template catalog (vaccination / return-to-school added).
  templateKey: z.enum(['GENERAL', 'SCHOOL_LEAVE', 'FITNESS', 'MEDICAL_REST', 'VACCINATION', 'RETURN_TO_SCHOOL']).optional(),
  diagnosis: safeOptStr('diagnosis'),
  reason: z.string().min(2, 'Reason for certificate is required').max(2000),
  restDays: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().int().min(0).max(365).optional()
  ),
  // Certificate duration type. 'SINGLE_DAY' → only certificateDate
  // is meaningful; 'DATE_RANGE' → fromDate/toDate (server mirrors toDate from
  // fromDate + restDays when the client didn't send it).
  durationType: z.enum(['SINGLE_DAY', 'DATE_RANGE']).optional(),
  certificateDate: dateSchema.optional().or(z.literal('')),
  // Standalone certificates have no appointment to derive the mode from,
  // so the client sends the doctor's pick; appointment-linked issues
  // ignore this and snapshot the appointment's own consultationType.
  consultationType: z.enum(['ONLINE', 'OFFLINE']).optional(),
  fromDate: dateSchema.optional().or(z.literal('')),
  toDate: dateSchema.optional().or(z.literal('')),
  additionalNotes: safeOptStr('additionalNotes')
});

// CREATE — full validation, including the cross-field .refine() checks.
const medicalCertificateSchema = medicalCertificateBaseSchema.refine(
  d => !!d.appointmentId || !!d.patientId,
  { message: 'Either appointmentId or patientId is required', path: ['patientId'] }
).refine(
  d => {
    // Date-range ordering is only enforced for DATE_RANGE certificates; a
    // single-day certificate never carries a from/to pair to compare.
    if (d.durationType === 'SINGLE_DAY') return true;
    if (!d.fromDate || !d.toDate) return true;
    return d.fromDate <= d.toDate;
  },
  { message: 'fromDate must be on or before toDate', path: ['toDate'] }
);

// UPDATE — a PATCH-style partial of the base object. Built from
// medicalCertificateBaseSchema (a plain ZodObject, so .partial() is valid)
// rather than from medicalCertificateSchema. The controller's update
// handler already re-derives durationType/date consistency itself from the
// merged existing-row + patch view, so the create-only cross-field
// .refine() checks above are intentionally NOT reapplied here — they would
// incorrectly reject partial patches that only touch a single field (e.g.
// { reason: '...' } has neither appointmentId nor patientId, which is fine
// for an update but would fail the "create" refine).
const medicalCertificateUpdateSchema = medicalCertificateBaseSchema.partial();

// ─────────────────────────────────────────────────────────────────────
// v4.0.0 — Receptionist, Medical Centre & Pharmacy module
// ─────────────────────────────────────────────────────────────────────
const staffStatus = z.enum(['ACTIVE', 'SUSPENDED']);
const staffPhone = z.preprocess(stripPhoneCountryCode, phoneSchema);

const createReceptionistSchema = z.object({
  name: z.string().trim().min(2).max(120).pipe(safeText('name')),
  phone: staffPhone,
  email: z.string().trim().toLowerCase().email(),
  password: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), strongPassword.optional()),
  status: staffStatus.optional(),
  canManageConsultations: z.boolean().optional(),
  canManagePharmacy: z.boolean().optional(),
  canIssueCertificates: z.boolean().optional(),
  assignments: z.array(z.object({
    doctorId: z.string().uuid(),
    medicalCentreId: z.string().uuid()
  })).min(1, 'Assign at least one doctor and medical centre').max(50)
});

const updateReceptionistSchema = z.object({
  name: z.string().trim().min(2).max(120).pipe(safeText('name')).optional(),
  phone: staffPhone.optional(),
  password: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), strongPassword.optional()),
  status: staffStatus.optional(),
  canManageConsultations: z.boolean().optional(),
  canManagePharmacy: z.boolean().optional(),
  canIssueCertificates: z.boolean().optional(),
  assignments: z.array(z.object({
    doctorId: z.string().uuid(),
    medicalCentreId: z.string().uuid()
  })).min(1).max(50).optional()
});

const medicalCentreSchema = z.object({
  name: z.string().trim().min(2).max(160).pipe(safeText('clinic name')),
  address: safeOptStr('address'),
  phone: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().optional()),
  email: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().email().optional()),
  city: safeOptStr('city'),
  state: safeOptStr('state'),
  pincode: safeOptStr('pincode'),
  mapUrl: safeOptStr('mapUrl'),
  isActive: z.boolean().optional()
});
const updateMedicalCentreSchema = medicalCentreSchema.partial();

const createPharmacyUserSchema = z.object({
  name: z.string().trim().min(2).max(120).pipe(safeText('name')),
  phone: staffPhone,
  email: z.string().trim().toLowerCase().email(),
  password: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), strongPassword.optional()),
  status: staffStatus.optional(),
  medicalCentreId: z.string().uuid().optional(),
  doctorIds: z.array(z.string().uuid()).min(1, 'Assign at least one doctor').max(50)
});
const updatePharmacyUserSchema = z.object({
  name: z.string().trim().min(2).max(120).pipe(safeText('name')).optional(),
  phone: staffPhone.optional(),
  password: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), strongPassword.optional()),
  status: staffStatus.optional(),
  medicalCentreId: z.string().uuid().nullable().optional(),
  doctorIds: z.array(z.string().uuid()).min(1).max(50).optional()
});

const staffPatientCreateSchema = z.object({
  name: z.string().trim().min(2).max(120).pipe(safeText('name')),
  phone: staffPhone,
  email: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().email().optional()),
  parentName: safeOptStr('parentName'),
  dateOfBirth: dateSchema.optional().or(z.literal('')),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  address: safeOptStr('address')
});

const receptionistBookSchema = z.object({
  patientId: z.string().uuid().optional(),
  patientName: z.string().min(2).max(120).pipe(safeText('patientName')).optional(),
  phone: phoneSchema.optional(),
  email: z.string().email().optional().or(z.literal('')),
  parentName: safeOptStr('parentName'),
  dateOfBirth: dateSchema.optional().or(z.literal('')),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  address: safeOptStr('address'),
  doctorId: z.string().uuid(),
  medicalCentreId: z.string().uuid().optional(),
  date: dateSchema,
  startTime: timeSchema,
  consultationType: z.enum(['ONLINE', 'OFFLINE']),
  primaryProblem: z.string().min(3).max(2000).pipe(safeText('primaryProblem')),
  // Source is captured explicitly from the booking form. The in-person
  // channel is a single "Walk-in / Reception" option (WALK_IN); Phone and
  // Other stay distinct. Legacy CLINIC_RECEPTION is still accepted so
  // historical rows and any stale cached frontend bundle mid-deploy don't
  // 400 — it is treated as WALK_IN everywhere it's displayed or reported.
  // isWalkIn is kept accepted (but unused when source is present).
  source: z.enum(['CLINIC_RECEPTION', 'WALK_IN', 'PHONE', 'OTHER']).optional(),
  isWalkIn: z.boolean().optional()
}).refine(d => !!d.patientId || (!!d.patientName && !!d.phone), {
  message: 'Either patientId or (patientName + phone) is required', path: ['patientId']
});

const receptionistInvoiceSchema = z.object({
  appointmentId: z.string().uuid(),
  amount: z.preprocess(v => (v === '' || v === null || v === undefined ? undefined : Number(v)), z.number().nonnegative().max(50000, 'Amount is too high for a consultation invoice').optional()),
  paymentMethod: z.enum(['CASH', 'CARD', 'UPI', 'ONLINE', 'OTHER']).optional(),
  notes: safeOptStr('notes')
});

const staffRescheduleSchema = z.object({
  date: dateSchema,
  startTime: timeSchema,
  reason: z.string().min(3).max(500)
});

const pharmacyItemSchema = z.object({
  name: z.string().trim().min(1).max(160).pipe(safeText('medicine name')),
  batchNumber: safeOptStr('batchNumber'),
  unit: safeOptStr('unit'),
  mrp: z.preprocess(v => (v === '' || v === null || v === undefined ? undefined : Number(v)), z.number().nonnegative().optional()),
  purchasePrice: z.preprocess(v => (v === '' || v === null || v === undefined ? undefined : Number(v)), z.number().nonnegative().optional()),
  sellingPrice: z.preprocess(v => (v === '' || v === null || v === undefined ? undefined : Number(v)), z.number().nonnegative().optional()),
  stock: z.preprocess(v => (v === '' || v === null || v === undefined ? undefined : Number(v)), z.number().int().min(0).optional()),
  expiryDate: dateSchema.optional().or(z.literal('')),
  manufacturer: safeOptStr('manufacturer'),
  medicalCentreId: z.string().uuid().optional(),
  isActive: z.boolean().optional()
});
const updatePharmacyItemSchema = pharmacyItemSchema.partial();

const pharmacyStockSchema = z.object({
  delta: z.preprocess(v => Number(v), z.number().int().refine(v => v !== 0, 'delta cannot be 0')),
  reason: safeOptStr('reason')
});

const pharmacyBillSchema = z.object({
  patientId: z.string().uuid().optional(),
  customerName: safeOptStr('customerName'),
  customerPhone: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().optional()),
  prescriptionId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  medicalCentreId: z.string().uuid().optional(),
  billType: z.enum(['PHARMACY', 'CONSULT', 'SERVICE']).optional(),
  paymentMethod: z.enum(['CASH', 'CARD', 'UPI', 'ONLINE', 'OTHER']).optional(),
  discount: z.preprocess(v => (v === '' || v === null || v === undefined ? 0 : Number(v)), z.number().nonnegative().optional()),
  tax: z.preprocess(v => (v === '' || v === null || v === undefined ? 0 : Number(v)), z.number().nonnegative().optional()),
  notes: safeOptStr('notes'),
  items: z.array(z.object({
    itemId: z.string().uuid().optional(),
    name: z.string().trim().min(1).optional(),
    quantity: z.preprocess(v => Number(v), z.number().int().min(1)),
    unitPrice: z.preprocess(v => (v === '' || v === null || v === undefined ? undefined : Number(v)), z.number().nonnegative().optional())
  }).refine(i => !!i.itemId || (!!i.name && i.name.trim().length > 0), {
    message: 'Each item needs an inventory medicine (itemId) or a manual name',
    path: ['name']
  })).min(1, 'At least one item is required')
});

// Flatten Zod errors into a readable "field: message" list. Shared by the
// admin controllers (doctor/receptionist/pharmacy management) so both stop
// carrying their own byte-identical copy.
function flattenZod(err) {
  const flat = err.flatten();
  const lines = [];
  for (const [k, msgs] of Object.entries(flat.fieldErrors || {})) {
    (msgs || []).forEach(m => lines.push(`${k}: ${m}`));
  }
  (flat.formErrors || []).forEach(m => lines.push(m));
  return lines.length ? lines.join(' | ') : 'Invalid input';
}

// Generates a throwaway initial password for accounts created by an admin;
// the account is onboarded via invite link rather than by sharing this
// value directly, and mustChangePassword forces the real owner to set
// their own on first use.
function randomPassword() {
  return `Neo${Math.random().toString(36).slice(2, 6)}${Date.now().toString().slice(-4)}`;
}

module.exports = {
  loginSchema,
  slotQuerySchema,
  createDoctorSchema,
  updateDoctorByAdminSchema,
  updateDoctorAvailabilitySchema,
  updateDoctorAvailabilitySchemaForMode,
  updateDoctorFeesSchema,
  updateDoctorFeesSchemaForMode,
  clinicSettingsSchema,
  bookAppointmentSchema,
  prescriptionSchema,
  rescheduleSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  historicalAppointmentSchema,
  previousRecordSchema,
  drawnSignatureSchema,
  medicalCertificateSchema,
  medicalCertificateUpdateSchema,
  createReceptionistSchema,
  updateReceptionistSchema,
  medicalCentreSchema,
  updateMedicalCentreSchema,
  createPharmacyUserSchema,
  updatePharmacyUserSchema,
  staffPatientCreateSchema,
  receptionistBookSchema,
  receptionistInvoiceSchema,
  staffRescheduleSchema,
  pharmacyItemSchema,
  updatePharmacyItemSchema,
  pharmacyStockSchema,
  pharmacyBillSchema,
  flattenZod,
  randomPassword
};
