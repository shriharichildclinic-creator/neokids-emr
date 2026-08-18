# v3.4.12 — Previous Records: mobile modal fixes + conditional forms

## 1. Mobile modal responsiveness

The Previous Records **View** and **Edit/Add** modals had their headers
visibly cut off on phones:

- The parent `.np-modal` used `align-items:flex-end` on mobile, and the
  `.hr-modal` panel was forced to `height:100vh`. Together this pushed
  the sticky header above the visible viewport on tall content, clipping
  the title and close button.
- Long titles/subtitles pushed the close button off-screen on very
  narrow phones because the header flexbox had no explicit clamping.
- iOS Safari's collapsing address bar occasionally cropped the sticky
  footer / header because we used `vh` rather than `dvh`.

**Fix (styles.css, `@media (max-width: 640px)`):**
- Re-anchor the hr-modal to the top of the viewport on mobile
  (`align-items:flex-start`, `padding:0`).
- Switch the panel to `100dvh` (dynamic viewport) so it always matches
  the visible area on iOS/Android Chrome.
- Header pinned as a non-shrinking flex item with `min-height:56px`,
  a 36×36 always-centred close button, and two-line clamping on the
  title / subtitle so an overlong title can never grow the head beyond
  the visible area.
- Footer padded with `env(safe-area-inset-bottom)` so the action buttons
  clear the iOS home indicator.

## 2. Conditional forms per record type

The Add / Edit / View modals used one generic layout for all record
types, so doctors saw irrelevant fields (e.g. Treatment on a Lab Report,
Medications on a Radiology scan).

**Fix:** each field is now toggled by the selected record type from a
single source of truth (`RECORD_TYPE_FIELDS` in `historical-fix.js`):

| Record type          | Fields shown |
| -------------------- | ------------ |
| Consultation         | Diagnosis, Clinical Notes, Treatment, Medications, Attachments |
| Prescription         | Diagnosis, **Prescription Notes**, Medications, Attachments (Treatment / Lab Report hidden) |
| Lab Report           | Title, Findings, Attachments |
| Radiology / Scan     | Title, Scan Type, Findings, Attachments |
| Vaccination          | Vaccine Name, Dose Number, Batch Number, Vaccination Date (Diagnosis / Treatment / Medications hidden) |
| Referral Letter      | Referred To, Reason, Attachments (Medications / Treatment hidden) |
| Discharge Summary    | Admission Date, Discharge Date, Summary, Attachments (Medications / Treatment hidden) |
| Other                | Full form (backwards compatible) |

The **View** modal and generated **PDF** are aligned with the same
mapping — irrelevant rows are simply not rendered.

## 3. Additive-only backend contract

Type-specific extras (findings, scanType, vaccineName, doseNumber,
batchNumber, vaccinationDate, referredTo, reason, admissionDate,
dischargeDate, summary) are marshalled into the existing free-text
`notes` column via a stable JSON tail marker:

```
Notes body…\n\n<!--HR_EXTRAS_V1:{"findings":"…","scanType":"…"}:HR_EXTRAS_V1-->
```

This means:

- ✅ **No schema migration** — every existing route, controller, list
  endpoint, patient-history payload, PDF generator and search-index
  keeps working unchanged.
- ✅ **Legacy records** (with no marker) pass through untouched — the
  extractor returns the notes body verbatim and empty extras.
- ✅ **Older clients** that still POST plain notes stay compatible;
  those records simply have no extras JSON to unpack.
- ✅ **Marker never leaks** into any user-visible surface: the doctor
  view modal, patient-history timeline, legacy previous-records list,
  edit form and generated PDF all strip the tail before rendering.

## Files changed

- `public/doctor/index.html` — new `data-hr-field` attributes and new
  type-specific inputs inside `#historicalForm`.
- `public/doctor/styles.css` — mobile modal header/footer fix under
  `@media (max-width: 640px)`.
- `public/doctor/historical-fix.js` — `RECORD_TYPE_FIELDS`,
  `applyRecordTypeVisibility`, extras extract/embed helpers, wired into
  `openRecordModal` / `loadIntoForm` / `submitRecord` /
  `renderViewContent`.
- `public/doctor/app.js` — `stripHrExtras()` guard for the patient
  history timeline, legacy previous-records list, and legacy edit form.
- `src/services/historical-record-pdf.service.js` — extras extractor +
  per-type section ordering so the generated PDF matches the View modal.
- `package.json` — version bump to `3.4.12`.

## Backwards compatibility

- No routes, controllers, database columns or Prisma migrations changed.
- Every existing record renders exactly as before; extras only exist on
  records saved by v3.4.12 or later.
- Every legacy front-end path that referenced `notes` directly now
  strips the marker, so downgrading to an older client only means the
  extras section disappears — the raw JSON is never exposed.
