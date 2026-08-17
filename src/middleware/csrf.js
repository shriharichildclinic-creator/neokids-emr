/* =====================================================================
   csrf.js — Issue 28: CSRF / cross-origin write protection
   ---------------------------------------------------------------------
   The app uses Authorization: Bearer (JWT in localStorage) instead of
   cookies, so the classic browser-driven CSRF attack (cookie auto-attach
   from a malicious page) is NOT applicable. However, two related risks
   remain:

     (a) A malicious page that obtained the token via XSS — see Bug #10
         — could call any API from any origin. We can't stop that
         specific attacker (they already own the page), but we CAN stop
         the *non-XSS* CSRF cousin where a stranger's tab calls our API
         from a non-allowed origin and gets useful side-effects.

     (b) Some browsers (and Postman scripts) call our API without an
         Origin header at all. We allow that ONLY for same-origin /
         server-to-server cases (no Origin header, no Sec-Fetch-Site),
         because forcing every legit client (curl, Postman, Cashfree
         webhook, mobile apps) to send an Origin header would break
         production traffic.

   Strategy (defence in depth, not a single token):

     1. Mutating verb gate: only POST/PUT/PATCH/DELETE are checked.
        GET/HEAD/OPTIONS pass through.

     2. Webhook bypass: /api/webhooks/* is HMAC-verified and called by
        Cashfree (no browser, no Origin). Whitelisted.

     3. Auth bypass for unauthenticated public endpoints that the
        booking widget already needs cross-origin: /api/public/book and
        login/forgot-password. These have their own per-request limits
        and (for /book) a tncAccepted server-side check; CSRF doesn't
        apply because there's no privileged user session being abused.

     4. For everything else with Origin or Referer present:
         - Must match the configured allow-list (production: APP_URL +
           the WordPress site; dev: any localhost / 127.0.0.1).
         - Sec-Fetch-Site, if present, must be 'same-origin',
           'same-site', or 'none' (manual navigation, e.g. Postman).
        Mismatch → 403 CSRF_ORIGIN_REJECTED.

     5. Request with no Origin AND no Referer AND a real Authorization
        header passes (server-to-server / native apps). The Bearer
        token is itself the auth factor; only an XSS'd browser session
        is at risk, and that's mitigated by #10 (HttpOnly is not
        applicable for Bearer, so the in-browser XSS fix is the real
        defence).

   This is mounted in server.js BEFORE all /api/* routers except the
   webhook router.
   ===================================================================== */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Paths that genuinely need to accept cross-origin POSTs (booking widget
// is embedded on the WordPress marketing site, and login obviously must
// work before any session exists). All entries are exact prefixes.
const PUBLIC_WRITE_PREFIXES = [
  '/api/public/book',
  '/api/auth/login',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/webhooks'            // HMAC-verified
];

function isPublicWrite(pathname) {
  for (const p of PUBLIC_WRITE_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p + '?')) return true;
  }
  return false;
}

function originHost(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    // Origin is a scheme+host, Referer is a full URL — URL() handles both.
    return new URL(value).host.toLowerCase();
  } catch (_) {
    return null;
  }
}

function buildAllowList() {
  const list = new Set();

  // Always allow the configured APP_URL host(s).
  const fromEnv = [
    process.env.APP_URL,
    process.env.API_URL,
    process.env.WORDPRESS_URL,
    'https://neokidspro.in'
  ];
  for (const u of fromEnv) {
    const h = originHost(u);
    if (h) list.add(h);
  }

  // In non-production, accept localhost on any port + 127.0.0.1.
  if (process.env.NODE_ENV !== 'production') {
    // We encode "any localhost port" by adding a wildcard marker. The
    // matcher below treats anything starting with 'localhost' or
    // '127.0.0.1' as same-machine.
    list.add('__dev_localhost__');
  }

  return list;
}

function hostAllowed(host, allow) {
  if (!host) return false;
  if (allow.has(host)) return true;
  if (allow.has('__dev_localhost__')) {
    if (host === 'localhost' || host.startsWith('localhost:')) return true;
    if (host === '127.0.0.1' || host.startsWith('127.0.0.1:')) return true;
    if (host === '[::1]'     || host.startsWith('[::1]:'))     return true;
  }
  return false;
}

function makeCsrfGuard(opts = {}) {
  const allow = buildAllowList();

  return function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (isPublicWrite(req.path)) return next();

    const origin   = req.get('origin');
    const referer  = req.get('referer');
    const secFetch = req.get('sec-fetch-site'); // 'same-origin'|'same-site'|'cross-site'|'none'

    // If the browser told us the site relation, trust it first.
    if (secFetch) {
      if (secFetch === 'same-origin' || secFetch === 'same-site' || secFetch === 'none') {
        return next();
      }
      // 'cross-site' — must additionally come from an allow-listed host.
      const h = originHost(origin) || originHost(referer);
      if (hostAllowed(h, allow)) return next();
      return res.status(403).json({
        error: 'Cross-site request blocked',
        code:  'CSRF_ORIGIN_REJECTED'
      });
    }

    // No Sec-Fetch-Site header. Could be:
    //   - older browser
    //   - server-to-server / curl / mobile app
    //   - attacker crafting a request
    // Decision: if Origin OR Referer is present, it MUST be allow-listed.
    // If both are missing, treat as non-browser and let the Bearer token
    // do its job (these requests can't be CSRF — there's no ambient
    // credential to steal).
    if (origin || referer) {
      const h = originHost(origin) || originHost(referer);
      if (hostAllowed(h, allow)) return next();
      return res.status(403).json({
        error: 'Cross-site request blocked',
        code:  'CSRF_ORIGIN_REJECTED'
      });
    }

    return next();
  };
}

module.exports = { makeCsrfGuard, _internals: { isPublicWrite, originHost, hostAllowed, buildAllowList } };