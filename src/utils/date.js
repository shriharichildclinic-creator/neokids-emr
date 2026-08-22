const DEFAULT_TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

function pad(value) { return String(value).padStart(2, '0'); }

function parseDateOnly(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) {
    throw Object.assign(new Error('Invalid date format. Expected YYYY-MM-DD'), { statusCode: 400 });
  }
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function parseDateOnlyOrNull(dateStr) {
  if (!dateStr) return null;
  return parseDateOnly(dateStr);
}

function getDatePartsInTimeZone(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? 0 : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function getTodayDateString(timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day } = getDatePartsInTimeZone(new Date(), timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

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
    timeZone, day: '2-digit', month: 'short', year: 'numeric'
  }).format(new Date(date));
}

/**
 * Returns "X yrs Y months" from a DOB.
 * Accepts Date object or ISO string. Returns '' on invalid input.
 */
function calcAge(dob) {
  if (!dob) return '';
  const d = (dob instanceof Date) ? dob : new Date(dob);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  let years = today.getUTCFullYear() - d.getUTCFullYear();
  let months = today.getUTCMonth() - d.getUTCMonth();
  if (today.getUTCDate() < d.getUTCDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return '';
  if (years === 0) return `${months} month${months === 1 ? '' : 's'}`;
  return `${years} yr${years === 1 ? '' : 's'} ${months} month${months === 1 ? '' : 's'}`;
}

/**
 * Buckets one or more row sources into a trailing `days`-day daily series
 * keyed by ISO date (UTC), then splits that series into "this week" (the
 * trailing 7 days) vs "previous week" totals for the given `weekFields`.
 *
 * Shared by the Doctor/Receptionist/Pharmacy dashboard `stats` endpoints,
 * which each build a 14-day trend sparkline plus a week-over-week delta —
 * only the bucket shape, row source(s), and per-row accumulation differ.
 *
 * @param {Date} start - first day of the window (typically `today` minus
 *   `days - 1`)
 * @param {number} [days=14] - total number of days to bucket
 * @param {() => object} emptyBucket - returns a fresh zeroed bucket shape
 *   (the `date` key is added automatically, do not include it here)
 * @param {Array<{ rows: any[], dateOf: (row: any) => (Date|string), accumulate: (bucket: object, row: any) => void }>} sources -
 *   one or more row arrays to fold into the buckets; each row is matched to
 *   its bucket via `dateOf` and merged in via `accumulate`
 * @param {string[]} weekFields - bucket fields to sum into `thisWeek`/`prevWeek`
 * @returns {{ daily: Record<string, object>, thisWeek: object, prevWeek: object, last7Key: string }}
 */
function buildDailyTrend({ start, days = 14, emptyBucket, sources, weekFields }) {
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const daily = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setUTCDate(d.getUTCDate() + i);
    daily[dayKey(d)] = { date: dayKey(d), ...emptyBucket() };
  }
  for (const { rows, dateOf, accumulate } of sources) {
    for (const row of rows) {
      const bucket = daily[dayKey(dateOf(row))];
      if (bucket) accumulate(bucket, row);
    }
  }
  const splitStart = new Date(start); splitStart.setUTCDate(splitStart.getUTCDate() + (days - 7));
  const last7Key = dayKey(splitStart);
  const thisWeek = {}, prevWeek = {};
  weekFields.forEach(f => { thisWeek[f] = 0; prevWeek[f] = 0; });
  for (const bucket of Object.values(daily)) {
    const target = bucket.date >= last7Key ? thisWeek : prevWeek;
    weekFields.forEach(f => { target[f] += bucket[f]; });
  }
  return { daily, thisWeek, prevWeek, last7Key };
}

module.exports = {
  DEFAULT_TIME_ZONE,
  parseDateOnly,
  parseDateOnlyOrNull,
  getDatePartsInTimeZone,
  getTodayDateString,
  getTodayDateOnly,
  getCurrentTimeMinutes,
  formatDateOnly,
  calcAge,
  buildDailyTrend
};
