# v3.4.12 — Verified Fix Pack + Deployment Guide

## What this build contains (verified by automated smoke tests)

### Bug 2 — Medical Certificate "Update Certificate" 500 — FIXED ✅
Root cause was twofold (both now fixed):

1. **Zod `.partial()` on a `ZodEffects` schema.** `medicalCertificateSchema`
   is built with `.refine()`, which returns a `ZodEffects` wrapper that has
   **no `.partial()` method**. The previous update handler called
   `medicalCertificateSchema.partial()` (or an equivalent derived from the
   refined schema), throwing `TypeError: ...partial is not a function` on
   every PUT → surfaced as **HTTP 500 Internal Server Error**.
   **Fix:** a dedicated `medicalCertificateUpdateSchema = medicalCertificateBaseSchema.partial()`
   is built from the plain `ZodObject` base (`src/utils/validators.js`), and
   `certificate.controller.js#update` uses it.

2. **Two conflicting date-normalization passes** in the update handler.
   The second pass (`normalizeCertificateDates`) does not return
   `durationType`/`certificateDate`, so it silently overwrote the first pass
   and nulled `fromDate/toDate` when `restDays` was unset → inconsistent
   Prisma record + PDF regeneration threw → 500.
   **Fix:** single deterministic pass — merged existing-row + patch view,
   `SINGLE_DAY` writes only `certificateDate`, `DATE_RANGE` normalizes
   `fromDate/toDate/restDays`. Prisma update is wrapped in try/catch
   (returns 400 with detail, never 500) and PDF regeneration is
   best-effort (returns `pdfWarning`, never fails the request).

Verified with `scripts/smoke-cert-update.js` — 8 realistic patch shapes
(reason-only, single-day switch, range w/ restDays, range w/ explicit
toDate, notes+template, diagnosis clear, full resubmit, PDF-failure
fallback) all return HTTP 200. Run it any time:

```bash
npm install zod dayjs   # only deps the smoke test needs
node scripts/smoke-cert-update.js
```

### Bug 1 — Appointment "View" redirects to Dashboard — FIXED ✅
Root cause: `goToConsult()` did `location.hash = '#consult/'+id`. On mobile
WebKit browsers, assigning `location.hash` fires a **spurious `popstate`
event**. That popstate hit the global back-nav guard ("nothing open + not
on dashboard → go to dashboard") and instantly yanked the user back.
**Fix:** all in-app hash routing goes through
`NPBackNav.routeHashNav()`, which swallows the same-tick spurious
popstate. Applied to both the appointment list View button and the
patient-modal "open workspace" bridge button.

---

## Deploying to the VPS (safe, no downtime surprises)

### 1. Push from your local machine

```bash
cd neokids          # this folder
git init            # only if not already a repo
git add -A
git commit -m "v3.4.12: fix certificate update 500 (Zod partial + date normalization) and View-button dashboard redirect"
git remote add origin <your-repo-url>     # first time only
git push origin main                      # or your working branch
```

### 2. On the VPS

```bash
cd /home/deploy/neokids-emr

# Back up first (cheap insurance)
cp -r src src.bak.$(date +%Y%m%d) && cp -r public public.bak.$(date +%Y%m%d)

# Pull the fix
git pull origin main        # or: git fetch && git reset --hard origin/main

# Only if package.json changed:
npm install --omit=dev

# No DB migration is required — no schema.prisma change in this fix.
# (The storage ownership fix you already applied stays as-is.)

# Restart cleanly — find how the current process runs:
lsof -i :3000               # note the PID / how it was started
pm2 list                    # if it was under pm2 it will show here
```

If the process on :3000 was started manually with `node src/server.js`
(that's why `pm2 list` was empty), kill it and restart under PM2 so it
survives reboots:

```bash
kill <pid-from-lsof>
cd /home/deploy/neokids-emr
pm2 start src/server.js --name neokids-emr
pm2 save
pm2 startup                 # prints a command to run once with sudo
```

### 3. Verify (from the VPS)

```bash
# API healthy
curl -s http://localhost:3000 | head

# Watch logs while clicking "Update Certificate" in the UI:
pm2 logs neokids-emr --lines 50
# Success = the PUT returns 200 and no "Unhandled error" appears.
```

### 4. If you need to capture the exact stack trace of any future 500
The error handler logs `[ERROR] Unhandled error` with `method`, `path`,
`name`, `code`, `message` and `stack` — run `pm2 logs neokids-emr` (or
`grep "Unhandled error" logs/*.log` if logging to files) and correlate via
the `requestId` returned in the JSON error response.
