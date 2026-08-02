# NeoKidsPro EMR — v3.2 UI/UX & Dark Mode Audit

## Summary
Comprehensive UI/UX audit + Dark Mode audit across Doctor Panel and Admin
Panel. No business logic or API changes. No new CSS/SCSS/patch files were
introduced — every fix landed in the existing style, script and HTML files.

## Files changed
- `public/assets/neokids-theme.css` — Dark-Mode audit, design-system tokens,
  theme switch, overflow menu polish, badge/pill anti-stretch, focus rings,
  horizontal-overflow guard, calendar/date pickers, skeleton/tooltip/toast.
- `public/assets/np-ui.js` — Removed floating header/nav Dark-Mode toggle,
  added `NPTheme.current()` and `np-theme-change` event; Settings is now the
  single source of truth for theme.
- `public/doctor/styles.css` — Dashboard 2-1 grid spacing, sidebar sticky
  behaviour (no independent scrolling), appointment card date/time badge fix,
  status-pill anti-stretch, mobile appointment card padding across 720/520/400.
- `public/doctor/index.html` — Added "Appearance" setting card with radio-group
  theme switch above the Security card.
- `public/doctor/app.js` — Rewrote overflow-menu positioning so the ⋮ menu
  anchors beside the trigger (never at the bottom of the page); wired the
  Settings theme switch.
- `public/admin/styles.css` — Sidebar sticky/no-independent-scroll rewrite,
  Apply/Clear filter buttons de-stretched at every breakpoint.
- `public/admin/index.html` — Added "Appearance" panel to Settings.
- `public/admin/app.js` — Wired the Settings theme switch.
