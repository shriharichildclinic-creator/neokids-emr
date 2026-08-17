# Meta WhatsApp Business Templates — Complete Inventory

This document lists **every** Meta WhatsApp Cloud API template the EMR requires, including the existing production templates and the **three new templates** introduced by the notification-system extension.

Templates are managed in **Meta Business Manager → WhatsApp Manager → Message Templates**.

---

## 1. New templates introduced by this release

| # | Template name | Category | Language | Header | Body vars | Buttons |
|---|---|---|---|---|---|---|
| N1 | `neokids_prescription_pdf`   | UTILITY | en | DOCUMENT | 2 | — |
| N2 | `neokids_invoice_pdf`        | UTILITY | en | DOCUMENT | 3 | — |
| N3 | `neokids_vaccination_reminder` | UTILITY | en | TEXT (none) | 4 | 1 URL button |
| N4 | `medical_certificate_ready`  | UTILITY | en | DOCUMENT | 3 | — |

---

### N1. `neokids_prescription_pdf`

- **Category:** Utility
- **Language:** English
- **Header:** `DOCUMENT` (dynamic — the media id of the uploaded PDF is supplied at send time)
- **Body (2 vars):**
  ```
  Hi {{1}}, your prescription from Dr. {{2}} is attached.
  Please follow the medication and advice as noted. For any questions,
  reply to this message.

  — NeoKidsPro
  ```
- **Buttons:** none.
- **Sample values for approval:**
  - `{{1}}` = `Aarav`
  - `{{2}}` = `Vishal Parmar`

---

### N2. `neokids_invoice_pdf`

- **Category:** Utility
- **Language:** English
- **Header:** `DOCUMENT`
- **Body (3 vars):**
  ```
  Hi {{1}}, thank you for choosing NeoKidsPro.
  Your invoice {{2}} for ₹{{3}} is attached.

  — NeoKidsPro
  ```
- **Buttons:** none.
- **Sample values for approval:**
  - `{{1}}` = `Aarav`
  - `{{2}}` = `INV-3F2A9B10`
  - `{{3}}` = `500.00`

---

### N4. `medical_certificate_ready`  (v3.4.0)

- **Category:** Utility
- **Language:** English
- **Header:** `DOCUMENT` (dynamic — media id of the uploaded certificate PDF supplied at send time; filename `medical_certificate_<certNumber>.pdf`)
- **Body (3 vars):**
  ```
  Hello {{1}},

  Your medical certificate from {{2}} is ready.

  Certificate Date: {{3}}

  If you have any questions, please contact the clinic.

  Regards,
  {{2}}
  ```
- **Buttons:** none.
- **Variable mapping (code: `whatsapp-media.service.js → sendCertificatePdf`):**
  - `{{1}}` = Patient name
  - `{{2}}` = Clinic name (falls back to `Dr. <name>` when the doctor has no clinic configured)
  - `{{3}}` = Certificate date — the single-day date, else the rest-period start, else the issue date
- **Sample values for approval:**
  - `{{1}}` = `Aarav Sharma`
  - `{{2}}` = `NeoKidsPro Pediatric Clinic`
  - `{{3}}` = `17 Aug 2026`
- **Env override:** `WA_TPL_CERTIFICATE_PDF` (defaults to `medical_certificate_ready`)

---

### N3. `neokids_vaccination_reminder`

- **Category:** Utility
- **Language:** English
- **Header:** none (text-only).
- **Body (4 vars):**
  ```
  Hi {{1}}, this is a friendly reminder that {{1}}'s next vaccination
  ({{2}}) is due on {{3}}.

  Please book a vaccination consultation with {{4}} so your child stays
  on schedule.

  — NeoKidsPro
  ```
- **Buttons:** one URL button, label “Book Vaccination”.
  ```
  https://neokidspro.in/assets/booking-widget.html?{{1}}
  ```
  The `{{1}}` URL suffix is filled at send time with:
  `vacc=<vaccine-code>&patient=<patient-id>`.
- **Sample values for approval:**
  - `{{1}}` = `Aarav`
  - `{{2}}` = `DTwP/DTaP - 2`
  - `{{3}}` = `24 Jul 2026`
  - `{{4}}` = `Dr. Vishal Parmar`
  - Button URL suffix: `vacc=DTwP%2FDTaP-2&patient=abcd1234`

---

## 2. Existing templates (retained, unchanged)

These templates already exist in Meta and continue to be used exactly as before. Names must match Meta verbatim.

| # | Template name | Body vars | URL button |
|---|---|---|---|
| 1 | `reschedule_online_v2` | 5 | Meet suffix |
| 2 | `neokids_reminder_online_v2` | 4 | Meet suffix |
| 3 | `neokids_reminder_offline_v2` | 4 | Maps suffix |
| 4 | `neokids_booking_confirms_offline_v2` | 5 | Maps suffix |
| 5 | `reschedule_offline` | 5 | Maps suffix |
| 6 | `cancellation_notice` | 4 | — |
| 7 | `doctor_new_booking_offline` | 5 | — |
| 8 | `doctor_new_booking_online_v2` | 5 | Meet suffix |
| 9 | `doctor_reminder_offline` | 3 | — |
| 10 | `neokids_online_appt_confirm_v2` | 6 | Meet suffix |
| 11 | `doctor_reminder_online` | 3 | Meet suffix |

---

## 3. How to create and submit for approval

Do this once per template listed in section 1.

1. Log in to **[business.facebook.com](https://business.facebook.com/)** with the WhatsApp Business Account (WABA) owner.
2. Left sidebar → **WhatsApp Manager** → open the WABA → **Message templates** → **Create template**.
3. Fill in:
   - **Category:** `Utility` (all three new templates are transactional).
   - **Name:** copy the exact name from section 1 (lowercase, underscores).
   - **Language:** `English` (matches `META_LANG_CODE=en`).
4. **Header:**
   - For `neokids_prescription_pdf` and `neokids_invoice_pdf`, choose **Media → Document**. Do **not** upload a sample document — the code supplies the media id at send time.
   - For `neokids_vaccination_reminder`, choose **None**.
5. **Body:** paste the body text from section 1 exactly, including the `{{n}}` placeholders.
6. **Footer:** optional — you can add `Reply STOP to opt-out.` for the vaccination template to comply with opt-out best practices.
7. **Buttons:**
   - For `neokids_vaccination_reminder`, add **Call-to-action → Visit website → Dynamic URL**, base `https://neokidspro.in/assets/booking-widget.html?`, and the button label `Book Vaccination`.
   - Other two templates: no buttons.
8. Provide **sample values** exactly as listed in section 1. Meta rejects templates whose samples don’t satisfy their content policies (do NOT put placeholders like “xxx” or “test”).
9. Click **Submit**. Approval typically takes 1–60 minutes.
10. Once **Approved**, no code change is required — the names in `.env` (see `WA_TPL_PRESCRIPTION_PDF`, `WA_TPL_INVOICE_PDF`, `WA_TPL_VACCINATION`) already point to them.

### Sending via API (documentation only — code already handles this)

The template with a document header is sent as:

```jsonc
POST /v19.0/{PHONE_NUMBER_ID}/messages
{
  "messaging_product": "whatsapp",
  "to": "919XXXXXXXXX",
  "type": "template",
  "template": {
    "name": "neokids_prescription_pdf",
    "language": { "code": "en" },
    "components": [
      {
        "type": "header",
        "parameters": [
          { "type": "document",
            "document": { "id": "<uploaded_media_id>",
                          "filename": "prescription_3F2A9B10.pdf" } }
        ]
      },
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Aarav" },
          { "type": "text", "text": "Vishal Parmar" }
        ]
      }
    ]
  }
}
```

The media id comes from a prior `POST /v19.0/{PHONE_NUMBER_ID}/media` multipart upload (handled by `whatsapp-media.service.js`).

---

## 4. Email template — vaccination reminder

The email template is generated at runtime by `vaccination.service.js → buildEmailHtml`. Its shape:

- **Subject:** `Vaccination reminder for {ChildName} — {Vaccine} due {Date}`
- **HTML body:**

  ```
  Dear {ParentName},

  This is a friendly reminder that {ChildName}'s next vaccination
  is due on {DueDate}.

    Vaccine       : {VaccineName}
    Scheduled at  : {AgeLabel, e.g. "6 weeks"}
    Due date      : {DueDate}

  Please book a vaccination consultation with {DoctorName} so your
  child stays on schedule.

     [ 📅 Book Vaccination Consultation ]    ← button

  If the button doesn't work, open this link:
  {BookingLink}
  ```

The template supports the following variables (populated automatically):

| Variable | Source |
|---|---|
| `{ParentName}` | `Patient.parentName` (fallback: “Parent”) |
| `{ChildName}` | `Patient.name` |
| `{VaccineName}` | e.g. `DTwP/DTaP - 2` |
| `{AgeLabel}` | e.g. `10 weeks` |
| `{DueDate}` | Localised, `DD MMM YYYY` |
| `{DoctorName}` | `VACC_DOCTOR_NAME` env — default **Dr. Vishal Parmar** |
| `{BookingLink}` | `PUBLIC_BOOKING_URL/assets/booking-widget.html?vacc=1&patient=<id>` |

Nothing needs to be uploaded to any external system for the email template — SMTP delivery uses the existing `email.service.js` transport (SendGrid / SMTP / mock).
