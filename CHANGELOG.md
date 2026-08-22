# CHANGELOG

## v4.0.x — Role-aware analytics & consistent routing

### Better analytics for all four panels (real data, collected vs pending)
Revenue is now reported ethically everywhere: the headline figure is money
actually **collected**, with **pending** shown separately — never blended.
- **Doctor:** dashboard splits work into Online vs In-Clinic streams — consult
  counts and collected revenue for each, with pending noted, plus completion
  rate. Backed by an upgraded `/doctor/stats`.
- **Admin:** new "Revenue by source" row — Online / In-Clinic / Pharmacy
  collected totals (pending noted), total collected, and outstanding invoice
  count. Backed by new aggregations in `/admin/analytics`.
- **Receptionist:** front-desk ops rollup — booked vs walk-in today, checked-in
  vs awaiting, cash vs UPI/online collected today, and pending collection.
  Backed by an upgraded `/receptionist/stats`.
- **Pharmacy:** collected-today (paid bills only) with draft/pending noted,
  bills today, in-stock, low-stock and expiring-soon counts. Backed by a split
  `/pharmacy/stats`.

### Routing consistency
- Audited navigation across panels: the app is a set of SPAs, so hash routing
  (e.g. `/admin/#receptionists`) is the intended pattern — it makes views
  deep-linkable and refresh-safe. It was applied in Admin but missing in
  Receptionist and Pharmacy. Both now use the same hash-sync + restore-on-load
  + back/forward strategy, so refreshing or deep-linking keeps you on the same
  view with the correct active sidebar item.


## v4.0.x — EMR gateway & dashboard welcome headers

### Landing gateway
- Replaced the JSON response at `/` with a professional, responsive NeoKidsPro
  EMR gateway page (`public/assets/gateway.html`): portal cards for Admin,
  Doctor, Reception and Pharmacy, platform-capability and security sections,
  live version/environment footer, and light/dark theming. All existing routes
  (`/admin`, `/doctor`, `/receptionist`, `/pharmacy`) are unchanged. The former
  JSON service descriptor is still available at `/api`.

### Dashboard welcome headers
- Added a personalized welcome header (time-of-day greeting + live date/clock)
  to the Admin and Receptionist dashboards, reusing the doctor portal's
  `.np-welcome` design tokens for a consistent, cohesive look across roles.


## v4.0.x — Pharmacy modal, mobile & reporting fixes

### Pharmacy / billing modal (mobile)
- Fixed the Add Bill line-item grid: the "Price (₹)" and "Line total" labels
  overlapped into unreadable text on mobile because the CSS grid declared four
  columns while the row renders three fields. The grid now matches the real
  Qty / Price / Line total structure and gives each field its own cell on
  phones.
- Removed a stray empty pill that appeared under "Search medicine": the stock
  hint now collapses when it has no text (`.np-bill-stock:empty`).
- The Add Bill modal footer already uses the shared `.np-modal__foot`
  component (consistent padding, spacing, and responsive button wrapping).

### Prescriptions & row lists
- Fixed truncated prescription text: row meta now wraps correctly and the
  row stacks on phones so the action column no longer squeezes the content.

### Mobile date pickers & dropdowns
- Native date inputs across all panels now show a visible, inset calendar icon
  with a pointer cursor and dark-mode-aware colouring, matching the dropdown
  spacing used elsewhere.

### Table / list scalability
- Added a reusable bounded scroll container (`.np-scroll-list`) and applied it
  to previously unbounded card lists (patients, prescriptions, certificates,
  today's queue, recent bills, doctor all-appointments and Rx archive) so large
  datasets no longer grow the page indefinitely. Backend list endpoints already
  cap results server-side (200–500 rows).

### Revenue reporting
- Added an Appointment Source filter (Online booking / Walk-in-Reception /
  Phone / Other) to the Revenue report, threaded safely through the report
  query. Settlement generation and doctor breakdowns are unaffected — the
  filter only narrows the report view, never what counts as settleable revenue.


## v4.0.x — Billing, invoicing & UI consistency fixes

### Auto-refresh & search
- Receptionist lists (dashboard, appointments, patients, invoices, billing,
  pharmacy bills, prescriptions) now refresh automatically after create, edit,
  save, draft, paid, invoice and status-change actions via a single
  `refreshAfterMutation` helper. The patient search term is preserved across
  refreshes.

### Receptionist patient search
- Fixed: a patient registered at the front desk could not be found in search
  until a first appointment linked them. Added a `patient_registrations`
  linkage (new migration `20260825090000_patient_registration_scope`) so
  registered patients enter the staff member's search scope immediately.
  Applied to receptionist and pharmacy patient creation.

### Appointment source
- Merged the redundant "Clinic Reception" and "Walk-in" sources into a single
  "Walk-in / Reception" (`WALK_IN`) in-person channel. `Phone` and `Other`
  remain distinct. Legacy `CLINIC_RECEPTION` rows are still accepted and shown
  under the merged label across appointments, badges, audit logs and the
  booking confirmation logic.

### Doctor settlements
- Fixed the settlement doctor filter: period selects now default to
  "All months/years" (so a doctor's prior-month settlements are no longer
  hidden), filters apply immediately on change, and the selected doctor
  persists across reloads.

### Admin invoice coverage
- Added an "Online Booking Invoices" admin view + `GET /admin/online-invoices`
  endpoint surfacing NeoKidsPro online-booking invoices with admin-scoped PDF
  URLs.
- Added search and filters (invoice #/patient, doctor, clinic, date range) to
  the Reception Invoices admin view.

### PDFs
- Fixed amount-column clipping in the consultation, online, pharmacy and
  settlement invoice PDFs by right-aligning amounts within bounded columns
  that end at the page margin.

### UI / design system
- Added a reusable `.np-modal__foot` footer component; converted the booking,
  register-patient, reschedule, cancel, certificate, send and shared billing
  modals to use it so action buttons are consistently spaced and no longer
  stuck to the modal's bottom edge.
- Re-centered modals over the content area on desktop (offset by the fixed
  sidebar) so the Notification Details and other modals are no longer shifted
  left.
- Notification Logs: clearer date-picker affordance and calendar-icon spacing,
  mobile pagination cohesion, and a design-system-consistent empty state.


## Files merged
- Merged `public/assets/np-ux.js` into `public/assets/np-ui.js`
- Merged responsive and stabilization rules from `public/assets/neokids-fixes.css` into:
  - `public/admin/styles.css`
  - `public/doctor/styles.css`

## Patch files deleted
- `public/assets/neokids-fixes.css`
- `public/assets/np-ux.js`

## Duplicate / override cleanup
- Removed patch asset references from admin, doctor, and reset-password HTML entry points
- Removed duplicate patch script loading after merging into core assets
- Removed `width:auto` inline filter overrides that caused mobile overflow
- Added shared responsive toolbar classes directly in original views

## AI / debug artifact cleanup
- Removed frontend debug logging from `public/assets/booking-widget.html`
- Removed patch/version commentary references from HTML entry points
- Consolidated overflow-menu behavior into the original doctor app

## UI/UX bugs fixed
- Notification Logs mobile filter layout, pill wrapping, and viewport-safe control sizing
- Sticky top headers on mobile for Admin and Doctor panels
- Sidebar behavior restored so the sidebar remains fixed and only its nav area scrolls
- Mobile header spacing, title truncation, and profile alignment improvements
- Settlements / invoices / earnings tables converted to mobile-safe card layouts
- Waiting Room and Appointment card action menus now open inside the viewport
- Doctor panel filter layout restored across appointments, archive, and earnings views
- Internal scrolling applied to long overflow menus and responsive table regions
- Drawer body scroll lock restored on mobile sidebar open

## Security / stability improvements
- Removed redundant client patch loading that risked conflicting overrides
- Closed overflow menus on scroll / resize / escape to prevent stranded overlays
- Added idempotent sidebar binding protections in doctor/admin shells

## Remaining blockers
- None identified in the static UI pass. Dynamic backend data was preserved unchanged.

## v3.3.2 — 2026-08-02 — Root-cause mobile regression fixes

Fixed (surgical, no unrelated refactors):
- Mobile sidebar no longer blurs the whole app. Removed `backdrop-filter: blur()`
  from `.np-backdrop` (admin + doctor). Background dims only.
- Sidebar remains fully interactive when open. Enforced `z-index:50 + isolation:isolate`
  on the mobile drawer; backdrop stays at 44 and inherits no blur.
- Closed backdrop no longer intercepts touch/click. Added `pointer-events:none` guard
  on hidden `.np-backdrop` / `.np-drawer__backdrop`; re-enabled only when `.is-open`.
- Notification cards on mobile open again. Fixed by the pointer-events guard above,
  plus doctor `.np-modal` no longer inherits a whole-viewport blur.
- Notification badges no longer stretch full-width on mobile. Removed the
  `white-space:normal` override for `#notifView .np-badge`, added
  `width:max-content; justify-self:start; flex:0 0 auto` inside notif grid cells so
  WhatsApp / Email / Sent / Failed / Pending / Patient / Doctor pills hug their text.
- Notification Details payload readable in dark mode. Added
  `html[data-theme="dark"] .np-code-block` and `#notifModal pre` overrides.
- Fixed duplicate sidebar wiring: the safety-net IIFE (admin + doctor) is now
  idempotent, actually wires `backdrop.click → close`, and no longer shadows the
  primary `setupSidebar` handlers.
- Filter Apply/Clear buttons on Notifications use the shared `.np-btn` tokens
  with a consistent `min-height:40px`.

## v3.5.1 — Automation audit & vaccination reminder fix (2026-08-19)

**Vaccination reminders**
- Content: WhatsApp + Email reminders now carry the mandatory disclaimer
  (age/schedule-derived reminder, not a confirmation of a pending vaccine,
  consult your pediatrician, Vaccination Portal link). Email CTA relabelled
  to "Visit the Vaccination Portal".
- Template: code now defaults to the NEW Meta template
  `neokids_vacc_reminder_v2` (5 body vars + static portal button); old
  4-var `neokids_vaccination_reminder` is deprecated. See
  docs/META_WHATSAPP_TEMPLATES.md §N3 for the exact body to paste into Meta.
- Reliability: the daily scan stamp in lifecycle.service is now set only
  after a successful scan (previously set even when every send failed);
  scan results are logged unconditionally; `VACC_REMINDERS_ENABLED=false`
  kill switch added.
- Testing: new admin endpoint `POST /api/admin/jobs/vaccination-reminders/run`
  and new script `scripts/test-vaccination-reminders.js`.

**Finance**
- Root-cause fix for a double-credit race between the 5-minute
  auto-complete cron and the doctor's manual "Mark Complete": both paths
  now claim the appointment row transition atomically (updateMany with
  status guard) and only the winner credits/debits revenue.
- Verified correct and unchanged: settlement maths (clinic/doctor split,
  TDS on doctor gross, single round2 per total), Cashfree webhook
  signature + strict payment verification, KYC gate on settlement
  generation, immutable PAID settlements, cancelled-but-paid exclusion
  from settlements.

**Doctor dashboard**
- Welcome section redesigned: "Welcome back, Dr. <Name>", current date,
  waiting-room badge, and a new three-stat row (Today's appointments,
  Pending consultations, In waiting room) with real data from
  /doctor/stats and /doctor/waiting-room. Fully responsive, overflow-safe
  (min-width:0 grid, wrapping labels), keyboard-focusable.
