/* =====================================================================
   utils/asyncHandler.js — BACK-COMPAT SHIM (v3.4.4)
   ---------------------------------------------------------------------
   WHY THIS FILE EXISTS
   --------------------
   Multiple files in this repo (notably the v3.4.3 / v3.4.x ship of
   `src/controllers/previous.controller.js`) historically wrote

       const { asyncHandler } = require('../utils/asyncHandler');

   because some template scaffolding treated `utils/` as the home for
   async helpers. The codebase since standardised on
   middleware/errorHandler.js (which also exports `asyncHandler` and is
   the exact place the rest of the controllers route their error
   pipeline through).

   Rather than risk leaving a stale require on a deployed machine during
   a feature rollout, this file ACTS as a permanent re-export shim:

       require('../utils/asyncHandler')       ← still works
       require('../middleware/errorHandler')  ← canonical path

   Both import the SAME function — no double-wrapping, no behavioural
   drift. Future builds can keep using the canonical path while any
   old require keeps resolving.
   ===================================================================== */
const { asyncHandler } = require('../middleware/errorHandler');

module.exports = asyncHandler;
module.exports.asyncHandler = asyncHandler;
module.exports.default = asyncHandler;
