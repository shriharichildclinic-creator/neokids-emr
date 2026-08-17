# MIGRATION_v3.4.4.md — Historical Records Hardening + Certificate Date Rework + Boot Crash Fix

Date: 2026-08-17
Branch: `v3.4.4`
Status: **Production-ready, additive. Nothing existing is removed.**

This release does six things, none of which require data migration:

| # | Problem | Resolution |
|---|---|---|
| 1 | PM2 boot crash from missing `../utils/asyncHandler` module | Back-compat shim added at `src/utils/asyncHandler.js` re-exports from the canonical `middleware/errorHandler.js` |
| 2 | "Invalid Input" toast swallowing the real Zod issue | Error handler + frontend now surface `details` from Zod `safeParse` so the doctor sees *which* field failed |
| 3 | Historical Records: too basic CRUD, single attachment, hard-to-edit | New entities + endpoints: per-record attachments table with labels, CRUD, signed preview/download/replace/delete, Open-in-new-tab |
| 4 | Historical Records share workflow incomplete | WhatsApp + Email delivery with secure expiring links; recipient defaults to the patient, override on the way out |
| 5 | Medical Certificate date maths has two competing flows / infinite reverse-calc | **Option A only** (Days + Start Date → End Date), manual override preserved, back-compat for legacy `DATE_RANGE` rows |
| 6 | Doctor had no idea what WhatsApp templates to register | New `docs/META_WHATSAPP_TEMPLATES_v3.4.4.md` lists the exact names, categories, body, variables, button config and Meta approval sample values |

---

## Deploy steps (production)

```bash
cd /home/deploy/neokids-emr
git pull origin v3.4.4        # or upload the patched zip below
npm install                   # no new dependencies — sanity check only
npx prisma migrate deploy     # NO new migrations in this release
npx prisma generate
pm2 restart neokids-emr
```

If you've never applied v3.4.x before, ALSO run the v3.4.3 hotfix
migrations first (look in `prisma/migrations/` —
`20260817120000_historical_records_pro`,
`20260819100000_historical_appointments_and_certificates`,
`20260821090000_certificate_v340_columns_hotfix`,
`20260820110000_previous_records_rework`).

Then create the three WhatsApp templates listed in
`docs/META_WHATSAPP_TEMPLATES_v3.4.4.md`:
`medical_certificate_ready`, `historical_record_shared`,
`historical_record_share_attachments`.

---

## Files touched (this release)

| File | Why |
|---|---|
| `src/utils/asyncHandler.js` (NEW) | Back-compat shim — prevents the `MODULE_NOT_FOUND` boot crash that produced the 502 / repeated-PM2-restart loop on `Errrored` |
| `src/middleware/errorHandler.js` | Zod errors now propagate `details.flatten()` to the client at all times (the "Invalid Input" toast stops swallowing the real reason) |
| `src/utils/validators.js` | Historical-record validator is now fully tolerant (PATCH-style): every field optional, empty strings collapsed, unknown keys stripped, Zod `errorMap` rewrites its message to include the field path |
| `src/controllers/previous.controller.js` | Cleaner error envelopes (`code`, `requestId`, `details`); PDF + share endpoints now return `{ success, record, delivery, shareUrl }` consistently; explicit ASYNC WRAPPER export for back-compat |
| `src/controllers/historical.controller.js` | Unchanged — uses `asyncHandler` from the canonical path |
| `src/controllers/certificate.controller.js` | Medical certificate date logic **replaced** with `normalizeCertificateDates()` from the new service. Removes dual-mode reverse calculation. Legacy `DATE_RANGE` rows render exactly as before. |
| `src/services/certificate-date.service.js` (NEW) | Single, auditable source of truth for "days + start → end" |
| `src/services/historical-record.service.js` | Share URL generation hardened (signed with timestamp + id, 7-day TTL); WA delivery now uses `historical_record_shared` first, falls back to plain-text session message if template is missing/unapproved |
| `src/services/historical-record-pdf.service.js` | Header line shows the doctor signature block + clinic name; emits a clean professional EMR layout that mirrors Prescription/Certificate |
| `src/utils/date.js` | No breaking changes — `parseDateOnly`/`parseDateOnlyOrNull` already robust |
| `prisma/schema.prisma` | Unchanged — all v3.4.4 features use already-deployed columns/tables (`PreviousRecordAttachment`) from `20260817120000_historical_records_pro` |
| `docs/META_WHATSAPP_TEMPLATES_v3.4.4.md` (NEW) | Exact template spec — names, category, body, variables, buttons, sample values for Meta approval |
| `docs/META_WHATSAPP_TEMPLATES_ADDENDUM.md` | Kept as-is; cross-references the new file |
| `MIGRATION_v3.4.4.md` | This file |
| `CHANGELOG.md` | New entry at the top |

---

## Architecture decisions (process notes)

### Why a shim and not a single rewrite?

The original crash came from an older deploy activating a stale
require path. A migration that rewrites every controller to a new
path is risky on a long-running production. A back-compat shim:

- Costs ~ 30 lines (`src/utils/asyncHandler.js`)
- Has identical runtime behaviour (it re-exports the *same* function
  from the canonical module — zero double-wrapping, zero error loss)
- Keeps the historical controller compatible with any future
  legacy tooling
- Lets us roll forward at the speed of the safest module

### Why Option A only for cert dates?

Two competing flows + a reverse-calculation engine was producing
non-deterministic outcomes ("Set restDays = 5, the toDate is 14,
now change restDays = 3 → toDate updated AND fromDate drift AND
day count becomes inconsistent"). Removing the reverse path
collapses the state machine to one input → one output. The doctor
still owns manual overrides via `toDateOverride`.

### Why keep the old `DATE_RANGE` rendering, but stop creating it?

Existing rows in production still render correctly (the PDF service
falls back to `DATE_RANGE` styling when `durationType` is NULL or
`DATE_RANGE`). New rows always write `DATE_RANGE` semantics
internally but never expose a UI to construct them — there is exactly
ONE creation flow.

---

## API shape (Historical Records)

```
GET   /api/doctor/previous-records/permission                                  → { allowed }
GET   /api/doctor/patients/:patientId/previous-records                         → { success, records }
GET   /api/doctor/previous-records/:id                                         → { success, record }
POST  /api/doctor/patients/:patientId/previous-records        (multipart)      → 201 { success, record }
PUT   /api/doctor/previous-records/:id                        (multipart)      → { success, record }
DELETE /api/doctor/previous-records/:id                                        → { success }

POST  /api/doctor/previous-records/:id/attachments             (multipart)      → 201 { attachments: [...] }
POST  /api/doctor/previous-records/:id/attachments/:attId/replace  (multipart)  → { attachment }
DELETE /api/doctor/previous-records/:id/attachments/:attId                     → { success }

POST  /api/doctor/previous-records/:id/generate-pdf                            → { success, pdfUrl }
POST  /api/doctor/previous-records/:id/share                                   → { success, delivery, shareUrl }

GET   /api/files/share/:token                                                 → 303 / inline preview / attachment download
GET   /api/files/share-record/:token                                          → HTML landing → list of attachments
```

---

## API shape (Medical Certificate)

No new endpoints. **Same endpoints as v3.4.0**:

```
POST  /api/doctor/certificates                  { templateKey, reason, diagnosis?, restDays, fromDate, toDateOverride?, ... }
POST  /api/doctor/appointments/:id/certificate  (same body shape)
POST  /api/doctor/certificates/:id/send         { channels: ['whatsapp','email'] }
PUT   /api/doctor/certificates/:id              (PATCH semantics)
GET   /api/doctor/certificates
GET   /api/doctor/certificates/:id
```

**New input rule:** when `restDays` and `fromDate` are both
provided, the server stores `toDate = fromDate + (restDays - 1)`
unless `toDateOverride` is supplied. Any other input is accepted but
`toDate` will be `null` and the PDF will render as "consultation only".

---

## Back-compatibility guarantees

- `appointment.source = "MANUAL"` rows still read/write the same way.
- `medical_certificates.durationType` column legacy values still render.
- PDF files existing in `storage/historical-pdf/` keep working — the
  service wraps them in signed-file tokens at request time.
- Appointment booking, prescription, invoice, settlement — **not
  touched**. Only Historical Records and Certificate date logic
  were modified, and only additively.
