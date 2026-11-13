#!/usr/bin/env node
'use strict';

// Perps tracker: volume, open interest and hold time across Bulk, Arcus and Entropy.
// Run `node server.js` (or double-click start.bat) and open http://localhost:8787.
//   --once      sync once, print a summary, exit
//   --no-open   don't open the browser automatically
//   --port N    use another port

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { URL } = require('url');

const crypto = require('crypto');
const api = require('./src/http');
const { prepare, computeStats, hedgeGroups } = require('./src/metrics');
const analytics = require('./src/analytics');
const { Store, writeJsonAtomic } = require('./src/store');
const markettime = require('./src/markettime');
const points = require('./src/points');
const portfolio = require('./src/portfolio');
const alerts = require('./src/alerts');
const notify = require('./src/notify');
const security = require('./src/security');
const leagues = require('./src/leagues');
const estimate = require('./src/estimate');
const referrals = require('./src/referrals');
const { MarketWatch } = require('./src/watch');

const EXCHANGES = [
  require('./src/exchanges/bulk'),
  require('./src/exchanges/arcus'),
  require('./src/exchanges/entropy'),
];
const BY_ID = Object.fromEntries(EXCHANGES.map((e) => [e.id, e]));

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

// ---------- config ----------

function defaultConfig() {
  return {
    port: 8787,
    refreshSeconds: 60,
    wallets: { bulk: [], arcus: [], entropy: [] },
    targets: analytics.defaultTargets(),
    disabled: [],
    bulkTargets: analytics.defaultTargets(analytics.BULK_RULES),
    bulkDisabled: [],
    points: [],
    leagueRewards: [], // what Bulk's league payouts paid you, as you logged them
    arcusPointsName: '',
    alerts: alerts.cleanSettings({}),
    profile: null, // from the first-run setup: your name, the exchanges you use, what you want from it
    onboardedAt: null,
    tourDone: false,
    myCodes: [], // your own referral codes (Referrals page)
  };
}

// Your answers from the first-run setup.
const GOALS = ['aura', 'arcus', 'hedge', 'fees', 'alerts'];
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const ex = (Array.isArray(p.exchanges) ? p.exchanges : []).filter((x) => ['bulk', 'arcus', 'entropy'].includes(x));
  const noAccount = (Array.isArray(p.noAccount) ? p.noAccount : []).filter((x) => ['bulk', 'arcus', 'entropy'].includes(x));
  return { name: cleanName(p.name).slice(0, 30), exchanges: [...new Set(ex)], noAccount: [...new Set(noAccount)], goals: (Array.isArray(p.goals) ? p.goals : []).filter((g) => GOALS.includes(g)).slice(0, GOALS.length) };
}

const SERIES_KEYS = new Set(points.POINT_SERIES.map((s) => s.key));
const cleanName = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60);
function cleanPoints(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && SERIES_KEYS.has(p.series) && Number.isFinite(Number(p.value)) && Number.isFinite(Number(p.at)))
    .map((p) => ({ id: String(p.id || crypto.randomUUID()), series: p.series, value: Number(p.value), at: Number(p.at) }))
    .slice(-2000);
}

function cleanWallets(input) {
  const out = {};
  const errors = [];
  for (const ex of EXCHANGES) {
    const seen = new Set();
    out[ex.id] = [];
    const list = input && Array.isArray(input[ex.id]) ? input[ex.id] : [];
    for (const w of list) {
      const address = String((w && w.address) || '').trim();
      if (!address) continue;
      const label = String((w && w.label) || '').trim().slice(0, 40);
      const problem = ex.validate(address);
      if (problem) {
        errors.push(`${ex.name}: ${address.slice(0, 12)}… - ${problem}`);
        continue;
      }
      const k = /^0x/i.test(address) ? address.toLowerCase() : address;
      if (seen.has(k)) continue;
      seen.add(k);
      out[ex.id].push({ address, label });
    }
  }
  return { wallets: out, errors };
}

function loadConfig() {
  const base = defaultConfig();
  if (!fs.existsSync(CONFIG_FILE)) return base;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      port: Number(raw.port) || base.port,
      refreshSeconds: Math.max(15, Number(raw.refreshSeconds) || base.refreshSeconds),
      wallets: cleanWallets(raw.wallets).wallets,
      targets: analytics.cleanTargets(raw.targets),
      disabled: analytics.cleanDisabled(raw.disabled),
      bulkTargets: analytics.cleanTargets(raw.bulkTargets, analytics.BULK_RULES),
      bulkDisabled: analytics.cleanDisabled(raw.bulkDisabled, analytics.BULK_RULES),
      points: cleanPoints(raw.points),
      leagueRewards: leagues.cleanReceived(raw.leagueRewards),
      arcusPointsName: cleanName(raw.arcusPointsName),
      alerts: alerts.cleanSettings(raw.alerts),
      profile: cleanProfile(raw.profile),
      onboardedAt: Number(raw.onboardedAt) || null,
      tourDone: raw.tourDone === true,
      myCodes: referrals.cleanMine(raw.myCodes),
    };
  } catch (e) {
    const backup = `${CONFIG_FILE}.broken-${Date.now()}`;
    try {
      fs.renameSync(CONFIG_FILE, backup);
    } catch {}
    console.error(`config.json couldn't be read (${e.message}); moved it to ${path.basename(backup)} and started fresh.`);
    return base;
  }
}

let config = loadConfig();
let activePort = config.port;
const saveConfig = () => writeJsonAtomic(CONFIG_FILE, config);

// ---------- updates ----------
// A fingerprint of the tracker's own code when it started. If the files on disk change while it
// runs (an update copied in), the page says to restart: the running copy still has the old code.
function codeFiles() {
  const list = [path.join(ROOT, 'server.js')];
  for (const dir of ['src', path.join('src', 'exchanges')]) {
    try {
      for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith('.js')) list.push(path.join(ROOT, dir, f));
    } catch {}
  }
  return list.sort();
}
function codeSignature() {
  const h = crypto.createHash('sha1');
  for (const f of codeFiles()) {
    try {
      const st = fs.statSync(f);
      h.update(`${path.relative(ROOT, f)}:${st.size}:${Math.round(st.mtimeMs)}|`);
    } catch {
      h.update(`${f}:gone|`);
    }
  }
  return h.digest('hex').slice(0, 12);
}
const BUILD = codeSignature();
let buildCheck = { at: 0, stale: false };
function restartNeeded() {
  if (Date.now() - buildCheck.at > 15000) buildCheck = { at: Date.now(), stale: codeSignature() !== BUILD };
  return buildCheck.stale;
}

// ---------- syncing ----------

const store = new Store(path.join(ROOT, 'data'));
const pointsStore = new points.PointsStore(path.join(ROOT, 'data'));
const balanceBook = new portfolio.BalanceBook(path.join(ROOT, 'data'));
const liveBalances = new portfolio.LiveBalances();
const plainHttp = { get: (u, o) => api.get(u, o), post: (u, b, o) => api.post(u, b, o) };

// ---------- risk watch and alerts ----------
const watch = new MarketWatch();
const graceEnv = Number(process.env.PERPS_HEDGE_GRACE_MS);
const alertCenter = new alerts.AlertCenter(path.join(ROOT, 'data'), Number.isFinite(graceEnv) && graceEnv >= 0 ? { hedgeGraceMs: graceEnv } : {});
let watchTimer = null;
let lastSecurity = null; // the last security check (also in data/security.json)
let officialStatus = null; // an official, signed build or a modified one (security.verifyOfficial)
let pageSoundAt = 0; // last time an open, visible dashboard that can play sounds asked for state
let desktopError = null;
let freshCache = { key: null, hedges: null };

// Your effective taker fee per exchange (bps), for what swapping a hedge's sides would cost.
function takerBps() {
  const out = {};
  for (const e of (prepared && prepared.exchanges) || []) {
    let fee = 0;
    let vol = 0;
    for (const w of e.wallets) for (const f of w.rich) if (f.role !== 'M' && f.n > 0) (fee += f.fee), (vol += f.n);
    if (vol > 1000) out[e.id] = (fee / vol) * 1e4;
  }
  return out;
}

// Hedges with the latest mark prices and funding rates.
function freshHedges() {
  if (!stats) return [];
  const key = `${stats.generatedAt}|${watch.at}`;
  if (freshCache.key !== key) freshCache = { key, hedges: watch.fresh(stats.hedges, takerBps()) };
  return freshCache.hedges;
}

function deliver(list, { forceDesktopSound = false } = {}) {
  const st = config.alerts;
  const pageOpen = Date.now() - pageSoundAt < 25 * 1000;
  for (const a of list) {
    notify.terminal(a, { sound: st.sound });
    if (!st.desktop) continue;
    // With the dashboard open, visible and able to play sounds, it plays them; the pop-up stays quiet.
    const silent = forceDesktopSound ? false : !st.sound || pageOpen;
    notify
      .desktop(a, { url: `http://localhost:${activePort}/#overview`, silent })
      .then((err) => {
        if (err && desktopError !== err) console.error(`  [!] Desktop notifications aren't working: ${err}`);
        desktopError = err || null;
      })
      .catch(() => {});
  }
}

function runAlerts() {
  if (!prepared || !stats) return;
  try {
    const fills = [];
    for (const e of prepared.exchanges) for (const w of e.wallets) for (const f of w.fills) if (f.liq) fills.push({ ...f, exchange: e.id });
    // Bulk positions, your AURA rate and the cutoff, for multiplier milestones and the cutoff reminder.
    let bulk = null;
    if ((config.wallets.bulk || []).length) {
      const lv = liveView();
      bulk = { legs: lv.bulk, base: lv.rate.base, oiHour: lv.rate.oiHour, model: lv.model, cutoff: lv.cutoff, hold: holdKnown() };
    }
    const fresh = alertCenter.evaluate({ hedges: freshHedges(), fills, settings: config.alerts, bulk });
    if (fresh.length) deliver(fresh);
  } catch (e) {
    console.error(`Couldn't check alerts: ${e.message}`);
  }
}

// Prices and funding for the markets you hold, every 30 s while a leg is near liquidation, else 2 min.
function scheduleWatch(ms) {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(async () => {
    try {
      if (stats && stats.positions.length) {
        await watch.tick(plainHttp, stats.positions);
        runAlerts();
      }
    } catch (e) {
      // try again next time
    }
    scheduleWatch(watch.interval(freshHedges()));
  }, ms);
}

// A reading of every exchange's balance for the history line (at most every 5 minutes).
function recordBalances() {
  if (!prepared) return;
  try {
    const view = portfolio.computePortfolio(prepared, liveBalances, null, Date.now());
    const values = {};
    for (const x of view.exchanges) values[x.id] = x.equity;
    balanceBook.record(Date.now(), values);
  } catch (e) {
    console.error(`Couldn't record balances: ${e.message}`);
  }
}
const walletStatus = {}; // "<exchange>:<address>" -> { state, error, progress, syncedAt }
let syncing = false;
let syncQueued = false;
let lastSyncStart = null;
let lastSyncEnd = null;
let stats = null;
let prepared = null;
let timer = null;
let version = 0; // bumps whenever data, targets or points change; keys the view cache
const viewCache = new Map();
function bump() {
  version += 1;
  viewCache.clear();
}
// Your Bulk AURA rate and this week's estimate, for Strategy's Bulk view.
function bulkAura() {
  try {
    const view = points.computePoints(prepared, pointsStore.state, { points: config.points, arcusName: config.arcusPointsName, wallets: config.wallets });
    const p = view.programs.find((x) => x.id === 'bulk');
    if (!p) return null;
    const e = p.estimate;
    const weeks = p.data ? p.data.weeks.filter((w) => w.trading > 0 && w.publishAt <= Date.now()) : [];
    const lw = weeks[weeks.length - 1];
    return {
      perDollar: e ? e.perDollar : null,
      baseRate: e && Number.isFinite(e.baseRate) ? e.baseRate : null,
      rates: e && e.rates ? e.rates : null,
      // Every revealed week with the rates it actually paid you (Strategy's "last AURA week").
      weeks: e && e.calibration ? e.calibration.filter((c) => c.rules || c.eff).map((c) => ({ week: c.week, start: c.start, end: c.end, rules: c.rules, eff: c.eff })) : [],
      estimate: e ? { points: e.points.projected, low: e.points.low, high: e.points.high, dropAt: e.dropAt, volume: e.volume.projected, soFar: e.points.soFar, confidence: e.confidence } : null,
      lastWeek: lw ? { week: lw.week, trading: lw.trading, volume: lw.countedVolume || lw.volume, fees: lw.fees } : null,
    };
  } catch (e) {
    return null;
  }
}

// Leagues page: Bulk's weekly league payouts (Challenger Series), with your share.
function leaguesView() {
  if (!prepared) recompute();
  const view = points.computePoints(prepared, pointsStore.state, { points: config.points, arcusName: config.arcusPointsName, wallets: config.wallets });
  const p = view.programs.find((x) => x.id === 'bulk');
  return {
    hasBulk: (config.wallets.bulk || []).length > 0,
    ...leagues.computeLeagues({ bulk: p && p.data, estimate: p && p.estimate, received: config.leagueRewards, takerBps: takerBps().bulk, now: Date.now() }),
  };
}

// Bulk's AURA rates this week (your estimate's, else the model's typical ones): per $ of taker
// volume, per $ open for an hour, and what an hour open adds relative to a quick round trip. The
// public model has no rate for open positions (oiHour, perHour null): the hold multiplier is hidden.
function bulkRates() {
  return cachedView(`bulk-rates|${pointsStore.version}`, () => {
    const a = bulkAura();
    const r = a && a.rates;
    const hold = (m) => (estimate.model.hold && m > 0 ? m : null);
    if (r && r.taker > 0) return { base: r.taker, oiHour: hold(r.oiHour), perHour: hold(r.perHour), source: r.own ? 'yours' : 'typical', week: a.lastWeek ? a.lastWeek.week : null };
    const f = estimate.model.ref;
    if (f) return { base: f.taker * (f.credit || 1), oiHour: f.oiHour * (f.credit || 1), perHour: estimate.model.hold ? estimate.model.hold.perHour : null, source: 'typical', week: null };
    return { base: 0, oiHour: null, perHour: null, source: 'none', week: null };
  });
}
const holdKnown = () => Boolean(estimate.model.hold && estimate.model.hold.perHour > 0);

// Live page: every open position with what the browser needs to tick its hold time and, on Bulk,
// its AURA multiplier and what closing it now would earn. Prices are the latest the risk watch read.
function liveView() {
  if (!prepared) recompute();
  const now = Date.now();
  const weekStart = analytics.bulkWeekStart(now);
  const rate = bulkRates();
  const bulk = [];
  const other = [];
  for (const ex of prepared.exchanges) {
    for (const w of ex.wallets) {
      for (const p of w.positions || []) {
        const m = watch.marks[`${ex.id}|${p.mkt}`];
        const fresh = m && m.mark > 0;
        const mark = fresh ? m.mark : p.mark;
        const notional = mark > 0 ? Math.abs(p.size) * mark : p.notional;
        const upnl = fresh && p.entry > 0 ? p.size * (mark - p.entry) : p.upnl;
        const liqDist = p.liq > 0 && mark > 0 ? Math.max(0, p.size > 0 ? (mark - p.liq) / mark : (p.liq - mark) / mark) : null;
        const row = { exchange: ex.id, wallet: w.label, mkt: p.mkt, side: p.side, size: p.size, entry: p.entry, mark, notional, upnl, lev: p.lev == null ? null : p.lev, openTs: p.openTs || null, liq: p.liq > 0 ? p.liq : null, liqDist, liqEst: Boolean(p.liqEst) };
        if (ex.id !== 'bulk') {
          other.push(row);
          continue;
        }
        // Taker volume this position has traded in the current AURA week (it earned as it traded;
        // the position also earns every hour it's open).
        let weekVol = null;
        if (p.openTs) {
          const from = Math.max(p.openTs, weekStart);
          weekVol = 0;
          for (const f of w.fills) if (f.role === 'T' && f.mkt === p.mkt && f.ts >= from && (!p.acct || !f.acct || f.acct === p.acct)) weekVol += f.sz * f.px;
        }
        bulk.push({ ...row, weekVol, crossed: Boolean(p.openTs && p.openTs < weekStart) });
      }
    }
  }
  const byOpen = (a, b) => (a.openTs || Infinity) - (b.openTs || Infinity);
  bulk.sort(byOpen);
  other.sort(byOpen);
  // The same asset on several exchanges is one hedge (Bulk BTC-USD long + Entropy BTC short).
  const fresh = new Map(freshHedges().map((g) => [g.asset, g]));
  const groups = [];
  for (const [asset, legs] of hedgeGroups([...bulk, ...other])) {
    const longSize = legs.filter((l) => l.size > 0).reduce((a, l) => a + l.size, 0);
    const shortSize = -legs.filter((l) => l.size < 0).reduce((a, l) => a + l.size, 0);
    const longUsd = legs.filter((l) => l.size > 0).reduce((a, l) => a + l.notional, 0);
    const shortUsd = legs.filter((l) => l.size < 0).reduce((a, l) => a + l.notional, 0);
    const both = longSize > 0 && shortSize > 0;
    const imbalance = both ? Math.abs(longSize - shortSize) / Math.max(longSize, shortSize) : 1;
    const f = fresh.get(asset);
    const withDist = legs.filter((l) => l.liqDist != null);
    const nearest = withDist.length ? withDist.reduce((a, l) => (l.liqDist < a.liqDist ? l : a)) : null;
    legs.sort((a, b) => (a.exchange === 'bulk' ? 0 : 1) - (b.exchange === 'bulk' ? 0 : 1) || (a.side === b.side ? b.notional - a.notional : a.side === 'L' ? -1 : 1));
    groups.push({
      asset,
      status: !both ? 'open' : imbalance <= 0.05 ? 'hedged' : 'uneven',
      longUsd,
      shortUsd,
      netUsd: longUsd - shortUsd,
      upnl: legs.reduce((a, l) => a + (Number.isFinite(l.upnl) ? l.upnl : 0), 0),
      fundDay: f && f.fundNow ? f.fundNow.perDay : null,
      nearest: nearest ? { exchange: nearest.exchange, mkt: nearest.mkt, dist: nearest.liqDist, est: nearest.liqEst, add10: alerts.marginFor(nearest, 0.1), add15: alerts.marginFor(nearest, 0.15) } : null,
      legs,
    });
  }
  const hasBulkLeg = (g) => g.legs.some((l) => l.exchange === 'bulk');
  groups.sort((a, b) => Number(hasBulkLeg(b)) - Number(hasBulkLeg(a)) || b.longUsd + b.shortUsd - (a.longUsd + a.shortUsd));
  return {
    now,
    weekStart,
    cutoff: weekStart + 7 * markettime.DAY,
    model: { perHour: rate.perHour, week: 168 },
    rate,
    takerBps: takerBps().bulk || 3.5, // your Bulk taker fee, to compare holding's cost per AURA with trading's
    // The AURA side of the Live page (multiplier, AURA if closed now) needs a model for open positions.
    hasBulk: (config.wallets.bulk || []).length > 0 && holdKnown(),
    bulk,
    other,
    groups,
    syncedAt: lastSyncEnd,
    pricesAt: Math.max(lastSyncEnd || 0, watch.at || 0) || null,
  };
}

function cachedView(key, build) {
  const k = `${version}|${key}`;
  if (!viewCache.has(k)) viewCache.set(k, build());
  return viewCache.get(k);
}

const statusKey = (exId, address) => `${exId}:${address}`;
const problemLog = {}; // "<exchange>:<address>" -> the last sync problem printed in the window
const PROBLEM_QUIET_MS = 30 * 60 * 1000;

function allWallets() {
  return EXCHANGES.flatMap((ex) => (config.wallets[ex.id] || []).map((w) => ({ ex, w })));
}

async function syncWallet(ex, wallet) {
  const key = statusKey(ex.id, wallet.address);
  const cache = store.get(ex.id, wallet.address);
  const st = (walletStatus[key] = { ...(walletStatus[key] || {}), state: 'syncing', progress: 'starting', error: null });
  const onRetry = ({ waitMs, status, host }) => {
    st.progress = status === 429 ? `rate-limited by ${host}, waiting ${Math.ceil(waitMs / 1000)}s` : `retrying ${host}`;
  };
  const ctx = {
    http: {
      get: (url, opts) => api.get(url, { ...opts, onRetry }),
      post: (url, body, opts) => api.post(url, body, { ...opts, onRetry }),
    },
    progress: (msg) => {
      st.progress = msg;
    },
  };
  const name = `${ex.name} ${wallet.label || wallet.address.slice(0, 6)}`;
  const clock = () => new Date().toLocaleTimeString();
  try {
    await ex.sync(wallet, cache, ctx);
    cache.syncedAt = Date.now();
    walletStatus[key] = { state: 'ok', error: null, progress: null, syncedAt: cache.syncedAt };
    if (flag('--verbose')) console.log(`  [ok] ${name}: ${cache.fills.length} fills, ${cache.positions.length} open positions`);
    // Back after a problem that was printed: say so once.
    const pl = problemLog[key];
    if (pl && pl.open) {
      pl.open = false;
      if (!pl.toldBack) console.log(`  [ok] ${clock()}  ${name} synced again${pl.fails > 1 ? ` (after ${pl.fails} failed tries)` : ''}.`);
      pl.toldBack = true;
    }
  } catch (e) {
    const msg = ex.explainError(e);
    walletStatus[key] = { state: 'error', error: msg, progress: null, syncedAt: cache.syncedAt || null };
    // Print each problem once, not every refresh: the same problem again within 30 minutes stays
    // quiet even if a sync in between worked (Bulk's gateway can fail on and off for a while).
    const now = Date.now();
    const pl = problemLog[key];
    if (pl && pl.msg === msg && now - pl.printedAt < PROBLEM_QUIET_MS) {
      pl.open = true;
      pl.fails += 1;
    } else {
      const last = cache.syncedAt ? ` Last good sync ${duration(now - cache.syncedAt)} ago.` : '';
      console.error(`  [!] ${clock()}  ${name}: ${msg}${last}`);
      problemLog[key] = { msg, printedAt: now, open: true, fails: 1, toldBack: false };
    }
  } finally {
    store.save(ex.id, wallet.address);
  }
}

function recompute() {
  prepared = prepare({
    now: Date.now(),
    exchanges: EXCHANGES.map((ex) => ({
      id: ex.id,
      name: ex.name,
      appUrl: ex.appUrl,
      wallets: (config.wallets[ex.id] || []).map((w) => ({
        ...w,
        cache: store.get(ex.id, w.address),
        status: walletStatus[statusKey(ex.id, w.address)] || null,
      })),
    })),
  });
  stats = computeStats(prepared);
  bump();
}

async function syncAll() {
  if (syncing) {
    syncQueued = true;
    return;
  }
  syncing = true;
  lastSyncStart = Date.now();
  try {
    // Exchanges in parallel (different APIs), wallets on the same exchange one at a time.
    // Points programs (Bulk AURA, Arcus points) load alongside.
    await Promise.all([
      ...EXCHANGES.map(async (ex) => {
        for (const w of config.wallets[ex.id] || []) await syncWallet(ex, w);
      }),
      points.syncPoints({ get: (url, opts) => api.get(url, opts), post: (url, body, opts) => api.post(url, body, opts) }, pointsStore, config).catch((e) => {
        console.error(`  [!] points: ${e.message}`);
      }),
    ]);
  } finally {
    try {
      recompute();
      recordBalances();
      try {
        points.recordEstimates(pointsStore, prepared, config);
      } catch (e) {
        // the estimate log is a nice-to-have
      }
      runAlerts();
      scheduleWatch(1000); // fresh prices and funding for what's held now, then on its own timer
    } catch (e) {
      console.error(`Couldn't compute stats: ${e.stack || e.message}`);
    }
    syncing = false;
    lastSyncEnd = Date.now();
    if (syncQueued) {
      syncQueued = false;
      setImmediate(syncAll);
    }
  }
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(syncAll, config.refreshSeconds * 1000);
}

// What the page shows about this copy: official and signed, or modified.
function officialView() {
  const o = officialStatus || { state: 'unsigned', version: null, repo: null, changed: [], missing: [] };
  const changed = [...(o.changed || []), ...(o.missing || []), ...(o.added || [])];
  return { state: o.state, version: o.version, repo: o.repo, signedAt: o.signedAt || null, changed: changed.slice(0, 6), changes: changed.length, edition: estimate.model.status.edition, model: estimate.model.name, ignored: estimate.model.status.ignored || null };
}

// Your own Bulk referral code and how many people used it, from your AURA data.
function bulkReferralInfo() {
  for (const w of config.wallets.bulk || []) {
    const e = (pointsStore.state.bulk || {})[w.address];
    const d = e && e.wallet;
    if (d && d.referral_code) return { code: d.referral_code, sent: Number(d.referrals_sent) || 0, qualified: Number(d.referrals_qualified) || 0, referredBy: d.referred_by_code || null };
  }
  return null;
}

function snapshot() {
  const now = Date.now();
  const weekStart = markettime.pointsWeekStart(now);
  return {
    now,
    build: BUILD,
    restartNeeded: restartNeeded(),
    pointsWeek: { start: weekStart, next: markettime.pointsWeekStart(weekStart + 8 * markettime.DAY) },
    drops: points.nextDrops(pointsStore.state, now, config.wallets, config.arcusPointsName),
    pointsSync: { running: pointsStore.busy, version: pointsStore.version, errors: pointsStore.state.errors || {} },
    market: markettime.marketStatus(now),
    config: { refreshSeconds: config.refreshSeconds, wallets: config.wallets, targets: config.targets, disabled: config.disabled, bulkTargets: config.bulkTargets, bulkDisabled: config.bulkDisabled, arcusPointsName: config.arcusPointsName, profile: config.profile, onboardedAt: config.onboardedAt, tourDone: config.tourDone },
    official: officialView(),
    signup: referrals.OURS.map((r) => ({ id: r.id, name: r.name, code: r.code, accessCode: r.accessCode || null, link: r.link, perk: r.perk, ready: referrals.ready(r) })), // sign-up links for setup and Settings
    developer: require('./src/official').DEVELOPER,
    rules: analytics.RULES.map(({ id, label, quote, why, bench, unit, cmp, target }) => ({ id, label, quote, why, bench, unit, cmp, default: target })),
    bulkHold: prepared ? (({ perHour, base, oiHour }) => ({ perHour, base, oiHour, week: 168 }))(bulkRates()) : { perHour: estimate.BULK_HOLD.perHour, week: 168 },
    bulkRules: analytics.BULK_RULES.map(({ id, label, why, bench, unit, cmp, target }) => ({ id, label, why, bench, unit, cmp, default: target })),
    windows: analytics.WINDOWS,
    pointSeries: points.POINT_SERIES,
    programs: points.PROGRAMS,
    exchanges: EXCHANGES.map((ex) => ({
      id: ex.id,
      name: ex.name,
      appUrl: ex.appUrl,
      addressKind: ex.addressKind,
      addressHint: ex.addressHint,
    })),
    sync: { running: syncing, lastStart: lastSyncStart, lastEnd: lastSyncEnd, wallets: walletStatus },
    // Hedges carry the latest prices and funding (the risk watch runs between full syncs).
    stats: stats ? { ...stats, hedges: freshHedges() } : stats,
    watch: { at: watch.at || null, errors: watch.errors },
    alerts: { recent: alertCenter.recent(8), settings: config.alerts, desktopError },
  };
}

// ---------- export ----------

const csvCell = (v) => {
  const t = v == null ? '' : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const iso = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString() : '');

function sendExport(res, what) {
  if (!prepared) recompute();
  const day = new Date().toISOString().slice(0, 10);
  const attach = (name, type, body) => {
    res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  if (what === 'all') {
    const caches = {};
    for (const { ex, w } of allWallets()) caches[`${ex.id}:${w.address}`] = store.get(ex.id, w.address);
    const body = { app: 'perps-tracker', exportedAt: new Date().toISOString(), config, caches, points: pointsStore.state, balances: balanceBook.points, stats };
    return attach(`perps-tracker-${day}.json`, 'application/json; charset=utf-8', JSON.stringify(body, null, 1));
  }
  if (what === 'trades.csv') {
    const rows = [['exchange', 'wallet', 'address', 'time_utc', 'market', 'side', 'size', 'price', 'notional_usd', 'fee_usd', 'role', 'realised_pnl_usd', 'counted']];
    for (const ex of prepared.exchanges) {
      for (const w of ex.wallets) {
        const all = store.get(ex.id, w.address).fills; // every fill, including ones kept only to follow a position
        for (const f of [...all].sort((a, b) => a.ts - b.ts)) rows.push([ex.name, w.label, w.address, iso(f.ts), f.mkt, f.side === 'B' ? 'buy' : 'sell', f.sz, f.px, (f.sz * f.px).toFixed(6), f.fee, f.role === 'M' ? 'maker' : 'taker', f.pnl == null ? '' : f.pnl, f.ext ? 'no (placed in another app)' : 'yes']);
      }
    }
    return attach(`perps-trades-${day}.csv`, 'text/csv; charset=utf-8', csv(rows));
  }
  if (what === 'positions.csv') {
    const rows = [['exchange', 'wallet', 'market', 'side', 'opened_utc', 'closed_utc', 'held_minutes', 'volume_usd']];
    const all = prepared.exchanges.flatMap((ex) => ex.wallets.flatMap((w) => w.cycles.map((c) => ({ ex, w, c }))));
    all.sort((a, b) => a.c.closeTs - b.c.closeTs);
    for (const { ex, w, c } of all) rows.push([ex.name, w.label, c.mkt, c.side === 'L' ? 'long' : 'short', iso(c.openTs), iso(c.closeTs), ((c.closeTs - c.openTs) / 60000).toFixed(2), c.vol == null ? '' : c.vol.toFixed(2)]);
    return attach(`perps-closed-positions-${day}.csv`, 'text/csv; charset=utf-8', csv(rows));
  }
  if (what === 'points.csv') {
    const view = points.computePoints(prepared, pointsStore.state, { points: config.points, arcusName: config.arcusPointsName, wallets: config.wallets });
    const rows = [['program', 'period', 'from_utc', 'to_utc', 'revealed_utc', 'earned', 'total_after', 'rank', 'your_volume_usd', 'your_fees_usd', 'fees_per_1k']];
    const fx = (n, dp = 2) => (Number.isFinite(n) ? n.toFixed(dp) : '');
    for (const p of view.programs) {
      const d = p.data;
      if (!d) continue;
      if (p.id === 'bulk') {
        for (const w of d.predeposit.weeks) rows.push([p.title, `Pre-deposit week ${w.week}`, '', '', '', w.aura, '', '', '', '', '']);
        for (const w of d.weeks) rows.push([p.title, `Mainnet week ${w.week}`, iso(w.start), iso(w.end), iso(w.publishAt), w.total, '', '', fx(w.volume), fx(w.fees), fx(w.feesPer1k)]);
      }
      if (p.id === 'arcus') for (const h of [...d.history].reverse()) rows.push([p.title, `Week of ${h.week}`, iso(h.start), iso(h.end), iso(h.distributedAt), h.gained == null ? '' : fx(h.gained), fx(h.points), h.rank || '', fx(h.volume), fx(h.fees), fx(h.feesPer1k)]);
      for (const r of [...((d.manual && d.manual.rows) || [])].reverse()) rows.push([`${p.title} (logged by hand)`, 'Log', '', iso(r.at), '', r.first ? '' : fx(r.gained), r.value, '', fx(r.volume), fx(r.fees), fx(r.costPer1k)]);
    }
    return attach(`perps-points-${day}.csv`, 'text/csv; charset=utf-8', csv(rows));
  }
  return sendJson(res, 404, { error: 'Unknown export' });
}

// ---------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2' };

function send(res, status, body, type, cache = 'no-store') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function readBody(req, limit = 200 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isLocalHost(hostHeader) {
  const host = String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

async function handle(req, res) {
  // Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
  if (!isLocalHost(req.headers.host)) return send(res, 403, 'Forbidden', 'text/plain');
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/state' && req.method === 'GET') {
    if (url.searchParams.get('sound') === '1') pageSoundAt = Date.now();
    else if (url.searchParams.get('left') === '1') pageSoundAt = 0;
    return sendJson(res, 200, snapshot());
  }
  if (url.pathname === '/api/live' && req.method === 'GET') return sendJson(res, 200, liveView());
  if (url.pathname === '/api/leagues' && req.method === 'GET') return sendJson(res, 200, cachedView(`leagues|${pointsStore.version}|${config.leagueRewards.length}`, leaguesView));
  if (url.pathname === '/api/security' && req.method === 'GET') return sendJson(res, 200, { last: lastSecurity || security.readResult(path.join(ROOT, 'data')), autostart: security.autostartStatus() });
  if (url.pathname === '/api/referrals' && req.method === 'GET') return sendJson(res, 200, referrals.view(config, { official: officialView(), bulk: bulkReferralInfo() }));
  if (url.pathname === '/api/alerts' && req.method === 'GET') return sendJson(res, 200, { alerts: alertCenter.recent(50), settings: config.alerts });
  if ((url.pathname === '/api/strategy' || url.pathname === '/api/playbook') && req.method === 'GET') {
    if (!prepared) recompute();
    const platform = analytics.parsePlatform(url.searchParams.get('platform')).key; // one exchange, several, or "all"
    const win = analytics.WINDOWS[url.searchParams.get('window')] ? url.searchParams.get('window') : 'thisWeek';
    if (platform === 'bulk') {
      // Bulk alone: trading AURA habits, with your own AURA rate from the points estimate.
      return sendJson(res, 200, cachedView(`st|bulk|${win}|${pointsStore.version}`, () => analytics.computeStrategy(prepared, { platform, window: win, bulkTargets: config.bulkTargets, bulkDisabled: config.bulkDisabled, aura: bulkAura() })));
    }
    return sendJson(res, 200, cachedView(`st|${platform}|${win}`, () => analytics.computeStrategy(prepared, { platform, window: win, targets: config.targets, disabled: config.disabled })));
  }
  if (url.pathname === '/api/points' && req.method === 'GET') {
    if (!prepared) recompute();
    return sendJson(res, 200, cachedView(`points|${pointsStore.version}`, () => points.computePoints(prepared, pointsStore.state, { points: config.points, arcusName: config.arcusPointsName, wallets: config.wallets })));
  }
  if (url.pathname === '/api/portfolio' && req.method === 'GET') {
    // ?live=1 (the Pulse portfolio is open): re-read account values if older than 8 seconds.
    if (!prepared) recompute();
    if (url.searchParams.get('live') === '1') {
      // Wait for the fresh read (about a second), but never more than 4 seconds.
      const job = liveBalances.refresh(EXCHANGES, config.wallets, store, plainHttp).then(recordBalances).catch(() => {});
      await Promise.race([job, new Promise((r) => setTimeout(r, 4000))]);
    }
    return sendJson(res, 200, portfolio.computePortfolio(prepared, liveBalances, balanceBook, Date.now()));
  }
  if (url.pathname.startsWith('/api/export/') && req.method === 'GET') return sendExport(res, url.pathname.slice('/api/export/'.length));
  if (url.pathname === '/api/fees' && req.method === 'GET') {
    if (!prepared) recompute();
    const win = analytics.WINDOWS[url.searchParams.get('window')] ? url.searchParams.get('window') : '30d';
    return sendJson(res, 200, cachedView(`fees|${win}`, () => analytics.computeFees(prepared, { window: win })));
  }

  if (url.pathname.startsWith('/api/') && req.method === 'POST') {
    if (!/application\/json/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON' });
    let body = {};
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch (e) {
      return sendJson(res, 400, { error: `Bad request: ${e.message}` });
    }
    if (url.pathname === '/api/sync') {
      syncAll();
      return sendJson(res, 200, snapshot());
    }
    if (url.pathname === '/api/referrals/mine') {
      // Your own referral codes (Referrals page).
      config.myCodes = referrals.cleanMine(body.myCodes);
      saveConfig();
      return sendJson(res, 200, referrals.view(config, { official: officialView(), bulk: bulkReferralInfo() }));
    }
    if (url.pathname === '/api/profile') {
      // The tour finished or skipped, or your name changed.
      if (body.tourDone != null) config.tourDone = Boolean(body.tourDone);
      if (body.name != null) config.profile = cleanProfile({ ...(config.profile || {}), name: body.name });
      saveConfig();
      return sendJson(res, 200, snapshot());
    }
    if (url.pathname === '/api/onboarding') {
      // First-run setup: who you are, what you trade, your wallets and Arcus points name.
      const { wallets, errors } = cleanWallets(body.wallets || {});
      if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
      config.wallets = wallets;
      config.profile = cleanProfile(body.profile);
      if (body.arcusPointsName != null) config.arcusPointsName = cleanName(body.arcusPointsName);
      if (body.alerts) config.alerts = alerts.cleanSettings({ ...config.alerts, ...body.alerts });
      config.onboardedAt = Date.now();
      saveConfig();
      recompute();
      syncAll();
      return sendJson(res, 200, snapshot());
    }
    if (url.pathname === '/api/targets') {
      if (body.mode === 'bulk') {
        config.bulkTargets = analytics.cleanTargets({ ...config.bulkTargets, ...(body.targets || {}) }, analytics.BULK_RULES);
        if (body.disabled) config.bulkDisabled = analytics.cleanDisabled(body.disabled, analytics.BULK_RULES);
        saveConfig();
        bump();
        return sendJson(res, 200, { ok: true, targets: config.bulkTargets, disabled: config.bulkDisabled });
      }
      config.targets = analytics.cleanTargets({ ...config.targets, ...(body.targets || {}) });
      if (body.disabled) config.disabled = analytics.cleanDisabled(body.disabled);
      saveConfig();
      bump();
      return sendJson(res, 200, { ok: true, targets: config.targets, disabled: config.disabled });
    }
    if (url.pathname === '/api/points') {
      const value = Number(body.value);
      const at = body.at == null ? Date.now() : Number(body.at);
      if (!SERIES_KEYS.has(body.series)) return sendJson(res, 400, { error: 'Unknown points series' });
      if (!Number.isFinite(value) || value < 0) return sendJson(res, 400, { error: 'Enter a number of points (0 or more)' });
      if (!Number.isFinite(at) || at > Date.now() + 60000) return sendJson(res, 400, { error: 'That date is in the future' });
      config.points = cleanPoints([...config.points, { id: crypto.randomUUID(), series: body.series, value, at }]);
      saveConfig();
      bump();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/points/bulk-import') {
      // AURA pasted from the browser, for when Bulk's website turns the tracker away.
      const r = points.importBulk(pointsStore, config.wallets.bulk || [], body.text);
      if (r.error) return sendJson(res, 400, { error: r.error });
      bump();
      return sendJson(res, 200, { ok: true, ...r });
    }
    if (url.pathname === '/api/points/delete') {
      config.points = config.points.filter((p) => p.id !== String(body.id));
      saveConfig();
      bump();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/settings') {
      if (body.arcusPointsName != null) config.arcusPointsName = cleanName(body.arcusPointsName);
      saveConfig();
      points
        .syncPoints({ get: (u, o) => api.get(u, o), post: (u, b, o) => api.post(u, b, o) }, pointsStore, config)
        .catch(() => {})
        .finally(() => bump());
      bump();
      return sendJson(res, 200, snapshot());
    }
    if (url.pathname === '/api/alerts/settings') {
      config.alerts = alerts.cleanSettings({ ...config.alerts, ...(body.settings || {}) });
      saveConfig();
      return sendJson(res, 200, { ok: true, settings: config.alerts });
    }
    if (url.pathname === '/api/alerts/test') {
      // where: "desktop" tests the pop-up and its sound; "page" lets the open dashboard play it.
      const level = body.level === 'warn' ? 'warn' : 'danger';
      const a = alertCenter.test(level);
      if (body.where === 'desktop') {
        a.quiet = true; // the page shouldn't also play it
        alertCenter.save();
        notify.terminal(a);
        const err = await notify.desktop(a, { url: `http://localhost:${activePort}/#overview`, silent: false });
        desktopError = err || null;
        return sendJson(res, 200, { ok: !err, error: err || null });
      }
      notify.terminal(a, { sound: false });
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/leagues/received') {
      // You logged what a league payout paid you: it corrects the pool estimate from then on.
      const now = Date.now();
      const v = leaguesView();
      const WEEK = 7 * 24 * 3600 * 1000;
      const payoutAt = Number(body.payoutAt) || leagues.FIRST_PAYOUT + Math.floor((now - leagues.FIRST_PAYOUT) / WEEK) * WEEK;
      if (!(payoutAt >= leagues.FIRST_PAYOUT) || payoutAt > now) return sendJson(res, 400, { error: 'That payout hasn’t happened yet.' });
      if ((payoutAt - leagues.FIRST_PAYOUT) % WEEK !== 0) return sendJson(res, 400, { error: 'Payouts are on AURA Saturdays.' });
      if (body.remove) config.leagueRewards = config.leagueRewards.filter((r) => r.payoutAt !== payoutAt);
      else {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount < 0 || amount > 1e7) return sendJson(res, 400, { error: 'Enter the amount in dollars, like 4.60.' });
        const league = v.you ? v.you.league : null;
        const view = points.computePoints(prepared, pointsStore.state, { points: config.points, arcusName: config.arcusPointsName, wallets: config.wallets });
        const p = view.programs.find((x) => x.id === 'bulk');
        const estimated = leagues.estimateFor(payoutAt, league, points.bulkHours(pointsStore.state), p && p.data);
        config.leagueRewards = leagues.cleanReceived([...config.leagueRewards.filter((r) => r.payoutAt !== payoutAt), { payoutAt, amount, league, estimated }]);
      }
      saveConfig();
      bump();
      return sendJson(res, 200, leaguesView());
    }
    if (url.pathname === '/api/security/scan') {
      // Run check now: everything, including Windows Defender.
      lastSecurity = await security.scan(ROOT, { mode: 'manual', defender: true });
      officialStatus = security.verifyOfficial(ROOT);
      security.saveResult(path.join(ROOT, 'data'), lastSecurity);
      return sendJson(res, 200, { last: lastSecurity, autostart: security.autostartStatus() });
    }
    if (url.pathname === '/api/autostart') {
      const st = security.setAutostart(Boolean(body.on), ROOT);
      if (st.error) return sendJson(res, 400, { error: st.error, autostart: st });
      if (st.on) security.saveTrust(ROOT); // the version you're running now is the one allowed to start
      return sendJson(res, 200, { autostart: st });
    }
    if (url.pathname === '/api/shutdown') {
      // Lets a newer copy of the tracker take over (start.bat run again while this one is open).
      sendJson(res, 200, { ok: true });
      console.log('  A newer copy of the tracker started; closing this one.');
      setTimeout(() => process.exit(0), 300);
      return undefined;
    }
    if (url.pathname === '/api/config') {
      const { wallets, errors } = cleanWallets(body.wallets || {});
      if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
      config.wallets = wallets;
      if (body.refreshSeconds != null) config.refreshSeconds = Math.min(3600, Math.max(15, Math.round(Number(body.refreshSeconds) || 60)));
      if (body.arcusPointsName != null) config.arcusPointsName = cleanName(body.arcusPointsName);
      if (body.alerts) config.alerts = alerts.cleanSettings({ ...config.alerts, ...body.alerts });
      saveConfig();
      schedule();
      recompute();
      syncAll();
      return sendJson(res, 200, snapshot());
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  const ext = path.extname(file).toLowerCase();
  return send(res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream', ext === '.woff2' ? 'public, max-age=604800' : 'no-store');
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function listen(port, attemptsLeft = 10) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        console.error(e);
        try {
          sendJson(res, 500, { error: e.message });
        } catch {}
      });
    });
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && attemptsLeft > 0) resolve(listen(port + 1, attemptsLeft - 1));
      else reject(e);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

// ---------- one copy at a time ----------
// Running start.bat again while the tracker is open used to start a second copy on the next port,
// with both writing the same data folder. Now the new copy asks the old one to close first.
function localRequest(port, method, pathName, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathName, timeout: 1500, headers: { Host: `localhost:${port}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

async function takeOver(firstPort) {
  const ports = Array.from({ length: 11 }, (_, i) => firstPort + i);
  const found = (await Promise.all(ports.map(async (p) => ({ p, r: await localRequest(p, 'GET', '/api/state') })))).filter(
    (x) => x.r && x.r.status === 200 && x.r.json && x.r.json.sync && x.r.json.config
  );
  const stubborn = [];
  for (const { p } of found) {
    const r = await localRequest(p, 'POST', '/api/shutdown', {});
    if (!r || r.status !== 200) stubborn.push(p);
  }
  if (stubborn.length) {
    console.error('');
    console.error(`  An older copy of the tracker is still running at ${stubborn.map((p) => `http://localhost:${p}`).join(' and ')}.`);
    console.error('  Close its black window (or end "Node.js" in Task Manager), then start the tracker again.');
    console.error('');
    process.exit(1);
  }
  if (found.length) await new Promise((r) => setTimeout(r, 900)); // let the old copy release the port
}

// ---------- CLI summary ----------

function money(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
}
function duration(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function printSummary() {
  if (!stats) return;
  const rows = [['', 'Volume (all)', 'Volume 24h', 'Volume 7d', 'Open interest', 'Avg hold', 'Fills']];
  for (const ex of EXCHANGES) {
    const s = stats.exchanges[ex.id];
    if (!s || !s.wallets.length) continue;
    rows.push([ex.name, money(s.ranges.all.volume), money(s.ranges['24h'].volume), money(s.ranges['7d'].volume), money(s.oi.notional), duration(s.ranges.all.avgHoldMs), String(s.ranges.all.fills)]);
  }
  const t = stats.totals;
  rows.push(['TOTAL', money(t.ranges.all.volume), money(t.ranges['24h'].volume), money(t.ranges['7d'].volume), money(t.oi.notional), duration(t.ranges.all.avgHoldMs), String(t.ranges.all.fills)]);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  console.log('');
  for (const r of rows) console.log(r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('   '));
  console.log('');
}

// ---------- security check output ----------
function printSecurity(r) {
  const mark = { ok: 'ok  ', warn: 'note', fail: 'FAIL' };
  console.log('');
  console.log(`  Security check: ${r.ok ? 'passed' : 'FAILED'}`);
  for (const c of r.checks) if (c.state !== 'ok' || !r.ok) console.log(`    [${mark[c.state]}] ${c.label}: ${c.detail}`);
}
function ask(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

// ---------- main ----------

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 16) console.warn(`Node ${process.versions.node} is old; Node 18 or newer is recommended.`);

  if (flag('--once')) {
    if (!allWallets().length) {
      console.log('No wallets yet. Run without --once and add them in the dashboard, or edit config.json.');
      return;
    }
    console.log('Syncing...');
    await syncAll();
    printSummary();
    process.exit(0);
  }

  // Security check before anything else. Starting with Windows: the full check, and the tracker
  // stays closed if any part fails. Started by you: the quick check, and you decide.
  const auto = flag('--autostart');
  lastSecurity = await security.scan(ROOT, { mode: auto ? 'autostart' : 'start', defender: auto });
  security.saveResult(path.join(ROOT, 'data'), lastSecurity);
  printSecurity(lastSecurity);
  if (!lastSecurity.ok) {
    const first = lastSecurity.checks.find((c) => c.state === 'fail');
    if (auto) {
      const err = await notify.desktop({ kind: 'security', level: 'danger', title: "Perps Tracker didn't start", body: `Security check: ${first.label}. ${first.detail}` }).catch(() => null);
      if (err) console.error(`  Couldn't show a pop-up: ${err}`);
      process.exit(1);
    }
    if (process.stdin.isTTY) {
      const answer = await ask('  Start anyway? Type yes and press Enter (anything else closes it): ');
      if (!/^\s*y(es)?\s*$/i.test(answer)) process.exit(1);
    } else console.warn('  Starting anyway (no one to ask).');
  }
  if (!auto) security.saveTrust(ROOT); // you opened it yourself: this version is the trusted one
  officialStatus = security.verifyOfficial(ROOT);
  if (officialStatus.state !== 'verified') console.warn(`  This is ${officialStatus.state === 'modified' ? 'a modified' : 'an unsigned'}, unofficial build. Official version: ${officialStatus.repo}`);

  recompute(); // show cached numbers immediately
  const wantPort = Number(argValue('--port')) || config.port;
  await takeOver(wantPort);
  const { port } = await listen(wantPort);
  activePort = port;
  const url = `http://localhost:${port}`;
  console.log('');
  console.log('  PERPS TRACKER is running');
  console.log(`  Dashboard: ${url}`);
  console.log('  Keep this window open. Press Ctrl+C to stop.');
  console.log('');
  if (!flag('--no-open') && !auto) openBrowser(url);
  schedule();
  syncAll();
  scheduleWatch(20 * 1000);
  setInterval(runAlerts, 60 * 1000); // multiplier milestones and the cutoff reminder happen on the clock
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
