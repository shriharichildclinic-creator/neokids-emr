# NeoKidsPro EMR v3.3.6 Rework Audit + Deployment Notes

## What was fixed

### 1) Previous Records
- Reworked into a doctor-only feature gated by a doctor-level permission flag.
- Added `Doctor.canAddPreviousRecords` database field.
- Added new `PreviousRecord` table and doctor routes for create/list/update/delete.
- Admin panel now only toggles the permission; admin creation flow was removed from routing.
- Doctor UI now uses a dedicated **Previous Records** workflow for existing patients, with attachment support and edit/delete actions.
- Patient history API now includes previous records and permission metadata.

### 2) Certificate System
- Admin certificate flow is now read-only in the UI.
- Certificate API responses now return signed PDF URLs so browser downloads work without broken auth.
- Existing admin access remains for view/download/audit only.

### 3) Digital Signatures
- Added drawn-signature support (`POST /api/doctor/signature/drawn`).
- Doctor settings UI now supports:
  - upload image signature
  - draw signature on canvas
  - preview existing signature
  - save registration number
- Signature controller now safely replaces old files on update.

### 4) PDF Generation
- Prescription PDF now includes appointment date, appointment time, and consultation mode.
- Signature block logic remains consolidated in a single doctor section.
- Certificate URLs are signed for browser-safe opening.

### 5) UI / Permission separation
- Doctor form in admin panel now includes **Allow Previous Records** checkbox.
- Admin certificate create button is disabled/read-only.
- Doctor sidebar label changed from Historical Records to Previous Records.

## Database changes applied in this package
Migration folder added:
- `prisma/migrations/20260820110000_previous_records_rework/migration.sql`

Schema changes:
- `Doctor.canAddPreviousRecords Boolean @default(false)`
- new `PreviousRecord` model / `previous_records` table
- relations from `Doctor` and `Patient` to `PreviousRecord`

## Core files changed
- `prisma/schema.prisma`
- `prisma/migrations/20260820110000_previous_records_rework/migration.sql`
- `src/utils/validators.js`
- `src/utils/fileTokens.js`
- `src/controllers/previous.controller.js`
- `src/controllers/signature.controller.js`
- `src/controllers/certificate.controller.js`
- `src/controllers/doctor.controller.js`
- `src/controllers/admin.controller.js`
- `src/routes/doctor.routes.js`
- `src/routes/admin.routes.js`
- `src/routes/files.routes.js`
- `src/services/pdf.service.js`
- `public/doctor/index.html`
- `public/doctor/app.js`
- `public/admin/index.html`
- `public/admin/app.js`

## Known scope notes
- Legacy historical-appointment flow was left in place for backward compatibility, but Previous Records now has its own doctor-only route set.
- Prisma CLI validation in this environment is blocked by the project’s datasource syntax/version mismatch, so runtime JS syntax and route-level integration were validated instead.

## Deployment steps
1. Back up the current project and database.
2. Replace the application files with this fixed package.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Generate Prisma client:
   ```bash
   npx prisma generate
   ```
5. Apply the migration:
   ```bash
   npx prisma migrate deploy
   ```
   If your deployment process uses manual SQL, apply:
   - `prisma/migrations/20260820110000_previous_records_rework/migration.sql`
6. Restart the application.
7. Smoke test:
   - admin can toggle doctor Previous Records permission
   - doctor sees/hides Previous Records tab based on permission
   - doctor can create/edit/delete previous records for an existing patient
   - doctor can upload/draw/remove signature
   - doctor can generate a prescription PDF showing date/time/mode
   - doctor/admin can open certificate PDFs from the UI

## Recommended post-deploy checks
- Verify `storage/signatures` and `storage/historical-rx` are writable.
- Confirm signed file URLs open correctly in a fresh browser tab.
- Confirm existing doctors default to `canAddPreviousRecords = false` until explicitly enabled.
