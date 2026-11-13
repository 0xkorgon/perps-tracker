'use strict';

// US market clock helpers (no dependencies, DST-aware):
//  - Arcus/Entropy stock & ETF perps count as "US hours" on NYSE trading days between
//    04:00 and 20:00 New York time (Arcus's own regularTradingHours); weekends, NYSE holidays
//    and nights are "off hours".
//  - Arcus points weeks run Wednesday 3 PM ET to Wednesday 3 PM ET.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// NYSE full-day closures (New York dates).
const NYSE_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

let session = { start: 4 * 3600, end: 20 * 3600 }; // seconds of day, New York time

function setSession(startSecondsOfDay, endSecondsOfDay) {
  if (Number.isFinite(startSecondsOfDay) && Number.isFinite(endSecondsOfDay) && endSecondsOfDay > startSecondsOfDay) {
    session = { start: startSecondsOfDay, end: endSecondsOfDay };
  }
}

// n-th weekday of a month, as a UTC day number (weekday: 0 = Sunday).
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return Date.UTC(year, month, day);
}

const dstCache = new Map();
// US daylight saving: 2nd Sunday of March 2:00 local (07:00 UTC) to 1st Sunday of November 2:00 local (06:00 UTC).
function dstRange(year) {
  if (!dstCache.has(year)) {
    dstCache.set(year, [nthWeekday(year, 2, 0, 2) + 7 * HOUR, nthWeekday(year, 10, 0, 1) + 6 * HOUR]);
  }
  return dstCache.get(year);
}

// Offset of New York time from UTC at instant ts (ms), e.g. -4h in summer.
function nyOffset(ts) {
  const [a, b] = dstRange(new Date(ts).getUTCFullYear());
  return ts >= a && ts < b ? -4 * HOUR : -5 * HOUR;
}

// Broken-down New York wall-clock time for an instant.
function nyParts(ts) {
  const d = new Date(ts + nyOffset(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    date: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    weekday: d.getUTCDay(),
    seconds: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(),
  };
}

// Is this instant inside the US stock session (trading day, 04:00-20:00 New York)?
function isUsHours(ts) {
  const p = nyParts(ts);
  if (p.weekday === 0 || p.weekday === 6) return false;
  if (NYSE_HOLIDAYS.has(p.date)) return false;
  return p.seconds >= session.start && p.seconds < session.end;
}

// Convert a New York wall-clock time to a UTC timestamp.
function nyToUtc(y, mIndex, d, h = 0, min = 0) {
  const guess = Date.UTC(y, mIndex, d, h, min) + 5 * HOUR;
  return Date.UTC(y, mIndex, d, h, min) - nyOffset(guess);
}

// Start of the Arcus points week containing ts (Wednesday 15:00 New York).
function pointsWeekStart(ts) {
  const local = new Date(ts + nyOffset(ts));
  const daysBack = (local.getUTCDay() - 3 + 7) % 7;
  let start = nyToUtc(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysBack, 15, 0);
  if (start > ts) {
    start = nyToUtc(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysBack - 7, 15, 0);
  }
  return start;
}

function marketStatus(ts) {
  const open = isUsHours(ts);
  const p = nyParts(ts);
  return { open, nyTime: `${String(Math.floor(p.seconds / 3600)).padStart(2, '0')}:${String(Math.floor((p.seconds % 3600) / 60)).padStart(2, '0')}`, weekday: p.weekday };
}

const utcDayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

module.exports = { isUsHours, nyParts, nyOffset, nyToUtc, pointsWeekStart, marketStatus, setSession, utcDayKey, NYSE_HOLIDAYS, DAY, HOUR };
