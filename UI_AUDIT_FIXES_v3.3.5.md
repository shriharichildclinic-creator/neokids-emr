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

## Verified
- All edited CSS files: brace-balanced.
- All edited JS files: `node --check` passes.
- All edited HTML files: `<div>` open/close tags balanced.

## Not covered in this pass (flagged, not fixed)
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
