/**
 * Google Meet / Calendar Integration — Hardened
 * =============================================================
 *
 * BUG 2 — "invalid_grant: Token has been expired or revoked"
 * -------------------------------------------------------------
 * Root cause is CONFIGURATION, not code:
 *
 *   The OAuth refresh token in .env (GOOGLE_REFRESH_TOKEN) was issued
 *   for a Google account whose Cloud project is still in "Testing"
 *   publishing status. Google force-expires refresh tokens for testing
 *   apps after 7 days, OR when:
 *     - the OAuth client secret is rotated
 *     - the user revokes access in https://myaccount.google.com/permissions
 *     - the user changes their Google password
 *     - the redirect URI on the OAuth client is changed
 *     - the requested scopes change
 *
 *   Once that happens, EVERY refresh attempt returns
 *     { error: 'invalid_grant',
 *       error_description: 'Token has been expired or revoked.' }
 *   and `event.data.hangoutLink` is undefined → "FULL MEET LINK = null".
 *
 * FIX REQUIRED
 *   1. Move the OAuth app to "In production" publishing status, OR add
 *      the admin Google account to the test-users list and refresh the
 *      token weekly.
 *   2. Re-issue a refresh token (see scripts/get-refresh-token.js shipped
 *      with this fix). Paste the new value into GOOGLE_REFRESH_TOKEN.
 *   3. Make sure GOOGLE_REDIRECT_URI EXACTLY matches a redirect URI
 *      registered on the OAuth client (https://api.neokidspro.in/auth/google/callback).
 *      A trailing slash mismatch alone will break refresh.
 *   4. Scope must include ALL of:
 *        https://www.googleapis.com/auth/calendar.events
 *        https://www.googleapis.com/auth/calendar
 *        https://www.googleapis.com/auth/meetings.space.settings   <-- NEW, see BUG 3
 *      otherwise events.insert with conferenceData fails (first two) or the
 *      "ask to join" fix below silently no-ops (third).
 *
 * BUG 3 — "Ask to join" / "Wait until a host lets you in" for EVERY join
 * -------------------------------------------------------------
 * Root cause: the calendar event that creates the Meet space is owned by a
 * single API/service Google account, and (in the original version of this
 * file) `attendees` was left empty. A Meet space's default access type
 * (`RESTRICTED`) lets in the organizer AND any explicit calendar invitee
 * without knocking — everyone else knocks. With no invitees and no real
 * person ever signed into the organizer account inside an actual Meet
 * call, BOTH the doctor and the patient were just anonymous guests, so
 * both knocked, and nobody was present to let either of them in.
 *
 * PRIMARY FIX (works on any Google account, free or paid):
 *   Add the doctor and patient as calendar `attendees` (with
 *   `sendUpdates: 'none'` so no invite email is sent). Once they're
 *   invited guests, Google's default RESTRICTED rule lets them straight
 *   in without knocking. This is the fix that actually matters here.
 *
 * BONUS FIX (Workspace-only, best-effort, safe to ignore if it fails):
 *   Immediately after creating the event, PATCH the space's
 *   `config.accessType` to `OPEN` via the separate Google Meet REST API
 *   (meet.googleapis.com/v2) — "anyone with the link, no invite needed."
 *   This requires the `meetings.space.settings` OAuth scope AND, per
 *   Google's own docs, a paid Google Workspace account — it is NOT
 *   available on a plain personal @gmail.com account. If it fails (which
 *   is expected/fine on a personal account), we just log a warning and
 *   fall back to the attendee-based fix above, which already solves the
 *   reported problem without costing anything.
 *
 * CODE CHANGES IN THIS FILE
 * -------------------------------------------------------------
 *  - Detect invalid_grant explicitly and log a CLEAR remediation
 *    message so this never wastes another debugging cycle.
 *  - Cache the calendar client and acquire an access token once per
 *    process lifetime (reduces refresh-call load).
 *  - When Meet creation fails for ANY reason, return a structured
 *    error object instead of throwing. Callers (automation.service)
 *    already handle a null meetLink gracefully.
 *  - Add doctor + patient as calendar attendees (sendUpdates:none) so
 *    Google recognizes them as invitees and lets them skip the knock.
 *  - NEW: after creating the event, also best-effort PATCH the Meet
 *    space to accessType=OPEN (Workspace accounts only).
 */
const logger = require('../utils/logger');

function hasGoogleCreds() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID
    && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REFRESH_TOKEN
  );
}

// ── BUG 3 fix: open up the Meet space so nobody has to "ask to join" ──
// Uses the standalone Google Meet REST API (v2), NOT the Calendar API.
// Requires the `meetings.space.settings` OAuth scope on top of the
// existing Calendar scopes. If that scope is missing, Google returns a
// 403 PERMISSION_DENIED — we catch that specifically and log a clear
// remediation message instead of failing the whole booking flow.
async function setSpaceOpenAccess(oauth2, meetingCode) {
  if (!meetingCode) return { ok: false, reason: 'NO_MEETING_CODE' };
  try {
    const { token } = await oauth2.getAccessToken();
    if (!token) return { ok: false, reason: 'NO_ACCESS_TOKEN' };

    const res = await fetch(
      `https://meet.googleapis.com/v2/spaces/${encodeURIComponent(meetingCode)}?updateMask=config.accessType`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ config: { accessType: 'OPEN' } })
      }
    );

    if (res.ok) return { ok: true };

    const data = await res.json().catch(() => ({}));
    if (res.status === 403) {
      logger.error(
        '[GoogleMeet] Could not set accessType=OPEN (403 PERMISSION_DENIED). ' +
        'The refresh token is missing the "meetings.space.settings" scope. ' +
        'Re-issue GOOGLE_REFRESH_TOKEN with that scope added — see ' +
        'scripts/get-refresh-token.js. Meeting links will keep showing ' +
        '"Ask to join" until this is fixed.'
      );
      return { ok: false, reason: 'MISSING_SCOPE' };
    }
    logger.warn(`[GoogleMeet] spaces.patch(accessType=OPEN) failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
    return { ok: false, reason: 'PATCH_FAILED' };
  } catch (e) {
    logger.warn(`[GoogleMeet] spaces.patch(accessType=OPEN) threw: ${e.message || e}`);
    return { ok: false, reason: 'PATCH_THREW' };
  }
}

let _calendarClient = null;
let _oauth2Client   = null;
function getOAuth2Client() {
  if (_oauth2Client) return _oauth2Client;
  const { google } = require('googleapis');
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  // Surface refresh failures in a recognizable way
  oauth2.on('tokens', (tokens) => {
    if (tokens.access_token) {
      logger.info('[GoogleMeet] OAuth access token refreshed');
    }
  });

  _oauth2Client = oauth2;
  return _oauth2Client;
}

function getCalendarClient() {
  if (_calendarClient) return _calendarClient;
  const { google } = require('googleapis');
  _calendarClient = google.calendar({ version: 'v3', auth: getOAuth2Client() });
  return _calendarClient;
}

function isInvalidGrant(err) {
  const msg = (err && (err.message || '')) + ' ' +
              JSON.stringify((err && err.response && err.response.data) || {});
  return /invalid_grant/i.test(msg) || /Token has been expired or revoked/i.test(msg);
}

async function createMeetLink({ summary, description, startISO, endISO, doctorEmail, patientEmail }) {
  if (!hasGoogleCreds()) {
    const code = Math.random().toString(36).slice(2, 6) + '-'
               + Math.random().toString(36).slice(2, 6) + '-'
               + Math.random().toString(36).slice(2, 6);
    return { meetLink: `https://meet.google.com/${code}`, eventId: `mock_${Date.now()}`, accessType: 'OPEN', mock: true };
  }

  try {
    const calendar = getCalendarClient();

    // BUG 3 fix (free-tier, no Workspace needed): add the doctor and
    // patient as calendar guests so Meet recognizes them as "invitees" —
    // Google's default access rule lets invitees skip the knock, and
    // only strangers get asked to wait. `sendUpdates: 'none'` below
    // suppresses the invite EMAIL, so this stays low-friction; the only
    // trade-off is the event may show up on the guest's own Google
    // Calendar (governed by their own account's auto-add setting, not
    // something we control). That's a reasonable trade for online
    // consultations actually being joinable.
    const attendees = [doctorEmail, patientEmail]
      .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
      .map(email => ({ email }));

    const event = await calendar.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      sendUpdates: 'none',
      sendNotifications: false,
      requestBody: {
        summary,
        description,
        start: { dateTime: startISO, timeZone: 'Asia/Kolkata' },
        end:   { dateTime: endISO,   timeZone: 'Asia/Kolkata' },
        guestsCanInviteOthers: false,
        guestsCanSeeOtherGuests: false,
        ...(attendees.length ? { attendees } : {}),
        conferenceData: {
          createRequest: {
            requestId: `neokids-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' }
          }
        }
      }
    });

    const meetLink = event.data.hangoutLink || null;
    const eventId  = event.data.id || null;

    // Bonus, best-effort: if this Google account happens to be a paid
    // Workspace account, also flip the space fully OPEN (anyone with the
    // link, no invite needed at all). On a personal @gmail.com account
    // this call is expected to fail — that's fine, the attendee-based
    // fix above already solves the "ask to join" problem for the doctor
    // and patient regardless of account type.
    let accessType = attendees.length ? 'RESTRICTED (invited guests skip the knock)' : 'RESTRICTED';
    if (meetLink) {
      const meetingCode = (meetLink.match(/meet\.google\.com\/(.+)$/) || [])[1];
      const patch = await setSpaceOpenAccess(getOAuth2Client(), meetingCode);
      if (patch.ok) accessType = 'OPEN';
    }

    return { meetLink, eventId, accessType };
  } catch (err) {
    if (isInvalidGrant(err)) {
      logger.error(
        '[GoogleMeet] OAuth refresh token is expired or revoked. ' +
        'Generate a new GOOGLE_REFRESH_TOKEN — see scripts/get-refresh-token.js. ' +
        'Underlying error: ' + (err.message || err)
      );
      // Drop the cached clients so the next attempt picks up a new env value
      // (after the operator updates .env and restarts).
      _calendarClient = null;
      _oauth2Client = null;
      return { meetLink: null, eventId: null, error: 'INVALID_GRANT' };
    }
    logger.error('[GoogleMeet] events.insert failed:', err.message || err);
    return { meetLink: null, eventId: null, error: 'INSERT_FAILED' };
  }
}

async function deleteMeetEvent(eventId) {
  if (!eventId) return;
  if (String(eventId).startsWith('mock_')) return;
  if (!hasGoogleCreds()) return;
  try {
    const calendar = getCalendarClient();
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'none'
    });
  } catch (e) {
    if (isInvalidGrant(e)) {
      logger.warn(`[GoogleMeet] Cannot delete event ${eventId}: refresh token invalid.`);
      _calendarClient = null;
      _oauth2Client = null;
      return;
    }
    logger.warn(`Failed to delete previous Google Meet event ${eventId}: ${e.message}`);
  }
}

module.exports = { createMeetLink, deleteMeetEvent };
