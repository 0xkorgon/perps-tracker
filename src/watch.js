'use strict';

// Risk watch: current mark prices and funding rates for the markets you hold, read more often than
// the full sync (every 30 seconds while any leg is within 15% of liquidation, otherwise every 2
// minutes). Used to keep liquidation distances fresh, fire alerts in time, and show what each hedge
// earns or pays in funding right now.
//
// Bulk         GET  /api/v1/ticker/<symbol>      markPrice, fundingRate (hourly), one per market held
// Arcus        GET  /v1/markets                  markPrice, fundingRate (hourly), all markets at once
// Hyperliquid  POST info {metaAndAssetCtxs, dex} markPx, funding (hourly), one per dex held

const { num } = require('./util');

const BULK = process.env.PERPS_BULK_API || 'https://mainnet-api1.bulk.trade/api/v1';
const ARCUS = process.env.PERPS_ARCUS_API || 'https://api.arcus.xyz';
const HL = process.env.PERPS_HL_API || 'https://api.hyperliquid.xyz/info';

const FAST = 30 * 1000;
const SLOW = 2 * 60 * 1000;
const NEAR = 0.15;
// Taker fee guesses when your own fills don't say (bps of notional).
const DEFAULT_TAKER_BPS = { bulk: 3.5, arcus: 2.25, entropy: 4.5 };

const dexOf = (coin) => (coin && coin.includes(':') ? coin.slice(0, coin.indexOf(':')) : '');

function liqDistance(size, mark, liq) {
  if (!(liq > 0) || !(mark > 0)) return null;
  return Math.max(0, size > 0 ? (mark - liq) / mark : (liq - mark) / mark);
}

class MarketWatch {
  constructor() {
    this.marks = {}; // "<exchange>|<mkt>" -> { mark, funding (per hour, fraction), at }
    this.at = 0;
    this.errors = {};
    this.running = false;
  }

  // How long until the next check, given how close the nearest leg is.
  interval(hedges) {
    const near = (hedges || []).some((g) => g.legs.some((l) => l.liqDist != null && l.liqDist < NEAR));
    return near ? FAST : SLOW;
  }

  async tick(http, positions) {
    if (this.running) return;
    this.running = true;
    const errors = {};
    try {
      const held = { bulk: new Set(), arcus: new Set(), entropy: new Map() };
      for (const p of positions || []) {
        if (p.exchange === 'bulk') held.bulk.add(p.mkt);
        else if (p.exchange === 'arcus') held.arcus.add(p.mkt);
        else if (p.exchange === 'entropy') held.entropy.set(p.mkt, p.coin || p.mkt);
      }
      const now = Date.now();
      const jobs = [];
      if (held.arcus.size) {
        jobs.push(
          http
            .get(`${ARCUS}/v1/markets`, { retries: 1 })
            .then((res) => {
              for (const m of (res && res.markets) || []) {
                if (!held.arcus.has(m.marketDisplayName)) continue;
                this.marks[`arcus|${m.marketDisplayName}`] = { mark: num(m.markPrice), funding: num(m.fundingRate), at: now };
              }
            })
            .catch((e) => (errors.arcus = e.message))
        );
      }
      for (const sym of held.bulk) {
        jobs.push(
          http
            .get(`${BULK}/ticker/${encodeURIComponent(sym)}`, { retries: 1 })
            .then((t) => {
              if (t && t.markPrice != null) this.marks[`bulk|${sym}`] = { mark: num(t.markPrice), funding: num(t.fundingRate), at: now };
            })
            .catch((e) => (errors.bulk = e.message))
        );
      }
      if (held.entropy.size) {
        // Display name -> Hyperliquid coin. Older cached positions don't carry the coin, so names
        // without a dex are looked up in the main list first and then Entropy's own ("io").
        const byDex = new Map();
        for (const [mkt, coin] of held.entropy) {
          const dex = dexOf(coin);
          if (!byDex.has(dex)) byDex.set(dex, []);
          byDex.get(dex).push({ mkt, coin });
        }
        if (byDex.has('') && !byDex.has('io')) byDex.set('io', []);
        jobs.push(
          (async () => {
            const found = new Set();
            for (const [dex, want] of byDex) {
              const res = await http.post(HL, dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }, { retries: 1 });
              const [meta, ctxs] = Array.isArray(res) ? res : [];
              const universe = (meta && meta.universe) || [];
              const wanted = dex === 'io' ? [...want, ...[...held.entropy].filter(([, c]) => !dexOf(c)).map(([mkt]) => ({ mkt, coin: `io:${mkt}` }))] : want;
              universe.forEach((u, i) => {
                const c = ctxs && ctxs[i];
                if (!c) return;
                for (const w of wanted) {
                  if (found.has(w.mkt)) continue;
                  if (u.name === w.coin || (!dex && u.name === w.mkt)) {
                    this.marks[`entropy|${w.mkt}`] = { mark: num(c.markPx), funding: num(c.funding), at: now };
                    found.add(w.mkt);
                  }
                }
              });
            }
          })().catch((e) => (errors.entropy = e.message))
        );
      }
      await Promise.all(jobs);
      // Forget markets no longer held.
      const keep = new Set((positions || []).map((p) => `${p.exchange}|${p.mkt}`));
      for (const k of Object.keys(this.marks)) if (!keep.has(k)) delete this.marks[k];
      this.at = now;
      this.errors = errors;
    } finally {
      this.running = false;
    }
  }

  // Hedges with fresh marks (distance to liquidation) and funding now, per leg and per group.
  // takerBps: { bulk, arcus, entropy } your effective taker fee, for what a swap would cost.
  fresh(hedges, takerBps = {}) {
    const fee = (ex) => (Number.isFinite(takerBps[ex]) ? takerBps[ex] : DEFAULT_TAKER_BPS[ex] || 4) / 1e4;
    return (hedges || []).map((g) => {
      const legs = g.legs.map((l) => {
        const m = this.marks[`${l.exchange}|${l.mkt}`];
        if (!m) return { ...l, fundHour: null, fundRate: null };
        const mark = m.mark > 0 ? m.mark : l.mark;
        const notional = Math.abs(l.size) * mark;
        // Positive rate: longs pay shorts. Received per hour (negative = paid).
        const fundHour = Number.isFinite(m.funding) ? -Math.sign(l.size) * m.funding * notional : null;
        return { ...l, mark, notional, liqDist: liqDistance(l.size, mark, l.liq), fundRate: m.funding, fundHour, markAt: m.at };
      });
      const withDist = legs.filter((l) => l.liqDist != null);
      const nearest = withDist.length ? withDist.reduce((a, l) => (l.liqDist < a.liqDist ? l : a)) : null;
      const known = legs.filter((l) => l.fundHour != null);
      const perDay = known.length === legs.length && legs.length ? known.reduce((a, l) => a + l.fundHour, 0) * 24 : null;
      // Swapping which exchange holds the long and which the short flips every leg's funding.
      let swap = null;
      if (perDay != null && g.status !== 'open' && perDay < -0.01 && new Set(legs.map((l) => l.exchange)).size > 1) {
        const cost = legs.reduce((a, l) => a + 2 * l.notional * fee(l.exchange), 0); // close and reopen every leg
        const gain = -perDay - perDay; // from paying |perDay| to earning |perDay|
        swap = { perDay: -perDay, cost, paybackDays: gain > 0 ? cost / gain : null };
      }
      return {
        ...g,
        legs,
        nearest: nearest ? { exchange: nearest.exchange, mkt: nearest.mkt, dist: nearest.liqDist, est: nearest.liqEst } : g.nearest,
        fundNow: perDay == null ? null : { perDay, perHour: perDay / 24, swap },
      };
    });
  }
}

module.exports = { MarketWatch, liqDistance, DEFAULT_TAKER_BPS };
