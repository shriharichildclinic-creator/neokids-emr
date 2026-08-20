# Meta WhatsApp Business Templates — Complete Inventory (v3.5.2)

This document lists **every** Meta WhatsApp Cloud API template the EMR requires, including the existing production templates and the templates introduced by the vaccination-reminder / notification-system extensions.

Templates are managed in **Meta Business Manager → WhatsApp Manager → Message Templates**.

---

## ⭐ NEW — Vaccination reminder template (this fix)

**Not yet created in Meta Business Manager.** This is a system-generated, age-based reminder from NeoKidsPro — not a personal message from a doctor — so **no doctor name is interpolated anywhere in this template.** Body variables dropped from 5 to 4 (the old `{{4}}` doctor-name slot is removed).

### `neokids_vacc_reminder_v1`

> First submission — create fresh in Meta Business Manager. Code defaults to `neokids_vacc_reminder_v1`; if you name it differently in Meta, set `.env` → `WA_TPL_VACCINATION=<your-template-name>` to match.

- **Category:** `Utility`
- **Language:** `English (en)`
- **Header:** *None* (text-only)
- **Body (4 variables) — paste EXACTLY, including the blank lines:**

```
Hi {{1}}'s parent, this is a system-generated reminder that {{1}}'s vaccination {{2}} falls due on {{3}} as per the standard vaccination schedule for your child's age.

{{4}}

What you can do:
- If the vaccination is due, or you're unsure whether your child has already received it, please consult your nearest healthcare provider.
- Book an online pediatric consultation through NeoKidsPro at https://neokidspro.in for questions on schedule, eligibility, missed doses, catch-up vaccinations, or vaccine safety.
- In Mumbai? VaxiClinics at https://vaxiclinics.com administers vaccinations for children and also offers home-vaccination visits where available.

This is an automated reminder and does not replace professional medical advice.

— NeoKidsPro
```

- **Footer (optional but recommended):**
  ```
  Reply STOP to opt out of vaccination reminders.
  ```
- **Buttons:** ONE **static** Call-to-action → Visit website button.
  - Type: **Static URL** (no dynamic suffix — the button URL is fixed)
  - Label: `Visit Vaccination Portal`
  - URL:   `https://vaxiclinics.com/`
- **Variable mapping (code: `vaccination.service.js → sendReminderForVaccine`):**
  - `{{1}}` = Child name
  - `{{2}}` = Vaccine name (e.g. `DTwP/DTaP - 2`)
  - `{{3}}` = Due date (`DD MMM YYYY`)
  - `{{4}}` = Mandatory disclaimer, sent verbatim from the code:
    ```
    This is an automated reminder generated from your child's recorded date of birth and standard vaccination schedules. We do not maintain records of vaccinations administered outside NeoKidsPro and cannot confirm whether this vaccine is pending, overdue, or already completed. Please consult a qualified pediatrician.
    ```
- **Sample values for Meta approval:**
  - `{{1}}` = `Aarav`
  - `{{2}}` = `DTwP/DTaP - 2`
  - `{{3}}` = `27 Aug 2026`
  - `{{4}}` = the disclaimer text above (verbatim)

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
    "name": "neokids_vacc_reminder_v1",
    "language": { "code": "en" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Aarav" },
          { "type": "text", "text": "DTwP/DTaP - 2" },
          { "type": "text", "text": "27 Aug 2026" },
          { "type": "text", "text": "This is an automated reminder generated from your child's recorded date of birth and standard vaccination schedules. We do not maintain records of vaccinations administered outside NeoKidsPro and cannot confirm whether this vaccine is pending, overdue, or already completed. Please consult a qualified pediatrician." }
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

> **Note (this fix):** `{{2}}` for `medical_certificate_ready` is now always the **issuing doctor's name** (e.g. `Dr. Vishal Parmar`) — never the clinic/hospital name. The template shell itself (variable count/type) is unchanged, so **no Meta resubmission is required** — only the value the code sends into `{{2}}` changed.

---

## How to submit the new vaccination template

1. Log in to **[business.facebook.com](https://business.facebook.com/)** with the WABA owner account.
2. Left sidebar → **WhatsApp Manager** → open your WABA → **Message templates** → **Create template**.
3. Fill:
   - **Category:** `Utility`
   - **Name:** `neokids_vacc_reminder_v1`
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
    WA_TPL_VACCINATION=neokids_vacc_reminder_v1
    ```
    No code change is required.
