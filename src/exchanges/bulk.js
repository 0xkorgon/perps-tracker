'use strict';

// Bulk (app.bulk.trade) - Solana perp DEX. One unsigned POST endpoint answers account queries
// by public key. History is newest-first and cursor-paginated; timestamps are nanoseconds.

const { num, toMs, isSolanaAddress } = require('../util');
const { isServerTrouble, serverTroubleText } = require('../http');

const BASE = process.env.PERPS_BULK_API || 'https://mainnet-api1.bulk.trade/api/v1';
const PAGE = 5000;
const MIN_PAGE = 250;

const query = (http, body, opts) => http.post(`${BASE}/account`, body, opts);

function lane(row, pubkey) {
  return row.iso && row.isoPubkey ? String(row.isoPubkey) : pubkey;
}

function normFill(f, pubkey) {
  const isTaker = f.taker === pubkey || (f.isoPubkey && f.taker === f.isoPubkey);
  return {
    id: `${pubkey}:${f.slot}:${f.sequence}:${f.isBuy ? 'B' : 'S'}`,
    ts: toMs(f.timestamp),
    tie: num(f.slot) * 1e4 + num(f.sequence),
    mkt: String(f.symbol),
    side: f.isBuy ? 'B' : 'S',
    sz: Math.abs(num(f.amount)),
    px: num(f.price),
    fee: -num(f.fee), // Bulk reports fees as a P&L delta (negative = paid); flipped so positive = paid
    pnl: null, // Bulk reports realised PnL per closed position instead
    role: isTaker ? 'T' : 'M',
    sp: null,
    eff: null,
    liq: num(f.reasonCode) !== 0 ? 1 : 0,
    acct: lane(f, pubkey),
  };
}

function normClosed(p, pubkey) {
  const q = num(p.quantity);
  return {
    id: `${pubkey}:${p.closeSlot}:${p.sequence}:${p.symbol}:${p.isoPubkey || ''}`,
    acct: lane(p, pubkey),
    mkt: String(p.symbol),
    side: q >= 0 ? 'L' : 'S',
    size: Math.abs(q),
    openTs: toMs(p.openTime),
    closeTs: toMs(p.closeTime),
    volBase: Math.abs(num(p.totalVolume)),
    openPx: num(p.avgOpenPrice),
    closePx: num(p.avgClosePrice),
    pnl: num(p.realizedPnl), // before fees
    fees: -num(p.fees),
    reason: p.closeReason || 'normal',
  };
}

function normFunding(r, pubkey) {
  return { id: `${pubkey}:${r.slot}:${r.sequence}:${r.symbol}`, ts: toMs(r.timestamp), mkt: String(r.symbol), amt: num(r.payment), acct: lane(r, pubkey) };
}

function normActivity(r, pubkey) {
  if (r.status && r.status !== 'completed') return null;
  return {
    id: `${pubkey}:${r.slot}:${r.sequence}`,
    ts: toMs(r.timestamp),
    kind: r.activityType,
    amt: Math.abs(num(r.amount)),
    from: r.from || null,
    to: r.to || null,
    acct: pubkey,
  };
}

function mapPositions(acc, pubkey) {
  return (Array.isArray(acc.positions) ? acc.positions : [])
    .filter((p) => p && num(p.size) !== 0)
    .map((p) => ({
      acct: lane(p, pubkey),
      mkt: String(p.symbol),
      size: num(p.size),
      entry: num(p.price),
      mark: num(p.fairPrice),
      notional: Math.abs(num(p.notional)) || Math.abs(num(p.size) * num(p.fairPrice)),
      upnl: num(p.unrealizedPnl),
      lev: p.leverage != null ? num(p.leverage) : null,
      avgEntryTs: p.averageEntryTime ? toMs(p.averageEntryTime) : null,
      liq: num(p.liquidationPrice) > 0 ? num(p.liquidationPrice) : null,
      exits: exitPrices(p),
    }));
}

// Take-profit / stop-loss trigger prices attached to a position (Bulk calls them protection orders).
function exitPrices(p) {
  const orders = p && p.protection && Array.isArray(p.protection.orders) ? p.protection.orders : [];
  const out = [];
  for (const o of orders) {
    const t = (o && o.trigger) || {};
    for (const v of [t.px, t.pxHi, t.pxLo, t.triggerPx]) if (num(v) > 0) out.push(num(v));
  }
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}

// Account value of one account. `agg*` fields include isolated positions' lanes (an isolated
// position's margin isn't in `totalMargin`), so they're preferred when present.
function accountValue(acc) {
  const m = (acc && acc.margin) || {};
  const pick = (agg, plain) => (m[agg] != null ? num(m[agg]) : num(m[plain]));
  return { equity: pick('aggTotalMargin', 'totalMargin'), available: pick('aggAvailableMargin', 'availableMargin'), upnl: pick('aggUnrealizedPnl', 'unrealizedPnl') };
}

// Account value only (for the live portfolio): one request per account.
async function balance(wallet, cache, ctx) {
  const master = wallet.address.trim();
  const out = { equity: 0, available: 0, upnl: 0 };
  for (const user of [master, ...((cache.meta && cache.meta.subAccounts) || [])]) {
    let acc = null;
    try {
      acc = unwrapFullAccount(await query(ctx.http, { type: 'fullAccount', user }));
    } catch (e) {
      if (e.status !== 404 || user === master) throw e;
    }
    if (!acc) continue;
    const v = accountValue(acc);
    out.equity += v.equity;
    out.available += v.available;
    out.upnl += v.upnl;
  }
  return out;
}

function unwrapFullAccount(res) {
  const item = Array.isArray(res) ? res.find((x) => x && x.fullAccount) : res && res.fullAccount ? res : null;
  return item ? item.fullAccount : null;
}

// Page through one history type. Returns true once the API says there is nothing more.
// When Bulk's gateway times out (504) on a page, the same page is asked for again in smaller
// pieces (5,000 rows, then 2,500, ... down to 250) before giving up until the next sync.
async function walkHistory(http, type, user, startSlot, onRows, ctx) {
  let cursor = null;
  let limit = PAGE;
  let checked = 0;
  for (let page = 1; page <= 800; page++) {
    const body = { type, user, limit };
    if (cursor) body.cursor = cursor;
    else if (startSlot) body.startSlot = startSlot;
    let res;
    try {
      res = await query(http, body, { retries: limit > MIN_PAGE ? 1 : 2 });
    } catch (e) {
      if (!isServerTrouble(e) || limit <= MIN_PAGE) throw e;
      limit = Math.max(MIN_PAGE, Math.floor(limit / 2));
      ctx.progress(`Bulk timed out on ${type}; asking for ${limit.toLocaleString()} at a time`);
      continue;
    }
    const rows = res && Array.isArray(res.data) ? res.data : null;
    if (!rows) throw new Error(`Unexpected ${type} response from Bulk`);
    onRows(rows);
    checked += rows.length;
    const pg = res.page || {};
    if (!pg.hasMore || !pg.nextCursor) return true;
    cursor = pg.nextCursor;
    ctx.progress(`paging Bulk ${type} (${checked.toLocaleString()} checked)`);
  }
  return false;
}

async function sync(wallet, cache, ctx) {
  const http = ctx.http;
  const master = wallet.address.trim();

  const acc = unwrapFullAccount(await query(http, { type: 'fullAccount', user: master }));
  if (!acc) throw new Error('Unexpected account response from Bulk');
  const subs = (Array.isArray(acc.subAccounts) ? acc.subAccounts : [])
    .map((s) => (s && (s.pubkey || s.publicKey)) || (typeof s === 'string' ? s : null))
    .filter((s) => s && s !== master);
  cache.meta.subAccounts = subs;
  cache.meta.kind = acc.kind || null;
  cache.meta.assetClass = 'crypto';

  const positions = mapPositions(acc, master);
  let equity = accountValue(acc).equity;
  for (const sub of subs) {
    try {
      const subAcc = unwrapFullAccount(await query(http, { type: 'fullAccount', user: sub }));
      if (subAcc) {
        positions.push(...mapPositions(subAcc, sub));
        equity += accountValue(subAcc).equity;
      }
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  cache.positions = positions;
  cache.meta.equity = equity;
  const tier = Array.isArray(acc.feeTiers) ? acc.feeTiers.find((t) => t && t.symbol === 'global') || acc.feeTiers[0] : null;
  if (tier) cache.meta.feeTier = { level: num(tier.tierIndex), makerBps: num(tier.makerBps), takerBps: num(tier.takerBps) };

  const jobs = [
    { type: 'fills', field: 'fills', norm: normFill, slotOf: (r) => num(r.slot) },
    { type: 'positions', field: 'closed', norm: normClosed, slotOf: (r) => num(r.closeSlot) },
    { type: 'fundingHistory', field: 'funding', norm: normFunding, slotOf: (r) => num(r.slot) },
    { type: 'activityHistory', field: 'transfers', norm: normActivity, slotOf: (r) => num(r.slot) },
  ];
  for (const job of jobs) job.map = new Map((Array.isArray(cache[job.field]) ? cache[job.field] : []).map((x) => [x.id, x]));

  for (const pk of [master, ...subs]) {
    for (const job of jobs) {
      const key = `${job.type}_${pk}`;
      const startSlot = cache.cursor[key] || null;
      let maxSlot = startSlot || 0;
      let complete;
      try {
        complete = await walkHistory(
          http,
          job.type,
          pk,
          startSlot,
          (rows) => {
            for (const r of rows) {
              const n = job.norm(r, pk);
              if (n) job.map.set(n.id, n);
              const s = job.slotOf(r);
              if (s > maxSlot) maxSlot = s;
            }
            cache[job.field] = Array.from(job.map.values());
          },
          ctx
        );
      } catch (e) {
        if (e.status === 404 && pk !== master) continue; // empty sub-account
        if (job.type === 'activityHistory' || job.type === 'fundingHistory') continue; // optional extras
        throw e;
      }
      if (complete && maxSlot) cache.cursor[key] = maxSlot;
    }
  }
  for (const job of jobs) if (!Array.isArray(cache[job.field])) cache[job.field] = Array.from(job.map.values());
  cache.meta.ownKeys = [master, ...subs];
}

function explainError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (err && err.status === 404) return 'Bulk has no account for this address yet. Use the Solana wallet you connected at app.bulk.trade.';
  if (err && err.status === 400) return 'Bulk rejected this address. Check it is the full Solana address.';
  if (isServerTrouble(err)) return serverTroubleText(err, 'Bulk');
  if (err && err.status === 0) return `Can't reach Bulk's API. Check your internet connection. (${msg})`;
  return msg;
}

module.exports = {
  id: 'bulk',
  name: 'Bulk',
  appUrl: 'https://app.bulk.trade',
  addressKind: 'solana',
  addressHint: 'The Solana wallet you connected at app.bulk.trade. Its sub-accounts are picked up automatically.',
  validate: (a) => (isSolanaAddress(a) ? null : 'Bulk needs a Solana address (base58, 32–44 characters).'),
  sync,
  balance,
  explainError,
};
