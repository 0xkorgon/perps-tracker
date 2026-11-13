'use strict';

// Next-drop estimates: how many points the week being traded now should pay out.
//
// Bulk AURA  From the AURA model (src/model.js): the public model estimates from your own revealed
//            weeks (AURA paid per dollar you took, the latest weighing most, checked against each
//            past week); official owner builds can add their own.
// Arcus      Arcus splits a fixed 250,000 points a week by a score it doesn't publish (stocks and
//            off-hours trading earn more). Your paid weeks calibrate what a dollar of stocks and a
//            dollar of crypto earned you against the market's average dollar; the estimate is
//            250,000 x that x your volume / all Arcus volume, so a busier week on Arcus means fewer
//            points for the same trading. See the Arcus section below.
//
// Your volume for the rest of the week is projected from your pace: this week's daily rate so far,
// blended with your recent daily average while the week is young. The page also lets you try
// other amounts (your own volume barely moves either exchange's total, so `perDollar` is all it
// needs).

const { HOUR, DAY, WEEK, median, projectVolume, typicalDaily, pack, hoursTotal, holdMult } = require('./estimate-core');
const model = require('./model');

const ARCUS_POOL = 250000; // points handed out each week (Arcus: fixed for the program)

// Bulk: whichever model this copy has.
const bulkEstimate = (args) => model.bulkEstimate(args);

// ---------- Arcus ----------
// Arcus splits a fixed 250,000 points a week by a score it doesn't publish; it says trading stock
// tokens and other real-world assets, and trading off-hours, earn more. So your paid weeks calibrate
//   points = 250,000 x (eS x your stock volume + eC x your crypto volume) / all Arcus volume
// eS and eC (what a dollar of each earned you, relative to the market's average dollar) are fitted
// on your paid weeks, recent weeks weighing most, and both pulled toward your overall efficiency
// until weeks with different mixes tell them apart. Weeks whose market volume is a few hours short
// at the edges are scaled up instead of dropped. Each paid week is also predicted from the weeks
// before it only; how far those predictions missed sets the likely range.
const ARCUS_DECAY = 0.7; // each paid week further back counts this much less
const ARCUS_VOL_ERR = [[0, 0.22], [24, 0.18], [48, 0.15], [72, 0.12], [96, 0.09], [120, 0.06], [144, 0.03], [168, 0]];
const interpA = (table, x) => {
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (Math.max(x, x0) - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
};

// Your efficiency per dollar of stocks (eS) and crypto (eC), and with `hold` per dollar-hour of
// positions open (eO), from paid weeks before `beforeAt`. Weighted least squares on
// y = eS*S + eC*C (+ eO*O), errors relative to volume, recent weeks weighing most, eS and eC pulled
// toward your overall efficiency and eO toward nothing until the weeks say otherwise.
function solve(A, b) {
  // Gaussian elimination for a small system (2x2 or 3x3).
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
function fitArcus(rows, beforeAt, { hold = false } = {}) {
  const use = rows.filter((r) => r.at < beforeAt).sort((a, b) => b.at - a.at);
  if (!use.length) return null;
  const w = use.map((r, k) => Math.pow(ARCUS_DECAY, k) * Math.min(1, r.V / 20000));
  let sw = 0;
  let sy = 0;
  let sv = 0;
  let so = 0;
  use.forEach((r, k) => {
    sy += w[k] * r.y;
    sv += w[k] * r.V;
    so += w[k] * (r.O || 0);
    sw += w[k];
  });
  const e0 = sv > 0 ? sy / sv : null; // overall efficiency
  if (!(e0 > 0)) return null;
  const vbar = sv / sw;
  const obar = Math.max(1, so / sw);
  const lam = 0.2 * vbar; // the prior weighs like a fifth of a typical week
  const feats = (r) => (hold ? [r.S, r.C, r.O || 0] : [r.S, r.C]);
  const k = hold ? 3 : 2;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  // Ridge: eS, eC toward e0; eO toward 0.
  const prior = hold ? [e0, e0, 0] : [e0, e0];
  const scale = hold ? [lam, lam, (lam * vbar * vbar) / (obar * obar)] : [lam, lam];
  for (let i = 0; i < k; i++) {
    A[i][i] += scale[i];
    b[i] += scale[i] * prior[i];
  }
  use.forEach((r, j) => {
    const x = feats(r);
    const q = w[j] / Math.max(1, r.V);
    for (let i = 0; i < k; i++) {
      b[i] += q * x[i] * r.y;
      for (let l = 0; l < k; l++) A[i][l] += q * x[i] * x[l];
    }
  });
  const sol = solve(A, b) || prior;
  const clamp = (x) => Math.min(5 * e0, Math.max(0.05 * e0, x));
  const eS = clamp(sol[0]);
  const eC = clamp(sol[1]);
  const eO = hold ? Math.max(0, sol[2]) : 0;
  // Both classes measured: some week with at least 20% of each.
  const both = use.some((r) => r.S >= 0.2 * r.V) && use.some((r) => r.C >= 0.2 * r.V);
  return { eS, eC, eO, e0, n: use.length, both, hold, weeks: use.map((r) => r.label) };
}
const predictArcus = (f, r, M) => (ARCUS_POOL / M) * (f.eS * r.S + f.eC * r.C + f.eO * (r.O || 0));

// mixFor(a, b): your Arcus volume between two times split into { volume, stocks, crypto, off }.
function arcusEstimate({ view, fillsFor, mixFor, firstTs, now, hours, open = 0 }) {
  if (!view || !view.nextDrop) return null;
  const end = view.nextDrop;
  const start = view.current && Number.isFinite(view.current.start) ? view.current.start : end - WEEK;
  const H = hours || {};
  const keys = Object.keys(H).map(Number).sort((a, b) => a - b);
  // All Arcus volume in a window, scaled up for up to a quarter of it missing at the edges.
  const market = (s, e) => {
    let sum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of keys) {
      const ov = Math.min(t + HOUR, e) - Math.max(t, s);
      if (ov <= 0) continue;
      sum += (H[t] * ov) / HOUR;
      lo = Math.min(lo, Math.max(t, s));
      hi = Math.max(hi, Math.min(t + HOUR, e));
    }
    const span = hi - lo;
    if (!(span > 0) || span < 0.75 * (e - s)) return null;
    return { total: (sum * (e - s)) / span, scaled: span < e - s - 2 * HOUR };
  };
  const mix = mixFor || ((a, b) => {
    const v = fillsFor('arcus', a, b).volume;
    return { volume: v, stocks: v, crypto: 0, off: 0 };
  });

  const soFar = fillsFor('arcus', start, Math.min(now, end)).volume;
  const user = projectVolume(soFar, start, end, now, typicalDaily(fillsFor, firstTs, 'arcus', start));

  // Paid weeks with their mix and the market's volume.
  const rows = [];
  const rough = [];
  for (const h of view.history || []) {
    if (!(h.gained > 0) || !(h.volume > 0) || !Number.isFinite(h.start) || !Number.isFinite(h.end)) continue;
    const m = mix(h.start, h.end);
    const M = market(h.start, h.end);
    const label = h.week;
    if (M && M.total > 0 && m.volume > 0) rows.push({ label, at: h.end, len: h.end - h.start, S: m.stocks, C: m.crypto, V: m.volume, O: m.oiHours || 0, off: m.off, y: (h.gained * M.total) / ARCUS_POOL, gained: h.gained, M: M.total, scaled: M.scaled });
    else rough.push({ label, rate: h.gained / h.volume });
  }
  rows.sort((a, b) => a.at - b.at);

  // The check: each paid week predicted from the weeks before it only.
  const backtest = (opts) =>
    rows
      .map((r) => {
        const f = fitArcus(rows, r.at, opts);
        if (!f) return null;
        const predicted = predictArcus(f, r, r.M);
        return { week: r.label, predicted, actual: r.gained, err: r.gained / predicted - 1, from: f.n };
      })
      .filter(Boolean);
  const rmsOf = (b) => (b.length ? Math.sqrt(b.slice(-6).reduce((a, x) => a + x.err * x.err, 0) / Math.min(6, b.length)) : null);
  // Volume alone, or volume plus the hours your positions stay open (Arcus also rewards capital
  // kept on it). Holding is used once it has predicted your weeks better on at least three of them.
  const btMix = backtest({ hold: false });
  const btHold = backtest({ hold: true });
  const hold = btHold.length >= 3 && btMix.length >= 3 && rmsOf(btHold) < rmsOf(btMix) * 0.9;
  const bt = hold ? btHold : btMix;
  // The range comes from checks that had at least two earlier weeks to go on, once there are any.
  const btRange = bt.some((b) => b.from >= 2) ? bt.filter((b) => b.from >= 2) : bt;
  const n = Math.min(6, btRange.length);
  const rms = rmsOf(btRange);

  // All Arcus volume by the drop: so far this week, then last paid week's daily rate.
  const cur = market(start, Math.min(now, end));
  const exSoFar = cur ? cur.total : now - start < 3 * HOUR ? 0 : null;
  const lastRow = rows[rows.length - 1] || null;
  const lastWeekDaily = lastRow ? lastRow.M / (lastRow.len / DAY) : null;
  const ex = exSoFar != null ? projectVolume(exSoFar, start, end, now, lastWeekDaily) : null;

  // This week's mix: so far, else your last 14 days, else your last paid week.
  let m = mix(start, Math.min(now, end));
  let mixFrom = 'this week so far';
  if (!(m.volume >= 2000)) {
    m = mix(start - 14 * DAY, start);
    mixFrom = 'your last 14 days';
  }
  if (!(m.volume >= 2000) && lastRow) {
    m = { volume: lastRow.V, stocks: lastRow.S, crypto: lastRow.C, off: lastRow.off };
    mixFrom = `your week of ${lastRow.label}`;
  }
  const stockShare = m.volume > 0 ? m.stocks / m.volume : 1;
  const offShare = m.stocks > 0 ? m.off / m.stocks : 0;

  const fit = fitArcus(rows, Infinity, { hold });
  const pc = (x) => `${Math.round(x * 100)}%`;
  const notes = [];
  const basis = [{ label: 'Weekly pool', value: '250,000 points', note: 'Fixed by Arcus, split by its own score' }];
  let perDollar;
  let low;
  let high;
  let confidence;
  let fixedSoFar = 0;
  let fixedAll = 0;
  if (fit && ex && ex.projected > 0) {
    const eff = fit.eS * stockShare + fit.eC * (1 - stockShare);
    perDollar = (ARCUS_POOL * eff) / ex.projected;
    // With holding in the model: the hours your positions have been open this week, and your open
    // Arcus positions staying open to the drop, earn on top of volume.
    if (fit.hold && fit.eO > 0) {
      const oiSoFar = (mix(start, Math.min(now, end)).oiHours || 0);
      fixedSoFar = (ARCUS_POOL / ex.projected) * fit.eO * oiSoFar;
      fixedAll = fixedSoFar + (ARCUS_POOL / ex.projected) * fit.eO * Math.max(0, open) * (Math.max(0, end - now) / HOUR);
    }
    const sRate = n >= 2 ? Math.max(0.1, rms * (1 + 1 / n)) : n === 1 ? Math.max(0.25, Math.abs(btRange[0].err) * 1.5) : 0.35;
    const sV = interpA(ARCUS_VOL_ERR, (Math.min(now, end) - start) / HOUR);
    const spread = 1.28 * Math.sqrt(sRate * sRate + sV * sV);
    low = Math.max(0.35, 1 - spread);
    high = 1 + spread;
    confidence = n >= 2 && rms <= 0.2 ? 'good' : 'fair';
    basis.push(
      fit.both
        ? { label: 'Your efficiency', value: `stocks ×${fit.eS.toFixed(2)} · crypto ×${fit.eC.toFixed(2)}`, note: `What a dollar of each earned you against Arcus's average dollar, from ${fit.n} paid week${fit.n > 1 ? 's' : ''}` }
        : { label: 'Your efficiency', value: `×${fit.e0.toFixed(2)}`, note: `Your points ÷ your share of Arcus volume, from ${fit.n} paid week${fit.n > 1 ? 's' : ''}${stockShare < 0.8 && !fit.both ? '. Crypto is rated like stocks until a paid week with more crypto' : ''}` }
    );
    basis.push({ label: 'Your mix', value: `${pc(stockShare)} stocks`, note: `${stockShare > 0 ? `${pc(offShare)} of it off-hours; ` : ''}from ${mixFrom}` });
    if (fit.hold) basis.push({ label: 'Holding', value: `×${((fit.eO * 24) / Math.max(1e-9, fit.e0)).toFixed(2)} a day`, note: 'A dollar kept open for a day, against a dollar traded: it predicted your weeks better than volume alone' });
    basis.push({ label: 'All Arcus volume', value: ex.projected, money: true, note: `Expected by the drop (${Math.round(ex.soFar / 1e6).toLocaleString('en-US')}M so far this week)` });
    if (bt.length) basis.push({ label: 'Checked on your weeks', value: `±${(rms * 100).toFixed(0)}%`, note: `${bt.slice(-3).map((b) => `${b.week} ${b.err >= 0 ? '+' : '−'}${Math.abs(Math.round(b.err * 100))}%`).join(', ')} (each predicted from the weeks before it only)` });
    if (fit.n < 3) notes.push(`Based on ${fit.n === 1 ? 'one paid week' : 'two paid weeks'} so far. The range narrows as more drops are recorded.`);
    if (rows.some((r) => r.scaled)) notes.push("Arcus's volume for one of your paid weeks is a few hours short, so it's scaled up to the full week.");
  } else if (rough.length || rows.length) {
    // Market volume unknown: points per dollar in paid weeks, as if Arcus were as busy as then.
    perDollar = median([...rough.map((r) => r.rate), ...rows.map((r) => r.gained / r.V)]);
    low = 0.5;
    high = 1.6;
    confidence = 'fair';
    notes.push("Arcus's market volume isn't loaded yet, so this assumes the market is as busy as in your paid weeks.");
    basis.push({ label: 'Your rate', value: `${(perDollar * 1e4).toFixed(2)} per $10K`, note: 'Points per dollar in your paid weeks' });
  } else if (ex && ex.projected > 0) {
    perDollar = ARCUS_POOL / ex.projected; // assume points follow volume one for one
    low = 0.3;
    high = 2;
    confidence = 'rough';
    notes.push(view.me ? 'No paid week on record for your points name yet, so this assumes points follow volume share. It gets much closer after the next drop.' : 'Add your Arcus points name in Settings to calibrate this on your own drops.');
    basis.push({ label: 'All Arcus volume', value: ex.projected, money: true, note: 'Expected by the drop' });
  } else return null;

  const est = pack({ program: 'arcus', unit: 'points', dropAt: end, start, end, now, user, perDollar, low, high, confidence, basis, notes, fixed: fixedAll, fixedSoFar });
  est.check = { rms, backtest: bt, hold, rmsVolume: rmsOf(btMix), rmsHold: rmsOf(btHold) };
  est.fit = fit;
  const lb = bt[bt.length - 1];
  if (lb) est.lastResult = { week: lb.week, label: `Week of ${lb.week}`, model: lb.predicted, actual: lb.actual };
  return est;
}


module.exports = { bulkEstimate, arcusEstimate, projectVolume, hoursTotal, holdMult, model, ARCUS_POOL, BULK_HOLD: model.hold || { perHour: null, week: 168 } };
