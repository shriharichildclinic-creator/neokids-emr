# Notification System — Extensions (v3.2)

This document describes the two extensions layered **on top of** the
existing production notification architecture. Nothing in the existing
Email/WhatsApp flow was replaced; both features are additive.

## 1. WhatsApp PDF Sharing (Prescription & Invoice)

New module: `src/services/whatsapp-media.service.js`

Flow:
1. When `onPrescriptionCreated()` or `onOnlineBookingConfirmed()`
   generates a PDF via `pdf.service.js`, the file lands under
   `storage/prescriptions/<id>.pdf` or `storage/invoices/<id>.pdf`.
2. **Existing email attachment path continues to run unchanged.**
3. In addition, the file is uploaded to Meta via
   `POST /v19.0/{PHONE_ID}/media`, yielding a `media_id`.
4. A `document`-header template message is sent to the patient
   (`neokids_prescription_pdf` or `neokids_invoice_pdf`).
5. Success / failure is logged into `notification_logs` with
   `channel = WHATSAPP` — same table used by every existing
   notification, so admins already have a UI for it.

The WhatsApp send is wrapped in try/catch — a failure never blocks
email delivery or the prescription-completion transaction.

## 2. Vaccination Reminder Automation

New module: `src/services/vaccination.service.js`

- The IAP-style schedule (see `docs/VACCINATION_SCHEDULE.md`) is
  expanded per patient from `Patient.dateOfBirth`.
- The daily lifecycle tick calls `processVaccinationReminders()` once
  per calendar day (dedup lives in `NotificationLog`, guarded also in
  `lifecycle.service.js`).
- For every vaccine whose due date falls within `VACC_APPROACH_DAYS`
  (default: 7 days), both channels are dispatched:
  - **WhatsApp template** `neokids_vaccination_reminder`
    (child, vaccine, due date, doctor + booking-link button).
  - **Email** — rendered inline by `buildEmailHtml()`.
- Both messages nudge the parent to **book a vaccination consultation
  with Dr. Vishal Parmar** (configurable via `VACC_DOCTOR_NAME`).
