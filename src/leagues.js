'use strict';

// Bulk's Challenger Series, season 1 (docs.bulk.trade, The Challenger Series).
//
//   Weeks        Saturday to Saturday. League cash is paid at each AURA reveal, 17 Oct to 5 Dec
//                (8 weeks); the top regular-season traders then go to the Playoffs (separate prize
//                pool, format announced before 5 Dec).
//   Pool         12.5% of Bulk's net revenue (trading fees minus maker rebates), in USDC.
//   Leagues      by trading AURA rank (gauntlets included; referral and other AURA don't count;
//                $10K+ of volume to qualify). Bulk's docs (checked 25 Nov) say "only Trading AURA
//                earned during the current week", but its league data still places wallets by
//                cumulative trading AURA ("cumulative_aura", and cutoffs like 50,171 for Challenger
//                that one week's 1M AURA couldn't reach), so the tracker follows the data:
//                  Challenger  top 25                45%  (+ Playoffs qualification)
//                  Diamond     ranks 26-100          25%
//                  Platinum    rank 101 to top 10%   } 30% between them; Platinum averages 2x Gold
//                  Gold        down to top 25%       }
//                  Silver, Bronze                    nothing
//   Split        within each league, pro-rata by trading AURA.
//   Claims       $5 minimum; smaller rewards stay on your balance until they reach it.
//   Not eligible market makers; wash-trading and Sybil accounts are excluded.
//
// Bulk doesn't publish its weekly fees or each league's total AURA, so:
//   pool         12.5% x Bulk's volume this AURA week (its public candles, projected to the cutoff)
//                x its net fee per dollar: 3.0 bps on crypto markets, 1.4 bps on TradFi (stocks,
//                ETFs, indices at 1.5 bps taker), corrected from the payouts you log
//   league AURA  each league's wallets x a typical wallet's AURA between its cutoffs (log-uniform:
//                more wallets near the bottom of the band than the top)

const markets = require('./markets');

const HOUR = 3600 * 1000;
const WEEK = 7 * 24 * HOUR;
const FIRST_PAYOUT = Date.UTC(2026, 9, 17, 13, 0); // Sat 17 Oct 2026, at the AURA reveal
const SEASON_WEEKS = 8;
const LAST_PAYOUT = FIRST_PAYOUT + (SEASON_WEEKS - 1) * WEEK; // Sat 5 Dec 2026
const POOL_SHARE = 0.125;
const MIN_CLAIM = 5;
const BASE_FEE_BPS = markets.NET_BPS.crypto; // the payout estimates you log are measured against this
const LEAGUES = [
  { id: 'challenger', name: 'Challenger', share: 0.45 },
  { id: 'diamond', name: 'Diamond', share: 0.25 },
  { id: 'platinum', name: 'Platinum', share: 0.3, weight: 2 },
  { id: 'gold', name: 'Gold', share: 0.3, weight: 1 },
];
const ORDER = ['gold', 'platinum', 'diamond', 'challenger'];
// Bulk's trading leaderboard, Mon 12 Oct 2026 09:40 UTC. Used until an AURA import is newer.
const SNAPSHOT = {
  at: Date.UTC(2026, 9, 12, 9, 40),
  population: 2211,
  cutoffs: { challenger: 30638, diamond: 5259, platinum: 1920, gold: 506 },
};
const STALE = 8 * 24 * HOUR; // cutoffs older than a week and a day: ask for a fresh AURA import
const CHALLENGER_SPAN = 5; // the top wallet's AURA, as a multiple of the Challenger cutoff (for its band)

// Wallets per league for a number of qualified traders (Platinum to the top 10%, Gold the top 25%).
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
// Each league's part of the pool (Platinum and Gold share 30%, a Platinum wallet averaging twice a
// Gold one).
function pots(pool, n) {
  const pg = n.platinum * 2 + n.gold;
  return {
    challenger: pool * 0.45,
    diamond: pool * 0.25,
    platinum: pg > 0 ? (pool * 0.3 * n.platinum * 2) / pg : 0,
    gold: pg > 0 ? (pool * 0.3 * n.gold) / pg : 0,
  };
}
// A typical wallet's trading AURA in each league, from the cutoffs (the mean of a log-uniform band).
function bandMeans(cutoffs) {
  const band = (lo, hi) => (lo > 0 && hi > lo ? (hi - lo) / Math.log(hi / lo) : lo > 0 ? lo : null);
  const c = cutoffs || {};
  return {
    challenger: c.challenger > 0 ? band(c.challenger, c.challenger * CHALLENGER_SPAN) : null,
    diamond: band(c.diamond, c.challenger),
    platinum: band(c.platinum, c.diamond),
    gold: band(c.gold, c.platinum),
  };
}
// The payout after `now` this season, or null once the regular season is over.
function nextPayout(now) {
  if (now < FIRST_PAYOUT) return FIRST_PAYOUT;
  const t = FIRST_PAYOUT + Math.ceil((now - FIRST_PAYOUT) / WEEK) * WEEK;
  return t <= LAST_PAYOUT ? t : null;
}
const seasonWeek = (payAt) => (payAt ? Math.round((payAt - FIRST_PAYOUT) / WEEK) + 1 : null);
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Logged payouts: [{ payoutAt, amount, league, estimated }] (estimated at the base fee rate).
function feeFactor(received) {
  const f = median((received || []).filter((r) => r.estimated > 0 && r.amount >= 0).map((r) => r.amount / r.estimated));
  return f == null ? { factor: 1, calibrated: false } : { factor: f, calibrated: true };
}

// League sizes and cutoffs: the newest of the snapshot, your AURA import's (after a reveal) and the
// ones every dashboard shares (anyone's import, or the admin), with the trader count from your live
// trading league when that's newer still.
function leagueSource(bulk, shared) {
  const t = bulk && bulk.trading;
  let src = { source: 'snapshot', ...SNAPSHOT };
  if (t && t.cutoffs && t.cutoffsAt && t.cutoffsAt > src.at) src = { source: 'import', at: t.cutoffsAt, population: t.cutoffPopulation || t.population, cutoffs: t.cutoffs };
  if (shared && shared.cutoffs && shared.at > src.at) src = { source: shared.source === 'admin' ? 'admin' : 'shared', at: shared.at, population: shared.population || src.population, cutoffs: shared.cutoffs };
  const pop = t && t.population > 0 && bulk.dataAt && bulk.dataAt > src.at ? t.population : src.population;
  return { ...src, population: pop, counts: counts(pop) };
}

// Bulk's net fees per dollar this week, from the share traded on TradFi markets.
function netBps(tradShare) {
  const s = tradShare && Number.isFinite(tradShare.share) ? Math.max(0, Math.min(1, tradShare.share)) : 0;
  return markets.NET_BPS.crypto * (1 - s) + markets.NET_BPS.tradfi * s;
}

// What one wallet with `aura` trading AURA gets in league `id` from a pool of `pool` dollars.
function shareOf(id, aura, pool, n, means) {
  const pot = pots(pool, n)[id];
  if (!(pot > 0) || !(n[id] > 0)) return 0;
  const total = means[id] > 0 ? n[id] * means[id] : null;
  if (!(aura > 0) || !total) return pot / n[id]; // no AURA figures: the league average
  return (pot * aura) / Math.max(total, aura);
}
// The league `aura` trading AURA reaches with these cutoffs (null below Gold).
function leagueAt(aura, cutoffs) {
  for (const id of ['challenger', 'diamond', 'platinum', 'gold']) if (cutoffs[id] != null && aura >= cutoffs[id]) return id;
  return null;
}

// bulk: the Points page's Bulk view (league, rank, cutoffs, this week's fees). estimate: Bulk's
// next-drop estimate (Bulk's volume this week, your AURA rate). tradShare: the TradFi share of
// Bulk's volume this week. takerBps: your taker fee.
// market: Bulk's volume this week straight from its hourly candles ({ soFar, projected }), used when
// the estimate has none. gauntletAura: what this week's gauntlet should add to your trading AURA.
// shared: the league cutoffs every dashboard shares.
function computeLeagues({ bulk = null, estimate = null, received = [], takerBps = 3.5, tradShare = null, market: marketVol = null, gauntletAura = 0, shared = null, now = Date.now() } = {}) {
  const src = leagueSource(bulk, shared);
  const n = src.counts;
  const means = bandMeans(src.cutoffs);
  const cal = feeFactor(received);
  const bps = netBps(tradShare) * cal.factor;
  const payAt = nextPayout(now);
  const market = estimate && estimate.market && estimate.market.projected > 0 ? estimate.market : marketVol && marketVol.projected > 0 ? marketVol : null;
  const volume = market && market.projected > 0 ? market.projected : null;
  const fees = payAt && volume != null ? (volume * bps) / 1e4 : null;
  const pool = fees != null ? fees * POOL_SHARE : null;
  const p = pool != null ? pots(pool, n) : null;
  const pgW = n.platinum * 2 + n.gold;
  const rg = ranges(n);
  const leagues = LEAGUES.map((l) => ({
    id: l.id,
    name: l.name,
    share: l.share,
    weight: l.weight || null,
    potShare: l.weight ? (pgW > 0 ? (0.3 * l.weight * n[l.id]) / pgW : 0) : l.share, // this league's part of the pool
    wallets: n[l.id],
    ranks: rg[l.id],
    pot: p ? p[l.id] : null,
    each: p && n[l.id] > 0 ? p[l.id] / n[l.id] : null, // the league average (each wallet's share follows its AURA)
    typicalAura: means[l.id] != null ? Math.round(means[l.id]) : null,
    cutoff: src.cutoffs[l.id] != null ? src.cutoffs[l.id] : null,
  }));

  // You: trading AURA at the end of this week (revealed so far, revealed weeks not imported yet,
  // and this week's estimate), the league that puts you in, and your pro-rata share.
  const t = bulk && bulk.trading;
  let you = null;
  if (t && t.aura != null) {
    const week = estimate && estimate.points ? Math.max(0, estimate.points.projected || 0) : 0;
    const pending = bulk.pendingExpected > 0 ? bulk.pendingExpected : 0;
    const gauntlet = gauntletAura > 0 ? gauntletAura : 0;
    const endAura = t.aura + pending + week + gauntlet;
    const projId = t.qualified === false ? null : leagueAt(endAura, src.cutoffs);
    const mine = projId ? leagues.find((l) => l.id === projId) : null;
    const share = mine ? (pool != null ? shareOf(projId, endAura, pool, n, means) : null) : 0;
    const v = estimate && estimate.volume ? estimate.volume : null;
    const feesSoFar = bulk.current ? bulk.current.fees : null;
    const feesWeek = feesSoFar != null && v && v.soFar > 0 ? feesSoFar * (v.projected / v.soFar) : feesSoFar;
    you = {
      league: t.league, // at the last reveal
      rank: t.rank,
      population: t.population,
      qualified: t.qualified !== false,
      threshold: t.threshold,
      tradingAura: t.aura,
      pending,
      week,
      gauntlet,
      endAura,
      projected: mine ? mine.name : null,
      projectedId: projId,
      inPool: Boolean(mine),
      each: share,
      vsAverage: mine && mine.each > 0 && share != null ? share / mine.each : null,
      belowMin: share != null && share > 0 && share < MIN_CLAIM,
      feesWeek,
      covers: share != null && feesWeek > 0 ? share / feesWeek : null,
    };
    // The next league up, and what reaching it takes at your AURA rate and fee.
    const i = ORDER.indexOf(projId);
    const nextId = projId == null ? 'gold' : ORDER[i + 1];
    const next = nextId ? leagues.find((l) => l.id === nextId) : null;
    if (next && next.cutoff != null) {
      const gap = Math.max(0, next.cutoff - endAura);
      const perDollar = estimate && estimate.perDollar > 0 ? estimate.perDollar : null;
      const vol = perDollar ? gap / perDollar : null;
      const there = pool != null ? shareOf(next.id, Math.max(endAura, next.cutoff), pool, n, means) : null;
      you.next = { league: next.name, id: next.id, cutoff: next.cutoff, need: Math.max(0, next.cutoff - t.aura - pending), week: week + gauntlet, gap, volume: vol, fees: vol != null ? (vol * (takerBps || 3.5)) / 1e4 : null, extra: there != null ? there - (share || 0) : null };
    }
  }

  return {
    now,
    payAt,
    week: seasonWeek(payAt),
    seasonWeeks: SEASON_WEEKS,
    firstPayout: FIRST_PAYOUT,
    lastPayout: LAST_PAYOUT,
    seasonOver: payAt == null && now > LAST_PAYOUT,
    poolShare: POOL_SHARE,
    minClaim: MIN_CLAIM,
    feeBps: bps,
    netBps: { crypto: markets.NET_BPS.crypto * cal.factor, tradfi: markets.NET_BPS.tradfi * cal.factor },
    tradShare: tradShare && Number.isFinite(tradShare.share) ? tradShare.share : null,
    calibrated: cal.calibrated,
    volume,
    volumeSoFar: market ? market.soFar : null,
    fees,
    pool,
    population: src.population,
    leagues,
    source: { kind: src.source, at: src.at, stale: now - src.at > STALE },
    you,
    received: (received || []).slice().sort((a, b) => b.payoutAt - a.payoutAt),
  };
}

// What the payout at `payoutAt` should have paid you in `league` at the base fee rate, from Bulk's
// volume over the AURA week before it (hours: Bulk's hourly volume, { hourTs: usd }).
function estimateFor(payoutAt, league, hours, bulk, shared) {
  const end = payoutAt - 30 * 60 * 1000; // the week closes half an hour before the reveal
  const start = end - WEEK;
  let vol = 0;
  for (const [k, usd] of Object.entries(hours || {})) {
    const ts = Number(k);
    const ov = Math.min(ts + HOUR, end) - Math.max(ts, start);
    if (ov > 0) vol += (usd * ov) / HOUR;
  }
  if (!(vol > 0)) return null;
  const src = leagueSource(bulk, shared);
  const id = String(league || '').toLowerCase();
  const t = bulk && bulk.trading;
  const aura = t && t.aura > 0 ? t.aura : null;
  return shareOf(id, aura, (vol * BASE_FEE_BPS * POOL_SHARE) / 1e4, src.counts, bandMeans(src.cutoffs)) || null;
}

function cleanReceived(list) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && Number.isFinite(Number(r.payoutAt)) && Number.isFinite(Number(r.amount)) && Number(r.amount) >= 0)
    .map((r) => ({ payoutAt: Number(r.payoutAt), amount: Number(r.amount), league: typeof r.league === 'string' ? r.league.slice(0, 20) : null, estimated: Number.isFinite(Number(r.estimated)) ? Number(r.estimated) : null }))
    .slice(-104);
}

module.exports = { computeLeagues, estimateFor, cleanReceived, counts, pots, bandMeans, shareOf, leagueAt, leagueSource, nextPayout, seasonWeek, feeFactor, netBps, SNAPSHOT, FIRST_PAYOUT, LAST_PAYOUT, SEASON_WEEKS, POOL_SHARE, MIN_CLAIM, BASE_FEE_BPS, LEAGUES };
