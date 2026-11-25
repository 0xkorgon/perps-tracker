'use strict';

// The measured Bulk AURA model (published with the full tracker since 3.6.0). src/model.js loads it
// when it's here; without it the tracker falls back to src/model-public.js.
//
// Next-drop estimates: how many points the week being traded now should pay out.
//
// Bulk AURA  Measured on 12 Oct 2026 on every wallet on Bulk's trading leaderboard whose full trade
//            history (Bulk's public API) matched Bulk's own volume count: 873 wallets in week 4, 883
//            in week 5. One formula reproduces each wallet's trading AURA to within 0.4% (median;
//            98% of wallets within 5%):
//              AURA = A x taker volume + B x open positions' dollar-hours + L x volume liquidated
//            Maker fills and self-trades earn nothing. Market, fill size, number of trades and hold
//            time add nothing once these are counted: what looked like a "hold multiplier" is the
//            dollar-hours term (a position earns every hour it's open, cutoff or not).
//            A, B and L come from fixed weekly amounts shared out, so they move with Bulk's totals:
//            A with Bulk's volume (its public hourly candles; this week's projected to the cutoff).
//            Bulk then credits a little more on top (week 4 +5%, week 5 +12% at the median, different
//            per wallet); your own revealed weeks measure yours.
//            Calibration: every revealed week with your trading counts, including weeks known only
//            from your AURA total's categories (no weekly results pasted). For each, what Bulk paid
//            divided by the formula for your activity that week (taker volume, open dollar-hours,
//            liquidations) gives your factor: Bulk's credit plus how its rates moved since week 5.
//            This week uses your recent factors, the latest weighing most; with Bulk's market volume
//            loaded for those weeks, factors are measured at week 5's volume and the taker rate then
//            follows this week's volume. Each past week is also predicted from the weeks before it
//            only; how far those predictions missed sets the likely range.
//            Bulk renamed its rules from week 8 ("mainnet-week8-rebates-over-fees-v1", then
//            "mainnet-week11-manual-reviewed-v1") without publishing them: the formula's shape is
//            still week 5's, and your factor follows what Bulk actually paid you in those weeks.
//            Checked 25 Nov on a wallet that traded only crypto in weeks 5-7 and only stocks (1.5 bps
//            fees) in weeks 9-10: at Bulk's volume, AURA per $ stayed the same (factor 1.13-1.25 vs
//            1.14-1.22), and each week predicted from the ones before was within 9% (-6% to +9%).
//            So stock volume still earns like crypto volume; the name doesn't mean fees decide it.
// Arcus      Arcus splits a fixed 250,000 points a week by a score it doesn't publish (volume with
//            boosts for stocks and off-hours, market making, deposits). What's measurable is how
//            your points compared with your share of all volume on Arcus in weeks already paid:
//            your "efficiency". The estimate is 250,000 x efficiency x your volume / all Arcus
//            volume, so a busier week on Arcus means fewer points for the same trading.
//
// Your volume for the rest of the week is projected from your pace: this week's daily rate so far,
// blended with your recent daily average while the week is young. The page also lets you try
// other amounts (your own volume barely moves either exchange's total, so `perDollar` is all it
// needs).


const { HOUR, DAY, WEEK, median, projectVolume, pack, hoursTotal, hoursCover, interp, holdMult } = require('../src/estimate-core');


// Bulk's formula per rule set (Bulk names each week's rules; week 5 went back to week 1's).
// taker: AURA per $ of taker volume, oiHour: per $ open for an hour, liq: per $ liquidated,
// exVol: Bulk's total volume that week (its candles), which the taker rate is scaled by.
const BULK_FORMULA = {
  'mainnet-week4-v2': { week: 4, taker: 1.672e-3, oiHour: 7.708e-5, liq: 0.4154, exVol: 267455853, wallets: 873, medErr: 0.0041 },
  'mainnet-week1-v2': { week: 5, taker: 2.843e-3, oiHour: 5.962e-5, liq: 0.1344, exVol: 196542280, wallets: 883, medErr: 0.0045 },
};
const BULK_LATEST = 'mainnet-week1-v2';
const BULK_CREDIT = 1.1; // Bulk's credit on top of the formula, typical (week 4 1.05, week 5 1.12)
const BULK_DECAY = 0.6; // each week further back counts this much less in your factor
// How far Bulk's weekly volume can still move, by hours into the week (RMS error of the projection,
// backtested on every 12-hour start from 19 Sep to 5 Oct 2026).
const BULK_VOL_ERR = [[0, 0.2], [12, 0.18], [24, 0.16], [48, 0.13], [72, 0.11], [96, 0.096], [120, 0.071], [144, 0.039], [168, 0]];
const bulkRef = BULK_FORMULA[BULK_LATEST];
const BULK_HOLD = { perHour: bulkRef.oiHour / (2 * bulkRef.taker), week: 168 }; // week 5: +1.05% an hour

const formula = (r, a) => r.taker * a.taker + r.oiHour * a.oiHours + r.liq * a.liq;

// bulkFor(a, b): your Bulk activity between two times: { taker (not liquidations), liq, maker,
// oiHours ($ open x hours) }. open: your Bulk positions' notional now.
function bulkEstimate({ view, fillsFor, bulkFor, open = 0, firstTs, now, nextDrop, hours, coveredUntil }) {
  if (!nextDrop) return null;
  const end = nextDrop - 30 * 60000; // Bulk settles a week 30 minutes before the reveal
  const start = view && view.current && Number.isFinite(view.current.start) ? view.current.start : end - WEEK;
  // Without position history, all volume counts as taker volume and nothing as open positions.
  const act = bulkFor || ((a, b) => ({ taker: fillsFor('bulk', a, b).volume, liq: 0, maker: 0, oiHours: 0 }));
  const me = act(start, Math.min(now, end));
  const from = Math.max(start - 14 * DAY, Number.isFinite(firstTs) ? firstTs : start - 14 * DAY);
  const typical = (start - from) / DAY >= 1 ? act(from, start).taker / ((start - from) / DAY) : null;
  const user = projectVolume(me.taker, start, end, now, typical);
  const hoursLeft = Math.max(0, end - now) / HOUR;
  const H = hours || {};
  const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`;
  const m = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3).toLocaleString('en-US')}K`);

  // Bulk's volume this week: so far (up to the latest candle every market has been read to, if it's
  // under 12 hours old), then the last 7 days' daily average while the week is young.
  const keys = Object.keys(H).map(Number);
  const covered = Number.isFinite(coveredUntil) && coveredUntil > 0 ? coveredUntil + 2 * HOUR : Infinity; // every market read up to about here
  const fullyRead = (s, e) => e <= covered && hoursCover(H, s, e);
  const lastT = keys.length ? Math.min(Math.max(...keys) + HOUR, covered) : -Infinity;
  const upto = now - start < 3 * HOUR ? Math.min(now, end) : Math.min(now, end, lastT);
  const exTypical = fullyRead(upto - 7 * DAY, upto) ? hoursTotal(H, upto - 7 * DAY, upto) / 7 : null;
  const exOk = keys.length && (now - start < 3 * HOUR || (upto > start && Math.min(now, end) - upto < 12 * HOUR && fullyRead(start, upto)));
  const ex = exOk ? projectVolume(hoursTotal(H, start, upto), start, end, upto, exTypical) : null;

  // Every revealed week with your trading, not only the ones whose weekly results were loaded: how
  // what Bulk paid you compares with the reference formula (week 5's rules) for your activity that
  // week. That ratio carries Bulk's credit on top and how its rates have moved since week 5.
  //   r   AURA paid / formula                                   (any week)
  //   rV  AURA paid / formula with the taker rate scaled by Bulk's volume that week (weeks whose
  //       market volume is loaded), so a busy or quiet week doesn't move it
  const REF = BULK_FORMULA[BULK_LATEST];
  const knownRules = new Set(Object.keys(BULK_FORMULA));
  const rows = view
    ? view.weeks
        .filter((w) => !w.pending && w.end <= now && w.end > now - 12 * WEEK && Number.isFinite(w.start))
        .map((w) => {
          const a = act(w.start, w.end);
          const rules = BULK_FORMULA[w.ruleset] || null;
          const model = rules ? formula(rules, a) : null;
          const exV = fullyRead(w.start, w.end) ? hoursTotal(H, w.start, w.end) : null;
          const sc = exV > 0 && REF.exVol > 0 ? REF.exVol / exV : null;
          const base = formula(REF, a);
          const baseV = sc ? REF.taker * a.taker * sc + REF.oiHour * a.oiHours + REF.liq * a.liq : null;
          // A week under rules Bulk has since replaced (week 4's) says nothing about today's rates.
          const replaced = Boolean(w.ruleset && knownRules.has(w.ruleset) && w.ruleset !== BULK_LATEST);
          const usable = !replaced && w.trading > 0 && base >= 20;
          return {
            week: w.week,
            start: w.start,
            end: w.end,
            ruleset: w.ruleset || null,
            rules,
            act: a,
            credited: w.trading,
            raw: w.rawTrading > 0 ? w.rawTrading : null,
            model,
            g: model >= 20 && w.trading > 0 ? w.trading / model : null, // your credit under that week's own rules
            credit: w.rawTrading > 0 ? w.trading / w.rawTrading : null,
            exV,
            sc,
            base,
            baseV,
            r: usable ? w.trading / base : null,
            rV: usable && baseV >= 20 ? w.trading / baseV : null,
            newRules: Boolean(w.ruleset && !knownRules.has(w.ruleset)),
            referrals: w.referrals || 0,
            gauntlet: w.gauntlet || 0,
          };
        })
    : [];
  const thisWeek = view && view.current && view.current.week ? view.current.week : rows.length ? rows[rows.length - 1].week + 1 : 0;

  // This week's ratio: your recent weeks, the latest weighing most (each week back counts 0.6 as
  // much), a week too small to measure well counting less.
  const blend = (key, forWeek) => {
    let s = 0;
    let sw = 0;
    const used = [];
    for (const x of rows) {
      if (!Number.isFinite(x[key]) || x.week >= forWeek) continue;
      const wgt = Math.pow(BULK_DECAY, Math.max(0, forWeek - x.week - 1)) * Math.min(1, x.base / 50);
      s += wgt * x[key];
      sw += wgt;
      used.push(x.week);
    }
    return sw > 0 ? { r: s / sw, weeks: used } : null;
  };
  // The check: each revealed week predicted from the weeks before it only, with its real activity.
  const backtest = (key, baseKey) =>
    rows
      .filter((x) => Number.isFinite(x[key]))
      .map((x) => {
        const b = blend(key, x.week);
        if (!b) return null;
        const predicted = b.r * x[baseKey];
        return { week: x.week, predicted, actual: x.credited, err: x.credited / predicted - 1 };
      })
      .filter(Boolean);
  const btRaw = backtest('r', 'base');
  const btVol = backtest('rV', 'baseV');
  const rms = (bt) => (bt.length ? Math.sqrt(bt.slice(-6).reduce((a, b) => a + b.err * b.err, 0) / Math.min(6, bt.length)) : null);

  const bV = blend('rV', thisWeek);
  const bR = blend('r', thisWeek);
  let mode;
  let f;
  if (ex && ex.projected > 0 && bV && bV.weeks.some((w) => w >= thisWeek - 4)) {
    mode = 'vol';
    f = bV.r;
  } else if (bR) {
    mode = 'raw';
    f = bR.r;
  } else {
    mode = 'typical';
    const credits = rows.filter((w) => w.credit).slice(-2).map((w) => w.credit);
    f = credits.length ? median(credits) : BULK_CREDIT;
  }
  f = Math.min(2.5, Math.max(0.3, f));
  const used = mode === 'vol' ? bV.weeks : mode === 'raw' ? bR.weeks : [];
  const bt = mode === 'vol' ? btVol : mode === 'raw' ? btRaw : [];
  const errRms = rms(bt);
  const last = rows[rows.length - 1] || null;
  const notes = [];

  // Rates this week (credited AURA). With Bulk's volume known, the taker rate moves with it.
  const scale = mode !== 'raw' && ex && ex.projected > 0 && REF.exVol > 0 ? REF.exVol / ex.projected : 1;
  const A = f * REF.taker * scale;
  const B = f * REF.oiHour;
  const L = f * REF.liq;
  const fixedSoFar = B * me.oiHours + L * me.liq;
  const held = B * Math.max(0, open) * hoursLeft;

  const weekList = (ws) => (ws.length > 1 ? `weeks ${ws.slice(0, -1).join(', ')} and ${ws[ws.length - 1]}` : `week ${ws[0]}`);
  const basis = [];
  if (mode === 'vol') basis.push({ label: 'AURA per $1K you take', value: (A * 1000).toFixed(2), note: `${(f * REF.taker * 1000).toFixed(2)} from your ${weekList(used)} at week ${REF.week}’s volume, with Bulk ${scale >= 1 ? 'quieter' : 'busier'} this week (${pct(1 / scale - 1)} volume)` });
  else if (mode === 'raw') basis.push({ label: 'AURA per $1K you take', value: (A * 1000).toFixed(2), note: `What Bulk paid you per $ in ${weekList(used)}, the latest weighing most` });
  else basis.push({ label: 'AURA per $1K you take', value: (A * 1000).toFixed(2), note: ex ? `Week ${REF.week}’s rate, with Bulk ${scale >= 1 ? 'quieter' : 'busier'} this week (${pct(1 / scale - 1)} volume)` : `Week ${REF.week}’s rate (Bulk’s volume isn’t loaded yet)` });
  basis.push({ label: 'Open positions', value: `${(B * 24 * 1000).toFixed(2)} a day per $1K`, note: 'Every hour a position stays open earns, cutoff or not' });
  if (ex) basis.push({ label: 'Bulk volume this week', value: ex.projected, money: true, note: `Expected by the cutoff (${m(ex.soFar)} so far)` });
  basis.push({ label: mode === 'typical' ? 'Bulk’s credit for you' : 'Your factor', value: `×${f.toFixed(2)}`, note: mode === 'typical' ? 'Typical; yours is measured after your first reveal' : `What Bulk paid ÷ week ${REF.week}’s formula: its credit on top and how its rates moved` });
  if (bt.length) basis.push({ label: 'Checked on your weeks', value: `±${(errRms * 100).toFixed(1)}%`, note: `${bt.slice(-4).map((b) => `week ${b.week} ${pct(b.err)}`).join(', ')} (each predicted from the weeks before it only)` });
  basis.push({ label: 'Formula checked on', value: `${(REF.wallets || 0).toLocaleString('en-US')} wallets`, note: `Median error ${(REF.medErr * 100).toFixed(1)}% in week ${REF.week}` });

  if (open > 0 && hoursLeft > 0) notes.push(`Includes your open Bulk positions (${m(open)}) staying open to the cutoff: about ${Math.round(held).toLocaleString('en-US')} AURA.`);
  if (mode === 'raw' && !ex) notes.push("Bulk's total volume isn't loaded yet, so this uses what Bulk paid you per dollar in your recent weeks. A quieter week pays more per dollar, a busier one less.");
  else if (mode === 'raw') notes.push("Bulk's volume for your earlier weeks isn't loaded yet, so the rate isn't adjusted for how busy Bulk is this week. It is once those weeks' volume is in.");
  if (mode === 'typical') notes.push(view ? 'No revealed week with your trading yet, so Bulk’s credit is the typical one. It sharpens after your first reveal.' : "Your AURA couldn't be read, so Bulk’s credit is the typical one. Paste your AURA on the Points page to use your own.");
  // Weeks you traded under rules Bulk hasn't published (week 8 on): how the estimate did on them.
  const fresh = rows.filter((w) => w.newRules && w.credited > 0);
  if (fresh.length) {
    const hit = bt.filter((b) => fresh.some((w) => w.week === b.week));
    notes.push(hit.length ? `Bulk has used new, unpublished rules since week 8. On your weeks under them the estimate was ${hit.map((b) => `${pct(b.err)} in week ${b.week}`).join(', ')}, and your rate keeps following what Bulk pays you.` : `Bulk has used new, unpublished rules since week 8; your rate follows what it paid you in week ${fresh[fresh.length - 1].week}.`);
  }
  if (view && view.pendingWeeks && view.pendingWeeks.length) notes.push(`Week${view.pendingWeeks.length > 1 ? 's' : ''} ${view.pendingWeeks.join(', ')} ${view.pendingWeeks.length > 1 ? 'are' : 'is'} revealed but your AURA was read before ${view.pendingWeeks.length > 1 ? 'them' : 'it'}. Paste your AURA on the Points page to add ${view.pendingWeeks.length > 1 ? 'them' : 'it'} to the calibration.`);
  if (!bulkFor) notes.push('Your Bulk position history isn’t loaded, so open positions aren’t counted.');

  // Range (about 80%): how far your rate has missed on your own past weeks, how far Bulk's volume
  // can still move (when the rate follows it), and the open-position rate (it moves with
  // everyone's open positions, which aren't public).
  const projected = A * user.projected + fixedSoFar + held;
  const volShare = projected > 0 ? (A * user.projected) / projected : 0;
  const oiShare = projected > 0 ? (B * me.oiHours + held) / projected : 0;
  const sV = mode === 'raw' ? 0 : ex ? interp(BULK_VOL_ERR, (Math.min(now, end) - start) / HOUR) : 0.3;
  // A handful of checked weeks understates the spread, so it's widened a little while there are few.
  const nBt = Math.min(6, bt.length);
  const sRate = nBt >= 2 ? Math.max(0.03, errRms * (1 + 1 / nBt)) : nBt === 1 ? Math.max(0.08, Math.abs(bt[0].err) * 1.5) : 0.1;
  const s2 = (volShare * sV) ** 2 + (oiShare * 0.1) ** 2 + sRate ** 2;
  const spread = 1.28 * Math.sqrt(s2);
  const low = Math.max(0.4, 1 - spread);
  const high = 1 + spread;

  let confidence = 'rough';
  if (mode !== 'typical') confidence = bt.length >= (mode === 'vol' ? 2 : 3) && errRms <= 0.08 ? 'good' : 'fair';
  else if (ex) confidence = 'fair';

  const extras = [];
  const ref = rows.filter((w) => w.referrals > 0 && w.week >= thisWeek - 2).pop();
  if (ref) extras.push({ label: `Referral AURA, if your referrals trade like week ${ref.week}`, value: ref.referrals * (mode === 'raw' ? 1 : scale) });
  // Gauntlet AURA (Challenger Series) is paid on top of trading AURA; Bulk hasn't published how.
  const gw = rows.filter((w) => w.gauntlet > 0 && w.week >= thisWeek - 4).pop();
  if (gw && user.projected >= 10000) extras.push({ kind: 'gauntlet', label: `Gauntlet AURA (Challenger Series), if like week ${gw.week}`, value: gw.gauntlet });
  const est = pack({ program: 'bulk', unit: 'AURA', dropAt: nextDrop, start, end, now, user, perDollar: A, low, high, confidence, basis, notes, extras, fixed: fixedSoFar + held, fixedSoFar });
  est.market = ex ? { soFar: ex.soFar, projected: ex.projected, daily: ex.daily } : null;
  est.k = f * REF.taker * (REF.exVol || 0);
  est.baseRate = A; // AURA per $ of taker volume (Live and Strategy)
  est.rates = { taker: A, oiHour: B, liq: L, perHour: B / (2 * A), week: last ? last.week : REF.week, derived: false, own: mode !== 'typical', credit: f, mode };
  est.open = { notional: open, held, hoursLeft };
  est.activity = { taker: me.taker, oiHours: me.oiHours, liq: me.liq, maker: me.maker };
  est.check = { mode, weeks: used, rms: errRms, backtest: bt };
  // Your revealed weeks against the formula (Points page: how close it was), with the rates each
  // week actually paid you (Strategy's "last week" uses them).
  const predOf = new Map([...btRaw, ...btVol].map((b) => [b.week, b.predicted])); // with volume where it's known
  est.calibration = rows.map((w) => {
    let eff = null;
    if (w.rules && w.g) eff = { taker: w.rules.taker * w.g, oiHour: w.rules.oiHour * w.g, liq: w.rules.liq * w.g };
    else if (w.rV) eff = { taker: w.rV * REF.taker * w.sc, oiHour: w.rV * REF.oiHour, liq: w.rV * REF.liq };
    else if (w.r) eff = { taker: w.r * REF.taker, oiHour: w.r * REF.oiHour, liq: w.r * REF.liq };
    return { week: w.week, ruleset: w.ruleset, start: w.start, end: w.end, rules: w.rules ? { taker: w.rules.taker, oiHour: w.rules.oiHour, liq: w.rules.liq } : null, eff, taker: w.act.taker, oiHours: w.act.oiHours, liq: w.act.liq, model: w.model, raw: w.raw, credited: w.credited, g: w.g, r: w.r, rV: w.rV, exV: w.exV, predicted: predOf.has(w.week) ? predOf.get(w.week) : null };
  });
  return est;
}


// ---------- Strategy, Bulk alone: the habits and tips that come from the measured formula ----------
// Measured on every wallet on Bulk's trading leaderboard whose full trade history matched Bulk's
// own count (883 wallets, week 5; see estimate.js). One formula reproduces each wallet's trading
// AURA to within 0.5% (median):
//   AURA = A x taker volume + B x open positions' dollar-hours (+ L x volume liquidated)
// Week 5: A = 2.84 per $1,000, B = 0.0596 per $1,000 an hour (1.43 a day). A round trip held h
// hours therefore earns 1 + (B / 2A) x h times a quick one: +1.05% an hour, no cap. Maker fills
// earn no trading AURA; market, fill size and number of trades make no difference.
const REF = BULK_FORMULA[BULK_LATEST];
const refMult = (h) => holdMult(h, BULK_HOLD.perHour).toFixed(2);
const BULK_RULES = [
  { id: 'bVolume', label: '$250K+ taker volume per AURA week', why: `Trading AURA is paid on taker volume: ${(REF.taker * 1000).toFixed(2)} AURA per $1,000 in week ${REF.week}, more in quieter weeks.`, bench: 'AURA rises in step with taker volume (no cap seen up to $3M a week)', unit: 'usdWeek', cmp: 'gte', target: 250000 },
  { id: 'bTaker', label: 'Take liquidity for 95%+ of volume', why: 'Maker fills earn no trading AURA. They share Bulk’s separate maker pool (100K AURA a week, mostly market makers).', bench: 'Maker volume: about 0 trading AURA per $1K', unit: 'pct', cmp: 'gte', target: 0.95 },
  { id: 'bHold', label: 'Hold multiplier of 1.25× or more', why: `Bulk pays open positions by the hour, so a round trip earns more the longer it stays open: about +${(BULK_HOLD.perHour * 100).toFixed(2)}% an hour at week ${REF.week}’s rates, with no cap. 1.25× is an average hold of about a day.`, bench: `24 h → ${refMult(24)}×, 2 days → ${refMult(48)}×, 3 days → ${refMult(72)}×, a week → ${refMult(168)}×`, unit: 'mult', cmp: 'gte', target: 1.25 },
  { id: 'bCore', label: 'Keep a position open 90%+ of the week', why: `Open positions earn every hour, cutoff or not: $10K held all week earns about ${Math.round(REF.oiHour * 10000 * 168)} AURA at week ${REF.week}’s rates, as much as $${Math.round((10 * REF.oiHour * 168) / REF.taker)}K more taker volume would, with no fees.`, bench: `Week ${REF.week}: ${(REF.oiHour * 24 * 1000).toFixed(2)} AURA a day per $1,000 open`, unit: 'pct', cmp: 'gte', target: 0.9 },
  { id: 'bCost', label: 'Pay under $120 in fees per 1,000 AURA', why: 'Fees ÷ the trading AURA this volume and your open positions should earn. Holding longer lowers it: open positions earn by the hour with no fees.', bench: `Taker fee 3.5 bps; week ${REF.week}, quick round trips: about $${Math.round((0.00035 / (REF.taker * BULK_CREDIT)) * 1000)} per 1,000 AURA`, unit: 'usd', cmp: 'lte', target: 120 },
  { id: 'bQualify', label: '$10K+ volume to qualify for leagues', why: 'Bulk only ranks you in the trading league after $10,000 of volume.', bench: 'Bulk’s threshold: $10,000', unit: 'usd', cmp: 'gte', target: 10000 },
  { id: 'bBreakeven', label: 'Break even or better', why: 'Realised PnL + funding − fees. AURA is only worth it if the trading doesn’t bleed.', bench: 'PnL counts once a position fully closes', unit: 'usd', cmp: 'gte', target: 0 },
];

function bulkTips(perDollar, oiRate, mine) {
  const r = (perDollar * 1000).toFixed(2);
  const o = (oiRate * 24 * 1000).toFixed(2);
  const a5 = REF.taker / BULK_FORMULA['mainnet-week4-v2'].taker - 1;
  const b5 = REF.oiHour / BULK_FORMULA['mainnet-week4-v2'].oiHour - 1;
  const pc = (x) => `${Math.abs(Math.round(x * 100))}%`;
  return [
    { icon: 'sigma', title: 'The formula', body: `AURA ≈ ${r} per $1,000 of taker volume + ${o} per $1,000 open for a day (${mine ? 'your rates this week' : 'typical rates this week'}). Checked on ${REF.wallets} wallets, it reproduces each one’s trading AURA to within 0.5%.` },
    { icon: 'hourglass', title: 'Hold longer, earn more per dollar', body: `Every hour a position is open earns AURA on its size, cutoff or not, so a round trip earns more the longer it stays open: about +${(BULK_HOLD.perHour * 100).toFixed(2)}% an hour at week ${REF.week}’s rates (1 day ${refMult(24)}×, 2 days ${refMult(48)}×, a week ${refMult(168)}×), with no cap.` },
    { icon: 'swap', title: 'Only taker fills count', body: 'Maker fills earn no trading AURA; they go to Bulk’s maker pool (100K AURA a week, shared mostly by market makers). For trading AURA, take liquidity.' },
    { icon: 'repeat', title: 'Hold a core, rotate on top', body: `$10K held all week earns about ${Math.round(REF.oiHour * 10000 * 168)} AURA at week ${REF.week}’s rates, as much as $${Math.round((10 * REF.oiHour * 168) / REF.taker)}K more taker volume, without its fees. Keep a core hedged position open and do your round trips on top of it.` },
    { icon: 'coins', title: 'What doesn’t matter', body: 'Which market (BTC earns the same as alts), fill size and how many trades you make: only taker volume and the hours your positions stay open count. Trade where the spread is tightest.' },
    { icon: 'chart', title: 'The rate moves every week', body: `Bulk shares out fixed weekly amounts, so a quiet week pays more per dollar. Week ${REF.week} paid ${pc(a5)} ${a5 >= 0 ? 'more' : 'less'} per dollar of taker volume than week 4 and ${pc(b5)} ${b5 >= 0 ? 'more' : 'less'} per hour open.` },
    { icon: 'trophy', title: 'Referrals and leagues', body: 'Referral AURA runs about 25% of what your referrals’ volume earns. The trading league needs $10K+ of volume and ranks by total trading AURA.' },
    { icon: 'clock', title: 'Cutoff', body: 'Each AURA week closes Saturday 12:30 UTC and is revealed at 13:00 UTC. Trades count in the week they happen; open positions earn in every week they’re open.' },
  ];
}


module.exports = {
  edition: 'owner',
  name: 'Measured model',
  bulkEstimate,
  hold: BULK_HOLD, // { perHour }: what an hour open adds to a round trip
  ref: { ...REF, credit: BULK_CREDIT }, // typical rates when your own aren't measured yet
  bulkRules: BULK_RULES,
  bulkTips,
  BULK_FORMULA,
  BULK_LATEST,
  BULK_CREDIT,
  BULK_VOL_ERR,
};
