/**
 * scripts/get-refresh-token.js
 * =============================================================
 * One-time CLI helper to (re)issue a GOOGLE_REFRESH_TOKEN with the exact
 * scopes NeoKidsPro needs:
 *
 *   - https://www.googleapis.com/auth/calendar.events
 *   - https://www.googleapis.com/auth/calendar
 *   - https://www.googleapis.com/auth/meetings.space.settings   (NEW —
 *     required for the "ask to join" fix in googleMeet.service.js, which
 *     PATCHes the Meet space's accessType to OPEN)
 *
 * WHY YOU NEED TO RE-RUN THIS
 * -------------------------------------------------------------
 * Google invalidates a refresh token whenever the requested scopes
 * change. Since this fix adds a brand-new scope, the OLD refresh token
 * in .env will keep working for calendar events but will silently fail
 * (403 PERMISSION_DENIED) when trying to open up the Meet space. You
 * must generate a new token that includes all three scopes above.
 *
 * USAGE
 * -------------------------------------------------------------
 *   1. Make sure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
 *      GOOGLE_REDIRECT_URI are set in your shell / .env (this script
 *      reads them with dotenv if a .env file is present).
 *   2. In Google Cloud Console → APIs & Services → Library, make sure
 *      "Google Meet API" is ENABLED for this project (in addition to
 *      "Google Calendar API"). The meetings.space.settings scope will
 *      fail to authorize if the Meet API isn't enabled.
 *   3. Run:  node scripts/get-refresh-token.js
 *   4. Open the printed URL, sign in with the clinic's Google account,
 *      approve all three permissions.
 *   5. Paste the "code" query-param value from the redirect URL back
 *      into this script's prompt.
 *   6. Copy the printed refresh_token into GOOGLE_REFRESH_TOKEN in .env
 *      and restart the server.
 */
require('dotenv').config();
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/meetings.space.settings'
];

async function main() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI || 'https://api.neokidspro.in/auth/google/callback';

  if (!clientId || !clientSecret) {
    console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the environment.');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',   // required to get a refresh_token back
    prompt: 'consent',        // forces a refresh_token even if previously authorized
    scope: SCOPES
  });

  console.log('\n1) Open this URL, sign in with the CLINIC Google account, and approve all requested permissions:\n');
  console.log(authUrl);
  console.log('\n2) After approving, Google will redirect you to your redirect URI with a ?code=... query param.');
  console.log('   Copy just the code value (it will look like a long random string) and paste it below.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Paste the code here: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await oauth2Client.getToken(code.trim());
      if (!tokens.refresh_token) {
        console.error(
          '\nNo refresh_token was returned. This usually means this Google account already has an active grant.' +
          '\nGo to https://myaccount.google.com/permissions, remove access for this app, then re-run this script.'
        );
        process.exit(1);
      }
      console.log('\n✅ Success. Put this in your .env as GOOGLE_REFRESH_TOKEN:\n');
      console.log(tokens.refresh_token);
      console.log('\nGranted scopes:', tokens.scope);
    } catch (err) {
      console.error('\nToken exchange failed:', err.message || err);
      process.exit(1);
    }
  });
}

main();
