# v3.4.12 — Corrected Fix Pack + Safe Deployment Guide

This pack keeps ONLY the two targeted fixes plus their small supporting UI
additions, and restores the two safety files the previous AI build dropped
(`.gitignore` and `storage/`) — which is what let `node_modules/` get
committed during your last deploy.

## What is fixed
1. **Medical Certificate "Update Certificate" 500** — two compounding bugs:
   - `medicalCertificateSchema` is built with `.refine()` → a `ZodEffects`
     wrapper that has **no `.partial()` method**. Calling `.partial()` on it
     threw `TypeError` on every PUT → HTTP 500. Fixed by deriving
     `medicalCertificateUpdateSchema` from the plain base object
     (`src/utils/validators.js`).
   - The update handler ran **two conflicting date-normalization passes**;
     the second nulled `fromDate/toDate` and left an inconsistent Prisma
     record. Replaced with one deterministic pass; `prisma.update` wrapped in
     try/catch (400, never 500); PDF regeneration is best-effort.
   - Verified by `scripts/smoke-cert-update.js` — 8 patch shapes, all HTTP 200.

2. **Appointment "View" → Dashboard redirect** — `location.hash` assignment
   fires a spurious `popstate` on mobile WebKit, which hit the back-nav guard
   and bounced to Dashboard. All in-app hash routing now goes through
   `NPBackNav.routeHashNav()` (`public/doctor/app.js`).

## What is restored (vs the previous AI ZIP)
- `.gitignore`  → prevents `node_modules/`, `.env`, logs, etc. from being committed.
- `storage/.gitkeep` → keeps the runtime storage dir present without tracking uploads.

## What was NOT changed
- No UI redesign. No structure change. No tech-stack change.
- `Previous Records`, `Consultation History`, `Patient History` rendering code
  is byte-identical to the known-good build. Their data endpoints are untouched.
- Only dependency delta: `dayjs 1.11.21 → 1.11.23` (patch bump). `zod` stays
  pinned at `3.25.76` (identical to known-good). **No zod v4 anywhere.**

---

## Safe deployment procedure

### A. On your local machine
```bash
# 1. Start from your CURRENT repo (do NOT blindly overwrite it).
cd neokids-emr

# 2. Make sure node_modules is NOT tracked (one-time cleanup from last deploy).
git rm -r --cached node_modules 2>/dev/null || true
git rm --cached .env 2>/dev/null || true

# 3. Copy the fixed files in (this pack's contents merge into the repo root).
#    Verify .gitignore and storage/ are present before committing.
ls -la .gitignore storage/.gitkeep

# 4. Confirm git will not stage node_modules.
git status --short | grep node_modules && echo "WARNING: node_modules tracked" || echo "OK: node_modules ignored"

# 5. Commit ONLY source changes.
git add -A
git commit -m "v3.4.12: fix certificate update 500 + appointment View redirect"
git push origin main
```

### B. On the VPS
```bash
su - deploy
cd ~/neokids-emr

# Backup (cheap insurance)
cp -r src src.bak.$(date +%Y%m%d) && cp -r public public.bak.$(date +%Y%m%d)

git pull origin main

# dayjs changed → reinstall deps deterministically (dev deps not needed in prod)
npm ci --omit=dev

pm2 restart all
pm2 logs neokids-emr --lines 50
```

### C. Verify
- Click **Update Certificate** → should return 200 (no 500).
- Click appointment **View** on mobile → opens consultation, not Dashboard.
- Open **Previous Records / Consultation History / Patient History** → unchanged.

## Rollback
```bash
cd ~/neokids-emr
git revert HEAD && git push origin main
pm2 restart all
```
