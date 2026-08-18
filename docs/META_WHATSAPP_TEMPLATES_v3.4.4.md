# Meta WhatsApp Business Templates — v3.4.4 (Certificate + Historical Record Sharing)

This document lists **every** Meta WhatsApp Cloud API template the EMR
needs for v3.4.4 in addition to those already in the system. It is
additive: templates used by prescriptions / bookings / reminders are
unchanged.

Templates are managed in
**Meta Business Manager → WhatsApp Manager → Message templates → Create template**.

All new templates are category **`UTILITY`** and language **`en`** unless
noted otherwise.

---

## A. `medical_certificate_ready`  (re-submit if missing)

Already listed in `META_WHATSAPP_TEMPLATES.md` (N4) but updated for
v3.4.4 to match the new Option-A derived body.

- **Header:** Document (dynamic media id + filename `medical_certificate_<certNumber>.pdf`).
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
- **Variables:**
  - `{{1}}` Patient Name
  - `{{2}}` Clinic Name (falls back to `Dr. <name>`)
  - `{{3}}` Certificate date — uses the doctor's effective end date
    (Option A: `fromDate + restDays - 1`); falls back to `fromDate`
    when no `restDays` is present.
- **Sample values for approval:**
  - `{{1}}` = `Aarav Sharma`
  - `{{2}}` = `NeoKidsPro Pediatric Clinic`
  - `{{3}}` = `14 Aug 2026`
- **Env override:** `WA_TPL_CERTIFICATE_PDF` (defaults to `medical_certificate_ready`)

---

## B. `historical_record_shared`  (NEW — required for sharing)

Create exactly as below. The backend (`historical-record.service.js →
deliver()`) sends this template when a doctor taps "Share via
WhatsApp" on a Historical Record.

- **Category:** Utility
- **Header:** none (text-only).
- **Body (6 vars):**
  ```
  Hello {{1}},

  {{2}} has shared a medical record for your reference.

  Record Type: {{3}}
  Record Date: {{4}}

  You can access the document using the secure link below:
  {{5}}

  For assistance, contact: {{6}}

  Regards,
  NeoKidsPro
  ```
- **Variables:**
  - `{{1}}` Patient Name
  - `{{2}}` Doctor Name (rendered as `Dr. <name>`)
  - `{{3}}` Human record type (`Lab Report`, `Radiology / Imaging`, `Prescription`, ...)
  - `{{4}}` Record Date (`12 May 2024` style)
  - `{{5}}` Secure record URL (HMAC-signed, expires in 7 days)
  - `{{6}}` Clinic Name (env `CLINIC_NAME`, default `NeoKidsPro Clinic`)
- **Buttons:** 1 × `Call-to-action → Visit website → Dynamic URL` button
  with label **`View Record`**, suffix = `{{5}}`. The button base URL
  must be the prod domain with no trailing slash, e.g.
  `https://app.neokidspro.com`.
  If Meta rejects putting a path inside the dynamic URL base, leave the
  base as the production domain and pass only the signed token as the
  dynamic suffix; the controller generated URL already points at
  `/api/files/share-record/<token>` so just use the full URL prefixed
  with the domain for a static base and the token as a suffix.
- **Sample values for approval:**
  - `{{1}}` = `Aarav Sharma`
  - `{{2}}` = `Dr. Vishal Parmar`
  - `{{3}}` = `Lab Report`
  - `{{4}}` = `12 May 2024`
  - `{{5}}` = `app.neokidspro.com/api/files/share-record/abcd1234…`
  - `{{6}}` = `NeoKidsPro Clinic`

---

## C. `historical_record_share_attachments`  (NEW — sending attachments in bulk)

This is the OPTIONAL Variant used when the doctor picks "Share selected
attachments" instead of "Share full record". It uses a DOCUMENT header
so multiple PDFs / images are sent inline rather than a single link.

- **Category:** Utility
- **Header:** Document (dynamic media id, filename `<originalName>`).
- **Body (4 vars):**
  ```
  Hello {{1}},

  {{2}} has shared {{3}} medical attachment(s) with you.

  Please find the documents attached below.

  Regards,
  NeoKidsPro
  ```
- **Variables:**
  - `{{1}}` Patient Name
  - `{{2}}` Doctor Name
  - `{{3}}` Attachment count (number, e.g. `3`)
  - `{{4}}` Clinic Name (env `CLINIC_NAME`)
- **Buttons:** none.
- **Note:** Meta Cloud API accepts only ONE document per template
  message. To send N attachments, the system sends one
  `historical_record_share_attachments` per attachment in a loop
  (`seq 1..n`). The first carries `{{3}} = "<n> (1 of N)"` so the
  patient sees the total in the very first reply.

The system still creates the `historical_record_shared` text-template
above for the FULL record (with the secure sign-in link); this
attachment variant is fired IN ADDITION to it when attachments were
selected.

---

## Why two templates?  (audit trail)

- `historical_record_shared` — single secure URL the patient opens in
  a browser; works without uploading files to Meta and is the default
  when the doctor just wants "send me my record".
- `historical_record_share_attachments` — uploads the actual PDFs /
  JPGs directly into WhatsApp so the patient doesn't have to follow a
  link. Requires the patient to be inside an open 24-h window OR the
  template to be pre-approved (which is why we make it a UTILITY
  Business template).

---

## D. How to create and submit each template

Do this once per template.

1. Log in to **[business.facebook.com](https://business.facebook.com/)**
   with the WABA owner login.
2. **WhatsApp Manager** → open the WABA →
   **Message templates** → **Create template**.
3. Fill in:
   - **Name** — copy the exact name from sections A / B / C above.
   - **Category** → **Utility** for all three.
   - **Language** → **English** (matches `META_LANG_CODE=en`).
4. **Header:** choose the matching option. Document headers must NOT
   upload a sample — the code supplies a media id at send time.
5. **Body:** paste the body text exactly, including the `{{n}}`
   placeholders.
6. **Buttons:** add `Visit website → Dynamic URL` for
   `historical_record_shared` only.
7. **Sample values:** paste the sample values from sections A / B / C.
   Meta rejects templates whose sample values don't satisfy content
   policies — never substitute `xxx` or `test`.
8. **Submit.** Approval typically 1–60 minutes.
9. Once approved, no code change required — env keys point to the
   template names:
   - `WA_TPL_CERTIFICATE_PDF` (defaults to `medical_certificate_ready`)
   - `WA_TPL_HISTORICAL_SHARE` (defaults to `historical_record_shared`)
   - `WA_TPL_HISTORICAL_SHARE_FILES` (defaults to `historical_record_share_attachments`)

> Until a template is approved the backend falls back to a plain-text
> session message (valid only inside the 24-h customer-care window);
> sharing never hard-fails — `delivery.whatsapp` in the API response
> surfaces `{ status: "fallback_text_sent" | "skipped" | "failed", ... }`.

---

## E. Email — no template change required

`historical-record.service.js → deliver({ channel: 'email', ... })`
sends via the existing `email.service.js` transport
(SMTP/SendGrid/MOCK). Subject: `Medical Record Shared — <patient> (<date>)`,
HTML body previews the secure link (expires in 7 days) and lists every
attachment selected in the share dialog. **No external template
upload needed.**
