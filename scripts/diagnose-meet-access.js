/**
 * scripts/diagnose-meet-access.js
 * =============================================================
 * Run this on the SAME server/environment that has your real
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN in .env.
 *
 *    node scripts/diagnose-meet-access.js
 *
 * It will:
 *   1. Print which Google account the refresh token belongs to.
 *   2. Create a real test Calendar event with a Meet link (and delete it
 *      again at the end).
 *   3. Try to PATCH that space's accessType to OPEN.
 *   4. GET the space back and print its actual accessType.
 *   5. Print the exact Google error, if any, at every step.
 *
 * Paste the FULL output back — the exact error text at step 3/4 tells us
 * definitively why "Ask to join" is still happening. The single most
 * common cause: the Google Meet API (accessType, OPEN) is only available
 * to Google Workspace accounts — it does NOT work on a plain personal
 * @gmail.com account, even with the right scope and even with the Meet
 * API "enabled" in Cloud Console. If step 1 shows a @gmail.com address
 * (not a custom company domain), that is almost certainly the whole
 * problem, and the only real fixes are:
 *   (a) move GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN to a paid Google
 *       Workspace account for the clinic, or
 *   (b) stop relying on the Meet API accessType fix and switch to a
 *       different video provider (Daily.co, Whereby, Zoom, Jitsi, etc.)
 *       that supports host-free "anyone with the link" rooms via API.
 */
require('dotenv').config();
const { google } = require('googleapis');

async function main() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN in .env');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  console.log('── Step 1: Who does this refresh token belong to? ──────────');
  try {
    const { token } = await oauth2Client.getAccessToken();
    const infoRes = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
    const info = await infoRes.json();
    console.log(JSON.stringify(info, null, 2));
    if (info.email) {
      const isWorkspaceLikely = !/@gmail\.com$/i.test(info.email);
      console.log(`\nAccount: ${info.email}`);
      console.log(isWorkspaceLikely
        ? '  -> Custom domain — likely (but not guaranteed) a Workspace account. Continuing...'
        : '  -> This is a plain @gmail.com address. The Meet API accessType feature ' +
          'used below is documented as Workspace-only, so this is very likely why ' +
          '"Ask to join" persists no matter what the code does.');
    }
    console.log('Granted scopes:', info.scope);
    if (!/meetings\.space\.settings/.test(info.scope || '')) {
      console.log('\n⚠️  meetings.space.settings scope is NOT present on this token.');
      console.log('   Run scripts/get-refresh-token.js again and put the NEW token in .env.');
    }
  } catch (e) {
    console.error('Failed to introspect token:', e.message || e);
    process.exit(1);
  }

  console.log('\n── Step 2: Create a real test Meet event ───────────────────');
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end   = new Date(start.getTime() + 30 * 60 * 1000);
  let eventId, meetingCode;
  try {
    const event = await calendar.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      sendUpdates: 'none',
      requestBody: {
        summary: 'NeoKidsPro diagnostic test event (safe to ignore/delete)',
        start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
        end:   { dateTime: end.toISOString(),   timeZone: 'Asia/Kolkata' },
        conferenceData: {
          createRequest: {
            requestId: `diag-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' }
          }
        }
      }
    });
    eventId = event.data.id;
    const meetLink = event.data.hangoutLink;
    meetingCode = (meetLink || '').split('meet.google.com/')[1];
    console.log('Created event:', eventId);
    console.log('Meet link:', meetLink);
  } catch (e) {
    console.error('Event creation FAILED:', e.message || e);
    if (e.response && e.response.data) console.error(JSON.stringify(e.response.data, null, 2));
    process.exit(1);
  }

  console.log('\n── Step 3: PATCH accessType=OPEN via Meet API v2 ───────────');
  try {
    const { token } = await oauth2Client.getAccessToken();
    const res = await fetch(
      `https://meet.googleapis.com/v2/spaces/${encodeURIComponent(meetingCode)}?updateMask=config.accessType`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { accessType: 'OPEN' } })
      }
    );
    const data = await res.json().catch(() => ({}));
    console.log('HTTP status:', res.status);
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('PATCH threw:', e.message || e);
  }

  console.log('\n── Step 4: GET the space back to see the REAL current state ─');
  try {
    const { token } = await oauth2Client.getAccessToken();
    const res = await fetch(`https://meet.googleapis.com/v2/spaces/${encodeURIComponent(meetingCode)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json().catch(() => ({}));
    console.log('HTTP status:', res.status);
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('GET threw:', e.message || e);
  }

  console.log('\n── Cleanup: deleting the test event ─────────────────────────');
  try {
    await calendar.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'none' });
    console.log('Deleted.');
  } catch (e) {
    console.warn('Could not delete test event (harmless, delete it manually):', e.message || e);
  }

  console.log('\nDone. Paste this ENTIRE output back for diagnosis.');
}

main();
