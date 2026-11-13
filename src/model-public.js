'use strict';

// The public AURA model: estimates Bulk AURA from your own revealed weeks only, as AURA paid per
// dollar you took, the latest weeks weighing most. Each past week is also predicted from the weeks
// before it; how far those predictions missed is shown and sets the likely range.
//
// Official builds can carry a more detailed model (src/model.js loads it); this one needs nothing
// but your own history and AURA.

const { HOUR, DAY, WEEK, projectVolume, pack } = require('./estimate-core');

const DECAY = 0.6; // each week further back counts this much less

function bulkEstimate({ view, fillsFor, bulkFor, firstTs, now, nextDrop }) {
  if (!nextDrop) return null;
  const end = nextDrop - 30 * 60000; // Bulk settles a week 30 minutes before the reveal
  const start = view && view.current && Number.isFinite(view.current.start) ? view.current.start : end - WEEK;
  const taken = (a, b) => (bulkFor ? bulkFor(a, b).taker : fillsFor('bulk', a, b).volume);
  const soFar = taken(start, Math.min(now, end));
  const from = Math.max(start - 14 * DAY, Number.isFinite(firstTs) ? firstTs : start - 14 * DAY);
  const typical = (start - from) / DAY >= 1 ? taken(from, start) / ((start - from) / DAY) : null;
  const user = projectVolume(soFar, start, end, now, typical);

  // Your revealed weeks: what Bulk paid per dollar you took.
  const rows = (view ? view.weeks : [])
    .filter((w) => !w.pending && w.end <= now && w.end > now - 12 * WEEK && Number.isFinite(w.start))
    .map((w) => {
      const vol = taken(w.start, w.end);
      return { week: w.week, start: w.start, end: w.end, credited: w.trading, vol, rate: w.trading > 0 && vol >= 2000 ? w.trading / vol : null, gauntlet: w.gauntlet || 0, referrals: w.referrals || 0 };
    });
  const thisWeek = view && view.current && view.current.week ? view.current.week : rows.length ? rows[rows.length - 1].week + 1 : 0;
  const blend = (forWeek) => {
    let s = 0;
    let sw = 0;
    const used = [];
    for (const x of rows) {
      if (!Number.isFinite(x.rate) || x.week >= forWeek) continue;
      const wgt = Math.pow(DECAY, Math.max(0, forWeek - x.week - 1)) * Math.min(1, x.vol / 20000);
      s += wgt * x.rate;
      sw += wgt;
      used.push(x.week);
    }
    return sw > 0 ? { r: s / sw, weeks: used } : null;
  };
  const bt = rows
    .filter((x) => Number.isFinite(x.rate))
    .map((x) => {
      const b = blend(x.week);
      return b ? { week: x.week, predicted: b.r * x.vol, actual: x.credited, err: x.credited / (b.r * x.vol) - 1 } : null;
    })
    .filter(Boolean);
  const now0 = blend(thisWeek);
  if (!now0) return null; // nothing to go on until your first revealed week with trading
  const perDollar = now0.r;
  const n = Math.min(6, bt.length);
  const rms = n ? Math.sqrt(bt.slice(-6).reduce((a, b) => a + b.err * b.err, 0) / n) : null;
  const sRate = n >= 2 ? Math.max(0.05, rms * (1 + 1 / n)) : n === 1 ? Math.max(0.12, Math.abs(bt[0].err) * 1.5) : 0.2;
  const spread = 1.28 * sRate;
  const weekList = (ws) => (ws.length > 1 ? `weeks ${ws.slice(0, -1).join(', ')} and ${ws[ws.length - 1]}` : `week ${ws[0]}`);
  const basis = [{ label: 'AURA per $1K you take', value: (perDollar * 1000).toFixed(2), note: `What Bulk paid you per $ in ${weekList(now0.weeks)}, the latest weighing most` }];
  if (bt.length) basis.push({ label: 'Checked on your weeks', value: `±${(rms * 100).toFixed(1)}%`, note: `${bt.slice(-4).map((b) => `week ${b.week} ${b.err >= 0 ? '+' : '−'}${Math.abs(Math.round(b.err * 100))}%`).join(', ')} (each predicted from the weeks before it only)` });
  const notes = [];
  if (view && view.pendingWeeks && view.pendingWeeks.length) notes.push(`Week${view.pendingWeeks.length > 1 ? 's' : ''} ${view.pendingWeeks.join(', ')} ${view.pendingWeeks.length > 1 ? 'are' : 'is'} revealed but not loaded yet. Paste your AURA on the Points page to add ${view.pendingWeeks.length > 1 ? 'them' : 'it'}.`);
  const extras = [];
  const ref = rows.filter((w) => w.referrals > 0 && w.week >= thisWeek - 2).pop();
  if (ref) extras.push({ label: `Referral AURA, if your referrals trade like week ${ref.week}`, value: ref.referrals });
  const gw = rows.filter((w) => w.gauntlet > 0 && w.week >= thisWeek - 4).pop();
  if (gw && user.projected >= 10000) extras.push({ kind: 'gauntlet', label: `Gauntlet AURA (Challenger Series), if like week ${gw.week}`, value: gw.gauntlet });
  const confidence = bt.length >= 3 && rms <= 0.1 ? 'good' : 'fair';
  const est = pack({ program: 'bulk', unit: 'AURA', dropAt: nextDrop, start, end, now, user, perDollar, low: Math.max(0.4, 1 - spread), high: 1 + spread, confidence, basis, notes, extras });
  est.market = null;
  est.baseRate = perDollar;
  est.rates = { taker: perDollar, oiHour: null, liq: null, perHour: null, week: rows.length ? rows[rows.length - 1].week : null, derived: false, own: true, credit: null, mode: 'public' };
  est.open = { notional: 0, held: 0, hoursLeft: Math.max(0, end - now) / HOUR };
  est.activity = { taker: soFar };
  est.check = { mode: 'public', weeks: now0.weeks, rms, backtest: bt };
  const predOf = new Map(bt.map((b) => [b.week, b.predicted]));
  est.calibration = rows.map((w) => ({ week: w.week, start: w.start, end: w.end, rules: null, eff: w.rate ? { taker: w.rate, oiHour: 0, liq: 0 } : null, taker: w.vol, credited: w.credited, predicted: predOf.has(w.week) ? predOf.get(w.week) : null }));
  return est;
}

// Strategy, Bulk alone: general habits.
const bulkRules = [
  { id: 'bVolume', label: '$250K+ taker volume per AURA week', why: 'Trading AURA follows the volume you trade in each AURA week (Saturday 12:30 to Saturday 12:30 UTC).', bench: 'Your AURA per $ comes from your own revealed weeks', unit: 'usdWeek', cmp: 'gte', target: 250000 },
  { id: 'bCost', label: 'Pay under $120 in fees per 1,000 AURA', why: 'Fees ÷ the trading AURA this volume should earn at your own rate.', bench: 'Taker fee 3.5 bps on Bulk', unit: 'usd', cmp: 'lte', target: 120 },
  { id: 'bQualify', label: '$10K+ volume to qualify for leagues', why: 'Bulk only ranks you in the trading league after $10,000 of volume.', bench: 'Bulk’s threshold: $10,000', unit: 'usd', cmp: 'gte', target: 10000 },
  { id: 'bBreakeven', label: 'Break even or better', why: 'Realised PnL + funding − fees. AURA is only worth it if the trading doesn’t bleed.', bench: 'PnL counts once a position fully closes', unit: 'usd', cmp: 'gte', target: 0 },
];

function bulkTips(perDollar) {
  const r = perDollar > 0 ? (perDollar * 1000).toFixed(2) : null;
  return [
    { icon: 'sigma', title: 'Your rate', body: r ? `Bulk paid you about ${r} AURA per $1,000 you took in your recent weeks. The rate moves every week with how busy Bulk is.` : 'Your AURA per dollar is measured from your first revealed week with trading.' },
    { icon: 'clock', title: 'Cutoff', body: 'Each AURA week closes Saturday 12:30 UTC and is revealed at 13:00 UTC. Trades count in the week they happen.' },
    { icon: 'trophy', title: 'Leagues', body: 'The trading league needs $10K+ of volume and ranks by total trading AURA. The Leagues page shows what each league pays.' },
    { icon: 'copy', title: 'Keep your AURA current', body: 'Paste your AURA page on the Points page after each Saturday reveal: every revealed week sharpens your rate.' },
  ];
}

module.exports = { edition: 'public', name: 'Your own weeks', bulkEstimate, hold: null, ref: null, bulkRules, bulkTips };
