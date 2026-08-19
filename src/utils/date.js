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

module.exports = {
  DEFAULT_TIME_ZONE,
  parseDateOnly,
  parseDateOnlyOrNull,
  getDatePartsInTimeZone,
  getTodayDateString,
  getTodayDateOnly,
  getCurrentTimeMinutes,
  formatDateOnly,
  calcAge
};
