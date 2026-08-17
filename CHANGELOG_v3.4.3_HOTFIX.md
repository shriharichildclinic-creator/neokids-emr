# v3.4.3 HOTFIX — boot crash after Historical Records / Previous Records feature

The v3.4.3 build shipped three bugs that crashed the Node process on boot,
which produced the 502 Bad Gateway on api.neokidspro.in/doctor/ and the
`Script had too many unstable restarts (16). Stopped. "errored"` in pm2.

Fixed additively (existing architecture untouched):

1. `src/controllers/previous.controller.js`
   - Was: `const asyncH = require('../utils/asyncHandler');`  ← module does not exist
   - Now: `const { asyncHandler: asyncH } = require('../middleware/errorHandler');`
     (matches the rest of the codebase — same module `files.routes.js` uses)

2. `src/routes/files.routes.js`
   - Two new v3.4.3 share routes (`/share/:token`, `/share-record/:token`)
     called an undefined `asyncH`. This file imports `asyncHandler`, not `asyncH`.
   - Renamed the two call-sites to `asyncHandler(...)`. Nothing else touched.

3. `src/controllers/previous.controller.js`
   - `doctor.routes.js` registers `GET /previous-records/permission → prev.permission`,
     but `permission` was never exported → `Route.get() requires a callback function
     but got a [object Undefined]` at doctor.routes.js:56, crashing every restart.
   - Added `exports.permission` returning `{ allowed: true }` (matches the pre-feature
     production behaviour where the tab was visible). Change is additive.

No feature code, schema, migrations or v3.4.3 functionality removed.
