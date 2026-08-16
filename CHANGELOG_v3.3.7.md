# v3.3.7 — Doctor Settings signature & layout root-cause fixes

## 1. Digital Signature (dark-on-dark, contrast, scaling)

**Root causes found:**
- `#sigPreviewWrap` used `background:var(--np-surface)`, which resolves to a
  *dark* color in dark mode. A saved signature is dark ink on a transparent
  background, so on that dark surface it became nearly invisible.
- The "Clear drawing" button's dark-mode style set its text color to
  `var(--nk-ink)`, which resolves to a near-white color in dark mode — on a
  surface that was force-painted white by a separate override. Near-white
  text on white = invisible.
- That white-surface override existed in **two duplicated copies** (one for
  desktop, one re-declared inside a `max-width:1023px` media query), which
  is exactly the kind of override-on-override pattern that makes bugs like
  the one above easy to introduce and hard to find.
- Preview scaling was inconsistent because the saved-signature preview, the
  live (pre-save) preview, and the draw pad each had their own one-off
  inline `max-height`/`max-width`/`background` styles instead of a shared
  rule.

**Fix:**
- Introduced one consolidated, **unthemed** `.np-sig-surface` / `.np-sig-img`
  component in `neokids-theme.css`. It uses hardcoded light colors, not
  theme variables, because this is a functional white-paper-and-ink surface
  that is never supposed to follow the app theme — so it needs no dark-mode
  override to fight in the first place (one small, non-duplicated exception
  is added only where the base `.np-btn` dark rule outranks it by
  specificity).
- Deleted both duplicate `#sigDrawWrap`/`#sigCanvas`/`#sigLiveWrap`
  override blocks.
- `public/doctor/index.html`: the preview box, draw pad, and live preview
  now all use the same `.np-sig-surface` wrapper and `.np-sig-img` image
  class, so scaling (`height:56px; object-fit:contain`, aspect-ratio
  preserved, never stretched/squashed/cropped) can't drift between states.

## 2. Doctor Settings cards look "stretched" (Appearance, Consultation Fees)

**Root cause:** `.np-settings-grid` used CSS Grid's default
`align-items:stretch`, which forces every card in a grid row to match the
height of its tallest sibling. The Signature card grew tall (upload + draw
pad), stretching whatever card shared its row (Appearance) into a mostly
empty box; Clinic Location did the same to Consultation Fees.

**Fix:** `align-items:start` on `.np-settings-grid` (`public/doctor/styles.css`)
— one line, cards now size to their own content. The existing
`@media (max-width:900px)` single-column rule already covers tablet/mobile.

## 3. Prescription/certificate/invoice PDF signature block

**Root cause:** `drawSignatureBlock()` drew the signature image *above* the
doctor's name/qualification (wrong order vs. the required layout) and
center-aligned the image inside its box while the text below it was
left-aligned — the source of the "signature alignment inconsistent" and
"looks generated" complaints.

**Fix:** rebuilt the block as `Doctor Name → Qualification → [Reg. No] →
Signature Image → "Digital Signature" caption`, all flush to one shared
left edge (`leftX`). Height is computed and clamped up front so the whole
block always fits above the footer band on one page — never crops the
image, never overflows, never spawns an extra page. Verified with a
rendered test PDF (image below, from `pdftoppm`):

```
Dr. Juhainah Nasir
MBBS, MD (Pediatrics)
Reg. No: KMC 12345
[signature image, left-aligned, full aspect ratio, not cropped]
Digital Signature
```
