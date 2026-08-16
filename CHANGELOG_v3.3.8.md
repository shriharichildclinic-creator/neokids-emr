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

## 4. v3.3.8 follow-up — draw pad "one giant white rectangle", PDF signature order & crop

**Root cause of the draw pad looking like a single white blob with buttons
stuck to it:** the canvas already draws its own always-white bordered box
(`#sigCanvas`). v3.3.7 additionally wrapped the *entire* draw pad — canvas
+ hint text + buttons — in a second white `.np-sig-surface` box. Two white
boxes with barely-visible `#D9E6E6` borders sitting directly against each
other read as one continuous white rectangle, with the hint and buttons
squeezed into whatever sliver of that white area was left. This is also
why "Clear drawing" looked faint — it wasn't a contrast bug this time, it
was two nested white boxes eating the visual separation a button needs to
read clearly.

**Fix:** `#sigDrawWrap` is no longer a `.np-sig-surface`. It's a plain
container holding the canvas (which is white on its own) followed by the
hint and the button row on the normal themed card background — where the
existing base `.np-btn` styles already have correct contrast in both
themes, with no override needed. `.np-sig-surface` is now used only where
it was actually needed: the two image-only preview boxes (saved signature,
live preview), which have no buttons to lose. Removed the now-dead
`.np-sig-surface .np-btn` override block entirely (~40 lines) since
nothing renders a button inside `.np-sig-surface` anymore.

**PDF signature order (per doctor sign-off):** flipped to the conventional
layout — signature image **above** the printed name, not below:
```
[Signature Image]
Doctor Name
Qualifications
```

**PDF signature "cut at edges":** the image is now fit into a box inset by
6pt on every side (rather than flush to the block's outer edges), so ink
that runs close to the source PNG's own edges still renders with visible
margin instead of looking clipped. Re-verified by rendering a deliberately
edge-touching test signature — full strokes visible, clean margin, no
crop.

**Cache:** bumped `styles.css` / `neokids-theme.css` links to `?v=3.3.8`
so this update can't be masked by a stale cached stylesheet on redeploy.

