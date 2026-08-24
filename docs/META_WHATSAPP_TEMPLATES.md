# Meta WhatsApp Business Templates — Complete Inventory (v3.5.3)

This document lists every Meta WhatsApp Cloud API template the EMR requires, including the existing production templates and the templates introduced below.

Templates are managed in **Meta Business Manager → WhatsApp Manager → Message Templates**.

---

## ⭐ NEW — Staff invite template (this fix)

Used when an admin clicks **Send Invite (WhatsApp)** on a doctor (or, once wired up, a receptionist/pharmacy user). Delivers the same one-time account-activation link as the email invite, over WhatsApp instead.

### `neokids_staff_invite_v1`

> Not yet created in Meta Business Manager. Code defaults to `neokids_staff_invite_v1`; if you name it differently in Meta, set `.env` → `WA_TPL_STAFF_INVITE=<your-template-name>` to match.

- **Category:** `Utility`
- **Language:** `English (en)`
- **Header:** *None* (text-only)
- **Body (3 variables) — paste EXACTLY:**

```
Hi {{1}}, you've been added as a {{2}} on NeoKidsPro.

Tap below to set your password and activate your account. This link expires in {{3}}.

If you weren't expecting this, you can ignore this message.

— NeoKidsPro
```

- **Buttons:** ONE **dynamic** Call-to-action → Visit website button.
  - Type: **Dynamic URL**
  - Label: `Activate Account`
  - Base URL: `{EMR_URL}/assets/reset-password.html?token=` (use your actual `EMR_URL`, no trailing slash before `/assets`)
  - Dynamic suffix `{{1}}` = the raw invite token
- **Variable mapping (code: `invite.service.js → sendStaffInviteWhatsApp`):**
  - Body `{{1}}` = Staff member's name
  - Body `{{2}}` = Role label (`Doctor`, `Receptionist`, `Pharmacy`)
  - Body `{{3}}` = TTL, e.g. `1 day` (derived from `INVITE_TOKEN_TTL_MINUTES`)
  - Button `{{1}}` = raw invite token (same token embedded in the email invite link)
- **Sample values for Meta approval:**
  - `{{1}}` = `Vishal Parmar`
  - `{{2}}` = `Doctor`
  - `{{3}}` = `1 day`
  - Button sample suffix = `a1b2c3d4e5f6`

If the template isn't approved yet, or Meta rejects it, the send automatically falls back to a plain-text message (works only inside the 24h customer-care window) — see `sendWhatsAppWithFallback` in `whatsapp.service.js`.

---

## Vaccination reminder template (already live)

### `neokids_vacc_reminder_v2`

This is a system-generated, age-based reminder from NeoKidsPro — not a personal message from a doctor — so no doctor name is interpolated anywhere in this template.

- **Category:** `Utility`
- **Language:** `English (en)`
- **Header:** *None* (text-only)
- **Body (4 variables):**

```
Hi {{1}}'s parent, this is a reminder that {{1}}'s {{2}} vaccination is due on {{3}}.

{{4}}

Have questions about the vaccination schedule, eligibility, or missed doses? Visit NeoKidsPro to book an online consultation. If you're a Mumbai parent, VaxiClinics also offers in-person and home vaccination visits.

— NeoKidsPro
```

> Rewritten from `v1`: the previous body was rejected by Meta for ending its content too close to a variable-driven line with no closing static sentence. This version keeps the same 4 variables but always closes on plain static text ("— NeoKidsPro"), never a variable.

- **Footer:**
  ```
  Reply STOP to opt out of vaccination reminders.
  ```
- **Buttons:** ONE **static** Call-to-action → Visit website button.
  - Type: **Static URL** (no dynamic suffix)
  - Label: `Visit Vaccination Portal`
  - URL:   `https://vaxiclinics.com/`
- **Variable mapping (code: `vaccination.service.js → sendReminderForVaccine`):**
  - `{{1}}` = Child name
  - `{{2}}` = Vaccine name (e.g. `DTwP/DTaP - 2`)
  - `{{3}}` = Due date (`DD MMM YYYY`)
  - `{{4}}` = Mandatory disclaimer, sent verbatim from the code:
    ```
    This is an automated reminder generated from your child's recorded date of birth and standard vaccination schedules. NeoKidsPro does not administer vaccines and has no record of vaccinations your child may have already received elsewhere, so we cannot confirm whether this vaccine is pending, overdue, or already completed. Please consult a qualified pediatrician.
    ```
- **Sample values for Meta approval:**
  - `{{1}}` = `Aarav`
  - `{{2}}` = `DTwP/DTaP - 2`
  - `{{3}}` = `27 Aug 2026`
  - `{{4}}` = the disclaimer text above (verbatim)
- **Env:** `WA_TPL_VACCINATION=neokids_vacc_reminder_v2`

---

## ⭐ Ready-to-paste JSON payload (what the code sends to Meta)

You do **NOT** need to code this — the service builds it — but here is the exact payload for reference / debugging:

```jsonc
POST https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages
Authorization: Bearer {META_ACCESS_TOKEN}
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "to": "919XXXXXXXXX",
  "type": "template",
  "template": {
    "name": "neokids_vacc_reminder_v2",
    "language": { "code": "en" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Aarav" },
          { "type": "text", "text": "DTwP/DTaP - 2" },
          { "type": "text", "text": "27 Aug 2026" },
          { "type": "text", "text": "This is an automated reminder generated from your child's recorded date of birth and standard vaccination schedules. NeoKidsPro does not administer vaccines and has no record of vaccinations your child may have already received elsewhere, so we cannot confirm whether this vaccine is pending, overdue, or already completed. Please consult a qualified pediatrician." }
        ]
      }
    ]
  }
}
```

The URL button is **static**, so no `type:"button"` component is sent (this is intentional — Meta only requires a button-component in the request when the button URL has a dynamic suffix). The button URL is fixed at the template level.

---

## Existing templates (retained, unchanged)

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
| 12 | `neokids_prescription_pdf` | 2 | — (DOCUMENT header) |
| 13 | `neokids_invoice_pdf` | 3 | — (DOCUMENT header) |
| 14 | `medical_certificate_ready` | 3 | — (DOCUMENT header) |
| 15 | `neokids_staff_invite_v1` | 3 | Dynamic (token suffix) |
| 16 | `neokids_vacc_reminder_v2` | 4 | Static |

> **Note (this fix):** `{{2}}` for `medical_certificate_ready` is now always the **issuing doctor's name** (e.g. `Dr. Vishal Parmar`) — never the clinic/hospital name. The template shell itself (variable count/type) is unchanged, so **no Meta resubmission is required** — only the value the code sends into `{{2}}` changed.

---

## How to submit the new templates

### `neokids_staff_invite_v1`

1. Log in to **[business.facebook.com](https://business.facebook.com/)** with the WABA owner account.
2. Left sidebar → **WhatsApp Manager** → open your WABA → **Message templates** → **Create template**.
3. Fill:
   - **Category:** `Utility`
   - **Name:** `neokids_staff_invite_v1`
   - **Language:** `English`
4. **Header:** *None*.
5. **Body:** paste the body block from the section above exactly, including the placeholders `{{1}}..{{3}}`.
6. **Buttons:** click **Add button → Call-to-action → Visit website**, then:
   - Type: **Dynamic**
   - Button text: `Activate Account`
   - Website URL: `{EMR_URL}/assets/reset-password.html?token={{1}}` (replace `{EMR_URL}` with your real domain)
7. Fill the sample values shown above.
8. **Submit**. Approval usually takes 1–60 minutes.
9. Once **Approved**, set (or confirm) in `.env`:
   ```
   WA_TPL_STAFF_INVITE=neokids_staff_invite_v1
   ```
   No code change is required.

### `neokids_vacc_reminder_v2`

1. Log in to **[business.facebook.com](https://business.facebook.com/)** with the WABA owner account.
2. Left sidebar → **WhatsApp Manager** → open your WABA → **Message templates** → **Create template**.
3. Fill:
   - **Category:** `Utility`
   - **Name:** `neokids_vacc_reminder_v2`
   - **Language:** `English`
4. **Header:** *None*.
5. **Body:** paste the body block from the section above **exactly**, including the placeholders `{{1}}..{{4}}` and the blank lines.
6. **Footer:** `Reply STOP to opt out of vaccination reminders.`
7. **Buttons:** click **Add button → Call-to-action → Visit website**, then:
   - Type: **Static**
   - Button text: `Visit Vaccination Portal`
   - Website URL: `https://vaxiclinics.com/`
8. Fill the sample values shown above (Meta rejects templates whose samples don't satisfy content policy — do NOT use `test`, `xxx`, etc.).
9. **Submit**. Approval usually takes 1–60 minutes.
10. Once **Approved**, set (or confirm) in `.env`:
    ```
    WA_TPL_VACCINATION=neokids_vacc_reminder_v2
    ```
    No code change is required.
