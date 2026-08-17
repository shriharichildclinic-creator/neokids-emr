# NeoKidsPro EMR — Historical Records Refactor (v3.4.6)

## Summary
Complete UX/UI refactor of the Doctor Panel **Historical Records** section
from a form-first workflow to a records-first management screen. All legacy
endpoints and workflows are preserved.

## What changed

### Backend (additive, non-breaking)
- **New endpoint** `GET /api/doctor/previous-records`
  - Doctor-wide list across ALL patients (no more "select a patient first").
  - Full-text search across `patient.name`, `patient.phone`, `title`,
    `diagnosis`, `notes`, `treatment`, `medications`.
  - Filters: `recordType`, `dateFrom`, `dateTo`, `patientId`.
  - Pagination: `page`, `pageSize` (default 25, max 100).
  - Response includes `total`, `totalPages`, plus fully-decorated records
    (signed attachment URLs, doctor + patient blocks).
- **New endpoint** `GET /api/doctor/previous-records/:id` (was defined in
  the controller but never routed; now wired for the View modal).
- Existing routes (`/patients/:patientId/previous-records`,
  `/previous-records/:id` PUT/DELETE, attachment routes, share, PDF) are
  **untouched**.
- Prisma schema untouched — the new list endpoint reuses existing fields
  and indexes (`@@index([doctorId, patientId, recordDate])`).

### Frontend
- **`public/doctor/index.html`** — the `#historicalTab` section replaced
  with a records-first layout:
  - Sticky toolbar: instant search input + record-type filter + date-from
    / date-to + Reset.
  - `Add Historical Record` primary button in the panel head.
  - Desktop table (`Patient | Date | Type | Diagnosis | Files | Actions`)
    and mobile card list — auto-switch via CSS at 780 px.
  - Pagination footer.
  - Two new modals portaled to `<body>`:
    - `#hrRecordModal` — Add / Edit (patient picker, record type dropdown,
      title, diagnosis, notes, treatment, medications, drag-and-drop
      multi-attachment upload with per-file labels, existing-attachment
      management: preview / download / open / replace / delete).
    - `#hrViewModal` — read-only detail view with attachment previews and
      one-click "Edit" + "Generate PDF" actions.
- **`public/doctor/historical-fix.js`** — rewritten from a 58-line
  helper into a complete SPA module (~600 lines):
  - Debounced (220 ms) instant search — no Search button required.
  - Records load on tab open; not gated on patient selection.
  - Mobile-first responsive: full-screen modals with sticky header and
    footer at ≤ 640 px; card list at ≤ 780 px.
  - Multi-file uploads (PDF, JPG/PNG/WEBP, DOCX/XLSX future-ready) with
    25 MB per-file cap and 20-file cap enforced client-side; drag-drop
    supported.
  - Backward-compatible shims preserved: `window.hrRenderAttachments`,
    `window.hrShare`, `window.hrGeneratePdf`, `window.initHistoricalForm`.
- **`public/doctor/styles.css`** — new `.hr-*` design tokens (~200 lines),
  fully themed for light + dark; sticky toolbar; drop zone; attachment
  cards; responsive breakpoints.
- **`public/doctor/app.js`** — the legacy `initHistoricalForm()` and its
  IIFE counterpart are neutralized so the shared `#historicalForm`
  element only has ONE submit handler (the refactored module). The
  legacy Feature-1 endpoint `/doctor/historical-appointments` is left
  in place; the new panel uses `/doctor/previous-records` throughout.

## Requirements coverage
| # | Requirement                                     | Status |
|---|-------------------------------------------------|--------|
| 1 | Records-first page layout                       | ✅ |
| 2 | Real-time debounced search                      | ✅ |
| 3 | Correct information hierarchy                   | ✅ |
| 4 | Add Record via modal                            | ✅ |
| 5 | Edit Record modal preloads existing data        | ✅ |
| 6 | Multi-attachment support with metadata          | ✅ |
| 7 | Attachment management (add/remove/replace/DL/preview) | ✅ |
| 8 | Dedicated View modal (read-only)                | ✅ |
| 9 | Mobile card view + count chips                  | ✅ |
| 10 | Responsive modals (full-screen, sticky bars)   | ✅ |
| 11 | Records visible immediately, no patient gating | ✅ |
| 12 | CRUD audit (create, read, update, delete)      | ✅ |
| 13 | Pagination + debounced search                  | ✅ |
| 14 | Final expected workflow                        | ✅ |

## Legacy workflow preservation
- Patient history timeline still reads from the same
  `PreviousRecord` / `PreviousRecordAttachment` tables.
- Existing `/patients/:patientId/previous-records` route unchanged for
  callers that already filter by patient.
- Manual historical-appointment endpoint (`POST /doctor/historical-appointments`)
  and its Zod schema, upload middleware and controller left as-is.
- Share (WhatsApp + email) and PDF-generation endpoints unchanged;
  reachable from the new View modal.
- No Prisma migration required — schema is a superset of what was
  already in production since v3.4.3.
