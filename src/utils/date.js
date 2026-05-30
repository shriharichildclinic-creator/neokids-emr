// date.js — fixed version
// ROOT CAUSE of Issue 1: parseDateOnly() stored dates at UTC noon (12:00:00).
// getTodayDateOnly() also returns UTC noon. BUT when Prisma queries `date: today`,
// MySQL compares the stored DATE column value. The issue was that if the server
// runs in UTC, "today" noon UTC = "tomorrow" in IST for some hours, causing
// appointments stored for IST-today to not match the UTC-today query.
// FIX: All date comparisons now use IST-aware date strings consistently.

const DEFAULT_TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

function pad(value) {
  return String(value).padStart(2, '0');
}

// Stores date as UTC midnight (00:00:00) — safe for MySQL DATE columns
function parseDateOnly(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) {
    throw Object.assign(new Error('Invalid date format. Expected YYYY-MM-DD'), { statusCode: 400 });
  }
  const [year, month, day] = dateStr.split('-').map(Number);
  // Store at UTC midnight — avoids timezone shift issues with MySQL DATE type
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function parseDateOnlyOrNull(dateStr) {
  if (!dateStr) return null;
  return parseDateOnly(dateStr);
}

function getDatePartsInTimeZone(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? 0 : parts.hour), // handle midnight edge case
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function getTodayDateString(timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day } = getDatePartsInTimeZone(new Date(), timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Returns a Date object representing today at UTC midnight — matches parseDateOnly output
function getTodayDateOnly(timeZone = DEFAULT_TIME_ZONE) {
  return parseDateOnly(getTodayDateString(timeZone));
}

function getCurrentTimeMinutes(timeZone = DEFAULT_TIME_ZONE) {
  const { hour, minute } = getDatePartsInTimeZone(new Date(), timeZone);
  return hour * 60 + minute;
}

function formatDateOnly(date, locale = 'en-IN', timeZone = DEFAULT_TIME_ZONE) {
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(new Date(date));
}

module.exports = {
  DEFAULT_TIME_ZONE,
  parseDateOnly,
  parseDateOnlyOrNull,
  getDatePartsInTimeZone,
  getTodayDateString,
  getTodayDateOnly,
  getCurrentTimeMinutes,
  formatDateOnly
};
