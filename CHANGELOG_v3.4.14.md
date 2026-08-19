# Changelog — v3.4.14 (Multi-Specialty Scope Expansion)

NeoKidsPro remains **pediatric-first**, but the EMR no longer assumes every patient is a
child and no longer assumes every consultation happens in a physical clinic. The platform
now supports **pediatric, general physician, gynecology and future specialty** workflows,
including fully-online doctors.

## 1. Patient registration supports adults as well as children

- **DOB upper-age ceiling removed.** The booking schema previously rejected any patient
  aged 18 or older (`patient must be under 18 years old`). That refinement is gone —
  children, teenagers, adults and elderly patients can all be registered. The
  future-date guard is unchanged.
- **Parent / guardian name is now conditional.** It is **required for minors** (DOB
  younger than 18) and **optional for adults**, enforced both server-side
  (`bookAppointmentSchema` in `src/utils/validators.js`) and client-side in the booking
  widget (label flips between "Parent / Guardian Name \*" and "(optional)" live as the
  DOB changes, including the follow-up prefill flow).
- **Sibling / family grouping untouched.** Patients sharing a phone number, family
  search, and the phone+name identity lookup in `booking.service.js` are unchanged —
  an adult booking simply stores `parentName: null`.
- **Patient-facing copy made age-neutral** in the booking widget ("Patient's Full Name",
  "fill in the patient's information", T&C text now reads "I am the patient … or the
  parent / legal guardian of the patient …", DOB hint updated, "in-clinic paediatric
  consultation" → "in-person consultation"). Marketing sections of `book-now.html`
  intentionally keep pediatric positioning (pediatrics is still the primary focus).

## 2. Terminology audit — clinic → platform where inaccurate

Updated only wording that was genuinely clinic-centric; literal location fields
(`clinicName`, `clinicAddress`, maps links, "payment at the clinic", "clinical notes",
revenue "clinic share") are unchanged:

- Admin login: "Pediatric clinic management" → "Doctor network & telehealth platform administration".
- Admin dashboard: "Overview of your clinic" → "Overview of your platform";
  "Latest 10 bookings across the clinic" → "…across the platform";
  "Manage clinic doctors…" → "Manage platform doctors…"; doctor search placeholder
  "…phone, clinic…" → "…phone, practice…".
- Doctor panel login: "Sign in to your pediatric EMR" → "Sign in to your NeoKidsPro EMR";
  sidebar label "Pediatric EMR" → "NeoKidsPro EMR".
- Doctor settings: "Clinic Location" card → "Practice Location" ("Where patients will
  visit you in person"), "Save clinic details" → "Save practice location".
- Doctor panel: "Update your availability and clinic details…" → "…practice details…";
  patient-search hint "patients already registered in your clinic" → "…registered with
  you"; profile fields "Clinic / Clinic address" → "Practice / Practice address".

## 3. Doctor settings adapt to consultation mode

A doctor's configuration UI now only shows what is relevant to their
`consultationModes` (`ONLINE`, `OFFLINE`, `BOTH`):

- **Online-only doctor:** Practice Location card, in-person availability hours and the
  in-person fee field are hidden; an explanatory notice is shown instead.
- **Offline-only doctor:** online availability hours and the online fee field are hidden.
- **Hybrid (BOTH):** everything remains visible (previous behaviour).

Enforced at three layers:

1. **Doctor panel UI** (`public/doctor/index.html` + `app.js::applyModeVisibility()`)
   hides the irrelevant cards/fields and the availability/fees submit handlers only
   send fields relevant to the doctor's mode.
2. **Admin doctor form** (`public/admin/index.html` + `app.js::applyAdminModeVisibility()`)
   shows only the fee fields matching the selected consultation mode, live on change.
3. **Server-side guards** (`src/utils/validators.js`
   `updateDoctorAvailabilitySchemaForMode` / `updateDoctorFeesSchemaForMode`, used by
   `doctor.controller.js`) reject mode-irrelevant availability/fee fields, and
   `updateClinic` returns 400 for online-only doctors.

## Constraints honoured

- No DB schema change, no architecture or tech-stack change.
- Sibling/family relationship logic fully preserved.
- Appointment, consultation, billing and patient-management flows unchanged apart from
  the widened DOB rule and conditional parent requirement above.
- All pediatric workflows (minor bookings, mandatory guardian, vaccination records,
  certificates) behave exactly as before.
