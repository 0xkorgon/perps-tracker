'use strict';

const { isUsHours } = require('./markettime');

// Turns normalised fills / positions into the numbers the dashboard shows.
//
// Normalised fill: { id, ts(ms), tie, mkt, side 'B'|'S', sz, px, fee(+paid), role 'M'|'T',
//                    sp (exchange-reported position before the fill, or null),
//                    eff (exchange position-effect label, or null), liq, acct }

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const RANGES = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: Infinity };

const HOLD_BUCKETS = [
  { key: 'lt1m', label: '< 1 min', max: 60 * 1000 },
  { key: 'm1h', label: '1–60 min', max: HOUR },
  { key: 'h1d', label: '1–24 h', max: DAY },
  { key: 'gt1d', label: '> 1 day', max: Infinity },
];

const signedDelta = (f) => (f.side === 'B' ? f.sz : -f.sz);

// A position counts as flat when it is within float noise of zero relative to the sizes involved.
function isFlat(x, scale) {
  return Math.abs(x) <= Math.max(1e-12, Math.abs(scale || 0) * 1e-9);
}

// Fills that share a timestamp (one order sweeping several makers) can arrive in any order.
// When the exchange tells us the starting position of each fill, put them back in chain order.
function chainOrder(list) {
  const out = [];
  let i = 0;
  while (i < list.length) {
    let j = i + 1;
    while (j < list.length && list[j].ts === list[i].ts) j++;
    const group = list.slice(i, j);
    if (group.length > 1 && group.every((f) => f.sp != null)) {
      const left = group.slice();
      const after = (f) => f.sp + signedDelta(f);
      const near = (a, b) => isFlat(a - b, Math.max(Math.abs(a), Math.abs(b)));
      let cur = left.find((f) => !left.some((g) => g !== f && near(after(g), f.sp))) || left[0];
      while (cur) {
        out.push(cur);
        left.splice(left.indexOf(cur), 1);
        const a = after(cur);
        cur = left.find((g) => near(g.sp, a)) || left[0];
      }
    } else {
      out.push(...group);
    }
    i = j;
  }
  return out;
}

// Rebuild position lifecycles (flat -> open -> flat) for each account+market from the fill tape.
// Returns closed cycles with hold times, the open cycle per market, and position-notional
// segments over time (for time-weighted open interest).
//
// Bulk's fills carry no running position, and its fill history can start mid-position, so the
// replay needs a starting size. Every moment Bulk says a position closed (`flatPoints`: Map
// "acct|mkt" -> sorted close times; flips excluded via `flipPoints`) votes for the starting size
// that makes the replay flat there; the live position (`live`: Map -> signed size) gets a vote too.
// The most common answer wins, so one odd data point can't skew the whole history.
function anchorOffset(list, key, anchors) {
  const { live, flatPoints, flipPoints } = anchors;
  let scale = 0;
  for (const f of list) scale = Math.max(scale, f.sz);
  const tol = Math.max(1e-12, scale * 1e-6);
  const votes = [];
  const flats = flatPoints && flatPoints.get(key);
  if (flats && flats.length) {
    const flips = flipPoints && flipPoints.get(key);
    let i = 0;
    let net = 0;
    for (const T of flats) {
      if (T < list[0].ts || (flips && flips.has(T))) continue;
      // A close carries its closing fill's exact timestamp, so "flat at T" means after fills <= T.
      while (i < list.length && list[i].ts <= T) net += signedDelta(list[i++]);
      votes.push(-net);
    }
  }
  let liveVote = null;
  if (live) {
    let net = 0;
    for (const f of list) net += signedDelta(f);
    liveVote = (live.get(key) || 0) - net;
    votes.push(liveVote);
  }
  if (!votes.length) return 0;
  const bucketOf = (v) => Math.round(v / tol);
  const counts = new Map();
  for (const v of votes) counts.set(bucketOf(v), (counts.get(bucketOf(v)) || 0) + 1);
  let best = liveVote !== null ? liveVote : votes[0];
  let bestCount = counts.get(bucketOf(best));
  for (const v of votes) {
    const c = counts.get(bucketOf(v));
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  // No agreement at all and nothing live to fall back on: don't guess.
  if (bestCount < 2 && votes.length > 1 && liveVote === null) return 0;
  return Math.abs(best) <= tol ? 0 : best;
}

function reconstruct(fills, now, anchors = {}) {
  const byKey = new Map();
  for (const f of fills) {
    if (!(f.sz > 0) || !(f.ts > 0)) continue;
    const k = `${f.acct}|${f.mkt}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);
  }
  const cycles = [];
  const open = new Map();
  const segments = [];

  for (const [key, raw] of byKey) {
    raw.sort((a, b) => a.ts - b.ts || a.tie - b.tie);
    const list = chainOrder(raw);
    let pos = 0;
    let cur = null;
    let lastTs = null;
    let lastPx = 0;

    // Bulk-style markets: anchor the starting size, then snap back to flat at every moment the
    // exchange says the position was closed (repairs gaps inside the fill history too).
    const tapeOnly = list[0].sp == null && !list.some((f) => f.eff);
    const flats = tapeOnly && anchors.flatPoints ? anchors.flatPoints.get(key) || [] : [];
    const flips = tapeOnly && anchors.flipPoints ? anchors.flipPoints.get(key) : null;
    let keyScale = 0;
    for (const f of list) keyScale = Math.max(keyScale, f.sz);
    let fj = 0;
    if (tapeOnly) pos = anchorOffset(list, key, anchors);
    const snapToFlat = (beforeTs) => {
      while (fj < flats.length && flats[fj] < beforeTs) {
        const T = flats[fj++];
        if (T < list[0].ts || (flips && flips.has(T)) || isFlat(pos, keyScale)) continue;
        if (lastTs !== null && T > lastTs) {
          segments.push({ key, from: lastTs, to: T, notional: Math.abs(pos) * lastPx });
          lastTs = T;
        }
        pos = 0;
        cur = null;
      }
    };

    const startCycle = (f, size, known) => ({
      mkt: f.mkt,
      acct: f.acct,
      side: size > 0 ? 'L' : 'S',
      openTs: known ? f.ts : null,
      known,
      vol: 0,
      fees: 0,
      fills: 0,
      maxNotional: Math.abs(size) * f.px,
    });
    const closeCycle = (f) => {
      if (cur && cur.known) {
        cycles.push({
          mkt: cur.mkt,
          acct: cur.acct,
          side: cur.side,
          openTs: cur.openTs,
          closeTs: f.ts,
          holdMs: Math.max(0, f.ts - cur.openTs),
          vol: cur.vol,
          fees: cur.fees,
          fills: cur.fills,
          maxNotional: cur.maxNotional,
          liq: f.liq ? 1 : 0,
        });
      }
      cur = null;
    };

    for (const f of list) {
      if (fj < flats.length) snapToFlat(f.ts);
      const delta = signedDelta(f);
      const notional = f.sz * f.px;
      if (lastTs !== null && !isFlat(pos, f.sz) && f.ts > lastTs) {
        segments.push({ key, from: lastTs, to: f.ts, notional: Math.abs(pos) * lastPx });
      }

      // Re-sync with what the exchange says the position was (fills missing from history).
      if (f.sp != null && !isFlat(pos - f.sp, Math.max(Math.abs(pos), Math.abs(f.sp), f.sz))) {
        cur = null;
        pos = f.sp;
        if (!isFlat(pos, f.sz)) cur = startCycle(f, pos, false);
      } else if (f.eff && /^OPEN_/.test(f.eff) && !isFlat(pos, f.sz)) {
        cur = null;
        pos = 0;
      } else if (f.eff && /^CLOSE_/.test(f.eff) && isFlat(pos, f.sz)) {
        // Closing a position we never saw opened (history starts mid-position): skip it.
        lastTs = f.ts;
        lastPx = f.px;
        continue;
      }

      const prev = pos;
      let next = prev + delta;
      const scale = Math.max(Math.abs(prev), f.sz);
      if (isFlat(next, scale)) next = 0;

      if (isFlat(prev, f.sz)) {
        if (next !== 0) {
          cur = startCycle(f, next, true);
          cur.vol += notional;
          cur.fees += f.fee;
          cur.fills += 1;
        }
      } else if (next === 0 || Math.sign(next) !== Math.sign(prev)) {
        const closingPart = Math.min(1, Math.abs(prev) / f.sz);
        if (cur) {
          cur.vol += notional * closingPart;
          cur.fees += f.fee * closingPart;
          cur.fills += 1;
        }
        closeCycle(f);
        if (next !== 0) {
          cur = startCycle(f, next, true);
          cur.vol += notional * (1 - closingPart);
          cur.fees += f.fee * (1 - closingPart);
          cur.fills += 1;
        }
      } else if (cur) {
        cur.vol += notional;
        cur.fees += f.fee;
        cur.fills += 1;
        cur.maxNotional = Math.max(cur.maxNotional, Math.abs(next) * f.px);
      }

      pos = next;
      lastTs = f.ts;
      lastPx = f.px;
    }

    if (fj < flats.length) snapToFlat(Infinity);
    if (pos !== 0 && lastTs !== null) {
      if (now > lastTs) segments.push({ key, from: lastTs, to: now, notional: Math.abs(pos) * lastPx });
      open.set(key, { openTs: cur && cur.known ? cur.openTs : null, size: pos });
    }
  }
  return { cycles, open, segments };
}

// Bulk reports closed positions directly (exact open/close times), so prefer those.
function cyclesFromApi(closed) {
  return closed
    .filter((c) => c && c.openTs && c.closeTs)
    .map((c) => ({
      mkt: c.mkt,
      acct: c.acct,
      side: c.side,
      openTs: c.openTs,
      closeTs: c.closeTs,
      holdMs: Math.max(0, c.closeTs - c.openTs),
      vol: c.volBase && (c.openPx || c.closePx) ? (c.volBase * ((c.openPx || c.closePx) + (c.closePx || c.openPx))) / 2 : 0,
      fees: c.fees || 0,
      fills: null,
      maxNotional: c.size * (c.openPx || 0),
      liq: c.reason && c.reason !== 'normal' ? 1 : 0,
    }));
}

function median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function holdStats(cycles, bucketDefs = HOLD_BUCKETS) {
  const holds = cycles.map((c) => c.holdMs).sort((a, b) => a - b);
  const buckets = bucketDefs.map((b) => ({ key: b.key, label: b.label, count: 0 }));
  for (const h of holds) {
    const i = bucketDefs.findIndex((b) => h < b.max);
    buckets[i === -1 ? buckets.length - 1 : i].count += 1;
  }
  const sum = holds.reduce((a, b) => a + b, 0);
  return {
    closed: holds.length,
    avgHoldMs: holds.length ? sum / holds.length : null,
    medianHoldMs: median(holds),
    buckets,
  };
}

function fillStats(fills) {
  let volume = 0;
  let makerVolume = 0;
  let fees = 0;
  let liqs = 0;
  for (const f of fills) {
    const n = f.sz * f.px;
    volume += n;
    if (f.role === 'M') makerVolume += n;
    fees += f.fee;
    if (f.liq) liqs += 1;
  }
  return { volume, makerVolume, fees, fills: fills.length, liquidations: liqs };
}

// Time-weighted average open interest (USD) over [start, now].
function timeWeightedOi(segments, start, now) {
  const span = now - start;
  if (!(span > 0)) return null;
  let area = 0;
  for (const s of segments) {
    const a = Math.max(s.from, start);
    const b = Math.min(s.to, now);
    if (b > a) area += s.notional * (b - a);
  }
  return area / span;
}

function localDayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Array.prototype.push(...big) overflows the call stack on very long histories; loop instead.
function pushAll(target, items) {
  for (const x of items) target.push(x);
  return target;
}

function addInto(target, src) {
  for (const k of Object.keys(src)) target[k] = (target[k] || 0) + src[k];
}

// ---------- per-wallet preparation (shared by every view) ----------

const PLAY_BUCKETS = [
  { key: 'lt1m', label: '< 1 min', max: 60 * 1000 },
  { key: 'm10', label: '1–10 min', max: 10 * 60 * 1000 },
  { key: 'm60', label: '10 min–1 h', max: HOUR },
  { key: 'h6', label: '1–6 h', max: 6 * HOUR },
  { key: 'h24', label: '6–24 h', max: DAY },
  { key: 'd7', label: '1–7 days', max: 7 * DAY },
  { key: 'gt7', label: '> 7 days', max: Infinity },
];

function assetClass(exId, cache, mkt) {
  if (exId === 'entropy') {
    const c = cache.meta && cache.meta.classes ? cache.meta.classes[mkt] : null;
    return c === 'crypto' ? 'crypto' : 'stocks';
  }
  if (exId === 'bulk') return 'crypto';
  const cat = cache.meta && cache.meta.categories ? cache.meta.categories[mkt] : null;
  if (cat) return cat === 'CRYPTO' ? 'crypto' : 'stocks';
  return 'crypto';
}

// Turn one wallet's raw cache into everything the views need: enriched fills, closed
// positions with hold times, OI segments, PnL/funding/transfer events and live positions.
function prepareWallet(ex, w, wi, now) {
  const cache = w.cache || { fills: [], positions: [], meta: {} };
  const meta = cache.meta || {};
  const fills = Array.isArray(cache.fills) ? cache.fills : [];
  const positions = Array.isArray(cache.positions) ? cache.positions : [];
  const live = new Map();
  for (const p of positions) {
    const k = `${p.acct}|${p.mkt}`;
    live.set(k, (live.get(k) || 0) + p.size);
  }
  let flatPoints = null;
  let flipPoints = null;
  if (Array.isArray(cache.closed)) {
    flatPoints = new Map();
    flipPoints = new Map();
    for (const c of cache.closed) {
      const k = `${c.acct}|${c.mkt}`;
      if (!flatPoints.has(k)) {
        flatPoints.set(k, []);
        flipPoints.set(k, new Set());
      }
      flatPoints.get(k).push(c.closeTs);
      flipPoints.get(k).add(c.openTs); // a close at the same instant another position opened is a flip
    }
    for (const arr of flatPoints.values()) arr.sort((a, b) => a - b);
  }
  const rec = reconstruct(fills, now, { live: cache.syncedAt ? live : null, flatPoints, flipPoints });
  const useApiCycles = Array.isArray(cache.closed) && (cache.closed.length || !rec.cycles.length);
  const label = w.label || shortAddr(w.address);
  const cycles = (useApiCycles ? cyclesFromApi(cache.closed) : rec.cycles).map((c) => ({ ...c, exchange: ex.id, wallet: label }));
  const segments = rec.segments.map((s) => ({ ...s, key: `${ex.id}|${wi}|${s.key}` }));

  const clsCache = new Map();
  const clsOf = (mkt) => {
    if (!clsCache.has(mkt)) clsCache.set(mkt, assetClass(ex.id, cache, mkt));
    return clsCache.get(mkt);
  };
  // Fills marked ext were placed outside this exchange's app (Entropy: other Hyperliquid front
  // ends). They help rebuild positions above but don't count as volume, fees or PnL here.
  const counted = fills.some((f) => f.ext) ? fills.filter((f) => !f.ext) : fills;
  const rich = counted.map((f) => {
    const cls = clsOf(f.mkt);
    return { ts: f.ts, n: f.sz * f.px, fee: f.fee, role: f.role, mkt: f.mkt, cls, us: cls === 'stocks' ? isUsHours(f.ts) : null, liq: f.liq, ex: ex.id };
  });

  const pnlEvents = [];
  if (useApiCycles) {
    for (const c of cache.closed) if (c.closeTs && Number.isFinite(c.pnl)) pnlEvents.push({ ts: c.closeTs, amt: c.pnl, mkt: c.mkt, ex: ex.id });
  } else {
    for (const f of counted) if (f.pnl != null && f.pnl !== 0) pnlEvents.push({ ts: f.ts, amt: f.pnl, mkt: f.mkt, ex: ex.id });
  }
  const funding = (Array.isArray(cache.funding) ? cache.funding : []).map((x) => ({ ts: x.ts, amt: x.amt, mkt: x.mkt, ex: ex.id, acct: x.acct }));

  const own = new Set(meta.ownKeys || [w.address]);
  const transfers = [];
  for (const t of Array.isArray(cache.transfers) ? cache.transfers : []) {
    let dir = t.dir || null;
    if (!dir) {
      if (t.kind === 'deposit') dir = 'in';
      else if (t.kind === 'withdrawal') dir = 'out';
      else if (t.kind === 'transferExternal') dir = own.has(t.to) && !own.has(t.from) ? 'in' : own.has(t.from) && !own.has(t.to) ? 'out' : 'internal';
      else dir = 'internal';
    }
    if (dir === 'in' || dir === 'out') transfers.push({ ts: t.ts, dir, amt: t.amt });
  }

  const livePositions = positions.map((p) => {
    // Trust the rebuilt open time only if the rebuilt size matches the live position.
    const o = rec.open.get(`${p.acct}|${p.mkt}`);
    const consistent = o && isFlat(o.size - p.size, Math.max(Math.abs(o.size), Math.abs(p.size)) * 1e3);
    const openTs = (consistent && o.openTs) || p.avgEntryTs || null;
    // Funding paid or received on this position since it opened (positive = received).
    let fundSince = null;
    if (openTs) {
      fundSince = 0;
      for (const x of funding) if (x.mkt === p.mkt && x.ts >= openTs && (!x.acct || !p.acct || x.acct === p.acct)) fundSince += x.amt;
    }
    return { exchange: ex.id, wallet: label, ...p, side: p.size > 0 ? 'L' : 'S', openTs, cls: clsOf(p.mkt), fundSince };
  });

  let firstTs = Infinity;
  for (const f of counted) if (f.ts < firstTs) firstTs = f.ts;

  return {
    exchange: ex.id,
    label,
    address: w.address,
    status: w.status || null,
    fills: counted,
    rich,
    cycles,
    segments,
    pnlEvents,
    funding,
    transfers,
    positions: livePositions,
    equity: Number.isFinite(meta.equity) ? meta.equity : null,
    netDeposits: Number.isFinite(meta.netDeposits) ? meta.netDeposits : null,
    pnlAll: Number.isFinite(meta.pnlAll) ? meta.pnlAll : null, // Hyperliquid's all-time account PnL
    feeTier: meta.feeTier || null,
    official: meta.official || null,
    subAccounts: meta.subAccounts || [],
    accountIndexes: meta.indexes || null,
    syncedAt: cache.syncedAt || null,
    firstTs: Number.isFinite(firstTs) ? firstTs : null,
    check: meta.check || null,
  };
}

function prepare({ now, exchanges }) {
  return {
    now,
    exchanges: exchanges.map((ex) => ({
      id: ex.id,
      name: ex.name,
      appUrl: ex.appUrl,
      wallets: ex.wallets.map((w, wi) => prepareWallet(ex, w, wi, now)),
    })),
  };
}

// ---------- overview ----------
// input: the output of prepare()
function computeStats(prepared) {
  const now = prepared.now;
  const out = { generatedAt: now, ranges: Object.keys(RANGES), exchanges: {}, totals: null, daily: [], positions: [], closed: [] };

  const dayKeys = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    dayKeys.push(localDayKey(d.getTime()));
  }
  const daily = new Map(dayKeys.map((k) => [k, {}]));

  const totalFills = [];
  const totalCycles = [];
  const totalSegments = [];
  let totalFirstTs = Infinity;
  const totalOi = { notional: 0, long: 0, short: 0, count: 0 };

  for (const ex of prepared.exchanges) {
    const exFills = [];
    const exCycles = [];
    const exSegments = [];
    const oi = { notional: 0, long: 0, short: 0, count: 0 };
    const wallets = [];
    let firstTs = Infinity;
    let official = null;

    for (const pw of ex.wallets) {
      for (const f of pw.fills) {
        exFills.push(f);
        if (f.ts < firstTs) firstTs = f.ts;
        const dk = localDayKey(f.ts);
        if (daily.has(dk)) {
          const row = daily.get(dk);
          row[ex.id] = (row[ex.id] || 0) + f.sz * f.px;
        }
      }
      for (const c of pw.cycles) {
        exCycles.push(c);
        out.closed.push(c);
      }
      pushAll(exSegments, pw.segments);

      const wOi = { notional: 0, long: 0, short: 0, count: 0 };
      for (const p of pw.positions) {
        out.positions.push(p);
        wOi.notional += p.notional;
        wOi.count += 1;
        if (p.size > 0) wOi.long += p.notional;
        else wOi.short += p.notional;
      }
      addInto(oi, wOi);

      if (pw.official) {
        official = official || { lifetimeVolume: 0, windows: { '24h': 0, '7d': 0, '30d': 0 } };
        official.lifetimeVolume += pw.official.lifetimeVolume || 0;
        for (const k of ['24h', '7d', '30d']) official.windows[k] += (pw.official.windows || {})[k] || 0;
      }

      const fsAll = fillStats(pw.fills);
      const hsAll = holdStats(pw.cycles);
      wallets.push({
        label: pw.label,
        address: pw.address,
        status: pw.status,
        subAccounts: pw.subAccounts,
        accountIndexes: pw.accountIndexes,
        volume: fsAll.volume,
        fills: fsAll.fills,
        oi: wOi.notional,
        avgHoldMs: hsAll.avgHoldMs,
        equity: pw.equity,
        firstTs: pw.firstTs,
        syncedAt: pw.syncedAt,
        check: pw.check,
      });
    }

    const ranges = {};
    for (const [rk, len] of Object.entries(RANGES)) {
      const start = len === Infinity ? -Infinity : now - len;
      const fs = fillStats(exFills.filter((f) => f.ts >= start));
      const hs = holdStats(exCycles.filter((c) => c.closeTs >= start));
      const twStart = len === Infinity ? (Number.isFinite(firstTs) ? firstTs : now) : start;
      ranges[rk] = { ...fs, ...hs, twOi: exFills.length ? timeWeightedOi(exSegments, twStart, now) : null };
    }

    out.exchanges[ex.id] = {
      id: ex.id,
      name: ex.name,
      appUrl: ex.appUrl,
      wallets,
      oi,
      ranges,
      firstTs: Number.isFinite(firstTs) ? firstTs : null,
      official,
    };

    pushAll(totalFills, exFills);
    pushAll(totalCycles, exCycles);
    pushAll(totalSegments, exSegments);
    if (firstTs < totalFirstTs) totalFirstTs = firstTs;
    addInto(totalOi, oi);
  }

  const totalRanges = {};
  for (const [rk, len] of Object.entries(RANGES)) {
    const start = len === Infinity ? -Infinity : now - len;
    const fs = fillStats(totalFills.filter((f) => f.ts >= start));
    const hs = holdStats(totalCycles.filter((c) => c.closeTs >= start));
    const twStart = len === Infinity ? (Number.isFinite(totalFirstTs) ? totalFirstTs : now) : start;
    totalRanges[rk] = { ...fs, ...hs, twOi: totalFills.length ? timeWeightedOi(totalSegments, twStart, now) : null };
  }
  out.totals = { oi: totalOi, ranges: totalRanges, firstTs: Number.isFinite(totalFirstTs) ? totalFirstTs : null };
  out.daily = dayKeys.map((k) => ({ day: k, values: daily.get(k) }));
  out.positions.sort((a, b) => b.notional - a.notional);
  out.hedges = buildHedges(out.positions);
  out.closed.sort((a, b) => b.closeTs - a.closeTs);
  out.closed = out.closed.slice(0, 300);
  return out;
}

// ---------- hedges ----------
// The same asset on different exchanges: "NVDA-USD" (Arcus), "xyz:NVDA" (Entropy), "BTC-USD" (Bulk).
function assetKey(mkt) {
  let m = String(mkt || '').toUpperCase();
  if (m.includes(':')) m = m.slice(m.indexOf(':') + 1);
  return m.replace(/[-_/]?(USDC|USDT|USD|PERP)$/, '') || m;
}

// How far price must move against a position to hit its liquidation price, as a fraction of mark.
function liqDistance(p) {
  if (!(p.liq > 0) || !(p.mark > 0)) return null;
  return Math.max(0, p.size > 0 ? (p.mark - p.liq) / p.mark : (p.liq - p.mark) / p.mark);
}

// Index perps that some venues list under the index's name but price like its ETF (Entropy's
// mkts:US500 trades at SPY's price). They join the ETF's group only when the prices agree.
const SAME_AS = {
  US500: 'SPY', SPX: 'SPY', SP500: 'SPY', SPX500: 'SPY', USA500: 'SPY',
  US100: 'QQQ', NAS100: 'QQQ', NDX: 'QQQ', USTECH: 'QQQ', USTEC: 'QQQ',
  US30: 'DIA', DJI: 'DIA', DJIA: 'DIA',
  US2000: 'IWM', RUT: 'IWM',
  GOLD: 'XAU', PAXG: 'XAU', XAUT: 'XAU',
  SILVER: 'XAG',
  // The same company under another ticker (Bulk's SPACEX-USD is Arcus's SPCX-USD).
  SPACEX: 'SPCX', SPACEXUSD: 'SPCX',
};
const PRICE_MATCH = 0.03;

function hedgeGroups(positions) {
  const byAlias = new Map();
  for (const p of positions) {
    const k = assetKey(p.mkt);
    const base = SAME_AS[k] || k;
    if (!byAlias.has(base)) byAlias.set(base, []);
    byAlias.get(base).push({ p, k });
  }
  const groups = new Map();
  for (const [base, items] of byAlias) {
    const keys = [...new Set(items.map((x) => x.k))];
    const marks = items.map((x) => x.p.mark).filter((m) => m > 0);
    const agree = marks.length < 2 || Math.max(...marks) / Math.min(...marks) - 1 <= PRICE_MATCH;
    if (keys.length > 1 && agree) {
      keys.sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)));
      groups.set(keys.join(' / '), items.map((x) => x.p));
    } else {
      for (const x of items) {
        if (!groups.has(x.k)) groups.set(x.k, []);
        groups.get(x.k).push(x.p);
      }
    }
  }
  return groups;
}

// Group open positions by asset across exchanges and wallets. A group is hedged when its long
// and short sizes cancel out (within 5%), uneven when both sides exist but don't cancel, and
// open when it's one-sided.
function buildHedges(positions) {
  const groups = hedgeGroups(positions);
  const out = [];
  for (const [asset, ps] of groups) {
    const legs = ps
      .map((p) => ({
        exchange: p.exchange,
        wallet: p.wallet,
        mkt: p.mkt,
        side: p.side,
        size: p.size,
        notional: p.notional,
        mark: p.mark,
        entry: p.entry,
        lev: p.lev == null ? null : p.lev,
        liq: p.liq > 0 ? p.liq : null,
        liqEst: Boolean(p.liqEst),
        liqDist: liqDistance(p),
        exits: p.exits || null,
        upnl: p.upnl,
        fund: p.fundSince,
        openTs: p.openTs || null,
      }))
      .sort((a, b) => (a.side === b.side ? b.notional - a.notional : a.side === 'L' ? -1 : 1));
    const longSize = legs.filter((l) => l.size > 0).reduce((a, l) => a + l.size, 0);
    const shortSize = -legs.filter((l) => l.size < 0).reduce((a, l) => a + l.size, 0);
    const longUsd = legs.filter((l) => l.size > 0).reduce((a, l) => a + l.notional, 0);
    const shortUsd = legs.filter((l) => l.size < 0).reduce((a, l) => a + l.notional, 0);
    const netSize = longSize - shortSize;
    const both = longSize > 0 && shortSize > 0;
    const imbalance = both ? Math.abs(netSize) / Math.max(longSize, shortSize) : 1;
    const markAvg = legs.reduce((a, l) => a + l.notional, 0) / Math.max(1e-12, legs.reduce((a, l) => a + Math.abs(l.size), 0));
    const withDist = legs.filter((l) => l.liqDist != null);
    const nearest = withDist.length ? withDist.reduce((a, l) => (l.liqDist < a.liqDist ? l : a)) : null;
    const funds = legs.filter((l) => l.fund != null);
    out.push({
      asset,
      cls: ps[0].cls,
      legs,
      status: !both ? 'open' : imbalance <= 0.05 ? 'hedged' : 'uneven',
      longSize,
      shortSize,
      longUsd,
      shortUsd,
      netSize,
      netUsd: netSize * markAvg,
      imbalance,
      gross: longUsd + shortUsd,
      upnl: legs.reduce((a, l) => a + (l.upnl || 0), 0),
      fund: funds.length ? funds.reduce((a, l) => a + l.fund, 0) : null,
      fundPartial: funds.length > 0 && funds.length < legs.length,
      nearest: nearest ? { exchange: nearest.exchange, mkt: nearest.mkt, dist: nearest.liqDist, est: nearest.liqEst } : null,
    });
  }
  const rank = { uneven: 0, hedged: 1, open: 2 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.gross - a.gross);
}

function shortAddr(a) {
  const s = String(a || '');
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

module.exports = {
  prepare,
  computeStats,
  buildHedges,
  hedgeGroups,
  assetKey,
  reconstruct,
  timeWeightedOi,
  holdStats,
  fillStats,
  median,
  RANGES,
  HOLD_BUCKETS,
  PLAY_BUCKETS,
  HOUR,
  DAY,
};
