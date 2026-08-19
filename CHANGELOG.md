# CHANGELOG

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
