# UI Consistency & Notification Logs Audit — Fix Summary (v3.3.5)

Root-cause fixes only. No new component files or patch stylesheets were added;
duplicate/conflicting rules were removed and consolidated into the existing
shared files (`public/assets/neokids-theme.css` for cross-panel components,
`public/admin/styles.css` and `public/doctor/styles.css` for page-specific
layout only).

## 1. Root cause of "buttons/badges render differently everywhere"
`.np-btn` was independently defined **4 times** (twice inside
`neokids-theme.css` itself, once in `admin/styles.css`, once in
`doctor/styles.css`), each with different padding, radius, font-weight,
colors and heights — and the base rule never set `display`, which is why
Apply/Clear could stretch full-width. `.np-badge` had the same problem
(3 definitions, one of them uppercase+bordered on the Doctor panel only).
`.np-btn--disabled` had **3 conflicting versions** inside `doctor/styles.css`
alone.

**Fix:** one canonical `.np-btn` / `.np-badge,.np-pill,.np-chip` /
`.np-btn:disabled` definition in `neokids-theme.css`. All page-level
redeclarations removed (~15 blocks across both panels). Page CSS may only
add layout placement now, not size/color.

## 2. Pagination component was styled for dark mode but had no light-mode base
Added the missing canonical `.np-pagination` base and reused it for the new
Notification Logs pagination (see #4).

## 3. Notification Logs — pill spacing
`Patient`/`Doctor` pill next to the `Status` pill used an inline
`margin-left:.25rem`. Replaced with the shared `.np-badge-group` gap.

## 4. Notification Logs — "older notifications disappear" (functional bug)
`GET /admin/notifications` had a hard cap (`take`, max 500) and **no
skip/offset support at all** — anything past the most recent 200–500 rows
was permanently unreachable, with no UI to page further.
**Fix:** added real page-based pagination (`page`, `limit`, `total`,
`totalPages`, `hasMore`) to `admin.controller.js#listNotifications`, and a
Prev/Next control wired into `loadNotifications()` in `admin/app.js`.

## 5. Notification Logs — Failed Vaccination Reminder shows "Sent" with an "error" (functional bug)
`vaccination.service.js` stored its internal dedup key (e.g.
`VACC:HepB-1:2026-07-29`) in the `errorMessage` column — including on
successful ("SENT") sends. The UI renders `errorMessage` as the row's
"Error" regardless of status, so successful sends displayed what looked
like a delivery failure. **The Failed=0 counter was already correct** —
only the per-row display was misleading.
**Fix:** dedup key now lives in the existing `payload` JSON column;
`errorMessage` stays `null` on success. Dedup lookup (`alreadySentToday`)
updated to query `payload.dedupKey`. Frontend also hardened to only ever
render the Error column when `status === 'FAILED'`.
**Known follow-up (not in this fix):** there's no webhook handler that
updates a log's status after initial send based on actual downstream
delivery outcome — status is set once at send time only. Wiring a real
delivery-status webhook is a larger feature, not a bug fix, and is out of
scope here.

## 6. Notification Logs — "When" → "Date & Time"
Renamed in the table header, row, and detail modal; added
`.np-col-datetime` for guaranteed one-line rendering.

## 7. Template dropdown "opens upward" — investigated, not a code bug
`#notifTemplate` is a plain native `<select>`. No JS/CSS in the app
overrides its open direction — that's OS/browser behavior based on
available viewport space. No fix applied; flagging for confirmation rather
than faking a change. If you're seeing this on a specific browser/OS,
let us know which and we'll dig further.

## 8. Analytics chart — thick bars, cramped/overlapping date labels
Bar width cap reduced (26px → 18px desktop, 16px → 12px narrow), chart
height increased for more breathing room, and x-axis date labels now thin
out (every other day) once columns get too narrow to fit all 14 without
overlapping — always keeping "today" and the first day labeled.

## 9. Chart tooltip clipping
`.np-panel__body{ overflow-x:auto }` at ≤1023px implicitly set
`overflow-y` to `auto` too (per the CSS overflow spec), clipping the chart
tooltip on tablets and most phones. Scoped that rule to panels that
actually contain a table (which already scroll via `.np-table-wrap`), and
added an explicit `overflow:visible` fallback for the chart panel.

## 10. Dashboard — stray "blue line" between KPI cards and the analytics card
`.np-divider` was defined as an invisible spacer on the Admin panel
(`height:.85rem`, no line) but as a real visible 1px line on the Doctor
panel (`background: var(--np-border)`, a blue-tinted color) — same
component, two different visual behaviors depending on panel. It was also
being placed directly between the KPI grid and the analytics panel on
**both** dashboards, right above the panel's own border, reading as a
stray line.
**Fix:** one canonical `.np-divider` (a real, consistent thin rule for
actual section breaks inside forms/panels). Removed the `<div
class="np-divider">` between the KPI grid and analytics grid on both
dashboards; that spacing is now handled once, systemically, via
`.np-kpi-grid{ margin-bottom: 1.5rem }` in the shared theme file.

## 11. Validation/error message wrapping
`.np-error` was defined 3 times with different colors/radius and no
explicit wrap behavior. Consolidated to one definition with
`overflow-wrap: break-word` so error text wraps cleanly instead of
truncating awkwardly on narrow viewports.

## 12. (Round 2) Apply/Clear still stretched on Revenue / Settlements / Invoices
Round 1 fixed the shared `.np-btn`/`.np-badge` definitions, but missed that
these three pages don't use the same filterbar as Appointments/
Notifications — they use `.np-filterbar--toolbar`, which was
`display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr))`.
`auto-fit` collapses unused grid tracks, so whenever the Apply/Clear
buttons landed alone on a wrapped row, they stretched to fill the *entire*
row width — the classic "auto-fit lonely leftover item" bug. Mixing
fixed-size buttons with fluid dropdowns in the same grid tracks was the
wrong pattern regardless of the auto-fit quirk.
**Fix:** rebuilt `.np-filterbar--toolbar` as flexbox — dropdowns can grow
(`flex:1 1 160px`), the actions group never does (`flex:0 0 auto`). Also
wrapped every Apply/Clear pair in `.np-filter-actions` in the HTML for
Revenue, Settlements and Invoices (previously only Appointments/
Notifications had that wrapper).

## 13. (Round 2) Notification pagination "half cut" at the end
`.np-table-wrap` has `max-height:70vh; overflow:auto` — an internal scroll
box. Now that the table paginates at 50 rows/page, that inner scroll was
redundant and was clipping the last visible row right above the pagination
bar, making it look cut off. Removed the inner scroll specifically for the
notification table (`#notifView .np-table-wrap{ max-height:none;
overflow:visible; }`) — the page scrolls instead, same as every other
table.

## 14. (Round 2) Dashboard whitespace next to the chart
The chart panel and Recent Appointments panel were side-by-side in a
2-column grid (`align-items:start`). Since Recent Appointments (10 rows)
is naturally much taller than the 14-day chart, the shorter column left a
large empty area next to it. Stacked both panels full-width instead (chart
on top, appointments below) and gave the chart a bit more height now that
it has the full row width to work with.

## 15. (Round 2) Login page — card size mismatch + Sign in/Forgot password stuck together
The worst instance of the "same component styled 3 different ways" bug
found in this audit. `.np-login__card` was independently defined in
`neokids-theme.css`, `admin/styles.css`, **and** `doctor/styles.css`, with
genuinely different `max-width` (420px vs 440px — this was the visible
card-size mismatch), border-radius, padding, and logo size; Doctor also
had a glassmorphic background Admin didn't. Separately, the `<form>` had
`class="space-y-3"` (Admin) / `class="space-y-4"` (Doctor) — **neither
class exists anywhere in the CSS**, so there was zero spacing between
every field and button, including Sign in and Forgot password.
**Fix:** one canonical `.np-login` / `.np-login__card` / `.np-login__logo`
in `neokids-theme.css` (430px card, consistent radius/logo/decorative top
bar for both panels). Removed both page-level duplicate definitions. Added
real spacing via `#loginForm{ display:flex; flex-direction:column;
gap:.85rem }` and removed the dead `space-y-*` classes from both login
forms. Neutralized `.np-field`'s own `margin-bottom` inside the login form
specifically (`#loginForm .np-field{ margin-bottom:0 }`) so spacing isn't
doubled — `.np-field` itself still differs slightly between Admin (flex
column + gap) and Doctor (block + margin) everywhere else; consolidating
that fully would touch every form in both panels, which is a larger,
higher-risk change than this pass — flagging as a follow-up rather than
doing it without visual QA across every form.


- All edited CSS files: brace-balanced.
- All edited JS files: `node --check` passes.
- All edited HTML files: `<div>` open/close tags balanced.

## Not covered in this pass (flagged, not fixed)
- `.np-field` (every form field's label/input wrapper) still differs
  between Admin (flex column + gap) and Doctor (block + margin) outside
  the login form. Neutralized inside `#loginForm` specifically so login
  spacing is correct; a full consolidation touches every form in both
  panels and deserves its own visual QA pass rather than a blind merge.
- `.np-modal` and `.np-table` base styling also differs between Admin and
  Doctor panels (different max-width, shadow, animation). Not flagged with
  a concrete visual symptom in the audit brief, and Doctor's modals carry
  more complex content (consult workspace), so unifying blindly risked
  breaking layout without visual QA. Recommend a follow-up pass with
  screenshots from both panels before merging these.
- General responsive audit beyond the specific items above (filters
  collapsing, table overflow on very small screens) — the concrete,
  reproducible bugs were prioritized; a full device-matrix pass is still
  worth doing separately.
- Full regression test suite run — this pass was verified via static
  checks (syntax, brace/tag balance, cross-reference of every selector
  removed against its remaining usages), not a live browser run. Recommend
  running `TESTING.md` against a staging deploy before shipping.

---

## 16. (Round 3) Filter dropdowns/date inputs — different widths, heights, padding, radius
`.np-input`/`.np-select`/`.np-textarea` were defined **three times**
(theme.css, admin, doctor) with genuinely different padding (.6rem/.8rem
vs .65rem/.85rem), radius (10px vs 12px), and dropdown-arrow rendering
(native `appearance:auto` on Admin vs a hand-drawn SVG chevron on Doctor).
Consolidated into one canonical definition covering `.np-input`,
`.np-select`, `.np-textarea`, and Doctor's `.np-select-native` alias.

## 17. (Round 3) Prescription Archive date filter — invisible, tiny calendar icon
There was **no light-mode styling anywhere** for
`input[type=date]::-webkit-calendar-picker-indicator` (only a dark-mode
override existed — the same "dark mode styled, light mode forgotten"
pattern found earlier with pagination). Added proper sizing (20px icon in
a 32px tappable area), a hover state, and excluded date/time inputs from
the dropdown-arrow background image so the two don't visually collide.

## 18. (Round 3) Dashboard "Average" label hidden behind bars
The SVG painted the average reference line *before* the bars (so a tall
bar painted over it), and the label was anchored at the right edge —
exactly where the tallest/"today" bar usually sits. Moved the label to
the left side (guaranteed clear of every bar), added a background pill
behind the text, and fixed the paint order so it renders after the bars
regardless.

## 19. (Round 3) Charts too thick / labels overlapping on mobile
Replaced the single narrow/wide split with a real 4-tier responsive
system (xs <340px / sm <460px / md <720px / lg) — each tier gets its own
margins, grid line count, font size, and label-thinning threshold, and
bar width is now purely proportional to available space (no oversized
minimum that made short bars look like thick slabs on small screens).

## 20. (Round 3) Save/Cancel and other modal action buttons — inconsistent spacing
Admin had **no `.np-modal__foot` component at all** — every single modal
(Add Doctor, KYC actions, Settlement notes, etc.) built its own footer
row with `class="np-row" style="justify-content:flex-end; gap:.5rem;
margin-top:.5rem"` repeated inline, instance by instance. Doctor had a
real `.np-modal__foot` class but didn't consistently use it either (one
of its own modals used `.np-modal__foot` nested *inside* the body with
inline style overrides on top, which is structurally wrong).
**Fix:** added a canonical `.np-modal__foot` (full-bleed sibling footer)
and a canonical `.np-modal__actions` (lightweight inline row for footers
nested inside the body, which is how most modals here are actually built)
to theme.css, and replaced every inline-styled instance across
`admin/index.html`, `admin/finance.js`, and `doctor/index.html`.

---

# How to test all 3 reminder types + WhatsApp delivery

## Before testing anything: check the one thing that can silently fake all three
`whatsapp.service.js` only calls the real Meta WhatsApp API when the
environment variable `WA_PROVIDER` is set to exactly `META`. If it's
unset, misspelled, or anything else, the service runs in **MOCK mode** —
it logs a fake "sent" message and returns success **without ever calling
WhatsApp**. Every reminder type (vaccination, appointment, follow-up)
shares this same module, so this one setting can explain "it says Sent
but I never received it" across all three at once.
- On your **production** server, confirm `.env` has `WA_PROVIDER=META`
  exactly.
- Confirm `META_PHONE_NUMBER_ID` is set and `META_ACCESS_TOKEN` is a
  **permanent** System User token, not a temporary token — temporary
  tokens expire in 24h and are the #2 most common cause of silent
  delivery failure.
- Important limitation: even when correctly configured, "Sent" in this
  app only means *"Meta's API accepted the request and returned a message
  ID"* — there is no delivery-status webhook wired up, so the app never
  learns if Meta later marks a message as undelivered/failed. For true
  delivery confirmation, cross-check the message ID (logged via
  `logger.info('[META] Sent ... msgid=...')` in the server logs, and
  stored in the NotificationLog's `payload.response`) against Meta
  Business Manager's own message log.

## 1. Vaccination reminders
- **Trigger condition:** a patient's `dateOfBirth` puts a vaccine due date
  within `VACC_APPROACH_DAYS` (default 7) days from today. Runs once/day
  automatically as part of the lifecycle job.
- **To test:** create/edit a test patient (use your own phone number) with
  a `dateOfBirth` chosen so one vaccine's due date lands inside that
  7-day window — e.g. set DOB = today − 42 days to trigger the "6 weeks"
  dose group (DTwP-1, IPV-1, Hib-1, HepB-2, Rota-1, PCV-1) immediately.
- Restart the server (or wait for the next lifecycle tick — jobs run
  every `INTERNAL_JOBS_INTERVAL_MS`, default 5 min) and watch the server
  logs for `Vaccination reminders — considered=... sent=...`.
- Check Admin → Notification Logs, filter Template = vaccination reminder,
  channel WhatsApp — confirm status and check your phone.
- To re-test the same patient/vaccine again same day, wait until tomorrow
  (dedup is per calendar day) or delete the matching NotificationLog row.

## 2. Appointment reminders (the 30-minutes-before nudge)
- **Trigger condition:** a `CONFIRMED` appointment today whose start time
  is 28–33 minutes from now (a 5-minute window matching the job interval).
- **To test:** book/confirm a test appointment for ~30 minutes from now,
  with your own phone as the patient (and/or doctor) contact. Wait for
  the next lifecycle tick (≤5 min) and check the server logs and
  Notification Logs (template = `neokids_reminder_online`/`_offline` or
  the doctor equivalents) plus your WhatsApp.
- Don't set it exactly 30 minutes out and then wait past 33 minutes
  before the job runs — you'll miss the window and need to rebook.

## 3. Follow-up recalls
- **Trigger condition:** a prescription's `followUpDate` is exactly
  *tomorrow* (a day-before nudge) or exactly *7 days ago* (a one-week-
  later recall) — and the patient hasn't already rebooked with the same
  doctor since.
- **To test:** create/edit a prescription (via the doctor's consult flow)
  for a test patient with `followUpDate` set to tomorrow's date, and make
  sure that patient's phone is your own test number. Wait for the next
  lifecycle tick and check Notification Logs + your phone. To test the
  7-days-ago path, set `followUpDate` to exactly 7 days before today
  instead.
- Set `FOLLOWUP_VERBOSE=true` in `.env` for an extra log line confirming
  the recall job actually ran.

## General tip for all three
Every path funnels through the same `whatsapp.service.js`, so once you've
confirmed `WA_PROVIDER=META` is correctly set and you've verified ONE of
the three reminder types actually reaches your phone, the others are very
likely fine too (same failure mode would hit all three identically). If
one type fails and the others succeed, that points to something specific
to that reminder's trigger condition or template rather than the shared
WhatsApp layer.
