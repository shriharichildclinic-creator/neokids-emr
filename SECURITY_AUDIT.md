# NeoKidsPro EMR — Security Audit & Hardening Report (v3.4.15-sec)

Scope: full backend (`src/`), Prisma schema, and the booking widget /
admin / doctor front-ends. Every fix is surgical; no routes were removed,
no payloads renamed, no tech-stack or feature changes.

## Verdict on the 11 reported findings

| # | Finding | Present? | Action |
|---|---------|----------|--------|
| 1 | Production secrets in .env / backups / logs / configs | **NO** — no `.env*` in the bundle; all secrets via `process.env`; seed refuses known-default passwords; JWT refuses placeholder secrets in production. | Nothing to fix. Added no code. |
| 2 | Aadhaar / PAN / KYC docs public without auth | **YES (CRITICAL)** — `express.static` on `/files/kyc-documents` served identity documents to anyone with the URL. | Removed the static mount; added authenticated `GET /api/admin/kyc/:doctorId/:kind` (admin JWT, path-contained, `no-store`). Admin panel links rewritten + Bearer-token click handler. |
| 3 | Cancelled paid appointments in settlements/payouts | **YES (HIGH)** — `buildEligibleApptWhere` filtered on `paymentStatus:'PAID'` only, so a cancelled-but-paid consult still counted toward the doctor's settlement. | Eligibility now also requires `status IN (CONFIRMED, COMPLETED)`. Applies to settlements, revenue report, doctor earnings breakdown. |
| 4 | Login timing email/user enumeration | **YES (MEDIUM)** — unknown email returned in ~ms, known email + wrong password took a full bcrypt round (~100 ms). | Unknown-email path now performs a dummy `bcrypt.compare` against a boot-time synthetic hash → equal timing. |
| 5 | Duplicate patient creation race during booking | **PARTIAL** — `findOrCreatePatient` wrapped the lookup+create in a transaction but at default isolation; two concurrent bookings could still both insert. | Transaction now runs at `Serializable` with one P2034 retry; the P2002 slot catch is idempotent (re-returns your own live booking instead of a bare 409). |
| 6 | Cron/reminder overlap → duplicate sends | **YES (MEDIUM)** — 5-min `setInterval` had no re-entrancy guard; reminder dedup was read-then-write (TOCTOU). | Added in-process `_jobsInFlight` guard + 10-min watchdog in `runLifecycleJobs`; reminders are now claimed atomically via a unique `claimKey` on `notification_logs` (loser gets P2002 and skips). |
| 7 | Reminder window too narrow → missed reminders | **YES (MEDIUM)** — window was delta ∈ [28,33] min, i.e. ~5 one-minute ticks against a 5-minute cron. | Window widened to [15,45] min (env-tunable via `REMINDER_WINDOW_MIN/MAX_MINUTES`); the atomic claim keeps it to exactly one send per appointment. |
| 8 | Reschedule returns raw 500 on slot conflict | **NO** — slot conflict already returns HTTP 409; the global error handler already translates Prisma/validation errors into clean 4xx. | Nothing to fix. |
| 9 | Cashfree checkout cancel not handled in UI | **YES (MEDIUM)** — the widget's `.then()` only acted on a confirmed payment, so dismissing the Cashfree modal left a stuck "Verifying payment…" spinner. | `checkout().then()` now treats a non-paid resolution as immediate cancel/abandon (overlay torn down, failure screen shown, retry path offered); `.catch()` does the same. |
| 10 | Doctor cancel lacks financial-consequence visibility | **NO (after #3)** — a doctor-cancelled appointment now contributes ₹0 to settlements/earnings, so there is no hidden financial consequence left to surface. No code change needed beyond #3. | Covered by fix #3. |
| 11 | Doctor can't see/search another doctor's patients | **NO (already fixed)** — `searchPatients`, `patientHistory`, certificate & previous-record creation all run through `doctorOwnsPatient`/`myPatientIdSet`. | Verified, no change. |

## Additional hardening applied

- **Upload extension allow-lists** (`upload.js`): every multer filter now whitelists the on-disk extension in addition to the client-supplied MIME (profile: `.jpg/.jpeg/.png/.webp`; KYC: +`.pdf`; signature: `.png/.jpg/.jpeg`; historical Rx: `.pdf/.jpg/.jpeg/.png`).
- **SVG removed** from drawn-signature uploads (SVG can carry script) — PNG only, in both the controller and the Zod schema.
- **Public share routes** (`/api/files/share*`) now send `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store` so shared medical records are not cached by browsers/intermediaries.

## Migration included

`prisma/migrations/20260819090000_reminder_claim_unique/migration.sql`
adds `claimKey VARCHAR(191) NULL` + a unique index (idempotent —
`IF NOT EXISTS`) to `notification_logs`. Run `prisma migrate deploy`.

## Verification performed

`node --check` passed on every modified JS file (all 13); every inline
`<script>` block in `booking-widget.html` parses. Prisma schema updated
consistently with the migration.
