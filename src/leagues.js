'use strict';

// Bulk's Challenger Series (season 1, from Saturday 17 Oct 2026). Every AURA Saturday Bulk pays
// 12.5% of its net fees to the top trading leagues:
//   Challenger  top 25                     45%
//   Diamond     ranks 26-100               25%
//   Platinum    top 10%  } 30% between them, each Platinum wallet getting
//   Gold        top 25%  } two shares to every Gold wallet's one
//
// Bulk doesn't publish its fees or how a league's share is divided between its wallets, so:
//   pool        12.5% x Bulk's volume this AURA week (its public candles, projected to the cutoff)
//               x the net fee rate (3.5 bps: Bulk's taker fee; makers pay nothing)
//   per wallet  the league's share split equally between its wallets (Platinum 2:1 Gold)
// Once you've logged what a payout paid you, the fee rate is corrected by how far off the estimate was.

const HOUR = 3600 * 1000;
const WEEK = 7 * 24 * HOUR;
const FIRST_PAYOUT = Date.UTC(2026, 9, 17, 13, 0); // Sat 17 Oct 2026, at the AURA reveal
const POOL_SHARE = 0.125;
const BASE_FEE_BPS = 3.5;
const LEAGUES = [
  { id: 'challenger', name: 'Challenger', share: 0.45 },
  { id: 'diamond', name: 'Diamond', share: 0.25 },
  { id: 'platinum', name: 'Platinum', share: 0.3, weight: 2 },
  { id: 'gold', name: 'Gold', share: 0.3, weight: 1 },
];
// Bulk's trading leaderboard, live, Mon 12 Oct 2026 09:40 UTC. Used until an AURA import is newer.
const SNAPSHOT = {
  at: Date.UTC(2026, 9, 12, 9, 40),
  population: 2211,
  counts: { challenger: 25, diamond: 75, platinum: 122, gold: 331 },
  cutoffs: { challenger: 30638, diamond: 5259, platinum: 1920, gold: 506 },
};

// Wallets per league for a number of qualified traders (Platinum is the top 10%, Gold the top 25%).
function counts(pop) {
  const p10 = Math.floor(pop * 0.1);
  const p25 = Math.floor(pop * 0.25);
  return { challenger: Math.min(25, pop), diamond: Math.max(0, Math.min(100, pop) - 25), platinum: Math.max(0, p10 - 100), gold: Math.max(0, p25 - Math.max(100, p10)) };
}
function ranges(n) {
  let at = 1;
  const out = {};
  for (const l of LEAGUES) {
    out[l.id] = n[l.id] > 0 ? [at, at + n[l.id] - 1] : null;
    at += n[l.id];
  }
  return out;
}
// What one wallet in each league gets from a pool of `pool` dollars.
function perWallet(pool, n) {
  const pg = n.platinum * 2 + n.gold;
  const unit = pg > 0 ? (pool * 0.3) / pg : 0;
  return {
    challenger: n.challenger > 0 ? (pool * 0.45) / n.challenger : 0,
    diamond: n.diamond > 0 ? (pool * 0.25) / n.diamond : 0,
    platinum: unit * 2,
    gold: unit,
  };
}
// The payout after `now` (they start on 17 Oct, then every Saturday at the AURA reveal).
function nextPayout(now) {
  if (now < FIRST_PAYOUT) return FIRST_PAYOUT;
  return FIRST_PAYOUT + Math.ceil((now - FIRST_PAYOUT) / WEEK) * WEEK;
}
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Logged payouts: [{ payoutAt, amount, league, estimated }] (estimated at the base fee rate).
function feeRate(received) {
  const f = median((received || []).filter((r) => r.estimated > 0 && r.amount >= 0).map((r) => r.amount / r.estimated));
  return f == null ? { bps: BASE_FEE_BPS, calibrated: false } : { bps: BASE_FEE_BPS * f, calibrated: true, factor: f };
}

// League numbers: the latest AURA import (after a reveal) if it's newer than the snapshot.
function leagueSource(bulk) {
  const t = bulk && bulk.trading;
  if (t && t.cutoffs && t.cutoffsAt && t.cutoffsAt > SNAPSHOT.at) {
    const pop = t.cutoffPopulation || t.population;
    return { source: 'import', at: t.cutoffsAt, population: pop, counts: counts(pop), cutoffs: t.cutoffs };
  }
  return { source: 'snapshot', ...SNAPSHOT };
}

// bulk: the Points page's Bulk view (league, rank, cutoffs, this week's fees). estimate: Bulk's
// next-drop estimate (Bulk's volume this week, your AURA rate). takerBps: your taker fee.
function computeLeagues({ bulk = null, estimate = null, received = [], takerBps = BASE_FEE_BPS, now = Date.now() } = {}) {
  const src = leagueSource(bulk);
  const n = src.counts;
  const rate = feeRate(received);
  const market = estimate && estimate.market ? estimate.market : null;
  const volume = market && market.projected > 0 ? market.projected : null;
  const fees = volume != null ? (volume * rate.bps) / 1e4 : null;
  const pool = fees != null ? fees * POOL_SHARE : null;
  const each = pool != null ? perWallet(pool, n) : null;
  const rg = ranges(n);
  const leagues = LEAGUES.map((l) => ({ id: l.id, name: l.name, share: l.share, weight: l.weight || null, wallets: n[l.id], ranks: rg[l.id], each: each ? each[l.id] : null, cutoff: src.cutoffs[l.id] != null ? src.cutoffs[l.id] : null }));

  // You.
  const t = bulk && bulk.trading;
  let you = null;
  if (t && t.league) {
    const id = String(t.league).toLowerCase();
    const mine = leagues.find((l) => l.id === id) || null;
    const v = estimate && estimate.volume ? estimate.volume : null;
    const feesSoFar = bulk.current ? bulk.current.fees : null;
    const feesWeek = feesSoFar != null && v && v.soFar > 0 ? feesSoFar * (v.projected / v.soFar) : feesSoFar;
    const share = mine ? mine.each : 0;
    you = { league: t.league, rank: t.rank, population: t.population, tradingAura: t.aura, inPool: Boolean(mine), each: share, feesWeek, covers: share != null && feesWeek > 0 ? share / feesWeek : null };
    // The next league up, and what reaching it takes at your AURA rate and fee.
    const order = ['gold', 'platinum', 'diamond', 'challenger'];
    const i = order.indexOf(id);
    const nextId = i === -1 ? 'gold' : order[i + 1];
    const next = nextId ? leagues.find((l) => l.id === nextId) : null;
    if (next && next.cutoff != null) {
      const need = Math.max(0, next.cutoff - t.aura);
      const week = estimate && estimate.points ? Math.max(0, estimate.points.projected || 0) : 0;
      const gap = Math.max(0, need - week);
      const perDollar = estimate && estimate.perDollar > 0 ? estimate.perDollar : null;
      const vol = perDollar ? gap / perDollar : null;
      you.next = { league: next.name, cutoff: next.cutoff, need, week, gap, volume: vol, fees: vol != null ? (vol * (takerBps || BASE_FEE_BPS)) / 1e4 : null, extra: next.each != null ? next.each - (share || 0) : null };
    }
  }

  return {
    now,
    payAt: nextPayout(now),
    firstPayout: FIRST_PAYOUT,
    poolShare: POOL_SHARE,
    feeBps: rate.bps,
    calibrated: rate.calibrated,
    volume,
    volumeSoFar: market ? market.soFar : null,
    fees,
    pool,
    population: src.population,
    leagues,
    source: { kind: src.source, at: src.at },
    you,
    received: (received || []).slice().sort((a, b) => b.payoutAt - a.payoutAt),
  };
}

// What the payout at `payoutAt` should have paid one wallet in `league` at the base fee rate, from
// Bulk's volume over the AURA week before it (hours: Bulk's hourly volume, { hourTs: usd }).
function estimateFor(payoutAt, league, hours, bulk) {
  const end = payoutAt - 30 * 60 * 1000; // the week closes half an hour before the reveal
  const start = end - WEEK;
  let vol = 0;
  for (const [k, usd] of Object.entries(hours || {})) {
    const ts = Number(k);
    const ov = Math.min(ts + HOUR, end) - Math.max(ts, start);
    if (ov > 0) vol += (usd * ov) / HOUR;
  }
  if (!(vol > 0)) return null;
  const n = leagueSource(bulk).counts;
  const each = perWallet((vol * BASE_FEE_BPS * POOL_SHARE) / 1e4, n);
  return each[String(league || '').toLowerCase()] || null;
}

function cleanReceived(list) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && Number.isFinite(Number(r.payoutAt)) && Number.isFinite(Number(r.amount)) && Number(r.amount) >= 0)
    .map((r) => ({ payoutAt: Number(r.payoutAt), amount: Number(r.amount), league: typeof r.league === 'string' ? r.league.slice(0, 20) : null, estimated: Number.isFinite(Number(r.estimated)) ? Number(r.estimated) : null }))
    .slice(-104);
}

module.exports = { computeLeagues, estimateFor, cleanReceived, counts, perWallet, nextPayout, feeRate, SNAPSHOT, FIRST_PAYOUT, POOL_SHARE, BASE_FEE_BPS, LEAGUES };
