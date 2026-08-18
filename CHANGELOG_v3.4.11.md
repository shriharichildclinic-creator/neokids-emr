# v3.4.11 — Certificate Update fix + Doctor Panel polish + Global Mobile Back-Nav

## 1. Medical Certificate — "Update Certificate" 500 fix
Root cause: `certificate.controller.js#update` ran **two conflicting date
normalization passes** back-to-back. The second pass (`certDates.normalizeCertificateDates`)
only returns `{fromDate, toDate, restDays}` — it does NOT touch
`durationType` / `certificateDate`, so it silently overwrote the first
pass, wiped `fromDate/toDate` to `null` whenever `restDays` was unset,
and left inconsistent state. Prisma then choked and PDF regeneration
threw → surfaced as "Internal Server Error".

Fix:
- Replaced both passes with a single deterministic block.
- `SINGLE_DAY` → writes `certificateDate`, nulls `fromDate/toDate/restDays`.
- `DATE_RANGE` → normalizes via `certDates.normalizeCertificateDates`,
  nulls `certificateDate`.
- Wrapped `prisma.update` in try/catch → returns 400 with detail on DB
  failure, never 500.
- PDF regeneration now best-effort — a PDF failure never fails the
  update; a `pdfWarning` is returned instead.
- Also fixes `consultationType` and `templateKey` patch semantics.

File: `src/controllers/certificate.controller.js`

## 2. Doctor Panel — Profile Dropdown routing fix
Before: "My Profile" and "Settings" both opened Settings.
Now:
- **My Profile** → dedicated `#myProfileModal` (avatar, badges, email,
  phone, qualification, reg. no., clinic, clinic address) sourced from
  `/api/doctor/me`.
- **Settings** → Settings tab.
- **Change Password** → Settings tab, scrolls to `#setting-password`.

Files: `public/doctor/index.html`, `public/doctor/app.js`

## 3. Doctor Panel — Welcome section
Added a professional welcome band above KPIs on the Dashboard:
- Contextual greeting (Good morning / afternoon / evening).
- "Welcome back, Dr. {Name}" (dynamic from `/doctor/me`).
- Long-form local date pill + today's appointment count pill.
- Three cards: **Today's Appointments** (with completed sub-count),
  **Pending Tasks** (today − completed), **Important Alerts** (live from
  the waiting room; turns amber when any patient is waiting).

Styling matches existing EMR design tokens (blue↔mint gradient, existing
`--np-border`, `--np-text`, `--np-surface` vars, dark-mode parity).

Files: `public/doctor/index.html`, `public/doctor/app.js`,
`public/doctor/styles.css`

## 4. Global Mobile Back-Button Navigation (History API)
New `NPBackNav` manager wired into every modal open/close:
- `npOpenModal(id)` pushes a history entry via `history.pushState`.
- `npCloseModal(id)` unwinds that entry (`history.back()`) so the URL
  stays clean when a modal closes by X, submit, or Escape.
- Device Back button:
  - **Any overlay open** → closes only the top-most overlay
    (nested modals close one at a time).
  - **No overlay, not on Dashboard** → returns to Dashboard.
  - **On Dashboard, nothing open** → browser exits.

Integrated with the existing Previous Records preview stack
(`historical-fix.js`) so the Dashboard → Patient → Previous Record →
Attachment Preview drill-down unwinds correctly on Android/iPhone Back:

    Preview → Previous Record → Patient → Dashboard → (exit)

Files: `public/doctor/app.js`, `public/doctor/historical-fix.js`

## Non-goals (unchanged by design)
- Existing UI, architecture, design tokens, colors, and file layout are
  preserved. No new CSS/SCSS auxiliary files — styles appended to the
  existing `public/doctor/styles.css`.
