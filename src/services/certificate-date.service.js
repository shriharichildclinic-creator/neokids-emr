// =====================================================================
// services/certificate-date.service.js — v3.4.4
// ---------------------------------------------------------------------
// Single source of truth for Medical Certificate date math.
//
// Option A is the only supported flow (per product decision):
//
//     Doctor enters   →  Number of Days (inclusive)
//                        Start Date
//     System computes →  End Date   (= start + days - 1)
//
// Either field can be manually overridden by the doctor BEFORE save.
// Reverse-calculations, signature-day auto-fill, single-day mode and
// dual-flow (range+rest) inputs are GONE. Old certificates remain
// readable (DATE_RANGE fallback still renders), but no new race-prone
// code paths exist.
// =====================================================================

const dayjs = require('dayjs');
const { parseDateOnly, parseDateOnlyOrNull } = require('../utils/date');

/**
 * Inclusive end-date from a start date and a count of rest days.
 * Returns null if either input is missing or invalid.
 *
 *   start = 10 Aug,  days = 5  →  end = 14 Aug   (10,11,12,13,14 = 5 days)
 *   start = 01 Jan,  days = 1  →  end = 01 Jan
 */
function computeEndDate(startDateStr, days) {
  if (!startDateStr || !days || Number(days) < 1) return null;
  try {
    const d = dayjs(parseDateOnly(startDateStr)).add(Number(days) - 1, 'day');
    return d.format('YYYY-MM-DD');
  } catch (_) {
    return null;
  }
}

/**
 * Normalize a validated payload into { fromDate, toDate } written
 * DATE-only to the database. Includes any manual override the doctor
 * submitted.
 *
 * Precedence (HIGHEST first):
 *   1. toDateOverride  — manual end date from the form (always wins)
 *   2. computeEndDate(fromDate, restDays)
 *   3. toDate          — manual end date WITHOUT restDays
 *   4. fromDate        — a single "rest of today" row
 */
function normalizeCertificateDates(input) {
  const out = { fromDate: null, toDate: null, restDays: null };

  // Always store restDays if supplied — even if the doctor manually
  // overrode toDate — so "5 days rest" survives a later "just change end
  // date to tomorrow" edit and the original medical intent is preserved.
  if (Number.isFinite(Number(input.restDays)) && Number(input.restDays) > 0) {
    out.restDays = parseInt(input.restDays, 10);
  }

  if (input.fromDate) {
    out.fromDate = parseDateOnlyOrNull(input.fromDate);
  }

  // Manual override wins.
  if (input.toDateOverride) {
    out.toDate = parseDateOnlyOrNull(input.toDateOverride);
    return out;
  }

  // Auto-derive from (fromDate, restDays).
  if (out.fromDate && out.restDays) {
    out.toDate = parseDateOnlyOrNull(computeEndDate(input.fromDate, out.restDays));
    return out;
  }

  // Client supplied a manual end without restDays.
  if (input.toDate) {
    out.toDate = parseDateOnlyOrNull(input.toDate);
  }

  return out;
}

/**
 * Re-derived view of dates that the PDF renderer needs.
 * Falls back safely for legacy rows (DATE_RANGE / NULL).
 */
function viewForPdf(row) {
  const out = {
    fromDate: row.fromDate ? dayjs(row.fromDate).format('YYYY-MM-DD') : null,
    toDate:   row.toDate   ? dayjs(row.toDate).format('YYYY-MM-DD')   : null,
    restDays: row.restDays || null
  };
  // If we have restDays+from but no toDate, derive on the fly for display.
  if (!out.toDate && out.fromDate && out.restDays) {
    out.toDate = computeEndDate(out.fromDate, out.restDays);
  }
  return out;
}

module.exports = {
  computeEndDate,
  normalizeCertificateDates,
  viewForPdf
};
