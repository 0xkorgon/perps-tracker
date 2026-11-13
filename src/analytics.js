'use strict';

// The Strategy view (an Arcus points routine, measured on any platform) and the
// fees view (points live in points.js). Both read the output of metrics.prepare().

const { holdStats, PLAY_BUCKETS, DAY } = require('./metrics');
const { pointsWeekStart, utcDayKey, marketStatus } = require('./markettime');

const EXCHANGE_IDS = ['arcus', 'bulk', 'entropy'];
const PLATFORMS = [...EXCHANGE_IDS, 'all'];

// The exchanges a Strategy view covers: "arcus", "arcus,entropy", "bulk+arcus" or "all".
// Returns a canonical key (exchange order, "all" for all three) and the exchange ids.
function parsePlatform(input) {
  const raw = String(input || '').toLowerCase().split(/[\s,+]+/).filter(Boolean);
  const ids = raw.includes('all') ? EXCHANGE_IDS.slice() : EXCHANGE_IDS.filter((id) => raw.includes(id));
  if (!ids.length) return { key: 'arcus', ids: ['arcus'] };
  return { key: ids.length === EXCHANGE_IDS.length ? 'all' : ids.join(','), ids };
}
const WINDOWS = {
  thisWeek: 'This points week',
  lastWeek: 'Last points week',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All tracked history',
};

// ---------- the strategy checklist ----------
// `bench` is the benchmark trader's own number (from his Arcus points dashboard and messages).
// Targets default to those numbers and can be edited in the dashboard.
const RULES = [
  { id: 'oiNow', label: 'Keep $7–8K of OI open', quote: 'Min 7k 8k oi', why: 'Notional you have open right now, at mark price.', bench: '$7.6K open', unit: 'usd', cmp: 'gte', target: 7000 },
  { id: 'oi24h', label: 'Hold that OI 24 hours a day', quote: '24 saat tutuyorum', why: 'Share of the time your OI was at or above the $ target above.', bench: '24 h a day', unit: 'pct', cmp: 'gte', target: 0.9 },
  { id: 'roundTrips', label: 'Open & close 2–3 times a day', quote: 'Günde 2 3 kere aç kapa yapıyorum', why: 'Closed positions per day. Each rotation of ~$7.5K is ~$15K of volume.', bench: '2–3 a day', unit: 'perDay', cmp: 'between', target: [2, 3] },
  { id: 'stocks', label: 'Trade stocks & ETFs, not crypto', why: 'Arcus says its points boost stocks and RWA.', bench: '92.4% of volume', unit: 'pct', cmp: 'gte', target: 0.9 },
  { id: 'offHours', label: 'Trade outside US market hours', why: 'Arcus also boosts trading outside regular US hours (US session: 4am–8pm ET, trading days).', bench: '39.5% off-hours', unit: 'pct', cmp: 'gte', target: 0.35 },
  { id: 'hold', label: 'Hold positions 1–24 hours', why: 'Share of closed positions held between 1 hour and 1 day.', bench: '134 of 140 (96%)', unit: 'pct', cmp: 'gte', target: 0.8 },
  { id: 'noFlips', label: 'No quick flips under 10 min', why: 'Share of closed positions held under 10 minutes.', bench: '~1%', unit: 'pct', cmp: 'lte', target: 0.05 },
  { id: 'everyDay', label: 'Trade every day', why: 'Days with at least one fill, out of the days in the window.', bench: '7 of 7 days', unit: 'pct', cmp: 'gte', target: 1 },
  { id: 'volume', label: '~$250K volume per points week', why: 'Scaled to the length of the window you pick.', bench: '$251.0K', unit: 'usdWeek', cmp: 'gte', target: 250000 },
  { id: 'maker', label: 'Use maker orders for 35%+ of volume', why: 'Maker fills cost 0 bps on Arcus tier 0.', bench: '37.2% maker', unit: 'pct', cmp: 'gte', target: 0.35 },
  { id: 'fees', label: 'Keep fees under 1.5 bps of volume', why: 'Fees paid ÷ volume.', bench: '$33.58 on $251K = 1.34 bps', unit: 'bps', cmp: 'lte', target: 1.5 },
  { id: 'breakeven', label: 'Break even or better', why: 'Realised PnL + funding − fees.', bench: '+$7 net', unit: 'usd', cmp: 'gte', target: 0 },
];

// ---------- Bulk only: trading AURA habits ----------
// The habits, targets and tips come from the AURA model (src/model.js): the public model's are
// general; an owner build adds its own.
const model = require('./model');
const BULK_HOLD = model.hold || { perHour: null, week: 168 };
const { holdMult } = require('./estimate-core');
const BULK_CREDIT = (model.ref && model.ref.credit) || 1;
const REF = model.ref || null;
const BULK_RULES = model.bulkRules;
const BULK_LABELS = {
  bVolume: (t) => `${shortUsd(t)}+ taker volume per AURA week`,
  bTaker: (t) => `Take liquidity for ${Math.round(t * 100)}%+ of volume`,
  bHold: (t) => `Hold multiplier of ${(+t).toFixed(2)}× or more`,
  bCore: (t) => `Keep a position open ${Math.round(t * 100)}%+ of the week`,
  bCost: (t) => `Pay under ${shortUsd(t)} in fees per 1,000 AURA`,
  bQualify: (t) => `${shortUsd(t)}+ volume to qualify for leagues`,
};

const shortUsd = (n) => {
  const abs = Math.abs(n);
  const trim = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1).replace(/\.0$/, '') : x.toFixed(2).replace(/\.?0+$/, ''));
  for (const [v, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (abs >= v) return `$${trim(abs / v)}${u}`;
  return `$${trim(abs)}`;
};

// Labels follow the target once you change it (the default wording otherwise).
const LABELS = {
  oiNow: (t, d) => (t === d ? 'Keep $7–8K of OI open' : `Keep ${shortUsd(t)}+ of OI open`),
  roundTrips: (t) => `Open & close ${t[0]}–${t[1]} times a day`,
  stocks: (t) => (t >= 0.999 ? 'Trade only stocks & ETFs' : 'Trade stocks & ETFs, not crypto'),
  volume: (t, d) => (t === d ? '~$250K volume per points week' : `${shortUsd(t)}+ volume per points week`),
  maker: (t) => `Use maker orders for ${Math.round(t * 100)}%+ of volume`,
  fees: (t) => `Keep fees under ${t} bps of volume`,
};

function defaultTargets(rules = RULES) {
  return Object.fromEntries(rules.map((r) => [r.id, r.target]));
}

// Validate saved targets against the rule definitions.
function cleanTargets(input, rules = RULES) {
  const out = defaultTargets(rules);
  const src = input && typeof input === 'object' ? input : {};
  for (const r of rules) {
    const v = src[r.id];
    if (r.cmp === 'between') {
      if (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(Number(x)))) {
        const a = Math.max(0, Number(v[0]));
        const b = Math.max(a, Number(v[1]));
        out[r.id] = [a, b];
      }
    } else if (v != null && Number.isFinite(Number(v))) {
      out[r.id] = Number(v);
    }
  }
  return out;
}

function cleanDisabled(input, rules = RULES) {
  const ids = new Set(rules.map((r) => r.id));
  return Array.isArray(input) ? [...new Set(input.filter((x) => ids.has(x)))] : [];
}

// ---------- windows ----------
// Bulk's AURA weeks run Saturday 12:30 to Saturday 12:30 UTC.
const BULK_WEEK_ANCHOR = Date.UTC(2026, 8, 26, 12, 30);
const WEEK_MS = 7 * DAY;
function bulkWeekStart(ts) {
  return BULK_WEEK_ANCHOR + Math.floor((ts - BULK_WEEK_ANCHOR) / WEEK_MS) * WEEK_MS;
}
const BULK_WINDOWS = { thisWeek: 'This AURA week', lastWeek: 'Last AURA week' };

function windowFor(key, now, firstTs, bulk = false) {
  const wk = bulk ? bulkWeekStart(now) : pointsWeekStart(now);
  const label = (k) => (bulk && BULK_WINDOWS[k]) || WINDOWS[k];
  if (key === 'lastWeek') {
    const start = bulk ? wk - WEEK_MS : pointsWeekStart(wk - 1);
    return { key, label: label(key), start, end: wk, fullLen: wk - start, live: false };
  }
  if (key === '7d') return { key, label: WINDOWS[key], start: now - 7 * DAY, end: now, fullLen: 7 * DAY, live: true };
  if (key === '30d') return { key, label: WINDOWS[key], start: now - 30 * DAY, end: now, fullLen: 30 * DAY, live: true };
  if (key === 'all') {
    const start = Number.isFinite(firstTs) && firstTs < now ? firstTs : now - DAY;
    return { key, label: WINDOWS[key], start, end: now, fullLen: Math.max(DAY, now - start), live: true };
  }
  return { key: 'thisWeek', label: label('thisWeek'), start: wk, end: now, fullLen: 7 * DAY, live: true, inProgress: true };
}

// ---------- open interest timeline ----------
// Total OI over time as [from, to, usd] steps, built from per-market position segments.
function oiTimeline(segments) {
  const ev = [];
  for (const s of segments) {
    if (s.to > s.from && s.notional > 0) {
      ev.push([s.from, s.notional]);
      ev.push([s.to, -s.notional]);
    }
  }
  ev.sort((a, b) => a[0] - b[0]);
  const steps = [];
  let total = 0;
  for (let i = 0; i < ev.length; i++) {
    total += ev[i][1];
    const next = i + 1 < ev.length ? ev[i + 1][0] : null;
    if (next !== null && next > ev[i][0]) steps.push([ev[i][0], next, Math.max(0, total)]);
  }
  return steps;
}

function oiStats(steps, start, end, threshold) {
  let area = 0;
  let peak = 0;
  let above = 0;
  for (const [a, b, v] of steps) {
    const x = Math.max(a, start);
    const y = Math.min(b, end);
    if (y <= x) continue;
    area += v * (y - x);
    if (v > peak) peak = v;
    if (v >= threshold) above += y - x;
  }
  const span = end - start;
  return { avg: span > 0 ? area / span : null, peak, coverage: span > 0 ? above / span : null };
}

const utcDayStart = (ts) => Math.floor(ts / DAY) * DAY;

// ---------- strategy ----------
function computeStrategy(prepared, { platform = 'arcus', window = 'thisWeek', targets, disabled = [], bulkTargets, bulkDisabled = [], aura = null } = {}) {
  const now = prepared.now;
  const sel = parsePlatform(platform);
  const onlyBulk = sel.ids.length === 1 && sel.ids[0] === 'bulk';
  const tg = onlyBulk ? cleanTargets(bulkTargets, BULK_RULES) : cleanTargets(targets);
  const off = new Set(onlyBulk ? cleanDisabled(bulkDisabled, BULK_RULES) : cleanDisabled(disabled));
  const exs = prepared.exchanges.filter((e) => sel.ids.includes(e.id));
  const wallets = exs.flatMap((e) => e.wallets);
  // Picked exchanges with no wallet yet (shown as a note when others in the pick have one).
  const missing = sel.ids.filter((id) => !exs.some((e) => e.id === id && e.wallets.length));
  let firstTs = Infinity;
  for (const w of wallets) if (w.firstTs && w.firstTs < firstTs) firstTs = w.firstTs;
  const W = windowFor(window, now, firstTs, onlyBulk);
  const end = Math.min(W.end, now);
  const inW = (ts) => ts >= W.start && ts <= end;
  const windowDays = Math.max(0, end - W.start) / DAY;
  const periods = Math.max(1, Math.ceil(windowDays - 1e-9));

  // --- fills ---
  let volume = 0;
  let fills = 0;
  let makerVol = 0;
  let makerFills = 0;
  let fees = 0;
  let stocksVol = 0;
  let offVol = 0;
  let cryptoVol = 0;
  const activePeriods = new Set();
  const markets = new Map();
  const dayRows = new Map();
  const firstDay = utcDayStart(window === 'all' ? Math.max(W.start, end - 35 * DAY) : W.start);
  for (let d = firstDay; d <= end; d += DAY) dayRows.set(d, { day: utcDayKey(d), crypto: 0, stocksUs: 0, stocksOff: 0, taker: 0, maker: 0, fees: 0, pnl: 0, funding: 0, oiAvg: 0, oiPeak: 0 });
  const heatStart = utcDayStart(now) - 111 * DAY; // 16 weeks
  const heat = new Map();

  for (const w of wallets) {
    for (const f of w.rich) {
      if (f.ts >= heatStart && f.ts <= now) {
        const d = utcDayStart(f.ts);
        heat.set(d, (heat.get(d) || 0) + f.n);
      }
      if (!inW(f.ts)) continue;
      volume += f.n;
      fills += 1;
      fees += f.fee;
      if (f.role === 'M') {
        makerVol += f.n;
        makerFills += 1;
      }
      if (f.cls === 'stocks') {
        stocksVol += f.n;
        if (!f.us) offVol += f.n;
      } else cryptoVol += f.n;
      activePeriods.add(Math.floor((f.ts - W.start) / DAY));
      const mk = `${f.ex}|${f.mkt}`;
      if (!markets.has(mk)) markets.set(mk, { exchange: f.ex, mkt: f.mkt, cls: f.cls, volume: 0, fills: 0, fees: 0, pnl: 0, funding: 0 });
      const m = markets.get(mk);
      m.volume += f.n;
      m.fills += 1;
      m.fees += f.fee;
      const row = dayRows.get(utcDayStart(f.ts));
      if (row) {
        if (f.cls === 'stocks') row[f.us ? 'stocksUs' : 'stocksOff'] += f.n;
        else row.crypto += f.n;
        row[f.role === 'M' ? 'maker' : 'taker'] += f.n;
        row.fees += f.fee;
      }
    }
  }

  // --- PnL, funding, deposits ---
  let pnl = 0;
  let funding = 0;
  let depIn = 0;
  let depOut = 0;
  const addToMarket = (ex, mkt, field, amt) => {
    const mk = `${ex}|${mkt}`;
    if (markets.has(mk)) markets.get(mk)[field] += amt;
  };
  for (const w of wallets) {
    for (const e of w.pnlEvents) {
      if (!inW(e.ts)) continue;
      pnl += e.amt;
      addToMarket(e.ex, e.mkt, 'pnl', e.amt);
      const row = dayRows.get(utcDayStart(e.ts));
      if (row) row.pnl += e.amt;
    }
    for (const e of w.funding) {
      if (!inW(e.ts)) continue;
      funding += e.amt;
      addToMarket(e.ex, e.mkt, 'funding', e.amt);
      const row = dayRows.get(utcDayStart(e.ts));
      if (row) row.funding += e.amt;
    }
    for (const t of w.transfers) {
      if (!inW(t.ts)) continue;
      if (t.dir === 'in') depIn += t.amt;
      else depOut += t.amt;
    }
  }
  const net = pnl + funding - fees;

  // --- open interest ---
  const segments = wallets.flatMap((w) => w.segments);
  const steps = oiTimeline(segments);
  const oiTarget = onlyBulk ? 1 : Number(tg.oiNow) || 0;
  const oiW = oiStats(steps, W.start, end, oiTarget);
  const positions = wallets.flatMap((w) => w.positions);
  const oiNow = positions.reduce((a, p) => a + p.notional, 0);
  const oiPeak = Math.max(oiW.peak || 0, W.live ? oiNow : 0);
  for (const [d, row] of dayRows) {
    const s = oiStats(steps, Math.max(d, W.start), Math.min(d + DAY, end), oiTarget);
    row.oiAvg = s.avg || 0;
    row.oiPeak = s.peak || 0;
  }
  if (W.live && dayRows.has(utcDayStart(now))) {
    const today = dayRows.get(utcDayStart(now));
    today.oiPeak = Math.max(today.oiPeak, oiNow);
  }

  // --- holding time ---
  const cyclesW = wallets.flatMap((w) => w.cycles).filter((c) => inW(c.closeTs));
  const hs = holdStats(cyclesW, PLAY_BUCKETS);
  const bucket = (k) => (hs.buckets.find((b) => b.key === k) || { count: 0 }).count;
  const closed = hs.closed;
  const share1to24 = closed ? (bucket('h6') + bucket('h24')) / closed : null;
  const shareUnder10m = closed ? (bucket('lt1m') + bucket('m10')) / closed : null;
  const perDay = closed / Math.max(windowDays, 1);

  // --- equity / tier ---
  const eqs = wallets.map((w) => w.equity).filter((x) => Number.isFinite(x));
  const equity = eqs.length ? eqs.reduce((a, b) => a + b, 0) : null;
  const nds = wallets.map((w) => w.netDeposits).filter((x) => Number.isFinite(x));
  const lifetimeNetDeposits = nds.length ? nds.reduce((a, b) => a + b, 0) : null;
  const tiers = wallets.map((w) => w.feeTier).filter(Boolean);
  const feeTier = sel.ids.length === 1 && tiers.length ? tiers[0] : null; // tiers differ per exchange

  // --- daily series + cumulative result ---
  const daily = [...dayRows.values()];
  let cp = 0;
  let cf = 0;
  let cfee = 0;
  const cumulative = daily.map((d) => {
    cp += d.pnl;
    cf += d.funding;
    cfee += d.fees;
    return { day: d.day, pnl: cp, funding: cf, fees: cfee, net: cp + cf - cfee };
  });

  // --- activity heatmap (16 weeks, UTC days) ---
  const heatDays = [];
  let busiest = null;
  let heatActive = 0;
  for (let d = heatStart; d <= utcDayStart(now); d += DAY) {
    const vol = heat.get(d) || 0;
    heatDays.push({ day: utcDayKey(d), dow: new Date(d).getUTCDay(), vol });
    if (vol > 0) heatActive += 1;
    if (vol > 0 && (!busiest || vol > busiest.vol)) busiest = { day: utcDayKey(d), vol };
  }

  const marketRows = [...markets.values()]
    .map((m) => ({ ...m, share: volume > 0 ? m.volume / volume : 0, net: m.pnl + m.funding - m.fees }))
    .sort((a, b) => b.volume - a.volume);

  const k = {
    volume,
    fills,
    avgFill: fills ? volume / fills : null,
    makerShare: volume > 0 ? makerVol / volume : null,
    makerVolume: makerVol,
    takerVolume: volume - makerVol,
    makerFills,
    fees,
    feeBps: volume > 0 ? (fees / volume) * 1e4 : null,
    feeTier,
    funding,
    pnl,
    net,
    oiAvg: oiW.avg,
    oiPeak,
    oiNow: W.live ? oiNow : null,
    oiCoverage: oiW.coverage,
    equity,
    lifetimeNetDeposits,
    depIn,
    depOut,
    stocksVolume: stocksVol,
    cryptoVolume: cryptoVol,
    stocksShare: volume > 0 ? stocksVol / volume : null,
    offHoursVolume: offVol,
    offHoursShare: stocksVol > 0 ? offVol / stocksVol : null,
    activeDays: activePeriods.size,
    periods,
    windowDays,
    closed,
    perDay,
    share1to24,
    shareUnder10m,
    avgHoldMs: hs.avgHoldMs,
    medianHoldMs: hs.medianHoldMs,
    marketsTraded: markets.size,
  };

  let bulk = null;
  let checklist;
  if (onlyBulk) {
    bulk = bulkView(k, cyclesW, aura, W, now, ((oiW.avg || 0) * Math.max(0, end - W.start)) / 3600e3);
    checklist = evaluateBulkRules(k, bulk, tg, off, { W, now, hasWallets: wallets.length > 0 });
  } else checklist = evaluateRules(k, tg, off, { ids: sel.ids, W, now, hasWallets: wallets.length > 0 });

  return {
    platform: sel.key,
    platforms: sel.ids,
    mode: onlyBulk ? 'bulk' : 'points',
    bulk,
    missing,
    window: { key: W.key, label: W.label, start: W.start, end, live: W.live, inProgress: Boolean(W.inProgress), fullLen: W.fullLen },
    hasWallets: wallets.length > 0,
    kpis: k,
    holdBuckets: hs.buckets,
    daily,
    cumulative,
    heatmap: { days: heatDays, activeDays: heatActive, busiest },
    markets: marketRows.slice(0, 60),
    checklist,
    // Hold timers cover every exchange: a position held on Entropy still counts toward the habit.
    openPositions: prepared.exchanges
      .flatMap((e) => e.wallets.flatMap((w) => w.positions))
      .map((p) => ({ exchange: p.exchange, mkt: p.mkt, side: p.side, notional: p.notional, openTs: p.openTs || null }))
      .sort((a, b) => (a.openTs || Infinity) - (b.openTs || Infinity)),
    targets: tg,
    disabled: [...off],
    market: marketStatus(now),
    generatedAt: now,
  };
}

function evaluateRules(k, tg, off, { ids, W, now, hasWallets }) {
  const items = [];
  const onlyBulk = ids.length === 1 && ids[0] === 'bulk';
  const withBulk = ids.includes('bulk');
  const elapsedShare = W.fullLen > 0 ? Math.min(1, Math.max(0, now - W.start) / W.fullLen) : 1;
  for (const r of RULES) {
    const target = tg[r.id];
    let value = null;
    let note = '';
    let applicable = hasWallets && k.fills > 0;
    switch (r.id) {
      case 'oiNow':
        value = k.oiNow;
        applicable = hasWallets && W.live;
        if (!W.live) note = 'Live check: switch to a window that includes now.';
        break;
      case 'oi24h':
        value = k.oiCoverage;
        applicable = hasWallets && Number.isFinite(value);
        note = `Time with OI ≥ $${Math.round(tg.oiNow).toLocaleString('en-US')}.`;
        break;
      case 'roundTrips':
        value = k.perDay;
        applicable = hasWallets && k.fills > 0;
        note = `${k.closed} closed over ${Math.max(1, k.windowDays).toFixed(1)} days.`;
        break;
      case 'stocks':
        value = k.stocksShare;
        if (onlyBulk) {
          applicable = false;
          note = 'Doesn’t apply on Bulk: it only lists crypto';
        } else if (withBulk) note = 'Bulk volume counts as crypto (Bulk only lists crypto)';
        break;
      case 'offHours':
        value = k.offHoursShare;
        applicable = applicable && k.stocksVolume > 0;
        if (onlyBulk) {
          applicable = false;
          note = 'Doesn’t apply on Bulk: it only lists crypto';
        } else if (k.stocksVolume <= 0) note = 'Needs stock or ETF volume first';
        break;
      case 'hold':
        value = k.share1to24;
        applicable = hasWallets && k.closed > 0;
        if (!k.closed) note = 'Scored once a position closes in this window';
        break;
      case 'noFlips':
        value = k.shareUnder10m;
        applicable = hasWallets && k.closed > 0;
        if (!k.closed) note = 'Scored once a position closes in this window';
        break;
      case 'everyDay':
        value = k.periods ? k.activeDays / k.periods : null;
        note = `${k.activeDays} of ${k.periods} day${k.periods > 1 ? 's' : ''}.`;
        break;
      case 'volume': {
        const scaled = target * (W.fullLen / (7 * DAY));
        value = k.volume;
        if (W.inProgress && elapsedShare > 0 && elapsedShare < 1) note = `On pace for $${Math.round(k.volume / elapsedShare).toLocaleString('en-US')} this week.`;
        else if (Math.abs(scaled - target) > 1) note = `Target scaled to this window: $${Math.round(scaled).toLocaleString('en-US')}.`;
        items.push(finish(r, value, scaled, applicable, note, off, target));
        continue;
      }
      case 'maker':
        value = k.makerShare;
        break;
      case 'fees':
        value = k.feeBps;
        break;
      case 'breakeven':
        value = k.net;
        if (withBulk) note = 'Bulk PnL counts once a position is fully closed.';
        break;
      default:
        break;
    }
    items.push(finish(r, value, target, applicable, note, off));
  }
  const active = items.filter((i) => !i.disabled && i.state !== 'na');
  return { items, passed: active.filter((i) => i.state === 'pass').length, total: active.length };
}

// Your trading AURA picture for the window: hold multiplier from your closed positions, what the
// volume should earn, what holding longer would add, and the measured facts behind the habits.
const HOLD_BUCKETS_H = [
  { key: 'lt10m', label: '< 10 min', max: 1 / 6, mid: 0.05 },
  { key: 'm60', label: '10 min–1 h', max: 1, mid: 0.4 },
  { key: 'h6', label: '1–6 h', max: 6, mid: 3 },
  { key: 'h24', label: '6–24 h', max: 24, mid: 14 },
  { key: 'd3', label: '1–3 days', max: 72, mid: 44 },
  { key: 'd7', label: '3–7 days', max: 168, mid: 110 },
  { key: 'gt7', label: '7 days +', max: Infinity, mid: 168 },
];
function bulkView(k, cycles, aura, W, now, oiHours = 0) {
  // This week's rates (your estimate's, else week 5's typical with Bulk's typical credit).
  // A revealed week on its own: the rates that week actually paid you (`eff`, measured from what
  // Bulk paid for your activity), else that week's rules with your credit.
  const r = aura && aura.rates ? aura.rates : null;
  const found = aura && Array.isArray(aura.weeks) ? aura.weeks.find((x) => Math.abs(x.start - W.start) < 60e3 && Math.abs(x.end - W.end) < 60e3) : null;
  const wk = found && ((found.eff && found.eff.taker > 0) || found.rules) ? found : null;
  const credit = r && r.credit > 0 ? r.credit : BULK_CREDIT;
  const mine = aura && Number.isFinite(aura.perDollar) && aura.perDollar > 0;
  const wkRates = wk ? (wk.eff && wk.eff.taker > 0 ? wk.eff : { taker: wk.rules.taker * credit, oiHour: wk.rules.oiHour * credit }) : null;
  // Without a model for open positions (the public build), only taker volume is counted.
  const perDollar = wkRates ? wkRates.taker : mine ? aura.perDollar : REF ? REF.taker * BULK_CREDIT : 0;
  const oiRate = (wkRates ? wkRates.oiHour : r && r.oiHour > 0 ? r.oiHour : REF ? REF.oiHour * BULK_CREDIT : 0) || 0;
  const perHour = wkRates && wkRates.oiHour > 0 ? wkRates.oiHour / (2 * wkRates.taker) : r && r.perHour > 0 ? r.perHour : BULK_HOLD.perHour || null;
  let vol = 0;
  let weighted = 0;
  let hoursW = 0;
  const buckets = HOLD_BUCKETS_H.map((b) => ({ key: b.key, label: b.label, volume: 0, mult: holdMult(b.mid, perHour) }));
  for (const c of cycles) {
    const h = c.holdMs / 3600e3;
    const v = c.vol || 0;
    if (!(v > 0)) continue;
    vol += v;
    weighted += v * holdMult(h, perHour);
    hoursW += v * h;
    const i = HOLD_BUCKETS_H.findIndex((b) => h < b.max);
    buckets[i === -1 ? buckets.length - 1 : i].volume += v;
  }
  const mult = vol > 0 ? weighted / vol : null;
  const takerShare = k.volume > 0 ? k.takerVolume / k.volume : null;
  const est = k.takerVolume * perDollar + Math.max(0, oiHours) * oiRate;
  const avgH = vol > 0 ? hoursW / vol : null;
  // The same round trips with each position held a day longer: half their volume open 24 h more.
  const plusDay = vol > 0 ? (vol / 2) * 24 * oiRate : null;
  return {
    holdMult: perHour > 0 ? mult : null,
    holdKnown: perHour > 0,
    avgHoldH: avgH,
    closedVolume: vol,
    buckets,
    takerShare,
    perDollar,
    oiRate,
    oiHours,
    perDollarSource: wk ? 'week' : mine ? 'yours' : 'typical',
    rateWeek: wk ? wk.week : null,
    auraEstimate: est,
    plusDayHold: plusDay,
    costPer1k: est > 0 ? (k.fees / est) * 1000 : null,
    oiTimeShare: k.oiCoverage,
    weekEstimate: aura && aura.estimate ? aura.estimate : null,
    lastWeek: aura && aura.lastWeek ? aura.lastWeek : null,
    model: { perHour, taker: perDollar, oiHour: oiRate, week: 168 },
    tips: bulkTips(perDollar, oiRate, mine),
  };
}

const bulkTips = (perDollar, oiRate, mine) => model.bulkTips(perDollar, oiRate, mine);

function evaluateBulkRules(k, b, tg, off, { W, now, hasWallets }) {
  const items = [];
  const elapsedShare = W.fullLen > 0 ? Math.min(1, Math.max(0, now - W.start) / W.fullLen) : 1;
  for (const r of BULK_RULES) {
    const target = tg[r.id];
    let value = null;
    let note = '';
    let applicable = hasWallets && k.fills > 0;
    let useTarget = target;
    switch (r.id) {
      case 'bVolume':
        value = k.takerVolume;
        useTarget = target * (W.fullLen / (7 * DAY));
        if (W.inProgress && elapsedShare > 0 && elapsedShare < 1) note = `On pace for $${Math.round(k.takerVolume / elapsedShare).toLocaleString('en-US')} of taker volume this week.`;
        else if (Math.abs(useTarget - target) > 1) note = `Target scaled to this window: $${Math.round(useTarget).toLocaleString('en-US')}.`;
        break;
      case 'bTaker':
        value = b.takerShare;
        if (k.makerVolume > 0) note = `$${Math.round(k.makerVolume).toLocaleString('en-US')} of maker volume earned no trading AURA.`;
        break;
      case 'bHold':
        value = b.holdMult;
        applicable = hasWallets && b.closedVolume > 0;
        note =
          b.closedVolume > 0
            ? `Average hold ${b.avgHoldH < 1 ? `${Math.round(b.avgHoldH * 60)} min` : `${b.avgHoldH.toFixed(1)} h`}, weighted by volume.${b.plusDayHold > 0.5 ? ` The same volume held a day longer per position would earn about ${Math.round(b.plusDayHold).toLocaleString('en-US')} more AURA.` : ''}`
            : 'Scored once a position closes in this window';
        break;
      case 'bCore':
        value = b.oiTimeShare;
        applicable = hasWallets && Number.isFinite(value);
        break;
      case 'bCost':
        value = b.costPer1k;
        applicable = hasWallets && b.auraEstimate > 0;
        if (b.auraEstimate > 0) note = `$${k.fees.toFixed(2)} in fees for about ${Math.round(b.auraEstimate).toLocaleString('en-US')} AURA.`;
        break;
      case 'bQualify':
        value = k.volume;
        if (W.fullLen > 7 * DAY + 1) {
          value = k.volume / (W.fullLen / (7 * DAY));
          note = 'Average per week over this window.';
        } else if (W.inProgress && elapsedShare > 0 && elapsedShare < 1 && k.volume < target) note = `On pace for $${Math.round(k.volume / elapsedShare).toLocaleString('en-US')} this week.`;
        break;
      case 'bBreakeven':
        value = k.net;
        break;
      default:
        break;
    }
    items.push(finish({ ...r, rulesLabels: BULK_LABELS }, value, useTarget, applicable, note, off, target));
  }
  const active = items.filter((i) => !i.disabled && i.state !== 'na');
  return { items, passed: active.filter((i) => i.state === 'pass').length, total: active.length };
}

function finish(r, value, target, applicable, note, off, labelTarget = target) {
  let state = 'na';
  if (applicable && value != null && Number.isFinite(value)) {
    let pass;
    if (r.cmp === 'gte') pass = value >= target - 1e-12;
    else if (r.cmp === 'lte') pass = value <= target + 1e-12;
    else pass = value >= target[0] - 1e-12 && value <= target[1] + 1e-12;
    state = pass ? 'pass' : 'fail';
  }
  const labels = r.rulesLabels || LABELS;
  const label = labels[r.id] ? labels[r.id](labelTarget, r.target) : r.label;
  return { id: r.id, label, quote: r.quote || null, why: r.why, bench: r.bench, unit: r.unit, cmp: r.cmp, value, target, state, note, disabled: off.has(r.id) };
}

// ---------- fees ----------
function computeFees(prepared, { window = '30d' } = {}) {
  const now = prepared.now;
  let firstTs = Infinity;
  for (const e of prepared.exchanges) for (const w of e.wallets) if (w.firstTs && w.firstTs < firstTs) firstTs = w.firstTs;
  const W = windowFor(window, now, firstTs);
  const end = Math.min(W.end, now);
  const inW = (ts) => ts >= W.start && ts <= end;

  // Fees per UTC day (per UTC week when the window is longer than ~3 months), by exchange.
  const firstDay = Date.UTC(new Date(W.start).getUTCFullYear(), new Date(W.start).getUTCMonth(), new Date(W.start).getUTCDate());
  const weekly = end - firstDay > 92 * DAY;
  const bucketOf = (ts) => {
    const d = Date.UTC(new Date(ts).getUTCFullYear(), new Date(ts).getUTCMonth(), new Date(ts).getUTCDate());
    return weekly ? d - ((new Date(d).getUTCDay() + 6) % 7) * DAY : d; // weeks start Monday
  };
  const buckets = new Map();
  for (let d = bucketOf(firstDay); d <= end; d += weekly ? 7 * DAY : DAY) buckets.set(d, { day: utcDayKey(d), bulk: 0, arcus: 0, entropy: 0 });

  const byExchange = prepared.exchanges.map((e) => {
    const r = { id: e.id, name: e.name, wallets: e.wallets.length, fees: 0, makerFees: 0, takerFees: 0, volume: 0, makerVolume: 0, takerVolume: 0, fills: 0, funding: 0, stocksVolume: 0, feeTier: null, lifetimeFees: 0, lifetimeVolume: 0 };
    for (const w of e.wallets) {
      if (!r.feeTier && w.feeTier) r.feeTier = w.feeTier;
      for (const f of w.rich) {
        r.lifetimeFees += f.fee;
        r.lifetimeVolume += f.n;
        if (!inW(f.ts)) continue;
        r.fees += f.fee;
        r.volume += f.n;
        r.fills += 1;
        const b = buckets.get(bucketOf(f.ts));
        if (b && b[e.id] != null) b[e.id] += f.fee;
        if (f.role === 'M') {
          r.makerFees += f.fee;
          r.makerVolume += f.n;
        } else {
          r.takerFees += f.fee;
          r.takerVolume += f.n;
        }
        if (f.cls === 'stocks') r.stocksVolume += f.n;
      }
      for (const x of w.funding) if (inW(x.ts)) r.funding += x.amt;
    }
    r.bps = r.volume > 0 ? (r.fees / r.volume) * 1e4 : null;
    return r;
  });
  const sum = (key) => byExchange.reduce((a, r) => a + r[key], 0);
  const totals = {
    fees: sum('fees'),
    makerFees: sum('makerFees'),
    takerFees: sum('takerFees'),
    volume: sum('volume'),
    makerVolume: sum('makerVolume'),
    takerVolume: sum('takerVolume'),
    fills: sum('fills'),
    funding: sum('funding'),
    stocksVolume: sum('stocksVolume'),
  };
  totals.bps = totals.volume > 0 ? (totals.fees / totals.volume) * 1e4 : null;

  return {
    window: { key: W.key, label: W.label, start: W.start, end },
    byExchange,
    totals,
    daily: { unit: weekly ? 'week' : 'day', rows: [...buckets.values()] },
    generatedAt: now,
  };
}

module.exports = { computeStrategy, computePlaybook: computeStrategy, computeFees, cleanTargets, cleanDisabled, defaultTargets, parsePlatform, RULES, BULK_RULES, BULK_HOLD, holdMult, bulkWeekStart, WINDOWS, PLATFORMS, oiTimeline, oiStats, windowFor };
