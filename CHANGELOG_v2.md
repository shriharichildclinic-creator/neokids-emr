# NeoKidsPro EMR — v2.0 Changelog

Phase 2 UX/UI audit + implementation. **No breaking changes**, **all existing endpoints preserved**, **no DB migration required**.

---

## ✨ Doctor Panel

### FIX 1 — Appointment card action hierarchy
**Before:** 5 flat buttons (Join · Open · Complete · Reschedule · Cancel)
**After:** Primary "Open Consultation" · Secondary "Join Meeting" (when ONLINE) · `⋮` overflow with Mark complete · Reschedule · Cancel · View prescription
**Files:** `public/doctor/app.js` (`apptCard()` rewritten), `public/doctor/styles.css` (`.np-overflow*` classes appended)

### FIX 2 — Route-based consultation workspace
**Before:** Entire EMR crammed inside `#patientModal` (Rx, vitals, history)
**After:** Full-page workspace at `/doctor#consult/<appointmentId>` with Summary · Prescription · Patient History tabs. Modal kept for fast "peek" use from dashboard snapshot — modal has new "Open full workspace" button.
**Files:** `public/doctor/index.html` (new `#consultTab`), `public/doctor/app.js` (`openConsultation`, `handleHashRoute`, `moveRxFormInto`)

### FIX 3 — Prescription Archive
**Before:** No place to see past prescriptions after closing modal
**After:** New sidebar tab "Prescription Archive" with search + date-range filter; rows show patient, diagnosis, problem, with View PDF / Download / Open Visit actions
**Files:** `public/doctor/index.html` (new `#rxArchiveTab`), `public/doctor/app.js` (`loadRxArchive`, `renderRxArchive`)

### Misc doctor improvements
- Sidebar shows live `Waiting Room` patient count badge
- Cancelled cards display the cancellation reason inline (red box)
- Workspace summary surfaces `rescheduledAt` + `rescheduleReason` + appointment `notes`
- Empty states now include a recovery CTA where applicable

---

## ✨ Admin Panel

### FIX 4 — Modernized dashboard
**Before:** Bland Tailwind, 4 single-color KPIs, no chart, no trend
**After:** Adopts the same `np-` design system as the doctor panel:
- 6 KPI cards with delta indicators ("▲ 3 vs yesterday")
- 14-day appointment volume bar chart
- Recent appointments list with proper status badges
- Sidebar with sections (Overview / Manage / Monitor / Account)
- Sticky header, profile dropdown, mobile drawer
**Files:** `public/admin/index.html`, `public/admin/app.js`, **new** `public/admin/styles.css`

### FIX 5 — Appointment management filters
**Before:** Only a status dropdown
**After:** Status · Type (online/offline) · Payment · Doctor · Date range · Free-text search across patient name, phone, email, problem
**Files:** `public/admin/index.html`, `public/admin/app.js` (`loadAppointments`)
**Backend extension:** `GET /api/admin/appointments` now accepts `type`, `payment`, `q`, `limit` query params (additive; existing params unchanged)
**File:** `src/controllers/admin.controller.js` (`listAppointments`)

### FIX 6 — Doctor performance insights
**Before:** Doctor cards showed flat numbers; no drill-down
**After:** "Insights" button opens a right-side drawer with:
- 4 hero KPIs (Total / Completion% / Revenue / Cancellation%)
- Status & type breakdown chips
- 14-day per-doctor sparkline
- Upcoming 10 appointments
**New endpoint:** `GET /api/admin/doctors/:id/insights`
**Files:** `src/controllers/admin.controller.js` (`doctorInsights`), `src/routes/admin.routes.js`, `public/admin/app.js` (`openInsights`)

### FIX 7 — Notification Logs dashboard
**Before:** `NotificationLog` model fully populated but never surfaced to admins
**After:** Dedicated sidebar view with:
- Count chips (Sent / Failed / Queued totals)
- Filters: template (auto-populated from distinct values), status, channel, date range, free-text search across recipient/error/template
- Click-through row to a detail modal showing payload (pretty-printed JSON), error message (red), full metadata
- Sidebar shows red badge with FAILED count
**New endpoints:**
- `GET /api/admin/notifications?status=&channel=&template=&from=&to=&q=&direction=&appointmentId=&limit=`
- `GET /api/admin/notifications/templates`
**Files:** `src/controllers/admin.controller.js` (`listNotifications`, `listNotificationTemplates`), `src/routes/admin.routes.js`, `public/admin/app.js` (`loadNotifications`, `openNotifModal`)

### FIX 4 — Richer analytics endpoint
**Backward compatible:** original fields all still present. Added: `cancelledAppointments`, `pendingAppointments`, `confirmedAppointments`, `onlineAppointments`, `offlineAppointments`, `revenueLast30`, `yesterdayAppointments`, `last7Appointments`, `last30Appointments`, `completionRate`, `cancellationRate`, `todayDelta`, `notificationsTotal`, `notificationsFailed`, `daily[]` (14-day series).
**File:** `src/controllers/admin.controller.js` (`analytics`)

---

## 🔍 No-op / preserved on purpose
- All existing endpoints behave identically
- All Bug 1 / Bug 2 / Bug 3 / Bug 4 / Bug 5 fixes preserved
- No Prisma schema changes
- No new npm dependencies
- Patient-facing booking widget untouched (would need a separate audit pass)

---

## 📂 Files changed
```
src/controllers/admin.controller.js   ← MODIFIED (analytics enriched; +3 new exports)
src/routes/admin.routes.js            ← MODIFIED (3 new routes)
public/admin/index.html               ← REWRITTEN
public/admin/app.js                   ← REWRITTEN
public/admin/styles.css               ← NEW
public/doctor/index.html              ← REWRITTEN (preserves all existing IDs)
public/doctor/app.js                  ← REWRITTEN (preserves all existing functions)
public/doctor/styles.css              ← APPENDED (overflow menu + workspace styles)
TESTING.md                            ← NEW
CHANGELOG_v2.md                       ← NEW
```

---

## 🛠 Migration steps (deployment)

1. **No DB migration needed.** Existing schema fully supports v2.
2. **Bump cache buster:** `?v=2.0.0` already set in HTML files (forces clients to pull new JS/CSS).
3. **Server restart:** Required since admin controller has new exports.
4. **Smoke test:** Follow `TESTING.md` § 0 (Pre-flight) and § 1.2 (Admin Dashboard) immediately after deploy.

```bash
# Local
npm install
npm run dev

# Production
npm ci --omit=dev
pm2 reload neokidspro-api  # or your process manager
```

---

## ⚠️ Known follow-ups (for v2.1)

These weren't in scope for this pass:
- Patient-facing booking widget UI refresh
- Sibling badge click → switch patient context inside workspace
- Bulk actions on admin Appointments table (cancel multiple, export CSV)
- Doctor calendar/heatmap availability view
- Push notifications (web push) for waiting-room updates
- `appointment-state.service.js` is a thin file — consider expanding to centralize all status transitions for stricter auditing
