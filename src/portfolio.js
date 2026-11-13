'use strict';

// Portfolio: your balance on every exchange and in total, what's changed since you deposited and
// where it went, and the total over time.
//
// Balance       each exchange's own account value (Bulk: all lanes including isolated positions;
//               Arcus: equity per sub-account; Hyperliquid: the account value Entropy trades from).
// Since deposit balance minus net deposits. Bulk: deposits and withdrawals from its account history.
//               Arcus: its net-deposits figure. Hyperliquid: its own all-time PnL for the account.
// Where it went fees, funding and price PnL from your trades (what the tracker has on record).
// Live          while the Pulse portfolio is open, account values are re-read about every 10 seconds
//               (one to three small requests per exchange), separately from the full sync.
// History       a reading of every exchange's balance at most every 5 minutes, kept for 30 days in
//               data/balances.json (every 30 minutes after the first 2 days).

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./store');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LIVE_EVERY = 8 * 1000;
const RECORD_EVERY = 5 * MIN;

class BalanceBook {
  constructor(dir) {
    this.file = path.join(dir, 'balances.json');
    this.points = []; // [ts, bulk, arcus, entropy] (null where unknown)
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s && s.v === 1 && Array.isArray(s.points)) this.points = s.points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]));
    } catch {
      // first run
    }
  }

  // values: { bulk, arcus, entropy } (numbers or null). Saved at most every 5 minutes.
  record(ts, values, force = false) {
    const last = this.points[this.points.length - 1];
    if (!force && last && ts - last[0] < RECORD_EVERY) return false;
    const row = [ts, values.bulk ?? null, values.arcus ?? null, values.entropy ?? null];
    if (row.slice(1).every((v) => v == null)) return false;
    this.points.push(row);
    this.thin(ts);
    try {
      writeJsonAtomic(this.file, { v: 1, points: this.points });
    } catch (e) {
      console.error(`Couldn't save balances: ${e.message}`);
    }
    return true;
  }

  // Keep 30 days: every reading for 2 days, then one per 30 minutes.
  thin(now) {
    const out = [];
    let slot = null;
    for (const p of this.points) {
      if (p[0] < now - 30 * DAY) continue;
      if (p[0] >= now - 2 * DAY) {
        out.push(p);
        continue;
      }
      const s = Math.floor(p[0] / (30 * MIN));
      if (s !== slot) out.push(p);
      slot = s;
    }
    this.points = out;
  }
}

// ---------- live account values ----------
class LiveBalances {
  constructor() {
    this.values = {}; // "<exchange>:<address>" -> { equity, available, upnl, netDeposits?, pnlAll?, at }
    this.errors = {};
    this.at = 0;
    this.running = null;
  }

  // Refresh if older than 8 seconds. Resolves when done.
  refresh(exchanges, wallets, store, http) {
    if (this.running) return this.running;
    if (Date.now() - this.at < LIVE_EVERY) return Promise.resolve();
    this.running = (async () => {
      await Promise.all(
        exchanges
          .filter((ex) => typeof ex.balance === 'function')
          .map(async (ex) => {
            for (const w of wallets[ex.id] || []) {
              const key = `${ex.id}:${w.address}`;
              try {
                const v = await ex.balance(w, store.get(ex.id, w.address), { http });
                if (v && Number.isFinite(v.equity)) this.values[key] = { ...v, at: Date.now() };
                delete this.errors[key];
              } catch (e) {
                this.errors[key] = e.message;
              }
            }
          })
      );
      this.at = Date.now();
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}

// ---------- view ----------
function computePortfolio(prepared, live, book, now) {
  const exchanges = prepared.exchanges
    .filter((e) => e.wallets.length)
    .map((e) => {
      let equity = 0;
      let haveEquity = false;
      let available = null;
      let upnl = 0;
      let netDeposits = 0;
      let haveDeposits = true;
      let result = 0;
      let at = 0;
      let isLive = true;
      const lifetime = { fees: 0, funding: 0, realised: 0 };
      for (const w of e.wallets) {
        const lv = live && live.values[`${e.id}:${w.address}`];
        const fresh = lv && (!w.syncedAt || lv.at >= w.syncedAt - 60 * 1000);
        const eq = fresh ? lv.equity : w.equity;
        if (Number.isFinite(eq)) {
          equity += eq;
          haveEquity = true;
        }
        if (fresh && Number.isFinite(lv.available)) available = (available || 0) + lv.available;
        upnl += fresh && Number.isFinite(lv.upnl) ? lv.upnl : w.positions.reduce((a, p) => a + (p.upnl || 0), 0);
        at = Math.max(at, fresh ? lv.at : w.syncedAt || 0);
        if (!fresh) isLive = false;

        // Net deposits and the change since: each exchange's own numbers where it has them.
        if (e.id === 'entropy') {
          const pnl = fresh && Number.isFinite(lv.pnlAll) ? lv.pnlAll : w.pnlAll;
          if (Number.isFinite(pnl) && Number.isFinite(eq)) {
            result += pnl;
            netDeposits += eq - pnl;
          } else haveDeposits = false;
        } else {
          const nd = e.id === 'arcus' ? (fresh && Number.isFinite(lv.netDeposits) ? lv.netDeposits : w.netDeposits) : w.transfers.reduce((a, t) => a + (t.dir === 'in' ? t.amt : t.dir === 'out' ? -t.amt : 0), 0);
          if (Number.isFinite(nd) && Number.isFinite(eq) && (e.id === 'arcus' || w.transfers.length)) {
            netDeposits += nd;
            result += eq - nd;
          } else haveDeposits = false;
        }

        for (const f of w.rich) lifetime.fees += f.fee;
        for (const x of w.funding) lifetime.funding += x.amt;
        for (const x of w.pnlEvents) lifetime.realised += x.amt;
      }
      return {
        id: e.id,
        name: e.name,
        wallets: e.wallets.length,
        equity: haveEquity ? equity : null,
        available,
        upnl,
        netDeposits: haveDeposits ? netDeposits : null,
        result: haveDeposits && haveEquity ? result : null,
        lifetime,
        at: at || null,
        live: isLive,
      };
    });

  const known = exchanges.filter((x) => x.equity != null);
  const total = known.reduce((a, x) => a + x.equity, 0);
  const withResult = exchanges.filter((x) => x.result != null);
  const result = withResult.reduce((a, x) => a + x.result, 0);
  const deposits = withResult.reduce((a, x) => a + x.netDeposits, 0);
  const sum = (k) => exchanges.reduce((a, x) => a + x.lifetime[k], 0);
  const fees = sum('fees');
  const funding = sum('funding');
  const realised = sum('realised');
  const upnl = exchanges.reduce((a, x) => a + (x.upnl || 0), 0);
  const explained = realised + upnl + funding - fees;

  // Balance over time: the total at each reading (only readings where every exchange is known).
  const ids = ['bulk', 'arcus', 'entropy'];
  const want = exchanges.filter((x) => x.equity != null).map((x) => ids.indexOf(x.id) + 1);
  const series = (book ? book.points : [])
    .filter((p) => p[0] >= now - 7 * DAY && want.every((i) => p[i] != null))
    .map((p) => [p[0], want.reduce((a, i) => a + p[i], 0)]);
  if (known.length) series.push([now, total]);
  const ago = (ms) => {
    const cut = now - ms;
    const hit = series.find((p) => p[0] >= cut - 10 * MIN);
    return hit && hit[0] <= cut + 30 * MIN ? hit[1] : null;
  };
  const d1 = ago(DAY);
  const d7 = ago(7 * DAY);

  return {
    now,
    asOf: Math.max(0, ...exchanges.map((x) => x.at || 0)) || null,
    live: exchanges.length > 0 && exchanges.every((x) => x.live),
    total: {
      equity: known.length ? total : null,
      available: exchanges.some((x) => x.available != null) ? exchanges.reduce((a, x) => a + (x.available || 0), 0) : null,
      upnl,
      deposits: withResult.length ? deposits : null,
      result: withResult.length ? result : null,
      resultPct: withResult.length && deposits > 0 ? result / deposits : null,
      partial: withResult.length < exchanges.length,
      change24h: d1 != null && known.length ? total - d1 : null,
      change7d: d7 != null && known.length ? total - d7 : null,
    },
    exchanges,
    breakdown: {
      fees,
      funding,
      realised,
      upnl,
      // What the tracked trades don't account for (trades from other apps on Hyperliquid, history
      // older than the exchanges serve, rounding).
      other: withResult.length === exchanges.length ? result - explained : null,
    },
    history: { points: series, since: series.length ? series[0][0] : null },
    errors: live ? live.errors : {},
  };
}

module.exports = { BalanceBook, LiveBalances, computePortfolio };
