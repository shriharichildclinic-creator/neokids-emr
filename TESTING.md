# NeoKidsPro EMR — End-to-End Testing Playbook (v2.0)

Use this as a step-by-step QA checklist after every deploy. **Each section is independent — you can run them in any order, but the recommended sequence below mirrors a real user journey.**

Legend:
- ☐ = open task
- ✅ = pass
- ❌ = fail (file a bug)

---

## 0. Pre-flight Setup

| # | Step | Expected |
|---|---|---|
| 0.1 | `npm install` | No errors |
| 0.2 | Configure `.env` (DATABASE_URL, JWT_SECRET, SMTP_* or leave empty for mock mode) | Loaded |
| 0.3 | `npx prisma migrate deploy` (or `npx prisma db push` for dev) | Schema in sync |
| 0.4 | `node prisma/seed.js` | Admin + sample doctor exist |
| 0.5 | `npm run dev` | Server on :3000, no console errors |
| 0.6 | `curl http://localhost:3000/health` | `{ status: "ok" }` |
| 0.7 | Open `http://localhost:3000/admin` | Login screen renders, brand styles applied |
| 0.8 | Open `http://localhost:3000/doctor` | Login screen renders, brand styles applied |

---

## 1. Admin Workflow

### 1.1 Login
1. Visit `/admin` → enter seed admin email/password → **Sign in**
   - ✅ Lands on Dashboard view
   - ✅ Sidebar shows Dashboard / Doctors / Appointments / Notification Logs / Settings
   - ✅ Profile dropdown shows Admin name
2. **Bad password** test
   - Enter wrong password → "Login failed" toast, no token in localStorage
3. **Token expiry** test
   - Open DevTools → `localStorage.setItem('np_admin_token','garbage')` → reload
   - ✅ Auto-redirects back to login (401 interceptor)

### 1.2 Dashboard (FIX 4)
1. Verify 6 KPI cards render with correct values:
   - Today's Appointments (with ▲▼ delta vs yesterday)
   - Last 7 days
   - Total Patients
   - Lifetime Revenue (with last-30 sub)
   - Completion Rate %
   - Cancellation Rate %
2. ✅ 14-day bar chart renders (bars proportional, hover tooltip shows date/total/completed/revenue)
3. ✅ Recent appointments list shows 10 latest with status badge
4. ✅ Click "View all" → jumps to Appointments view

### 1.3 Doctor Onboarding
1. **Add Doctor**:
   - Click "+ Add Doctor"
   - Fill: name="Test Doc", email="test.doc+`<timestamp>`@example.com", phone="9876543210"
   - Leave password empty
   - Set online fee ₹500, in-person ₹750
   - Save → ✅ "Doctor created. Mock invite link: …" alert
2. **Verify card appears** in Doctors view
3. **Invite link works**:
   - Copy the mock invite URL → open in incognito → set new password → log in as that doctor on `/doctor`
   - ✅ Doctor must change password on first login (`mustChangePassword` flow)

### 1.4 Doctor Insights Drawer (FIX 6)
1. From Doctors view, click **Insights** on any doctor
2. ✅ Drawer slides in from the right
3. Verify:
   - 4 KPIs render (Total / Completion / Revenue / Cancellations)
   - 14-day bar chart (per-doctor)
   - Upcoming appointments list
   - Status badges (Completed / Confirmed / Pending / Cancelled / Online / In-person)
4. Click outside drawer → ✅ closes
5. Press Escape → ✅ closes

### 1.5 Doctor Edit
1. Click **Edit** on a doctor card → modal opens with prefilled data
2. ✅ Email field is read-only (still submitted but `disabled=false`)
3. Change phone → Save → ✅ "Doctor updated."
4. Verify the card reflects the new phone

### 1.6 Doctor Deactivate / Activate
1. Click **Deactivate** → card shows "Inactive" badge
2. Click **Activate** → card shows "Active" again
   - 🐛 **Known issue:** the legacy `DELETE /api/admin/doctors/:id` endpoint sets `deletedAt`, which would hide the doctor from `listDoctors`. The Deactivate button calls `PUT { isAvailable: false }` (no soft-delete), so re-activate works. Do NOT use the `DELETE` endpoint from the UI — only `/hard` is exposed via the trash icon.

### 1.7 Hard Delete
1. Try trashing a doctor who has appointments → ✅ 409 "Hard delete is blocked"
2. Create a fresh doctor (no appts) → click trash → ✅ "Doctor permanently deleted"

### 1.8 Appointments Filters (FIX 5)
1. Open Appointments view → ✅ Table loads with all filter pills
2. Test each filter independently:
   - Status = COMPLETED → only completed rows
   - Type = ONLINE → only online rows
   - Payment = PAID → only paid rows
   - Doctor = pick one → only their rows
   - Date range (from + to) → only rows within range
   - Search box: type "fever" → debounced filter, only rows whose patient name / problem matches
3. Test combinations: Status=CONFIRMED + Type=ONLINE + Doctor=X + last 30 days
   - ✅ All filters compose
4. Click **Clear** → all filters reset, full list reloads
5. Cancelled row: cancellation reason shown in red beneath status badge

### 1.9 Notification Logs (FIX 7)
1. Open Notification Logs view
2. ✅ Three count chips (Sent / Failed / Queued) render with totals
3. Filter by Status=FAILED → only failures
4. Filter by Channel=WHATSAPP → only WA logs
5. Filter by Template → dropdown auto-populated from distinct templates
6. Date range filter works
7. Click a row → ✅ Detail modal opens showing:
   - When, Channel, Direction, Template, Recipient, Appointment ID
   - Error message (if failed) in red monospace box
   - Payload JSON pretty-printed
8. Sidebar "Notification Logs" item shows red badge with FAILED count when > 0

### 1.10 Change Password
1. Settings → enter wrong current password → ✅ Error returned
2. Enter correct current + new (8+ chars, letters+digits) twice → ✅ "Password changed"
3. Sign out, sign back in with new password → ✅ Works

---

## 2. Doctor Workflow

### 2.1 Login & Auto-login
1. Visit `/doctor` → log in → ✅ Dashboard renders, KPI bar, snapshot, sidebar
2. Reload page → ✅ Still logged in (token in localStorage)
3. Sign out → ✅ Returns to login

### 2.2 Dashboard Snapshot & KPIs
1. ✅ 4 KPI cards render (Today's Patients / Total Consults / Completed Today / Revenue)
2. ✅ Today's snapshot shows up to 5 waiting patients
3. Sidebar shows "Waiting Room" with badge count = # waiting

### 2.3 Appointment Card Action Hierarchy (FIX 1)
**The most important UX verification.**
1. On any active appointment card you should see:
   - **Primary blue button**: "Open Consultation"
   - **Secondary green button** (only if ONLINE + meet link): "Join Meeting"
   - **Overflow `⋮` icon** at the end
2. Click `⋮` → ✅ Menu appears with: Mark complete · Reschedule · Cancel · (View prescription if exists)
3. Click outside menu → ✅ Closes
4. Press Escape → ✅ Closes
5. On COMPLETED/CANCELLED cards:
   - Primary becomes "View" (not "Open Consultation")
   - No green "Join Meeting" button
   - Overflow only contains "View prescription" if one exists
6. On a CANCELLED card → ✅ Red box shows cancellation reason

### 2.4 Route-Based Consultation Workspace (FIX 2)
1. Click "Open Consultation" on a CONFIRMED card
2. ✅ URL changes to `/doctor#consult/<appointment-id>`
3. ✅ Workspace renders in main area (NOT a modal) with:
   - Patient name, age, badges in header
   - Action buttons (Join Meeting / Reschedule / Cancel / Mark Complete) in header
   - Three tabs: Summary · Prescription · Patient History
4. **Deep-link test**: copy that URL, open in a new tab → ✅ Goes straight to the same consultation
5. Sidebar nav: "Active Consultation" appears under Clinical
6. Click another sidebar item (e.g., Waiting Room) → ✅ Active Consultation item disappears, URL hash cleared
7. Visit a non-existent consult ID → ✅ Workspace shows "Could not open consultation" with back button

### 2.5 Prescription Flow (within Workspace)
1. In consultation workspace → click "Prescription" tab
2. ✅ Existing prescription form renders (medications table + chief complaint + diagnosis + vitals + advice + follow-up)
3. Add a medication row → fill name / dose / freq / duration / instructions
4. Fill chief complaint, diagnosis (both required, min 2 chars)
5. Click "Save prescription"
   - ✅ Form submits, status changes to COMPLETED
   - ✅ Success card appears with PDF view/download/resend buttons
   - ✅ PDF link opens valid PDF in new tab
6. Click "Resend to patient" (if patient has email) → ✅ "Prescription re-sent to <email>"
7. **Validation tests**:
   - Submit without any medication → ❌ alert "add at least one medication"
   - Empty diagnosis → ❌ alert

### 2.6 Prescription Archive (FIX 3)
1. Sidebar → "Prescription Archive"
2. ✅ List of all your prescriptions, newest first
3. Date range filter: From=last week, To=today → ✅ List narrows
4. Search "fever" → ✅ Only matching diagnoses/problems
5. **Clear** button → resets all filters
6. Click "View PDF" → ✅ Opens PDF
7. Click "Open visit" → ✅ Takes you to that appointment's workspace

### 2.7 Modal "Peek" Mode (Backward Compatibility)
1. The Patient modal still exists for any code path that calls `openPatient(id)` directly. Verify by:
   - Opening DevTools console → `openPatient('<some-appt-id>')`
   - ✅ Modal opens with same Current Visit / Prescription / History tabs
   - ✅ "Open full workspace" button in header — clicking it closes the modal and routes to `#consult/<id>`

### 2.8 Reschedule Flow
1. From any active card → ⋮ → Reschedule
2. Pick a new date → ✅ Slots load for that doctor + type
3. Select a slot → "Confirm reschedule" enables
4. Add reason → submit
5. ✅ "Appointment rescheduled. Patient and doctor have been notified by email and WhatsApp."
6. Verify in Appointments tab → row shows new date/time
7. Open the consultation again → ✅ Summary shows "ⓘ Rescheduled on <date> — '<reason>'"

### 2.9 Cancel Flow
1. ⋮ → Cancel → modal opens
2. Try reason < 3 chars → ❌ alert
3. Type valid reason → submit
4. ✅ Card now shows CANCELLED badge + red "Cancelled: <reason>" box
5. ✅ Cannot re-cancel (button hidden)
6. ✅ Cannot reschedule a cancelled appt (button hidden)
7. ✅ Patient should receive WhatsApp + email (verify via Notification Logs in admin)

### 2.10 Mark Complete Flow
1. ⋮ → Mark complete → confirm dialog → OK
2. ✅ Status → COMPLETED
3. ✅ KPI "Completed Today" increments
4. ✅ Sidebar badge for Waiting Room decrements

### 2.11 Patient History Tab
1. In workspace → Patient History tab
2. ✅ Shows: total visits, completed, last visit, open follow-ups
3. ✅ Siblings badge row if same parent phone has multiple kids
4. ✅ List of past visits with prescription PDF links
5. Click a sibling badge — *(known: no action wired; planned for v2.1)*

### 2.12 Settings — Availability
1. Settings → Availability card
2. Change online from-to, offline from-to
3. Toggle slot duration (10/15/20/30) — pill active visual
4. Toggle working days — multi-select
5. Toggle "I'm accepting new appointments"
6. Save → ✅ "Availability saved"
7. Reload → ✅ Values persisted

### 2.13 Settings — Clinic Location, Fees, Photo, Password
1. Fill clinic name + address + Google Maps URL + lat/lng → Save
2. Update online/in-person fees → Save → ✅ Verify with Admin → Doctors view (fee should reflect)
3. Upload profile photo (JPG/PNG) → ✅ Photo shows in topbar and on patient-facing booking widget
4. Remove photo → confirms → ✅ initials shown
5. Change password (old → new ≥ 8 chars, letters+digits) → ✅ "Password updated"

---

## 3. Patient (Public) Workflow

### 3.1 Booking Widget
1. Open `/assets/booking-widget.html`
2. Search/pick a doctor → see specialization, fees, photo
3. Pick a date → slots load (matches doctor's availability)
4. Pick a slot → patient form (name, phone, problem, gender, DOB)
5. Online appt → ✅ Cashfree payment redirect (or mock mode shows success URL)
6. Offline appt → ✅ "Cash at clinic" path
7. After confirmation:
   - ✅ Patient receives WhatsApp + email
   - ✅ Doctor receives WhatsApp + email
   - ✅ Booking appears in admin Appointments AND doctor's Waiting Room

### 3.2 Sibling Booking (Bug 1 regression test)
1. Book once for parent phone 9876543210, child "Aarav"
2. Book again same phone, child "Aanya"
3. ✅ Both bookings succeed
4. ✅ Doctor's Patient History shows both as siblings

### 3.3 Reschedule (patient-side)
*Patient reschedule isn't yet a self-service feature; reschedule is doctor-driven only. Skip or escalate.*

### 3.4 Payment States
1. Successful payment → status CONFIRMED, paymentStatus PAID
2. Cancel payment mid-flow → status PENDING, paymentStatus UNPAID, `expiresAt` set
3. Wait for lifecycle job (or run manually) → ✅ Pending unpaid bookings auto-cancel after expiry

---

## 4. Automations & Notifications

Use Admin → Notification Logs to verify every event below produces logs.

| Event | Channels | Recipients |
|---|---|---|
| Doctor onboarded | WhatsApp + Email (invite link) | Doctor |
| Booking confirmed (online, paid) | WhatsApp + Email | Patient + Doctor |
| Booking confirmed (offline) | WhatsApp + Email | Patient + Doctor |
| Appointment rescheduled | WhatsApp + Email | Patient + Doctor |
| Appointment cancelled | WhatsApp + Email | Patient + Doctor |
| Prescription created | Email with PDF attachment | Patient |
| Prescription resend | Email with PDF attachment | Patient |
| Password reset | Email | Account holder |
| Follow-up reminder (cron) | WhatsApp | Patient |

For each row above:
1. Trigger the event
2. Open Admin → Notification Logs
3. Confirm at least one entry appears within ~5 seconds
4. If status = FAILED → click row → read error → file the issue with the payload

---

## 5. Cron / Lifecycle Jobs

The lifecycle service runs the following jobs (see `src/services/lifecycle.service.js`):

| Job | Cadence | Test |
|---|---|---|
| Auto-cancel expired PENDING/UNPAID bookings | Every minute | Create unpaid online appt, set `expiresAt` to 1 min ago in DB, wait, verify auto-cancelled |
| Auto-complete past appointments (no Rx) | Hourly | Create CONFIRMED appt with past date+time, wait, verify status = COMPLETED |
| Daily follow-up reminders | Daily 9 AM | Create prescription with `followUpDate` = tomorrow, wait, verify WhatsApp sent |
| Notification log cleanup (90+ days) | Weekly | Skip in dev |

---

## 6. Edge Cases & Regression

### 6.1 Empty States
- ☐ Brand new doctor (no patients) → Dashboard snapshot shows "No patients waiting" CTA
- ☐ Brand new admin (no doctors) → Doctors view shows "No doctors yet" empty state
- ☐ Search returning zero → "No matches" with clear-filters button

### 6.2 Permissions
- ☐ Doctor token cannot hit `/api/admin/*` → 403
- ☐ Admin token cannot hit `/api/doctor/*` → 403
- ☐ Doctor A cannot read Doctor B's appointment → 404 (scoped by doctorId)

### 6.3 CORS / Auth
- ☐ Browser sends `Authorization: Bearer …` on all `/api` calls
- ☐ Expired/invalid token → 401 interceptor logs out
- ☐ CORS in prod locked to APP_URL (no `*` with credentials)

### 6.4 PDF Storage
- ☐ Delete a prescription PDF from disk while DB row still references it
- ☐ Visit `GET /doctor/appointments/:id/prescription` → ✅ PDF regenerated on the fly

### 6.5 Slot Locking
- ☐ Two browsers simultaneously book the same doctor/date/slot → ✅ Second gets `unique_doctor_slot` constraint error (409)

### 6.6 Phone Normalization
- ☐ Submit phone with leading "91" → ✅ stripped server-side
- ☐ Submit phone with formatting "+91 98765 43210" → ✅ digits-only stored

### 6.7 Browser Matrix
Run a smoke pass (sign in → open consultation → save prescription) on:
- ☐ Chrome latest
- ☐ Safari latest (iOS + macOS)
- ☐ Firefox latest
- ☐ Edge latest

### 6.8 Mobile (≤ 1023px)
- ☐ Hamburger toggles sidebar drawer
- ☐ Backdrop click closes drawer
- ☐ Appointment cards stack cleanly
- ☐ Filter bar wraps without overflow
- ☐ Modal/drawer is full-width-ish

---

## 7. Performance / Smoke

| Metric | Target | Tool |
|---|---|---|
| `/api/admin/analytics` | < 300 ms with 10k appointments | `curl -w "%{time_total}"` |
| `/api/doctor/appointments` | < 200 ms with 1k appts | same |
| `/api/admin/notifications` | < 250 ms with 10k logs | same |
| Dashboard first-contentful paint | < 1 s on broadband | DevTools Lighthouse |

---

## 8. Automated Test Stubs (recommended next step)

We don't ship integration tests in this repo yet. Recommended to add **Playwright** scripts for these critical flows — each maps to a section above:

```js
// tests/e2e/doctor.spec.js
test('FIX 1 — appointment card has primary + secondary + overflow', async ({ page }) => {
  await login(page, 'doctor');
  const card = page.locator('.np-appt').first();
  await expect(card.locator('text=Open Consultation')).toBeVisible();
  await expect(card.locator('.np-overflow-trigger')).toBeVisible();
  await card.locator('.np-overflow-trigger').click();
  await expect(page.locator('.np-overflow-menu.is-open')).toBeVisible();
});

test('FIX 2 — deep-link to consultation', async ({ page }) => {
  await login(page, 'doctor');
  await page.goto('/doctor#consult/<known-id>');
  await expect(page.locator('#consultWorkspace')).toBeVisible();
});

test('FIX 3 — prescription archive renders and filters', async ({ page }) => {
  await login(page, 'doctor');
  await page.click('[data-tab=rxArchiveTab]');
  await expect(page.locator('#rxArchiveList .np-appt')).toHaveCountGreaterThan(0);
});

test('FIX 5 — admin appointments filter by status', async ({ page }) => {
  await login(page, 'admin');
  await page.click('[data-view=apptsView]');
  await page.selectOption('#filterStatus', 'COMPLETED');
  await page.click('#applyFilters');
  await expect(page.locator('#apptsTbody tr')).toHaveCountGreaterThan(0);
});

test('FIX 7 — notification logs detail modal', async ({ page }) => {
  await login(page, 'admin');
  await page.click('[data-view=notifView]');
  await page.locator('#notifTbody tr').first().click();
  await expect(page.locator('#notifModal')).toBeVisible();
});
```

Run with:
```bash
npm i -D @playwright/test
npx playwright install
npx playwright test
```

---

## 9. Bug Report Template

When you find a failure, file using this format:

```
**Title:**   [Admin · Notifications] Detail modal doesn't render payload
**Section:** 1.9 step 7
**Browser:** Chrome 120.0
**Steps to repro:**
1. …
2. …
**Expected:** payload JSON pretty-printed
**Actual:** payload field empty
**Console errors:** (paste)
**Network tab:** GET /api/admin/notifications → 200 with payload field present
**Severity:** P2
```

---

## 10. Sign-off Checklist (must be 100% before merging)

- ☐ All P0/P1 issues from previous version still resolved (Bug 1 through Bug 8)
- ☐ Section 1 — Admin Workflow (all checks pass)
- ☐ Section 2 — Doctor Workflow (all checks pass)
- ☐ Section 3 — Patient Workflow (all checks pass)
- ☐ Section 4 — Automations (every event produces a log)
- ☐ Section 5 — Cron jobs (auto-cancel + auto-complete + follow-up reminder all fire)
- ☐ Section 6 — Edge cases reviewed
- ☐ Section 7 — Performance targets met
- ☐ Production `.env` reviewed (no dev secrets leaked)
- ☐ Database backup taken before deploy

Once every box above is ticked — ship it. 🚀
