# v3.4.0 — Medical Certificate Feature Rework

Production-ready rework of the Medical Certificate feature. Every fix is a
root-cause fix — no CSS patches, no duplicate components, no parallel logic.

## Deployment

1. `npm install` (unchanged — no new dependencies)
2. `npx prisma migrate deploy` — applies
   `prisma/migrations/20260817120000_certificate_v340_rework/migration.sql`
   (adds `durationType`, `certificateDate`, `consultationType` to
   `medical_certificates`; all nullable, existing rows render unchanged)
3. `npx prisma generate`
4. Create the Meta WhatsApp template `medical_certificate_ready`
   (see `docs/META_WHATSAPP_TEMPLATES.md` → N4) — UTILITY category,
   DOCUMENT header, 3 body variables
5. Restart the server

Optional env override: `WA_TPL_CERTIFICATE_PDF` (defaults to
`medical_certificate_ready`).

---

## 1. Consultation mode reflected in the certificate

- `MedicalCertificate.consultationType` snapshots the appointment's mode at
  issue time (`ONLINE` / `OFFLINE`), so editing the appointment later never
  retroactively rewrites an issued certificate.
- **In-Person (OFFLINE):** PDF shows the clinic name, clinic address and
  clinic contact block; body says "was examined at our clinic on …".
- **Online (ONLINE):** PDF shows `Dr. <name>` + qualification + a highlighted
  "Teleconsultation / Online Consultation" line — **no physical clinic
  address block**; body says "was examined via teleconsultation …"; the
  footer reads "issued electronically by Dr. … following a teleconsultation".
- Every certificate now prints `Consultation: Online Consultation / Clinic
  Visit` in the meta block.
- Files: `pdf.service.js` (`generateMedicalCertificate`),
  `certificate.controller.js`, `schema.prisma`.
- The issue modal also has a **Consultation mode** segmented control
  (pre-filled from the appointment; editable for standalone certificates).

## 2. Automated delivery

- Issuing a certificate now generates the PDF **and** delivers it via
  WhatsApp + email (each channel independently best-effort; a WhatsApp
  failure never blocks email). The API response carries a per-channel
  `delivery` summary and the UI toasts it ("Delivered: WhatsApp ✓ · Email ✓").
- New certificate **actions modal** (opened from the "Send" button in the
  certificates list, and available after generation): **View PDF ·
  Download PDF · Send on WhatsApp · Send via Email** — the same action set
  prescriptions expose.
- New endpoint: `POST /api/doctor/certificates/:id/send` with
  `{ channels: ['whatsapp','email'] }` (defaults to both). Returns
  `{ whatsapp: 'sent'|'failed'|'skipped', email: 'sent'|'no_email'|'skipped' }`.
- Files: `certificate.controller.js` (`deliverCertificate`, `send`),
  `automation.service.js` (`onCertificateIssued`), `doctor.routes.js`,
  `app.js` (`openCertActions`, `sendCertificateChannel`), `index.html`
  (`#certActionsModal`).

## 3. WhatsApp integration

- New `sendCertificatePdf()` in `whatsapp-media.service.js`, following the
  exact prescription pattern: upload the PDF to Meta (`/{phone-id}/media`)
  → send template `medical_certificate_ready` with a DOCUMENT header
  (media id) so it works **outside** the 24-hour window.
- Template contract (documented in `docs/META_WHATSAPP_TEMPLATES.md`):
  - `{{1}}` = patient name
  - `{{2}}` = clinic name (falls back to `Dr. <name>`)
  - `{{3}}` = certificate date (single-day date → rest start → issue date)
- Sends are recorded in `NotificationLog` (`SENT` / `FAILED` with Meta error
  codes), identical to prescriptions.
- Works with `WA_PROVIDER=MOCK` for local testing.

## 4. Email integration

- `onCertificateIssued` sends via the existing SMTP service with the PDF
  attached automatically:
  - Subject: `Medical Certificate – Dr. {{Doctor Name}}`
  - Body: "Hello {{Patient Name}}, your medical certificate has been
    generated and is attached to this email. Please find the certificate
    attached as a PDF." + certificate ID/date line + regards block.
- Patients with no email on file get `email: 'no_email'` in the delivery
  summary (surfaced in the UI) instead of a silent skip.

## 5. Three-dot menu bug

- **Root cause:** the overflow menu is portaled to `<body>` at
  `z-index:1200`, while modals sat at `z-index:100` — so the menu floated
  *above* the certificate modal until an outside click.
- **Fix:** (a) `.np-modal` raised to `z-index:1300`; (b) the "Medical
  certificate" menu item now calls `closeOverflowMenus()` first;
  (c) `npOpenModal()` — used by every modal open — closes any open overflow
  menu as a global invariant. Works on desktop and mobile.

## 6. Patient search UX

- **Root-cause backend fix:** `searchPatients` previously only searched
  patients who already had an appointment **with this doctor** — patients
  registered by reception or seen by another doctor were unfindable. It now
  searches the full patient directory (per-doctor last-visit enrichment is
  retained and still scoped to the doctor).
- **New UI** (`np-ppicker` component, replaces the tiny pill + raw text rows):
  - Search field with leading icon.
  - Dropdown results with avatar initials, **name**, **Gender • Age**, and
    **phone** in a styled, scrollable listbox (works with touch).
  - After selection: a prominent **patient card** (avatar, name,
    gender • age, phone) with a **Change patient** button that restores the
    search field.
  - Selection uses event delegation with `data-cert-pick` indices instead of
    serializing patient JSON into `onclick` attributes (which broke on
    names containing apostrophes).

## 7. Single-day certificates

- New **Certificate duration** segmented control: **Date range** (from/to)
  or **Single day** (one `certificateDate`, pre-filled with today).
- Backend: `durationType` + `certificateDate` columns; `DATE_RANGE` is the
  fallback for legacy rows (`NULL`), so old certificates render unchanged.
- PDF wording adapts: "absent from school **on 17 Aug 2026**" (single day)
  vs "**from 10 Aug 2026 to 14 Aug 2026**" (range); a "Certificate Date"
  section replaces "Recommended Rest" for single-day certificates.

## 8. Smart auto-date calculation

- Entering a **From date** + **Recommended rest (days)** auto-fills **To**:
  `to = from + (restDays − 1)` (inclusive — 10 Aug + 5 days → 14 Aug).
- The To field shows an `(auto)` / `(manual)` hint; editing it manually
  marks it doctor-controlled until From/rest changes again.
- The same derivation runs server-side when `toDate` is omitted, so API
  clients get identical behavior.

## 9. Certificate templates expanded

Six templates (controller catalog + validator enum + PDF copy in sync):

| Key | Label |
|---|---|
| `GENERAL` | General Medical Certificate |
| `SCHOOL_LEAVE` | School Leave Certificate |
| `FITNESS` | Fitness Certificate |
| `MEDICAL_REST` | Rest Advised Certificate |
| `VACCINATION` | **Vaccination Certificate** (new) |
| `RETURN_TO_SCHOOL` | **Return To School Certificate** (new) |

Each template's wording adapts automatically to single-day vs date-range
and to teleconsultation vs clinic visit.

## 10. Mobile UX

- The certificate modal now uses the standard panel (not the 980px `--lg`
  variant that overflowed phones) and inherits the existing bottom-sheet
  mobile treatment.
- Segmented controls stretch full-width; the delivery actions grid collapses
  2-up → 1-up under 400px; the patient dropdown caps at `50vh` with
  `-webkit-overflow-scrolling: touch` and `overscroll-behavior: contain`.
- Numeric keyboard (`inputmode="numeric"`) for rest days.

## 11. Modal rendering below the sidebar (critical)

- **Root cause:** `#certModal` lived inside the scrollable main column while
  the sidebar is a fixed/sticky element with its own stacking context
  (z-index 40 desktop / 50 mobile drawer). Under transformed/filtered
  ancestors and on mobile drawers, `position:fixed` is computed against the
  ancestor — the dialog surfaced far below the viewport or beneath the
  drawer.
- **Fix (portal pattern, matches the existing overflow-menu portal):**
  `npPortalModal()` moves all six modals (`patientModal`, `certModal`,
  `certActionsModal`, `linkConflictModal`, `rescheduleModal`, `cancelModal`)
  to `<body>` once at startup; `npOpenModal()` is the single open path.
  Combined with `z-index:1300`, every modal is now always viewport-centered
  and above the sidebar, header, backdrop and overflow menus — on every
  device.

---

### Files changed

```
prisma/schema.prisma
prisma/migrations/20260817120000_certificate_v340_rework/migration.sql  (new)
src/controllers/certificate.controller.js
src/controllers/doctor.controller.js          (searchPatients root-cause fix)
src/services/automation.service.js            (onCertificateIssued)
src/services/pdf.service.js                   (mode-aware, 6 templates, durations)
src/services/whatsapp-media.service.js        (sendCertificatePdf)
src/routes/doctor.routes.js                   (POST /certificates/:id/send)
src/utils/validators.js                       (new enums + fields)
public/doctor/index.html                      (modal rework + actions modal)
public/doctor/app.js                          (portal, picker, segments, actions)
public/doctor/styles.css                      (modal z-index, picker, seg, actions)
docs/META_WHATSAPP_TEMPLATES.md               (N4 medical_certificate_ready)
```
