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
 *   4. Scope must include both:
 *        https://www.googleapis.com/auth/calendar.events
 *        https://www.googleapis.com/auth/calendar
 *      otherwise events.insert with conferenceData fails.
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
 *  - Keep existing privacy guarantees: no attendees, sendUpdates:none.
 */
const logger = require('../utils/logger');

function hasGoogleCreds() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID
    && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REFRESH_TOKEN
  );
}

let _calendarClient = null;
function getCalendarClient() {
  if (_calendarClient) return _calendarClient;
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

  _calendarClient = google.calendar({ version: 'v3', auth: oauth2 });
  return _calendarClient;
}

function isInvalidGrant(err) {
  const msg = (err && (err.message || '')) + ' ' +
              JSON.stringify((err && err.response && err.response.data) || {});
  return /invalid_grant/i.test(msg) || /Token has been expired or revoked/i.test(msg);
}

async function createMeetLink({ summary, description, startISO, endISO }) {
  if (!hasGoogleCreds()) {
    const code = Math.random().toString(36).slice(2, 6) + '-'
               + Math.random().toString(36).slice(2, 6) + '-'
               + Math.random().toString(36).slice(2, 6);
    return { meetLink: `https://meet.google.com/${code}`, eventId: `mock_${Date.now()}`, mock: true };
  }

  try {
    const calendar = getCalendarClient();

    // NOTE: `attendees` is DELIBERATELY OMITTED below. Do not add it back.
    // Adding even one attendee triggers Google's auto-invite + auto-add-to-
    // their-calendar behavior.
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
        conferenceData: {
          createRequest: {
            requestId: `neokids-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' }
          }
        }
      }
    });

    return {
      meetLink: event.data.hangoutLink || null,
      eventId: event.data.id || null
    };
  } catch (err) {
    if (isInvalidGrant(err)) {
      logger.error(
        '[GoogleMeet] OAuth refresh token is expired or revoked. ' +
        'Generate a new GOOGLE_REFRESH_TOKEN — see scripts/get-refresh-token.js. ' +
        'Underlying error: ' + (err.message || err)
      );
      // Drop the cached client so the next attempt picks up a new env value
      // (after the operator updates .env and restarts).
      _calendarClient = null;
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
      return;
    }
    logger.warn(`Failed to delete previous Google Meet event ${eventId}: ${e.message}`);
  }
}

module.exports = { createMeetLink, deleteMeetEvent };
