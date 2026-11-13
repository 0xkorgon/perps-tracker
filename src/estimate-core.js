'use strict';

// Shared helpers for the points estimates: volume projection, Bulk's hourly volume, the estimate
// shape every program returns. Used by estimate.js and by an optional private model.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Hold multiplier: 1 + perHour x hours held (perHour from the AURA model, if it has one).
const holdMult = (hours, perHour) => 1 + Math.max(0, perHour || 0) * Math.max(0, hours);

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Volume by the end of a window, from what's done so far and the daily pace.
// typical: recent average per day (null if unknown). Early in the week the recent average carries
// most weight; after three days it's this week's own pace.
function projectVolume(soFar, start, end, now, typical) {
  const elapsed = Math.max(0, Math.min(now, end) - start);
  const remaining = Math.max(0, end - now);
  const elDays = elapsed / DAY;
  const thisPace = elDays >= 0.25 ? soFar / elDays : null;
  let daily;
  let basis;
  if (thisPace == null) {
    daily = typical || 0;
    basis = 'recent';
  } else if (typical == null) {
    daily = thisPace;
    basis = 'thisWeek';
  } else {
    const w = Math.min(1, elDays / 3);
    daily = w * thisPace + (1 - w) * typical;
    basis = w >= 1 ? 'thisWeek' : 'blend';
  }
  return { soFar, daily, remainingDays: remaining / DAY, elapsedDays: elDays, projected: soFar + daily * (remaining / DAY), basis };
}

// Average volume per day on an exchange over up to 14 days before `before` (null with < 1 day of history).
function typicalDaily(fillsFor, firstTs, exId, before) {
  const from = Math.max(before - 14 * DAY, Number.isFinite(firstTs) ? firstTs : before - 14 * DAY);
  const days = (before - from) / DAY;
  if (days < 1) return null;
  return fillsFor(exId, from, before).volume / days;
}

function pack({ program, unit, dropAt, start, end, now, user, perDollar, low, high, confidence, basis, notes = [], extras = [], fixed = 0, fixedSoFar = 0 }) {
  const est = (vol, f) => f + vol * perDollar;
  return {
    program,
    unit,
    dropAt,
    window: { start, end, settled: now >= end },
    volume: { soFar: user.soFar, projected: user.projected, daily: user.daily, remainingDays: user.remainingDays, basis: user.basis },
    perDollar,
    // AURA that doesn't depend on more volume (Bulk: open positions' hours and liquidations), so
    // what you'd get for a volume V is fixed + V x perDollar.
    fixed,
    fixedSoFar,
    range: { low, high },
    points: {
      soFar: est(user.soFar, fixedSoFar), // earned up to now
      projected: est(user.projected, fixed),
      low: est(user.projected, fixed) * low,
      high: est(user.projected, fixed) * high,
    },
    confidence,
    basis,
    notes,
    extras,
  };
}


// Bulk's total volume between two times, from hourly candles keyed by the hour's start (ms).
// Partial hours count in proportion (Bulk's weeks start and end at :30).
function hoursTotal(hours, s, e) {
  let v = 0;
  for (const [k, usd] of Object.entries(hours || {})) {
    const t = Number(k);
    const ov = Math.min(t + HOUR, e) - Math.max(t, s);
    if (ov > 0) v += (usd * ov) / HOUR;
  }
  return v;
}
// Candles cover the window if there are hours near both ends.
function hoursCover(hours, s, e) {
  const keys = Object.keys(hours || {}).map(Number);
  return keys.some((t) => t <= s + HOUR && t > s - 2 * HOUR) && keys.some((t) => t < e && t >= e - 3 * HOUR);
}
const interp = (table, x) => {
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (Math.max(x, x0) - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
};
// What the formula gives for one week's activity { taker, oiHours, liq }.

module.exports = { HOUR, DAY, WEEK, median, projectVolume, typicalDaily, pack, hoursTotal, hoursCover, interp, holdMult };
