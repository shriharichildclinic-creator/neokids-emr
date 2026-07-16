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
