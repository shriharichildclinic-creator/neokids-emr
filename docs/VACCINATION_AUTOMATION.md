# Vaccination Automation — How It Works (v3.5.2)

## One-paragraph summary

Every 5 minutes the server runs a lifecycle cron. **Only during 18:00–20:00 IST** (parent-friendly window, configurable) does that cron let the vaccination scan actually dispatch. When it runs, the scan reads every Patient with a `dateOfBirth`, expands the IAP paediatric vaccination schedule against that DOB, and picks any vaccine whose due date falls in the next 7 days. For each such (patient, vaccine, due-date), it atomically inserts a unique **claim row** in `NotificationLog` (unique DB index) — if that claim already exists (from an earlier tick, a previous day, or a parallel run), the reminder is silently skipped. If the claim wins, the service sends **one WhatsApp** (via the `neokids_vacc_reminder_v1` Meta template, once approved) **and one Email** (branded NeoKidsPro template) **only to the child's registered parent contact** — never to doctors, admins, or staff (they live in separate tables and staff-looking emails/names are filtered out). Both messages are system-generated (no doctor name anywhere) and include the mandatory disclaimer, the "consult a healthcare provider" clause, the NeoKidsPro booking link, and the VaxiClinics vaccination-portal link (guidance, in-person vaccination, and home visits in Mumbai). Once sent, that same (patient, vaccine, due-date) can **never** be sent again — the parent gets the next reminder only when the child reaches a **new age bucket** for which a **new** vaccine becomes due.

---

## Order of gates every reminder must pass

1. **Ops switch** — `VACC_REMINDERS_ENABLED` must not be `false`.
2. **Delivery window** — current IST hour must be inside `[VACC_WINDOW_START_HOUR_IST, VACC_WINDOW_END_HOUR_IST)`. Default 18:00–20:00 IST. This is the fix for the 5:20 AM regression.
3. **Once-per-day guard** — the lifecycle cron only calls the scan the FIRST time each IST calendar day the window is open (further 5-min ticks in the same window skip).
4. **Recipient eligibility** — `isEligibleRecipient(patient)` drops any row whose email/name looks like `admin@`, `doctor@`, `staff@`, `support@`, `noreply@`, or belongs to `neokidspro.in` / `vaxiclinics.com` (configurable via `STAFF_EMAIL_DOMAINS`).
5. **Approach window** — the vaccine's due date must fall in the next `VACC_APPROACH_DAYS` days (default 7).
6. **Atomic dedup claim** — `NotificationLog.claimKey = VACC:<patientId>:<vaccineCode>:<dueDate>` is unique-indexed at the DB level. Second attempts throw P2002 and skip.

Only when all 6 gates pass does the service send WhatsApp + Email.

---

## Answer to Scenario A (multiple consultations, same child)

Booking multiple consultations for the same child on Monday/Thursday etc. does **not** touch the vaccination pipeline at all — vaccinations are keyed by `(patientId, vaccineCode, dueDate)`, never by appointment. Since claimKey is unique-indexed:

- Monday reminder fires ✅
- Thursday: same `(patientId, code, dueDate)` → P2002 → **skipped**
- Same next day / week / month → **skipped**
- Only when the child crosses into a new age bucket (e.g. `MMR-1` due at 9 months after `DTwP-3` was due at 14 weeks) does a NEW claimKey exist → NEW reminder is sent, once.

Run `node scripts/test-vaccination-reminders.js --force` twice back-to-back; the 2nd invocation MUST report `sent: 0, skippedDedup > 0`. Proof is emitted at the tail of the script output.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VACC_REMINDERS_ENABLED` | `true` | Master kill-switch. |
| `VACC_APPROACH_DAYS` | `7` | How many days ahead of due date the reminder fires. |
| `VACC_WINDOW_START_HOUR_IST` | `18` | Earliest hour (24h IST) reminders can send. |
| `VACC_WINDOW_END_HOUR_IST` | `20` | Exclusive upper bound. |
| `VACC_PORTAL_URL` | `https://vaxiclinics.com/` | VaxiClinics link. |
| `NEOKIDS_URL` | `https://neokidspro.in/` | NeoKidsPro booking link. |
| `WA_TPL_VACCINATION` | `neokids_vacc_reminder_v1` | Meta template name. |
| `STAFF_EMAIL_DOMAINS` | `neokidspro.in,vaxiclinics.com` | Comma-list of domains never eligible. |
| `CLINIC_NAME` | `NeoKidsPro Clinic` | Shown in copy. |

---

## Endpoints for testing

- `POST /api/admin/jobs/vaccination-reminders/run` — respects the delivery window.
- `POST /api/admin/jobs/vaccination-reminders/run?force=1` — QA override, ignores the window.

Both return: template name, portal URL, delivery-window range, whether the run was forced, provider/SMTP/META config flags, and per-run counts (`considered`, `sent`, `skippedDedup`, `skippedIneligible`, `skippedWindow`).
