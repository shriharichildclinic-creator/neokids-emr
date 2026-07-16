# NeoKidsPro EMR · Phase-1 Audit Report (v3.0 → v3.1)

Audit date: **2026-06-30**
Scope: complete end-to-end audit of the EMR system prior to the v3.1
Blue-Green rebrand, dark-mode polish, and premium UI/UX upgrade.

---

## 1. Inventory

| Surface | Files | LoC |
|---|---|---|
| Doctor portal | `index.html`, `app.js`, `earnings.js`, `styles.css` | 3,519 |
| Admin portal  | `index.html`, `app.js`, `finance.js`, `styles.css` | 3,447 |
| Booking widget | `booking-widget.html` | 854 |
| Reset password | `reset-password.html` | 166 |
| UX helpers   | `np-ui.js`, `np-ux.js` | 831 |
| Brand theme  | `neokids-theme.css` | 970 |
| Total client | 12 files | **9,787 LoC** |
| Backend      | `src/` (Node/Express/Prisma) | (untouched) |

## 2. Module / page coverage

All of the following pages, modules and flows were navigated as part of the
audit; reference-only audit, no behavioural change:

### Authentication
- Login screen (doctor + admin) — both wired to `/api/auth/login`.
- Forgot-password & reset-password flow — `reset-password.html` page
  works with one-time tokens.
- Session persistence via JWT; token kept in localStorage; `data-theme`
  preference also persisted there.

### Doctor portal (12 sections)
- Dashboard (KPI cards, recent appointments, earnings glance).
- Waiting room (live queue, call-next, status badges).
- Appointments list with filters, search, pagination, statuses
  (Booked / Confirmed / In-progress / Completed / Cancelled / No-show).
- Calendar view (monthly/weekly grid).
- Patient management (search, history, allergies, growth chart, files).
- Consult workspace (vitals, complaints, examination, diagnosis, plan,
  follow-up, tabs).
- Prescriptions (medication table, dosage, frequency, duration, prints).
- Invoices (line items, tax, discount, PDF export).
- Earnings (monthly settlements, breakdown).
- Profile (KYC docs, bio, signature, availability, working days,
  consultation fees, clinic share split).
- Settings cards (notifications, integrations, security, danger zone).
- Theme toggle (`np-ux.js` floating button).

### Admin portal (10 sections)
- Dashboard (clinic KPIs, doctors-online, revenue, bookings, growth chart).
- Doctors list (cards with KYC pills, availability, contact, actions).
- Add / edit doctor (full form with file uploads — Aadhaar, PAN,
  cancelled cheque, medical registration; clinic share split with TDS).
- Patients list & profile.
- Appointments admin view (all doctors, statuses, filters, pagination,
  CSV export).
- Finance (settlements, payouts, expenses, taxes, charts).
- WhatsApp integration settings.
- Google Meet / Google Calendar integration settings.
- Notification log table.
- Settings.

### Booking widget (public)
- Embeddable booking form: select doctor → date → slot → patient details
  → confirm → payment → receipt.

### Cross-cutting features (verified intact)
- Search with debounce, autocomplete dropdowns.
- Filter chips (`np-chip` component).
- Date range presets (`np-daterange`).
- Pagination (`np-pagination`).
- File upload dropzone (`np-dropzone`).
- Modal + drawer system (`np-modal`, `np-drawer`).
- Toast / confirm / prompt (`np-ui.js`).
- Command palette (Ctrl-K / Cmd-K).
- Print stylesheet (invoices / prescriptions).
- Responsive sidebar (collapsible on mobile with `np-backdrop`).
- Profile dropdown.
- Theme toggle (light / dark / system).
- WhatsApp & Google Meet integration toggles & test buttons.
- CSRF guard (`src/middleware/csrf.js`).
- Rate limiting (per-route, per-IP and per-token).
- Webhook endpoints (payment / WhatsApp).

## 3. Issues catalogued

### 3.A — Branding (the headline issue)
1. **Primary color was `#EC4899` (vivid pink) instead of `#89BCBD`
   (Blue-Green).** Reproduced on:
   - `<meta name="theme-color">` in both `doctor/index.html` and
     `admin/index.html`
   - `manifest.webmanifest` `theme_color`
   - `favicon.svg` gradient stops
   - `--np-primary` in `doctor/styles.css` and `admin/styles.css`
   - `--nk-pink-500` token (which the entire `neokids-theme.css` was
     built around)
   - Inline `tailwind.config = { ... }` blocks
   - Setting card icon gradients (`doctor/index.html` line 443, 530)
   - Inline gradient stops in booking-widget and reset-password pages
   - `np-ux.js` palette item active state, theme toggle, daterange
     active state, dropzone hover, chip background
   - `np-ui.js` toast primary, modal title accent
2. **Pink-tinted scrollbars** (`#F8C6D9` / `#F198BD`) across all pages.
3. **Pink-warm borders** (`#F1D8E2`, `#FCE3EE`) sprinkled into card and
   login styles.
4. **Pink-warm row hover** (`#FFF1F6`) in tables.
5. **Two competing teal hues** — Brand Book `#89BCBD` and legacy
   Tailwind `#2DD4BF` co-existed, breaking palette cohesion.
6. **Display font** was Quicksand instead of Poppins (Brand Book).
7. **Warm-cream page surface** `#FFF7F4` clashed with the Blue-Green
   primary; should be a cool cream like `#F7FAFA`.

### 3.B — Dark mode
Reproduced bugs in dark mode (`html[data-theme="dark"]`):
1. **Pink-on-pink** highlights in the command palette and date-range
   active state — illegible.
2. **Sidebar active item** used the same pink accent — overwhelming.
3. **`select` `option`** elements rendered with default OS chrome
   (white) inside dark dropdowns — black-on-white text.
4. **Native date/time picker** appeared with a light icon on a dark
   input — fixed by `color-scheme: dark`.
5. **Profile menu** items used the pink accent on hover.
6. **Inline `style="color:#0F2A47"` / `#64748B`** in admin markup
   ignored the dark theme — appeared as dark-on-dark text.
7. **Hard-coded alert boxes** (`style="background:#FFFBEB"` etc.)
   stayed light yellow over dark background — failed contrast.
8. **`bg-white`, `bg-slate-50`, `text-slate-700` Tailwind utilities**
   used in some inline elements ignored the theme.
9. **Toast / confirm modals** from `np-ui.js` rendered with light
   surface when invoked in dark mode.
10. **Code chips** (`<code>`) used a pink bg + pink text — illegible
    on dark surface.
11. **Search input** had a white background in dark mode in some
    places.
12. **Empty state icons** kept light gradient — invisible on dark.
13. **Theme toggle button** itself was bright pink — clashing.

### 3.C — Light-mode polish (cosmetic)
1. Spacing inconsistencies on KPI cards (some 1.2rem, some 1rem).
2. Table column headers were sentence case instead of an uppercase
   premium SaaS pattern.
3. No micro-animation on card mount.
4. Focus ring missing on some interactive elements (covered by
   global `:focus-visible`).
5. Status badges had inconsistent saturation across the app.

### 3.D — Functional
**None.** All workflows, forms, file uploads, dropdowns, integrations,
rate limiting, CSRF guards, and webhook endpoints were verified to
work as in v3.0. No regressions identified.

## 4. Decision matrix

| Issue type | Action |
|---|---|
| Brand identity | Rebrand to `#89BCBD` (Phase 3) |
| Dark mode bugs | Rewrite dark-mode block in `neokids-theme.css` (Phase 2) |
| Cosmetic polish | Premium UI/UX upgrade pass (Phase 4) |
| Functional | No change required — preserved |

All actions captured in `CHANGELOG_v3.1.0_BLUE_GREEN_REBRAND.md`.
