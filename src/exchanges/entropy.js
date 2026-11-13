'use strict';

// Entropy (entropy.io) is a trading front end on Hyperliquid. It runs its own HIP-3 market
// deployer ("io": OpenAI, Anthropic, SanDisk…) and also lets you trade every other Hyperliquid
// market (BTC, HYPE, trade.xyz stocks, commodities…) from the same account.
//
// Everything is read from Hyperliquid's public info API with the wallet address. A fill counts
// as an Entropy trade when it is on one of Entropy's own markets, or when its client order ID was
// issued by Entropy: Entropy tags every order it sends with an attribution ID whose first four
// bytes are 0xE1000000 + the unix minute it was issued. Fills placed through other apps on the
// same Hyperliquid account are left out. A position opened on Entropy stays tracked until it is
// flat again, even if it's closed or liquidated somewhere else (so hold time and OI stay right),
// but only Entropy's own fills count towards volume and fees.

const { num, isEvmAddress } = require('../util');
const { isServerTrouble, serverTroubleText } = require('../http');

const API =process.env.PERPS_HL_API || 'https://api.hyperliquid.xyz/info';
const PAGE = 2000;
const FUNDING_PAGE = 500;
const MODE = 2; // cache layout version for this adapter (1 = Entropy's own markets only)
const CLOID_BASE = 0xe1000000;
const MAX_REST_MIN = 180 * 24 * 60; // a resting limit order can fill long after it was placed
const MINUTE = 60000;

let dexInfo = null;
let cryptoInfo = null;

// Entropy's HIP-3 deployer name (currently "io") instead of hard-coding it.
async function resolveDex(http) {
  if (dexInfo && Date.now() - dexInfo.at < 6 * 3600 * 1000) return dexInfo.name;
  try {
    const list = await http.post(API, { type: 'perpDexs' });
    const dexs = (Array.isArray(list) ? list : []).filter(Boolean);
    const hit = dexs.find((d) => /entropy/i.test(String(d.fullName || ''))) || dexs.find((d) => d.name === 'io');
    dexInfo = { name: hit ? hit.name : 'io', at: Date.now() };
  } catch (e) {
    if (!dexInfo) dexInfo = { name: 'io', at: 0 };
  }
  return dexInfo.name;
}

// Hyperliquid's own (crypto) perp names, to tell crypto apart from stocks on other HIP-3 dexes.
async function cryptoNames(http) {
  if (cryptoInfo && Date.now() - cryptoInfo.at < 6 * 3600 * 1000) return cryptoInfo.names;
  try {
    const meta = await http.post(API, { type: 'meta' });
    const names = new Set(((meta && meta.universe) || []).map((u) => String(u.name).toUpperCase()));
    if (names.size) cryptoInfo = { names, at: Date.now() };
  } catch (e) {
    // keep whatever we had
  }
  return cryptoInfo ? cryptoInfo.names : new Set(['BTC', 'ETH', 'SOL', 'HYPE']);
}

// True when Entropy issued this client order ID around the time of the fill.
function entropyCloid(cloid, time) {
  if (typeof cloid !== 'string' || !/^0x[0-9a-fA-F]{32}$/.test(cloid)) return false;
  const issued = parseInt(cloid.slice(2, 10), 16) - CLOID_BASE;
  const fillMin = Math.floor(Number(time) / MINUTE);
  return issued <= fillMin + 5 && issued >= fillMin - MAX_REST_MIN;
}

const dexOf = (coin) => (coin.includes(':') ? coin.slice(0, coin.indexOf(':')) : '');

function displayName(coin, prefix) {
  return coin.startsWith(prefix) ? coin.slice(prefix.length) : coin;
}

function classify(coin, prefix, crypto) {
  if (coin.startsWith(prefix)) return 'stocks'; // Entropy's own: equities, indices, pre-IPO
  if (coin.startsWith('@')) return 'crypto';
  const dex = dexOf(coin);
  if (!dex) return 'crypto'; // Hyperliquid's main perps are all crypto
  const base = coin.slice(dex.length + 1).toUpperCase();
  return crypto.has(base) ? 'crypto' : 'stocks'; // HIP-3: stocks, indices, commodities, FX
}

function normFill(f, prefix, ext) {
  return {
    id: `${f.tid}-${f.oid}`,
    ts: Number(f.time),
    tie: 0,
    mkt: displayName(f.coin, prefix),
    side: f.side === 'B' ? 'B' : 'S',
    sz: Math.abs(num(f.sz)),
    px: num(f.px),
    fee: num(f.fee) + num(f.builderFee), // positive = paid, negative = rebate
    pnl: num(f.closedPnl), // realised PnL before fees
    role: f.crossed ? 'T' : 'M',
    sp: f.startPosition == null ? null : num(f.startPosition),
    eff: f.dir || null,
    liq: f.liquidation ? 1 : 0,
    acct: '',
    ext: ext ? 1 : 0, // 1 = placed elsewhere, kept only to follow an Entropy position to flat
  };
}

// Page forward through a time-ordered (oldest-first) Hyperliquid list.
async function pageByTime(http, body, pageSize, onRows) {
  let start = body.startTime;
  for (let page = 1; page <= 100; page++) {
    const rows = await http.post(API, { ...body, startTime: start });
    if (!Array.isArray(rows)) throw new Error(`Unexpected ${body.type} response from Hyperliquid`);
    let maxT = start;
    for (const r of rows) maxT = Math.max(maxT, Number(r.time));
    onRows(rows, maxT);
    if (rows.length < pageSize) return;
    start = maxT > start ? maxT : start + 1;
  }
}

async function sync(wallet, cache, ctx) {
  const http = ctx.http;
  const user = wallet.address.trim().toLowerCase();
  const dex = await resolveDex(http);
  const prefix = `${dex}:`;
  if (cache.meta.mode !== MODE || (cache.meta.dex && cache.meta.dex !== dex)) {
    cache.fills = [];
    cache.funding = [];
    cache.cursor = {};
    cache.meta = { mode: MODE };
  }
  const meta = cache.meta;
  meta.dex = dex;
  meta.assetClass = 'mixed';
  meta.active = meta.active || {}; // coin -> true while an Entropy position is open
  meta.firstVia = meta.firstVia || {}; // coin -> first Entropy fill time
  meta.coins = meta.coins || {}; // display name -> Hyperliquid coin
  const crypto = await cryptoNames(http);
  meta.classes = meta.classes || {};

  // Fills: oldest-first, 2000 per call. Hyperliquid only serves a wallet's 10,000 most recent
  // fills (all markets), so the local cache is what keeps older history.
  const byId = new Map(cache.fills.map((f) => [f.id, f]));
  const seenAtLast = new Set(meta.seenAtLast || []);
  // Trades on this Hyperliquid account that weren't recognised as Entropy's. If these keep coming
  // with no recognised trades in between, Entropy may have changed how it tags orders.
  const others = Array.isArray(meta.others) ? meta.others : [];
  let lastTime = cache.cursor.lastTime || 0;
  await pageByTime(http, { type: 'userFillsByTime', user, startTime: lastTime, aggregateByTime: false }, PAGE, (rows, maxT) => {
    const sorted = rows.filter((f) => f && typeof f.coin === 'string').sort((a, b) => Number(a.time) - Number(b.time));
    for (const f of sorted) {
      const id = `${f.tid}-${f.oid}`;
      const t = Number(f.time);
      if (byId.has(id) || (t === lastTime && seenAtLast.has(id))) continue;
      if (t > lastTime) {
        lastTime = t;
        seenAtLast.clear();
      }
      seenAtLast.add(id);
      const coin = f.coin;
      const sp = num(f.startPosition);
      const after = sp + (f.side === 'B' ? 1 : -1) * Math.abs(num(f.sz));
      const flat = Math.abs(after) <= Math.max(Math.abs(sp), Math.abs(num(f.sz))) * 1e-9;
      const own = coin.startsWith(prefix) || entropyCloid(f.cloid, t);
      if (own) {
        if (!meta.firstVia[coin]) meta.firstVia[coin] = t;
        meta.active[coin] = !flat;
        meta.lastOwnTs = Math.max(meta.lastOwnTs || 0, t);
      } else if (meta.active[coin] && sp !== 0) {
        meta.active[coin] = !flat;
      } else {
        others.push({ ts: t, coin, oid: f.oid });
        continue; // someone else's front end
      }
      const nf = normFill(f, prefix, !own);
      byId.set(id, nf);
      meta.coins[nf.mkt] = coin;
      meta.classes[nf.mkt] = classify(coin, prefix, crypto);
    }
    cache.fills = Array.from(byId.values());
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    meta.others = others.filter((x) => x.ts >= cutoff).slice(-200);
    cache.cursor.lastTime = Math.max(cache.cursor.lastTime || 0, lastTime, maxT);
    meta.seenAtLast = Array.from(seenAtLast);
    ctx.progress(`${cache.fills.length.toLocaleString()} Entropy fills`);
  });

  // Funding payments (positive = received) on Entropy markets, from your first Entropy trade there.
  const fundById = new Map(cache.funding.map((x) => [x.id, x]));
  await pageByTime(http, { type: 'userFunding', user, startTime: cache.cursor.fundingTime || 0 }, FUNDING_PAGE, (rows, maxT) => {
    for (const r of rows) {
      const d = r.delta || {};
      if (d.type !== 'funding' || typeof d.coin !== 'string') continue;
      const since = d.coin.startsWith(prefix) ? 0 : meta.firstVia[d.coin];
      if (since == null || Number(r.time) < since) continue;
      const id = `${r.time}:${d.coin}`;
      fundById.set(id, { id, ts: Number(r.time), mkt: displayName(d.coin, prefix), amt: num(d.usdc), acct: '' });
    }
    cache.funding = Array.from(fundById.values());
    cache.cursor.fundingTime = Math.max(cache.cursor.fundingTime || 0, maxT);
  });

  // Open positions: Entropy's own markets, plus anything opened through Entropy that's still open.
  const dexes = new Set([dex]);
  for (const [coin, on] of Object.entries(meta.active)) if (on) dexes.add(dexOf(coin));
  const positions = [];
  for (const d of dexes) {
    const st = await http.post(API, d ? { type: 'clearinghouseState', user, dex: d } : { type: 'clearinghouseState', user });
    const aps = st && Array.isArray(st.assetPositions) ? st.assetPositions : [];
    for (const ap of aps) {
      const p = ap && ap.position;
      if (!p || num(p.szi) === 0) continue;
      const coin = String(p.coin);
      if (!coin.startsWith(prefix) && !meta.active[coin]) continue;
      const size = num(p.szi);
      const notional = Math.abs(num(p.positionValue));
      const mkt = displayName(coin, prefix);
      meta.classes[mkt] = meta.classes[mkt] || classify(coin, prefix, crypto);
      positions.push({
        acct: '',
        mkt,
        coin, // Hyperliquid's own name (dex:SYMBOL), for live prices and funding
        size,
        entry: num(p.entryPx),
        mark: size ? notional / Math.abs(size) : 0,
        notional,
        upnl: num(p.unrealizedPnl),
        lev: p.leverage && p.leverage.value != null ? num(p.leverage.value) : null,
        liq: num(p.liquidationPx) > 0 ? num(p.liquidationPx) : null,
      });
    }
  }
  cache.positions = positions;

  // Account value across Hyperliquid (unified accounts keep collateral in spot USDC), and
  // Hyperliquid's own all-time PnL for the account (its value minus what was paid in).
  try {
    const pv = portfolioValues(await http.post(API, { type: 'portfolio', user }));
    meta.equity = pv.equity;
    meta.pnlAll = pv.pnlAll;
  } catch (e) {
    meta.equity = null;
  }
  cache.transfers = []; // Hyperliquid deposits aren't Entropy-specific; not tracked

  // Tracking check: trades since the last recognised Entropy trade that weren't recognised.
  const since = meta.lastOwnTs || 0;
  const recent = (meta.others || []).filter((x) => x.ts > since && x.ts >= Date.now() - 14 * 24 * 3600 * 1000);
  const orders = new Set(recent.map((x) => x.oid));
  meta.check =
    orders.size >= 3
      ? { trades: orders.size, newest: Math.max(...recent.map((x) => x.ts)), lastOwn: meta.lastOwnTs || null, markets: [...new Set(recent.map((x) => displayName(x.coin, prefix)))].slice(0, 6) }
      : null;
}

// From Hyperliquid's `portfolio`: the latest account value and the all-time PnL.
function portfolioValues(pf) {
  const series = (name) => {
    const hit = Array.isArray(pf) ? pf.find((x) => Array.isArray(x) && x[0] === name) : null;
    return (hit && hit[1]) || {};
  };
  const last = (arr) => (Array.isArray(arr) && arr.length ? num(arr[arr.length - 1][1]) : null);
  return { equity: last(series('day').accountValueHistory), pnlAll: last(series('allTime').pnlHistory) };
}

// Account value only (for the live portfolio): portfolio, spot balances, and the open positions'
// unrealised PnL on the dexes where the tracker follows positions.
async function balance(wallet, cache, ctx) {
  const user = wallet.address.trim().toLowerCase();
  const http = ctx.http;
  const pv = portfolioValues(await http.post(API, { type: 'portfolio', user }));
  let available = 0;
  try {
    const sp = await http.post(API, { type: 'spotClearinghouseState', user });
    for (const b of (sp && sp.balances) || []) if (/^USD/.test(String(b.coin))) available += Math.max(0, num(b.total) - num(b.hold));
  } catch (e) {
    // optional
  }
  const meta = cache.meta || {};
  const dexes = new Set();
  for (const p of cache.positions || []) {
    const coin = (meta.coins && meta.coins[p.mkt]) || (meta.dex ? `${meta.dex}:${p.mkt}` : p.mkt);
    dexes.add(dexOf(coin));
  }
  let upnl = 0;
  for (const d of dexes) {
    const st = await http.post(API, d ? { type: 'clearinghouseState', user, dex: d } : { type: 'clearinghouseState', user });
    if (!d) available += num(st && st.withdrawable);
    for (const ap of (st && st.assetPositions) || []) upnl += num(ap && ap.position && ap.position.unrealizedPnl);
  }
  return { equity: pv.equity, available, upnl, pnlAll: pv.pnlAll };
}

function explainError(err) {
  if (isServerTrouble(err)) return serverTroubleText(err, 'Hyperliquid');
  if (err && err.status === 0) return `Can't reach Hyperliquid's API. Check your internet connection. (${err.message})`;
  if (err && (err.status === 400 || err.status === 422)) return 'Hyperliquid rejected this address. Check it is the full 0x address.';
  return err && err.message ? err.message : String(err);
}

module.exports = {
  id: 'entropy',
  name: 'Entropy',
  appUrl: 'https://entropy.io',
  addressKind: 'evm',
  addressHint:
    'The 0x wallet you log in to entropy.io with (it is your Hyperliquid account). Trades you place on Entropy count, on any market; trades from other apps on the same account are left out.',
  validate: (a) => (isEvmAddress(a) ? null : 'Entropy needs a 0x… address (your Hyperliquid account).'),
  sync,
  balance,
  explainError,
  _test: { entropyCloid, classify },
};
