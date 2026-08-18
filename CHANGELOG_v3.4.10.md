# v3.4.10 — Previous Records Part-5 Fix Audit & Deployment

## Priority 1 — Patient linking mutual exclusivity (root cause + fix)

**Root cause.** `setPatientSource()` in v3.4.9 hid + disabled the inactive
patient-source panel, but three real leaks let the two branches coexist:

1. `disabled` alone does not block autofill, `<label>`-forwarded clicks,
   or contenteditable interactions — the legacy inputs could still receive
   values while the toggle claimed EXISTING.
2. Switching source did not reset the branch being *left*. The hidden
   `#histPatientId` and search input kept a real patient linked while the
   Legacy fields were being typed into, and the ownership badge kept
   saying "Linked NeoKidsPro Patient" — this IS the "conflicting ownership
   data" the report describes.
3. The ownership badge was rendered once at modal open, never refreshed
   on toggle / patient-pick / patient-clear.

**Fix.**

* `setPatientSource(source, {initial})` now clears the leaving branch on
  every real user switch:
  * → LEGACY clears `state.selectedPatient`, `#histPatientId`,
    `#histPatientSearch`, the selected-patient card and any open results.
  * → EXISTING wipes every `#hrLegacy*` input.
* The inactive panel is made genuinely unreachable via **all** of:
  `disabled`, `readonly` (on text inputs / textareas), `tabindex="-1"`,
  `aria-hidden="true"`, `inert` (where supported) plus a new
  `.hr-panel--off` CSS class that adds `pointer-events:none`,
  `user-select:none`, muted colours, `cursor:not-allowed`, and blocks
  autofill styling. Every interaction path (mouse, touch, tab-order,
  autofill, AT) is closed off.
* Ownership badge now lives on a single `refreshOwnershipBadge()` helper
  that renders from the *current* toggle + selection state. Called on
  toggle-switch, patient-pick, patient-clear, and legacy-name input
  (debounced), so the label can never disagree with the form.
* Hidden `#histPatientId` disabled on LEGACY so no stale patient id
  can ever reach the save payload.

## Priority 2 — Mobile responsiveness

* **Modal header:** min-height 56px (52px < 640px), tighter phone padding,
  explicit close-button size + shrink, title/subtitle line-heights and
  `overflow-wrap:anywhere` — no more clipping / awkward wrap.
* **Toggle segmented control:** now `display:flex; width:100%` at every
  width, buttons `flex:1 1 0; min-width:0; white-space:normal` so labels
  wrap instead of overlap. A compact `.hr-seg__short` label ("Existing" /
  "Legacy") is shown below 520px so the two tabs never collide on
  small phones. Active state has a visible outline in addition to the
  fill so the selection is unambiguous on mobile.
* **Legacy-fields grid:** collapses to single column below 640px to stop
  horizontal overflow.

## Priority 3 — Three-dot attachment menu

* Portaled menu now switches to `position:fixed` via `.is-portaled`,
  overriding the stale `right:0` from the in-flow rule that was fighting
  the JS `left` value on scroll. Menu `z-index:1400` puts it above the
  `.np-modal` layer (1300). On close, the menu is returned to its holder
  if still connected, or removed if the row has been re-rendered — no
  more orphaned portaled menus stacking on `<body>`.

## Priority 4 — Preview modal UX

* Header now carries a proper "← Back" button (with icon) in addition
  to the corner ✕. On mobile both buttons close only the preview, so
  the parent Previous Record modal stays exactly where the doctor left
  it (this half was already fixed in v3.4.9 part 4).
* Preview open now `history.pushState`s a marker; a `popstate` listener
  intercepts hardware / browser Back and closes only the preview
  instead of navigating the whole page away. Closing via ✕/Back cleans
  the history entry back out.
* Preview image / iframe height on mobile uses `calc(100vh - 140px)`
  so the media fills the available screen without pushing the header
  or the Download button off-view.

## Files changed
* `public/doctor/historical-fix.js` — patient-source logic rewrite,
  ownership-badge helper, portaled menu fix, preview history integration.
* `public/doctor/styles.css` — modal header spacing, toggle
  responsiveness, `.hr-panel--off`, portaled-menu positioning, preview
  header + mobile media height, `.hr-modal__body .np-grid-2` collapse.
* `public/doctor/index.html` — dual-length toggle labels, preview
  header restructured with Back button + close icon, cache-buster bumped
  to `?v=3.4.10`.

No backend / schema / route changes — this is a UI-only patch on top
of v3.4.9 part 4.
