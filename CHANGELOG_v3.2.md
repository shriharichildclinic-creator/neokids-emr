# CHANGELOG — v3.2 (Notification System Extensions)

## Added
- **WhatsApp PDF sharing** (`src/services/whatsapp-media.service.js`)
  - Uploads Prescription and Invoice PDFs to Meta Cloud API and sends
    document-header templates: `neokids_prescription_pdf`, `neokids_invoice_pdf`.
- **Vaccination reminder automation** (`src/services/vaccination.service.js`)
  - IAP-based schedule expanded from `Patient.dateOfBirth`.
  - Sends WhatsApp + Email reminders when a dose falls within
    `VACC_APPROACH_DAYS` (default 7).
  - Encourages booking with **Dr. Vishal Parmar**.
- Docs: `docs/META_WHATSAPP_TEMPLATES.md`, `docs/VACCINATION_SCHEDULE.md`,
  `docs/NOTIFICATION_EXTENSIONS.md`.

## Changed
- `src/services/automation.service.js`
  - `onPrescriptionCreated` / `resendPrescription`: also share the PDF over
    WhatsApp (after the existing email path, non-blocking).
  - `onOnlineBookingConfirmed`: also share the invoice PDF over WhatsApp.
- `src/services/lifecycle.service.js`
  - Runs vaccination scan once per calendar day inside the existing
    lifecycle tick.
- `.env`: added `WA_TPL_PRESCRIPTION_PDF`, `WA_TPL_INVOICE_PDF`,
  `WA_TPL_VACCINATION`, `VACC_DOCTOR_NAME`, `VACC_APPROACH_DAYS`,
  `VACC_DOCTOR_ID`, `CLINIC_NAME`.

## Preserved (unchanged)
- `whatsapp.service.js` — existing template + fallback engine.
- `email.service.js` — existing SMTP transport.
- All existing Meta templates and their body-param shapes.
- Existing automations (booking confirms, reminders, reschedule,
  cancellation, follow-up recalls, doctor invites).
