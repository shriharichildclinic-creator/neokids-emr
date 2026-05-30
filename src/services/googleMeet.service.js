/**
 * Google Meet / Calendar Integration
 * Creates a Calendar event with a Meet conference attached.
 */
const dayjs = require('dayjs');

async function createMeetLink({ summary, description, startISO, endISO, attendees }) {
  const hasCreds = process.env.GOOGLE_CLIENT_ID
    && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REFRESH_TOKEN;

  if (!hasCreds) {
    // Fallback: deterministic placeholder link for local dev
    const code = Math.random().toString(36).slice(2, 6) + '-'
               + Math.random().toString(36).slice(2, 6) + '-'
               + Math.random().toString(36).slice(2, 6);
    return { meetLink: `https://meet.google.com/${code}`, eventId: `mock_${Date.now()}` };
  }

  const { google } = require('googleapis');
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  const event = await calendar.events.insert({
    calendarId: 'primary',
    conferenceDataVersion: 1,
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: 'Asia/Kolkata' },
      end: { dateTime: endISO, timeZone: 'Asia/Kolkata' },
      attendees: (attendees || []).map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: `neokids-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    }
  });

  return {
    meetLink: event.data.hangoutLink,
    eventId: event.data.id
  };
}

module.exports = { createMeetLink };
