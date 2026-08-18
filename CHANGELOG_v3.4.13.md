# v3.4.13 — Doctor Dashboard compact header + Previous Records filter fix

## Dashboard welcome section (public/doctor/index.html, styles.css, app.js)
- Replaced the tall v3.4.10 welcome band (greeting + sub-copy + pills + 3 inner
  stat cards) with a slim single-row header strip: eyebrow + greeting + date pill
  on the left, one live waiting-room badge on the right.
- Removed the duplicated "Today's Appointments" / "Pending Tasks" / "Important
  Alerts" cards. They had no independent data source:
  - "Pending Tasks" was computed as (todayAppointments − completedToday), a
    number already implied by the KPI cards.
  - "Important Alerts" was literally the waiting-room count, already shown in
    the nav badge and dashboard snapshot.
- The strip now shows ONE actionable, real-data element: a waiting-room status
  badge that deep-links into the Waiting Room tab (click / Enter / Space).
- KPI grid de-duplicated from 4 cards to 3 (Today's Patients with completion
  progress, Total Consults, Revenue). "Completed Today" merged into the
  Today's Patients sub-line.
- KPI grid switched to `repeat(auto-fit, minmax(200px,1fr))` so any card count
  fills the row evenly (no dead fourth column).

## Mobile UX
- Welcome strip: greeting/date wrap to at most two compact lines; the waiting
  badge becomes a full-width tap target below instead of a tall 2-up card stack.
- KPI cards collapse to dense one-line rows (label left, value right, sub right)
  instead of three full-height stacked cards — the whole stat block is ~3 short
  rows, eliminating most of the pre-content scrolling.
- Dash grid gap tightened (1.5rem → 1rem desktop, 1.25rem → .9rem stacked).

## Previous Records "All types" dropdown (public/doctor/styles.css)
- Fixed chevron jumping on open: `.np-input:focus` re-declared a shorthand
  `background` that reset the image layer to repeat/0 0 while the standalone
  `select.np-input` block only set position (no repeat). Added a dedicated
  `select.np-input.hr-toolbar__filter:focus` rule that re-asserts the full
  background shorthand (color + image + no-repeat + position), locking the
  chevron at `right .6rem center` in every state.
- Gave the type select its own minimum track width (`minmax(168px,1.05fr)`) on
  desktop so "All types" / longer option labels no longer clip ("All ty…").
- Ellipsis + overflow protections added to the filter selects.

## Cache busting
- styles.css and app.js query strings bumped to v=3.4.13.

No markup IDs consumed by other tabs were changed; Waiting Room, Appointments,
Prescription Archive, Certificates, Earnings and Settings flows are untouched.
