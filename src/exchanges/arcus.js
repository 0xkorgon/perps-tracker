'use strict';

// Arcus (app.arcus.xyz) - public, unauthenticated REST endpoints keyed by 0x address.
// History lists are newest-first, 1000 per page, with microsecond timestamps.

const { num, isEvmAddress, sleep } = require('../util');
const { isServerTrouble, serverTroubleText } = require('../http');
const markettime = require('../markettime');

const BASE = process.env.PERPS_ARCUS_API || 'https://api.arcus.xyz';
const PAGE = 1000;
const MIN_US = 100000000000000; // smallest `from` Arcus accepts (epoch µs)
const QUOTE_QUANTUM = 1e-9; // /v1/account/stats reports USD amounts in 1e-9 units
const DAY = 24 * 3600 * 1000;

let marketInfo = null; // { at, categories: { "BTC-USD": "CRYPTO", ... }, mmf: { "BTC-USD": 0.03, ... } }

async function loadMarkets(http) {
  if (marketInfo && Date.now() - marketInfo.at < 6 * 3600 * 1000) return marketInfo;
  try {
    const res = await http.get(`${BASE}/v1/markets`);
    const categories = {};
    const mmf = {};
    for (const m of (res && res.markets) || []) {
      categories[m.marketDisplayName] = m.category || 'CRYPTO';
      if (num(m.maintenanceMarginFraction) > 0) mmf[m.marketDisplayName] = num(m.maintenanceMarginFraction);
      const rth = m.regularTradingHours;
      if (rth && rth.timezone === 'America/New_York' && !rth.isOvernight) markettime.setSession(rth.startSecondsOfDay, rth.endSecondsOfDay);
    }
    marketInfo = { at: Date.now(), categories, mmf };
  } catch (e) {
    if (!marketInfo) marketInfo = { at: 0, categories: {}, mmf: {} };
  }
  return marketInfo;
}

function normFill(f) {
  const acct = String(f.accountIndex == null ? 0 : f.accountIndex);
  const fee = num(f.fee);
  return {
    id: `${acct}:${f.tradeId}:${f.side}`,
    ts: Number(f.createdAt) / 1000,
    tie: Number(f.tradeId) || 0,
    mkt: String(f.marketDisplayName || f.marketId),
    side: f.side === 'BUY' ? 'B' : 'S',
    sz: Math.abs(num(f.size)),
    px: num(f.price),
    fee, // positive = paid
    pnl: num(f.closedPnl) + fee, // Arcus's closedPnl already has the fill's fee taken off; add it back
    role: f.role === 'MAKER' ? 'M' : 'T',
    sp: null,
    eff: f.positionEffect || null,
    liq: f.liquidation ? 1 : 0,
    acct,
  };
}

// Walk a newest-first list backwards in time until `fromUs` (or the beginning).
// Returns true when the walk completed, false if it stopped at the page cap.
async function walkBack(http, path, listKey, timeKey, address, idx, fromUs, onRows, ctx, label) {
  let to = null;
  for (let page = 1; page <= 400; page++) {
    let url = `${BASE}${path}?address=${address}&accountIndex=${idx}&limit=${PAGE}&from=${fromUs || MIN_US}`;
    if (to) url += `&to=${to}`;
    const res = await http.get(url);
    const rows = res && Array.isArray(res[listKey]) ? res[listKey] : null;
    if (!rows) throw new Error(`Unexpected ${label} response from Arcus`);
    onRows(rows);
    if (rows.length < PAGE) return true;
    let minTs = Infinity;
    for (const r of rows) minTs = Math.min(minTs, Number(r[timeKey]));
    // `to` is inclusive, so pages overlap by a microsecond; step past it if we're stuck.
    to = to !== null && minTs >= to ? to - 1 : minTs;
    if (fromUs && to < fromUs) return true;
    ctx.progress(`walking back through Arcus ${label} (${(page * PAGE).toLocaleString()} checked)`);
    await sleep(200); // history pages are rate-limit heavy; stay polite
  }
  return false;
}

async function syncList(http, cache, address, idx, ctx, spec) {
  const key = `${spec.cursor}_${idx}`;
  const map = new Map(cache[spec.field].map((x) => [x.id, x]));
  const fromUs = cache.cursor[key] || null;
  let maxSeen = fromUs || 0;
  const complete = await walkBack(
    http,
    spec.path,
    spec.listKey,
    spec.timeKey,
    address,
    idx,
    fromUs,
    (rows) => {
      for (const r of rows) {
        const n = spec.norm(r, idx);
        if (n) map.set(n.id, n);
        const t = Number(r[spec.timeKey]);
        if (t > maxSeen) maxSeen = t;
      }
      cache[spec.field] = Array.from(map.values());
    },
    ctx,
    spec.label
  );
  // Only move the cursor once the whole gap is filled, so an interrupted sync can't leave holes.
  if (complete && maxSeen) cache.cursor[key] = maxSeen;
}

const LISTS = [
  { field: 'fills', cursor: 'last', path: '/v1/fills', listKey: 'fills', timeKey: 'createdAt', label: 'fills', norm: (r) => normFill(r) },
  {
    field: 'funding',
    cursor: 'fund',
    path: '/v1/funding',
    listKey: 'fundingPayments',
    timeKey: 'time',
    label: 'funding',
    norm: (r, idx) => ({ id: `${idx}:${r.time}:${r.marketId}`, ts: Number(r.time) / 1000, mkt: String(r.marketDisplayName || r.marketId), amt: num(r.payment), acct: String(idx) }),
  },
  {
    field: 'transfers',
    cursor: 'xfer',
    path: '/v1/accountTransferUpdates',
    listKey: 'accountTransferUpdates',
    timeKey: 'createdAt',
    label: 'transfers',
    norm: (r, idx) =>
      r.status && r.status !== 'APPLIED'
        ? null
        : {
            id: `${idx}:${r.id}`,
            ts: Number(r.createdAt) / 1000,
            dir: r.type === 'DEPOSIT' || r.type === 'REFERRAL_CLAIM' ? 'in' : r.type === 'WITHDRAWAL' ? 'out' : 'internal',
            kind: r.type,
            amt: Math.abs(num(r.amount)),
            acct: String(idx),
          },
  },
];

// Arcus doesn't report liquidation prices, so estimate one from its maintenance margin fraction.
// Isolated: the position's own margin + unrealised PnL must stay above maintenance margin.
// Cross: the account's equity (less isolated margin) must cover every cross position's maintenance.
function estimateLiq(p, all, accEquity) {
  if (!p.mmf || !(p.mark > 0)) return null;
  const s = Math.abs(p.size);
  let e0;
  let mmOthers = 0;
  if (p.iso) {
    e0 = p.margin + p.upnl;
  } else {
    if (accEquity == null) return null;
    e0 = accEquity - all.filter((q) => q.iso).reduce((a, q) => a + q.margin, 0);
    mmOthers = all.filter((q) => q !== p && !q.iso).reduce((a, q) => a + (q.mmf || 0) * q.notional, 0);
  }
  const px = p.size > 0 ? (s * p.mark - e0 + mmOthers) / (s * (1 - p.mmf)) : (e0 - mmOthers + s * p.mark) / (s * (1 + p.mmf));
  return Number.isFinite(px) && px > 0 ? px : null;
}

async function sync(wallet, cache, ctx) {
  const http = ctx.http;
  const address = wallet.address.trim().toLowerCase();

  // Cheap call first: fails fast (403) when the address isn't an Arcus account.
  const firstPositions = await http.get(`${BASE}/v1/positions?address=${address}&accountIndex=0`);

  const markets = await loadMarkets(http);
  cache.meta.categories = { ...(cache.meta.categories || {}), ...markets.categories };

  // Arcus supports sub-accounts 0-9; find the ones this wallet actually uses (re-checked daily).
  if (!Array.isArray(cache.meta.indexes) || Date.now() - (cache.meta.indexesAt || 0) > DAY) {
    const indexes = [0];
    for (let i = 1; i <= 9; i++) {
      const r = await http.get(`${BASE}/v1/fills?address=${address}&accountIndex=${i}&limit=1`);
      if (r && Array.isArray(r.fills) && r.fills.length) indexes.push(i);
    }
    cache.meta.indexes = indexes;
    cache.meta.indexesAt = Date.now();
  }

  for (const idx of cache.meta.indexes) {
    for (const spec of LISTS) await syncList(http, cache, address, idx, ctx, spec);
  }

  // Open positions and equity for every sub-account in use.
  const positions = [];
  let equity = 0;
  let netDeposits = 0;
  for (const idx of cache.meta.indexes) {
    const res = idx === 0 ? firstPositions : await http.get(`${BASE}/v1/positions?address=${address}&accountIndex=${idx}`);
    const map = res && res.positions && typeof res.positions === 'object' ? res.positions : {};
    let accEquity = null;
    try {
      const acc = await http.get(`${BASE}/v1/account?address=${address}&accountIndex=${idx}`, { retries: 2 });
      accEquity = num(acc && acc.equity);
      equity += accEquity;
      netDeposits += num(acc && acc.netDeposits);
    } catch (e) {
      if (e.status !== 404) throw e; // 404 = nothing deposited yet
    }
    const mine = [];
    for (const p of Object.values(map)) {
      if (!p) continue;
      const mag = Math.abs(num(p.size));
      if (!mag) continue;
      const mkt = String(p.marketDisplayName || p.marketId);
      mine.push({
        acct: String(idx),
        mkt,
        size: p.side === 'SHORT' ? -mag : mag,
        entry: num(p.averageEntryPrice),
        mark: num(p.markPx),
        notional: Math.abs(num(p.positionValueNotional)) || mag * num(p.markPx),
        upnl: num(p.unrealizedPnl),
        lev: p.leverage != null ? num(p.leverage) : null,
        iso: p.marginMode === 'ISOLATED',
        margin: num(p.marginUsed),
        mmf: markets.mmf[mkt] || null,
      });
    }
    for (const p of mine) {
      p.liq = estimateLiq(p, mine, accEquity);
      p.liqEst = p.liq != null;
      delete p.iso;
      delete p.margin;
      delete p.mmf;
      positions.push(p);
    }
  }
  cache.positions = positions;
  cache.meta.equity = equity;
  cache.meta.netDeposits = netDeposits;

  // Arcus's own volume figures and fee tier.
  try {
    const s = await http.get(`${BASE}/v1/account/stats?address=${address}&include=volumes,feeTier&windows=24h,7d,30d`, { retries: 1 });
    const w = (s && s.windowedStats) || {};
    cache.meta.official = {
      lifetimeVolume: num(s.lifetimeVolume) * QUOTE_QUANTUM,
      lifetimeFees: num(s.lifetimeFeesPaid) * QUOTE_QUANTUM,
      windows: {
        '24h': w['24h'] ? num(w['24h'].volume) * QUOTE_QUANTUM : null,
        '7d': w['7d'] ? num(w['7d'].volume) * QUOTE_QUANTUM : null,
        '30d': w['30d'] ? num(w['30d'].volume) * QUOTE_QUANTUM : null,
      },
      at: Date.now(),
    };
    if (s && s.tradingFeeTier) {
      const t = s.tradingFeeTier;
      cache.meta.feeTier = { level: num(t.level), makerBps: num(t.makerFeePpm) / 100, takerBps: num(t.takerFeePpm) / 100 };
    }
  } catch (e) {
    // Optional: the endpoint can return 503 while Arcus warms up.
  }
}

// Account value only (for the live portfolio): /v1/account per sub-account in use. It carries
// equity, free collateral, lifetime net deposits and the open positions' unrealised PnL.
async function balance(wallet, cache, ctx) {
  const address = wallet.address.trim().toLowerCase();
  const out = { equity: 0, available: 0, upnl: 0, netDeposits: 0 };
  for (const idx of (cache.meta && cache.meta.indexes) || [0]) {
    let acc = null;
    try {
      acc = await ctx.http.get(`${BASE}/v1/account?address=${address}&accountIndex=${idx}`, { retries: 1 });
    } catch (e) {
      if (e.status !== 404) throw e; // 404 = nothing deposited in this sub-account
    }
    if (!acc) continue;
    out.equity += num(acc.equity);
    out.available += num(acc.freeCollateral);
    out.netDeposits += num(acc.netDeposits);
    for (const p of Object.values(acc.positions || {})) out.upnl += num(p && p.unrealizedPnl);
  }
  return out;
}

function explainError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (err && err.status === 403 && /whitelist/i.test(msg)) {
    return "Arcus doesn't recognise this address. Arcus gives you an embedded wallet, so copy the 0x address shown inside the Arcus app.";
  }
  if (isServerTrouble(err)) return serverTroubleText(err, 'Arcus');
  if (err && err.status === 0) return `Can't reach Arcus's API. Check your internet connection. (${msg})`;
  if (err && err.status === 400) return 'Arcus rejected this address. Check it is the full 0x address.';
  return msg;
}

module.exports = {
  _test: { estimateLiq },
  id: 'arcus',
  name: 'Arcus',
  appUrl: 'https://app.arcus.xyz',
  addressKind: 'evm',
  addressHint:
    'Your Arcus account address (0x…). Arcus signs you in with an embedded wallet, so copy the address from inside the Arcus app.',
  validate: (a) => (isEvmAddress(a) ? null : 'Arcus needs a 0x… address.'),
  sync,
  balance,
  explainError,
};
