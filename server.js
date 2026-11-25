#!/usr/bin/env node
'use strict';

// Perps Tracker: one server, each person with their own private dashboard.
//
//   Run it for yourself with `npm start` (start.bat on Windows): it opens at http://localhost:8787
//   and needs no invite. Run it without --local to host it for others: new dashboards then need an
//   invite code, made on the admin page (#admin, with the key from data/admin.key).
//   Each dashboard is a workspace: its own wallets, settings, points and alerts in data/users/<id>.
//   A browser holds the workspace key (no sign-up); the server only stores a hash of it.
//   Wallet histories are shared between workspaces (data/wallets), so the same wallet is synced once.
//   Workspaces sync only while someone has their dashboard open.
//
// Environment:
//   PERPS_PORT       port to listen on (default 8787)
//   PERPS_HOST       address to listen on (default 127.0.0.1: only this computer can open it)
//   PERPS_DATA       data folder (default ./data)
//   PERPS_ORIGINS    more websites allowed to call the API (besides deploy/site.json), comma-
//                    separated; * wildcards allowed (https://perps-tracker-*.vercel.app)
//   PERPS_ADMIN_KEY  the admin key (default: made on first start, saved in data/admin.key)
//   PERPS_DEV=1      also allow http://localhost:* origins (local testing)
//   --local (or PERPS_OPEN=1)  run it for yourself on your own computer: no invite is needed to open
//                    a dashboard (npm start and start.bat in the open-source version do this)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const api = require('./src/http');
const { prepare, computeStats, hedgeGroups } = require('./src/metrics');
const analytics = require('./src/analytics');
const { Store, writeJsonAtomic } = require('./src/store');
const markettime = require('./src/markettime');
const points = require('./src/points');
const portfolio = require('./src/portfolio');
const alerts = require('./src/alerts');
const leagues = require('./src/leagues');
const estimate = require('./src/estimate');
const referrals = require('./src/referrals');
const markets = require('./src/markets');
const gauntlet = require('./src/gauntlet');
const { Invites } = require('./src/invites');
const { MarketWatch } = require('./src/watch');

const EXCHANGES = [require('./src/exchanges/bulk'), require('./src/exchanges/arcus'), require('./src/exchanges/entropy')];

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.PERPS_DATA || path.join(ROOT, 'data'));
const USERS_DIR = path.join(DATA_DIR, 'users');
const PORT = Number(process.env.PERPS_PORT) || 8787;
const HOST = process.env.PERPS_HOST || '127.0.0.1';
const DEV = process.env.PERPS_DEV === '1';
const OPEN = process.argv.includes('--local') || process.env.PERPS_OPEN === '1';
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

const WALLETS_PER_EXCHANGE = 5;
const REFEREES_MAX = 25; // referral wallets watched per dashboard
const REF_AURA_RATIO = 0.25; // Bulk: 1 AURA for every 4 Trading AURA your referrals earn
const ACTIVE_MS = 10 * 60 * 1000; // a dashboard polled in the last 10 minutes is open
const UNLOAD_MS = 60 * 60 * 1000; // after an hour without visits a workspace leaves memory
const MIN_REFRESH = 60;

fs.mkdirSync(USERS_DIR, { recursive: true });

// ---------- admin key ----------
function adminKey() {
  if (process.env.PERPS_ADMIN_KEY && process.env.PERPS_ADMIN_KEY.length >= 20) return process.env.PERPS_ADMIN_KEY;
  const file = path.join(DATA_DIR, 'admin.key');
  try {
    const k = fs.readFileSync(file, 'utf8').trim();
    if (k.length >= 20) return k;
  } catch {}
  const k = `adm_${crypto.randomBytes(24).toString('base64url')}`;
  fs.writeFileSync(file, `${k}\n`, { mode: 0o600 });
  console.log(`  Admin key created and saved in ${file}`);
  return k;
}
const ADMIN_KEY = adminKey();

// ---------- shared ----------
const store = new Store(path.join(DATA_DIR, 'wallets'));
// Market-wide volume (every Arcus market, every Bulk market, per hour) for the points estimates. It's
// the same for everyone, so all dashboards share one copy, kept in data/market.json.
const MARKET_FILE = path.join(DATA_DIR, 'market.json');
const MARKET_KEYS = ['arcusVol', 'bulkVol'];
const market = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8'));
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
})();
function shareMarket(st) {
  for (const k of MARKET_KEYS) {
    const mine = st[k];
    if (mine && (!market[k] || (mine.at || 0) > (market[k].at || 0))) market[k] = mine;
    if (!market[k]) market[k] = { hours: {}, at: 0, finalUntil: 0 };
    st[k] = market[k];
  }
  if (market.bulkVol && market.bulkVol.fees) markets.setFeeState(market.bulkVol.fees); // Bulk's last fee state
}
let marketSavedAt = 0;
function saveMarket() {
  if (Date.now() - marketSavedAt < 60 * 1000) return;
  marketSavedAt = Date.now();
  try {
    writeJsonAtomic(MARKET_FILE, market);
  } catch (e) {
    console.error(`Couldn't save market volume: ${e.message}`);
  }
}
const invites = new Invites(DATA_DIR);
const season = new gauntlet.Season(DATA_DIR); // this week's gauntlet and the shared league cutoffs
const plainHttp = { get: (u, o) => api.get(u, o), post: (u, b, o) => api.post(u, b, o) };

// At most a few exchange syncs at a time across everyone, so the exchanges' APIs aren't flooded.
function limiter(max) {
  let running = 0;
  const queue = [];
  const next = () => {
    if (running >= max || !queue.length) return;
    running += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        running -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
const walletSlots = limiter(Number(process.env.PERPS_SYNC_SLOTS) || 4);
const pointsSlots = limiter(2);

// The same wallet in several dashboards is synced once: a sync already running is shared, and a
// wallet synced in the last 20 seconds isn't synced again.
const walletJobs = new Map();
function syncWalletShared(ex, wallet, ctx) {
  const k = store.key(ex.id, wallet.address);
  if (walletJobs.has(k)) return walletJobs.get(k);
  const cache = store.get(ex.id, wallet.address);
  if (cache.syncedAt && Date.now() - cache.syncedAt < 20 * 1000) return Promise.resolve(cache);
  const job = walletSlots(async () => {
    await ex.sync({ address: wallet.address, label: wallet.label }, cache, ctx);
    cache.syncedAt = Date.now();
    return cache;
  }).finally(() => {
    walletJobs.delete(k);
    try {
      store.save(ex.id, wallet.address);
    } catch (e) {
      console.error(`Couldn't save ${k}: ${e.message}`);
    }
  });
  walletJobs.set(k, job);
  return job;
}

// ---------- config ----------
const GOALS = ['aura', 'arcus', 'hedge', 'fees', 'alerts'];
const cleanName = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60);
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const ids = ['bulk', 'arcus', 'entropy'];
  const ex = (Array.isArray(p.exchanges) ? p.exchanges : []).filter((x) => ids.includes(x));
  const noAccount = (Array.isArray(p.noAccount) ? p.noAccount : []).filter((x) => ids.includes(x));
  return { name: cleanName(p.name).slice(0, 30), exchanges: [...new Set(ex)], noAccount: [...new Set(noAccount)], goals: (Array.isArray(p.goals) ? p.goals : []).filter((g) => GOALS.includes(g)).slice(0, GOALS.length) };
}
const SERIES_KEYS = new Set(points.POINT_SERIES.map((s) => s.key));
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
    if (out[ex.id].length > WALLETS_PER_EXCHANGE) errors.push(`${ex.name}: up to ${WALLETS_PER_EXCHANGE} wallets.`);
  }
  return { wallets: out, errors };
}
// Your referrals' Bulk wallets, watched for their live volume (not part of your own stats). Bulk's
// referral page reads them with a request signed by your wallet, so the tracker uses their public
// trades instead: the same fills Bulk counts as referral volume.
function cleanReferees(input) {
  const bulk = EXCHANGES.find((e) => e.id === 'bulk');
  const list = input && Array.isArray(input.bulk) ? input.bulk : Array.isArray(input) ? input : [];
  const out = [];
  const errors = [];
  const seen = new Set();
  for (const w of list) {
    const address = String((w && w.address) || '').trim();
    if (!address) continue;
    const problem = bulk.validate(address);
    if (problem) {
      errors.push(`${address.slice(0, 12)}… - ${problem}`);
      continue;
    }
    if (seen.has(address)) continue;
    seen.add(address);
    const source = w && w.source === 'bulk' ? 'bulk' : 'manual'; // bulk: picked up from Bulk's Referrals page
    out.push({ address, label: String((w && w.label) || '').trim().slice(0, 40), source });
  }
  if (out.length > REFEREES_MAX) errors.push(`Up to ${REFEREES_MAX} referral wallets.`);
  return { referees: { bulk: out.slice(0, REFEREES_MAX) }, errors };
}
function defaultConfig() {
  return { v: 1, createdAt: Date.now(), invite: null, lastSeen: null, refreshSeconds: 120, wallets: { bulk: [], arcus: [], entropy: [] }, points: [], leagueRewards: [], arcusPointsName: '', alerts: alerts.cleanSettings({ milestones: 'off' }), profile: null, onboardedAt: null, tourDone: false, targets: analytics.defaultTargets(), disabled: [], bulkTargets: analytics.defaultTargets(analytics.BULK_RULES), bulkDisabled: [], myCodes: [], referees: { bulk: [] }, refInEstimates: false };
}
function loadConfig(file) {
  const base = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      v: 1,
      createdAt: Number(raw.createdAt) || base.createdAt,
      invite: raw.invite || null,
      lastSeen: Number(raw.lastSeen) || null,
      refreshSeconds: Math.min(3600, Math.max(MIN_REFRESH, Number(raw.refreshSeconds) || base.refreshSeconds)),
      wallets: cleanWallets(raw.wallets).wallets,
      points: cleanPoints(raw.points),
      leagueRewards: leagues.cleanReceived(raw.leagueRewards),
      arcusPointsName: cleanName(raw.arcusPointsName),
      alerts: alerts.cleanSettings({ milestones: 'off', ...raw.alerts }),
      profile: cleanProfile(raw.profile),
      onboardedAt: Number(raw.onboardedAt) || null,
      tourDone: raw.tourDone === true,
      targets: analytics.cleanTargets(raw.targets),
      disabled: analytics.cleanDisabled(raw.disabled),
      bulkTargets: analytics.cleanTargets(raw.bulkTargets, analytics.BULK_RULES),
      bulkDisabled: analytics.cleanDisabled(raw.bulkDisabled, analytics.BULK_RULES),
      myCodes: referrals.cleanMine(raw.myCodes),
      referees: cleanReferees(raw.referees).referees,
      refInEstimates: raw.refInEstimates === true,
    };
  } catch {
    return base;
  }
}

// ---------- a workspace: one person's dashboard ----------
const statusKey = (exId, address) => `${exId}:${address}`;

class Workspace {
  constructor(id) {
    this.id = id;
    this.dir = path.join(USERS_DIR, id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.configFile = path.join(this.dir, 'config.json');
    this.config = loadConfig(this.configFile);
    this.pointsStore = new points.PointsStore(this.dir);
    shareMarket(this.pointsStore.state);
    this.pointsJob = null;
    this.balanceBook = new portfolio.BalanceBook(this.dir);
    this.liveBalances = new portfolio.LiveBalances();
    this.alertCenter = new alerts.AlertCenter(this.dir);
    this.watch = new MarketWatch();
    this.walletStatus = {};
    this.refStatus = {}; // referral wallets' sync state, by address
    this.refPrepared = null;
    this.syncing = false;
    this.syncQueued = false;
    this.lastSyncStart = null;
    this.lastSyncEnd = null;
    this.stats = null;
    this.prepared = null;
    this.version = 0;
    this.viewCache = new Map();
    this.freshCache = { key: null, hedges: null };
    this.watchTimer = null;
    this.alertsAt = 0;
    this.lastSeen = Date.now();
    this.savedSeenAt = 0;
    this.closed = false;
  }

  save() {
    writeJsonAtomic(this.configFile, this.config);
  }

  touch() {
    this.lastSeen = Date.now();
    if (this.lastSeen - this.savedSeenAt > 10 * 60 * 1000) {
      this.savedSeenAt = this.lastSeen;
      this.config.lastSeen = this.lastSeen;
      try {
        this.save();
      } catch {}
    }
  }

  bump() {
    this.version += 1;
    this.viewCache.clear();
  }

  cachedView(key, build) {
    const k = `${this.version}|${key}`;
    if (!this.viewCache.has(k)) this.viewCache.set(k, build());
    return this.viewCache.get(k);
  }

  pointsView() {
    if (!this.prepared) this.recompute();
    return points.computePoints(this.prepared, this.pointsStore.state, { points: this.config.points, arcusName: this.config.arcusPointsName, wallets: this.config.wallets });
  }

  // Your effective taker fee per exchange (bps), for what swapping a hedge's sides would cost.
  takerBps() {
    const out = {};
    for (const e of (this.prepared && this.prepared.exchanges) || []) {
      let fee = 0;
      let vol = 0;
      for (const w of e.wallets) for (const f of w.rich) if (f.role !== 'M' && f.n > 0) (fee += f.fee), (vol += f.n);
      if (vol > 1000) out[e.id] = (fee / vol) * 1e4;
    }
    return out;
  }

  freshHedges() {
    if (!this.stats) return [];
    const key = `${this.stats.generatedAt}|${this.watch.at}`;
    if (this.freshCache.key !== key) this.freshCache = { key, hedges: this.watch.fresh(this.stats.hedges, this.takerBps()) };
    return this.freshCache.hedges;
  }

  // Alerts are kept in the workspace; the open dashboard shows them, plays the sound and, if the
  // person allowed it, shows a browser notification.
  runAlerts() {
    if (!this.prepared || !this.stats) return;
    this.alertsAt = Date.now();
    try {
      const fills = [];
      for (const e of this.prepared.exchanges) for (const w of e.wallets) for (const f of w.fills) if (f.liq) fills.push({ ...f, exchange: e.id });
      let bulk = null;
      if ((this.config.wallets.bulk || []).length) {
        const lv = this.liveView();
        bulk = { legs: lv.bulk, base: lv.rate.base, oiHour: lv.rate.oiHour, model: lv.model, cutoff: lv.cutoff, hold: this.holdKnown() };
      }
      this.alertCenter.evaluate({ hedges: this.freshHedges(), fills, settings: this.config.alerts, bulk });
    } catch (e) {
      console.error(`[${this.id.slice(0, 6)}] alerts: ${e.message}`);
    }
  }

  scheduleWatch(ms) {
    clearTimeout(this.watchTimer);
    if (this.closed) return;
    this.watchTimer = setTimeout(async () => {
      if (Date.now() - this.lastSeen > ACTIVE_MS) {
        this.watchTimer = null;
        return;
      }
      try {
        if (this.stats && this.stats.positions.length) {
          await this.watch.tick(plainHttp, this.stats.positions);
          this.runAlerts();
        }
      } catch {
        // next time
      }
      this.scheduleWatch(this.watch.interval(this.freshHedges()));
    }, ms);
  }

  stopWatch() {
    clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }

  recordBalances() {
    if (!this.prepared) return;
    try {
      const view = portfolio.computePortfolio(this.prepared, this.liveBalances, null, Date.now());
      const values = {};
      for (const x of view.exchanges) values[x.id] = x.equity;
      this.balanceBook.record(Date.now(), values);
    } catch (e) {
      console.error(`[${this.id.slice(0, 6)}] balances: ${e.message}`);
    }
  }

  recompute() {
    this.prepared = prepare({
      now: Date.now(),
      exchanges: EXCHANGES.map((ex) => ({
        id: ex.id,
        name: ex.name,
        appUrl: ex.appUrl,
        wallets: (this.config.wallets[ex.id] || []).map((w) => ({ ...w, cache: store.get(ex.id, w.address), status: this.walletStatus[statusKey(ex.id, w.address)] || null })),
      })),
    });
    this.stats = computeStats(this.prepared);
    this.prepareReferees();
    this.bump();
  }

  // Every referral wallet: the ones listed (by hand, or picked up from Bulk's Referrals page by the
  // bookmark) plus any of your own Bulk wallets that one of your codes referred (Bulk's AURA data
  // for each wallet names the wallet that referred it).
  allReferees() {
    const listed = this.config.referees.bulk || [];
    const mine = this.config.wallets.bulk || [];
    const own = new Set(mine.map((w) => w.address));
    const st = this.pointsStore.state.bulk || {};
    const auto = [];
    for (const w of mine) {
      const d = st[w.address] && st[w.address].wallet;
      const by = d && d.referred_by_wallet;
      if (by && by !== w.address && own.has(by) && !listed.some((x) => x.address === w.address)) auto.push({ address: w.address, label: w.label || `Your wallet ${w.address.slice(0, 4)}…`, source: 'own' });
    }
    return [...listed, ...auto];
  }

  // Merge the referred wallets the bookmark read from Bulk's Referrals page (logged in): new ones are
  // added, ones you removed by hand stay removed until Bulk lists a new one.
  addBulkReferees(list) {
    const have = this.config.referees.bulk || [];
    const own = new Set((this.config.wallets.bulk || []).map((w) => w.address));
    const bx = EXCHANGES.find((e) => e.id === 'bulk');
    list = list.filter((x) => !bx.validate(x.wallet));
    const fresh = list.filter((x) => !own.has(x.wallet) && !have.some((w) => w.address === x.wallet)).sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const room = Math.max(0, REFEREES_MAX - have.length);
    const add = fresh.slice(0, room).map((x) => ({ address: x.wallet, label: '', source: 'bulk' }));
    const { referees } = cleanReferees({ bulk: [...have, ...add] });
    this.config.referees = referees;
    return { found: list.length, added: add.length, skipped: Math.max(0, fresh.length - add.length) };
  }

  // Referral wallets, prepared on their own: their trades and open positions, never in your stats.
  prepareReferees() {
    const refs = this.allReferees();
    const bx = EXCHANGES.find((e) => e.id === 'bulk');
    this.refPrepared = refs.length ? prepare({ now: Date.now(), exchanges: [{ id: 'bulk', name: bx.name, appUrl: bx.appUrl, wallets: refs.map((w) => ({ ...w, cache: store.get('bulk', w.address) })) }] }) : null;
  }

  async syncReferee(ex, wallet) {
    const ctx = { http: { get: (url, opts) => api.get(url, opts), post: (url, body, opts) => api.post(url, body, opts) }, progress: () => {} };
    try {
      const cache = await syncWalletShared(ex, wallet, ctx);
      this.refStatus[wallet.address] = { state: 'ok', error: null, syncedAt: cache.syncedAt };
    } catch (e) {
      const cache = store.get(ex.id, wallet.address);
      this.refStatus[wallet.address] = { state: 'error', error: ex.explainError(e), syncedAt: cache.syncedAt || null };
    }
  }

  async syncWallet(ex, wallet) {
    const key = statusKey(ex.id, wallet.address);
    const st = (this.walletStatus[key] = { ...(this.walletStatus[key] || {}), state: 'syncing', progress: 'starting', error: null });
    const onRetry = ({ waitMs, status, host }) => {
      st.progress = status === 429 ? `rate-limited by ${host}, waiting ${Math.ceil(waitMs / 1000)}s` : `retrying ${host}`;
    };
    const ctx = {
      http: { get: (url, opts) => api.get(url, { ...opts, onRetry }), post: (url, body, opts) => api.post(url, body, { ...opts, onRetry }) },
      progress: (msg) => {
        st.progress = msg;
      },
    };
    try {
      const cache = await syncWalletShared(ex, wallet, ctx);
      this.walletStatus[key] = { state: 'ok', error: null, progress: null, syncedAt: cache.syncedAt };
    } catch (e) {
      const cache = store.get(ex.id, wallet.address);
      this.walletStatus[key] = { state: 'error', error: ex.explainError(e), progress: null, syncedAt: cache.syncedAt || null };
    }
  }

  async syncAll() {
    if (this.syncing) {
      this.syncQueued = true;
      return;
    }
    this.syncing = true;
    this.lastSyncStart = Date.now();
    // Points (AURA, Arcus points and the market volume behind the estimates) load alongside, but the
    // dashboard doesn't wait for them: trades show as soon as they're in, estimates when ready.
    this.syncPointsSoon();
    try {
      await Promise.all(
        EXCHANGES.map(async (ex) => {
          for (const w of this.config.wallets[ex.id] || []) await this.syncWallet(ex, w);
        })
      );
      // Then your referrals' wallets (for referral volume only).
      const bx = EXCHANGES.find((e) => e.id === 'bulk');
      for (const w of this.config.referees.bulk || []) await this.syncReferee(bx, w);
    } finally {
      try {
        this.recompute();
        this.recordBalances();
        try {
          points.recordEstimates(this.pointsStore, this.prepared, this.config);
        } catch {}
        try {
          this.recordGauntlet();
        } catch (e) {
          console.error(`[${this.id.slice(0, 6)}] gauntlet check: ${e.message}`);
        }
        this.runAlerts();
        this.scheduleWatch(1000);
      } catch (e) {
        console.error(`[${this.id.slice(0, 6)}] stats: ${e.stack || e.message}`);
      }
      this.syncing = false;
      this.lastSyncEnd = Date.now();
      if (this.syncQueued && !this.closed) {
        this.syncQueued = false;
        setImmediate(() => this.syncAll());
      }
    }
  }

  syncPointsSoon() {
    if (this.pointsJob) return this.pointsJob;
    this.pointsJob = pointsSlots(() => points.syncPoints(plainHttp, this.pointsStore, this.config))
      .catch((e) => console.error(`[${this.id.slice(0, 6)}] points: ${e.message}`))
      .finally(() => {
        this.pointsJob = null;
        saveMarket();
        try {
          if (this.prepared) points.recordEstimates(this.pointsStore, this.prepared, this.config);
          if (this.prepared) this.recordGauntlet();
        } catch {}
        this.bump();
      });
    return this.pointsJob;
  }

  close() {
    this.closed = true;
    this.stopWatch();
    this.config.lastSeen = this.lastSeen;
    try {
      this.save();
    } catch {}
  }

  // Your Bulk AURA rate and this week's estimate, for Strategy's Bulk view.
  bulkAura() {
    try {
      const p = this.pointsView().programs.find((x) => x.id === 'bulk');
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
    } catch {
      return null;
    }
  }

  // Bulk's AURA rates this week (your estimate's, else the model's typical ones): per $ of taker
  // volume, per $ open for an hour, and what an hour open adds relative to a quick round trip.
  bulkRates() {
    return this.cachedView(`bulk-rates|${this.pointsStore.version}`, () => {
      const a = this.bulkAura();
      const r = a && a.rates;
      const hold = (m) => (estimate.model.hold && m > 0 ? m : null);
      if (r && r.taker > 0) return { base: r.taker, oiHour: hold(r.oiHour), perHour: hold(r.perHour), source: r.own ? 'yours' : 'typical', week: a.lastWeek ? a.lastWeek.week : null };
      const f = estimate.model.ref;
      if (f) return { base: f.taker * (f.credit || 1), oiHour: f.oiHour * (f.credit || 1), perHour: estimate.model.hold ? estimate.model.hold.perHour : null, source: 'typical', week: null };
      return { base: 0, oiHour: null, perHour: null, source: 'none', week: null };
    });
  }

  holdKnown() {
    return Boolean(estimate.model.hold && estimate.model.hold.perHour > 0);
  }

  // Referral AURA. Bulk pays 1 AURA for every 4 Trading AURA your referrals earn. Their volume this
  // AURA week is read live from the referral wallets you list (no projection), and the referral AURA
  // it should earn is worked out at this week's rates, then checked against the weeks Bulk has
  // revealed (your referral volume and referral AURA as Bulk counted them).
  referralView(now = Date.now()) {
    return this.cachedView(`ref|${this.pointsStore.version}|${Math.floor(now / 120000)}`, () => this.referralViewNow(now));
  }

  referralViewNow(now) {
    const pv = this.cachedView(`points|${this.pointsStore.version}`, () => this.pointsView());
    const p = pv.programs.find((x) => x.id === 'bulk');
    const d = p && p.data;
    const e = p && p.estimate;
    const start = e && e.window ? e.window.start : analytics.bulkWeekStart(now);
    const end = e && e.window ? e.window.end : start + 7 * markettime.DAY;
    const upto = Math.min(now, end);
    // This week's rates: your estimate's, else the model's typical ones.
    let rates = e && e.rates && e.rates.taker > 0 ? { taker: e.rates.taker, oiHour: e.rates.oiHour || 0, liq: e.rates.liq || e.rates.taker, source: e.rates.own ? 'yours' : 'typical' } : null;
    if (!rates) {
      const r = this.bulkRates();
      rates = r.base > 0 ? { taker: r.base, oiHour: r.oiHour || 0, liq: r.base, source: r.source } : null;
    }
    const tradingOf = (a, rt) => (rt ? rt.taker * a.taker + (rt.oiHour || 0) * a.oiHours + (rt.liq || rt.taker) * a.liq : 0);
    const refs = this.allReferees();
    if (refs.length && (!this.refPrepared || this.refPrepared.exchanges[0].wallets.length !== refs.length)) this.prepareReferees();
    const rw = this.refPrepared ? this.refPrepared.exchanges[0].wallets : [];
    const allFor = points.bulkActivity(rw);
    const wallets = refs.map((w, i) => {
      const a = rw[i] ? points.bulkActivity([rw[i]])(start, upto) : { taker: 0, maker: 0, liq: 0, oiHours: 0 };
      const st = this.refStatus[w.address] || null;
      const cache = store.get('bulk', w.address);
      return { address: w.address, label: w.label || '', source: w.source || 'manual', volume: a.taker + a.maker + a.liq, taker: a.taker, maker: a.maker, oiHours: a.oiHours, trading: tradingOf(a, rates), syncedAt: cache.syncedAt || null, state: st ? st.state : cache.syncedAt ? 'ok' : 'pending', error: st ? st.error : null };
    });
    const live = wallets.reduce((t, w) => ({ volume: t.volume + w.volume, taker: t.taker + w.taker, maker: t.maker + w.maker, trading: t.trading + w.trading }), { volume: 0, taker: 0, maker: 0, trading: 0 });

    // Revealed weeks: Bulk's referral volume and AURA, what your listed wallets traded in them, and
    // what the 1:4 rule gives at that week's rates (the rates Bulk paid you, from your estimate).
    const eff = new Map(((e && e.calibration) || []).filter((c) => c.eff).map((c) => [c.week, c.eff]));
    // Bulk's referral volume for a week, summed over all your Bulk wallets (any of them can be the
    // one whose code was used).
    const aura = this.pointsStore.state.bulk || {};
    const refVolOf = (n) => {
      let t = null;
      for (const w of this.config.wallets.bulk || []) {
        const s = aura[w.address] && aura[w.address].weeks && aura[w.address].weeks[n];
        if (s && s.referral_trading_volume != null) t = (t || 0) + (Number(s.referral_trading_volume) || 0);
      }
      return t;
    };
    const weeks = (d && Array.isArray(d.weeks) ? d.weeks : [])
      .filter((w) => !w.pending && w.publishAt <= now && w.end <= now && w.end > now - 10 * 7 * markettime.DAY)
      .map((w) => {
        const a = rw.length ? allFor(w.start, w.end) : null;
        const measured = a ? a.taker + a.maker + a.liq : null;
        const r = eff.get(w.week);
        const predicted = a && r ? REF_AURA_RATIO * tradingOf(a, { taker: r.taker, oiHour: r.oiHour || 0, liq: r.liq || r.taker }) : null;
        return { week: w.week, start: w.start, end: w.end, bulkVolume: refVolOf(w.week), bulkAura: w.referrals || 0, measured, predicted };
      })
      .filter((w) => w.bulkVolume > 0 || w.bulkAura > 0 || w.measured > 0);
    // How far the rule has been off per dollar (so missing wallets don't count as a miss): Bulk's
    // referral AURA per $ of its referral volume over the rule's per $ of your wallets' volume.
    const ratios = weeks
      .filter((w) => w.bulkVolume > 1000 && w.bulkAura > 0 && w.measured > 1000 && w.predicted > 0)
      .slice(-4)
      .map((w) => w.bulkAura / w.bulkVolume / (w.predicted / w.measured));
    let factor = 1;
    if (ratios.length) {
      const sorted = ratios.slice().sort((a, b) => a - b);
      const m = sorted.length >> 1;
      const med = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
      factor = Math.min(2, Math.max(0.5, Math.exp((Math.log(med) * ratios.length) / (ratios.length + 1))));
    }
    const raw = REF_AURA_RATIO * live.trading;
    const lastWeek = weeks.filter((w) => w.bulkVolume != null || w.bulkAura > 0).pop() || null;
    return {
      start,
      end,
      ratio: REF_AURA_RATIO,
      included: this.config.refInEstimates === true,
      rates: rates ? { taker: rates.taker, oiHour: rates.oiHour, source: rates.source } : null,
      wallets,
      max: REFEREES_MAX,
      live: { ...live, at: Math.max(0, ...wallets.map((w) => w.syncedAt || 0)) || null },
      aura: refs.length && rates ? { soFar: raw * factor, raw, factor: Math.round(factor * 1000) / 1000, checks: ratios.length } : null,
      weeks: weeks.slice(-6),
      lastWeek,
      code: this.bulkReferralInfo(),
    };
  }

  // Your own Bulk referral code and how many people used it, from your AURA data.
  bulkReferralInfo() {
    for (const w of this.config.wallets.bulk || []) {
      const e = (this.pointsStore.state.bulk || {})[w.address];
      const d = e && e.wallet;
      if (d && d.referral_code) return { code: d.referral_code, sent: Number(d.referrals_sent) || 0, qualified: Number(d.referrals_qualified) || 0, referredBy: d.referred_by_code || null };
    }
    return null;
  }

  // Bulk's volume this AURA week straight from its hourly candles, projected to the cutoff (all
  // markets, or some: `syms`).
  bulkWeekVolume(now = Date.now(), syms = null) {
    const DAY = markettime.DAY;
    const start = analytics.bulkWeekStart(now);
    const end = start + 7 * DAY;
    const H = syms ? points.bulkSymHours(this.pointsStore.state, syms) : points.bulkHours(this.pointsStore.state);
    const keys = Object.keys(H).map(Number);
    if (!keys.length) return null;
    const upto = Math.min(now, end, Math.max(...keys) + 3600 * 1000);
    const soFar = estimate.hoursTotal(H, start, upto);
    const lastWeek = estimate.hoursTotal(H, upto - 7 * DAY, upto);
    const typical = keys.some((t) => t <= upto - 6 * DAY) && lastWeek > 0 ? lastWeek / 7 : null;
    if (!(soFar > 0) && !typical) return null;
    const v = estimate.projectVolume(soFar, start, end, upto, typical);
    return { start, end, soFar, projected: v.projected, daily: v.daily };
  }

  // This week's gauntlet (set on the admin page) and what your trading should earn from it: your
  // taker volume on its goal (so far, and at your pace) against Bulk's, from its public candles.
  // Scaled by the self-check (what Bulk paid against what dashboards estimated in past weeks).
  gauntletView(now = Date.now()) {
    const g = this.gauntletRaw(now);
    if (!g.set || !g.measurable || !g.aura) return g;
    const cal = season.calibration();
    const last = this.gauntletChecks().slice(-1)[0] || null;
    return { ...g, raw: g.aura, aura: { soFar: g.aura.soFar * cal.factor, projected: g.aura.projected * cal.factor }, calibration: { ...cal, last } };
  }

  // Your finished gauntlet weeks: what the tracker estimated near the cutoff and what Bulk paid (from
  // your AURA, once it's been read after that week's reveal).
  gauntletChecks() {
    const log = ((this.pointsStore.state.estLog || {}).gauntlet) || {};
    const done = Object.keys(log).filter((k) => log[k] && log[k].end <= Date.now()).sort().join(',');
    if (!done) return [];
    return this.cachedView(`gchecks|${this.pointsStore.version}|${done}`, () => this.gauntletChecksNow(log));
  }

  gauntletChecksNow(log) {
    const p = this.pointsView().programs.find((x) => x.id === 'bulk');
    const d = p && p.data;
    if (!d || !Array.isArray(d.weeks)) return [];
    const out = [];
    for (const [k, e] of Object.entries(log)) {
      const start = Number(k);
      if (!e || !(e.end <= Date.now())) continue;
      const wk = d.weeks.find((w) => Math.abs(w.start - start) < 3600 * 1000);
      if (!wk || !(wk.publishAt <= (d.dataAt || 0))) continue; // not revealed, or your AURA predates it
      const estimated = e.at >= e.end - 12 * 3600 * 1000 ? e.aura : e.projected; // logged near the cutoff, or the pace
      out.push({ start, week: wk.week, title: e.title || null, estimated: Math.round(estimated), paid: Math.round(wk.gauntlet || 0) });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // Through the week: log this gauntlet's estimate (before the self-check's scaling). After the
  // reveal: share how far it was off, without saying whose it was.
  recordGauntlet(now = Date.now()) {
    const g = this.gauntletRaw(now);
    const st = this.pointsStore.state;
    const log = ((st.estLog = st.estLog || {}).gauntlet = st.estLog.gauntlet || {});
    let changed = false;
    if (g.set && g.measurable && g.aura && g.totalKnown && now < g.end) {
      log[g.start] = { at: now, end: g.end, title: g.title, aura: Math.round(g.aura.soFar * 10) / 10, projected: Math.round(g.aura.projected * 10) / 10, yours: Math.round(g.yours.soFar), total: Math.round(g.total.soFar) };
      changed = true;
    }
    for (const k of Object.keys(log)) if (Number(k) < now - 70 * markettime.DAY) {
      delete log[k];
      changed = true;
    }
    if (changed) this.pointsStore.save();
    const anon = crypto.createHash('sha256').update(`gauntlet|${this.id}`).digest('hex').slice(0, 12);
    // Only weeks with enough at stake to say something (20 AURA estimated).
    for (const c of this.gauntletChecks()) if (c.estimated >= 20) season.offerCheck(c.start, anon, c.paid / c.estimated);
  }

  gauntletRaw(now = Date.now()) {
    const DAY = markettime.DAY;
    const start = analytics.bulkWeekStart(now);
    const end = start + 7 * DAY;
    const g = season.gauntlet(start);
    if (!g) return { set: false, start, end, reward: gauntlet.REWARD };
    const base = { set: true, start, end, ...g, goalLabel: gauntlet.GOALS[g.goal], measurable: g.goal !== 'other' };
    if (!base.measurable) return base;
    if (!this.prepared) this.recompute();
    const want = g.goal === 'markets' ? new Set(g.markets) : null;
    let soFar = 0;
    let before = 0; // the 14 days before this week, for your usual pace
    for (const ex of this.prepared.exchanges) {
      if (ex.id !== 'bulk') continue;
      for (const w of ex.wallets) {
        for (const f of w.fills) {
          if (f.role !== 'T' || (want && !want.has(f.mkt))) continue;
          if (f.ts >= start && f.ts < Math.min(now, end)) soFar += f.sz * f.px;
          else if (f.ts >= start - 14 * DAY && f.ts < start) before += f.sz * f.px;
        }
      }
    }
    const mine = estimate.projectVolume(soFar, start, end, now, before > 0 ? before / 14 : null);
    const all = this.bulkWeekVolume(now, want ? [...want] : null);
    const est = gauntlet.estimate(g, { yourSoFar: soFar, yourProjected: mine.projected, totalSoFar: all ? all.soFar : 0, totalProjected: all ? all.projected : 0 });
    return { ...base, ...(est || {}), totalKnown: Boolean(all) };
  }

  leaguesView() {
    const now = Date.now();
    const p = this.pointsView().programs.find((x) => x.id === 'bulk');
    const weekStart = analytics.bulkWeekStart(now);
    const tradShare = points.bulkTradShare(this.pointsStore.state, weekStart, now + 3600 * 1000);
    // League cutoffs from your AURA import help every dashboard.
    const t = p && p.data && p.data.trading;
    if (t && t.cutoffs && t.cutoffsAt) season.offerCutoffs({ at: t.cutoffsAt, population: t.cutoffPopulation, cutoffs: t.cutoffs }, 'import');
    const g = this.gauntletView(now);
    const gAura = g.aura ? g.aura.projected : 0;
    return {
      hasBulk: (this.config.wallets.bulk || []).length > 0,
      gauntlet: g,
      ...leagues.computeLeagues({ bulk: p && p.data, estimate: p && p.estimate, received: this.config.leagueRewards, takerBps: this.takerBps().bulk, tradShare, market: this.bulkWeekVolume(now), gauntletAura: gAura, shared: season.cutoffs(), now }),
    };
  }

  // AURA Planner (experimental): what the page needs to price a Bulk trade before opening it. The
  // page does the arithmetic as you type: AURA = taker rate x taker volume + hold rate x dollars
  // open x hours; fees from Bulk's tiers.
  plannerView() {
    if (!this.prepared) this.recompute();
    const now = Date.now();
    const DAY = markettime.DAY;
    const p = this.pointsView().programs.find((x) => x.id === 'bulk');
    const e = p && p.estimate;
    const rate = this.bulkRates();
    // Fee tier: your Bulk volume over the trailing 14 completed UTC days (sub-accounts included).
    const today = Math.floor(now / DAY) * DAY;
    let vol14 = 0;
    for (const ex of this.prepared.exchanges) if (ex.id === 'bulk') for (const w of ex.wallets) for (const f of w.fills) if (f.ts >= today - 14 * DAY && f.ts < today) vol14 += f.sz * f.px;
    const tier = markets.cryptoTier(vol14);
    const syms = points.bulkSymbols(this.pointsStore.state);
    const meta = points.bulkMarketMeta(this.pointsStore.state);
    const list = (syms.length ? syms : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'HYPE-USD', 'US500-USD', 'QQQ-USD', 'TSLA-USD', 'NVDA-USD'])
      .filter((symbol) => !meta[symbol] || !meta[symbol].status || meta[symbol].status === 'TRADING') // closed markets can't be traded
      .map((symbol) => {
        const cls = markets.bulkClass(symbol);
        return { symbol, cls, takerBps: markets.takerBps(cls, vol14, symbol), maxLeverage: meta[symbol] ? meta[symbol].maxLeverage : null };
      });
    const weekStart = analytics.bulkWeekStart(now);
    const pts = e && e.points;
    const err = pts && pts.projected > 0 && pts.high > pts.low ? Math.min(0.5, Math.max(0.03, (pts.high - pts.low) / (2 * pts.projected))) : 0.15;
    let league = null;
    try {
      const lv = this.leaguesView();
      if (lv.leagues) league = { endAura: lv.you ? lv.you.endAura : null, current: lv.you ? lv.you.projected : null, qualified: lv.you ? lv.you.qualified : null, cutoffs: Object.fromEntries(lv.leagues.map((l) => [l.id, l.cutoff])), names: Object.fromEntries(lv.leagues.map((l) => [l.id, l.name])) };
    } catch {}
    const d = p && p.data;
    const g = this.gauntletView(now);
    return {
      now,
      gauntlet: g.set ? { title: g.title, goal: g.goal, goalLabel: g.goalLabel, markets: g.markets, reward: g.reward, note: g.note, measurable: g.measurable, total: g.total || null, yours: g.yours || null, calibration: g.calibration || null } : null,
      hasBulk: (this.config.wallets.bulk || []).length > 0,
      cutoff: weekStart + 7 * DAY,
      rates: { base: rate.base || 0, oiHour: rate.oiHour || 0, source: rate.source, week: rate.week },
      err,
      tier,
      tradfiBps: markets.TRADFI_TAKER_BPS,
      makerBps: markets.MAKER_BPS,
      markets: list,
      league,
      yourFeesPer1k: d && d.weeks ? (() => {
        const ws = d.weeks.filter((w) => w.feesPer1k > 0);
        return ws.length ? ws[ws.length - 1].feesPer1k : null;
      })() : null,
    };
  }

  // Live page: open positions with hold time, PnL and distance to liquidation, hedges grouped.
  liveView() {
    if (!this.prepared) this.recompute();
    const now = Date.now();
    const weekStart = analytics.bulkWeekStart(now);
    const rate = this.bulkRates();
    const bulk = [];
    const other = [];
    for (const ex of this.prepared.exchanges) {
      for (const w of ex.wallets) {
        for (const p of w.positions || []) {
          const m = this.watch.marks[`${ex.id}|${p.mkt}`];
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
    const fresh = new Map(this.freshHedges().map((g) => [g.asset, g]));
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
    return { now, weekStart, cutoff: weekStart + 7 * markettime.DAY, model: { perHour: rate.perHour, week: 168 }, rate, takerBps: this.takerBps().bulk || 3.5, hasBulk: (this.config.wallets.bulk || []).length > 0 && this.holdKnown(), bulk, other, groups, syncedAt: this.lastSyncEnd, pricesAt: Math.max(this.lastSyncEnd || 0, this.watch.at || 0) || null };
  }

  snapshot() {
    const now = Date.now();
    const weekStart = markettime.pointsWeekStart(now);
    const c = this.config;
    return {
      now,
      version: VERSION,
      hosted: true,
      limits: { walletsPerExchange: WALLETS_PER_EXCHANGE, minRefresh: MIN_REFRESH },
      pointsWeek: { start: weekStart, next: markettime.pointsWeekStart(weekStart + 8 * markettime.DAY) },
      drops: points.nextDrops(this.pointsStore.state, now, c.wallets, c.arcusPointsName),
      pointsSync: { running: this.pointsStore.busy, version: this.pointsStore.version, errors: this.pointsStore.state.errors || {} },
      market: markettime.marketStatus(now),
      config: { refreshSeconds: c.refreshSeconds, wallets: c.wallets, referees: c.referees, refInEstimates: c.refInEstimates === true, targets: c.targets, disabled: c.disabled, bulkTargets: c.bulkTargets, bulkDisabled: c.bulkDisabled, arcusPointsName: c.arcusPointsName, profile: c.profile, onboardedAt: c.onboardedAt, tourDone: c.tourDone },
      signup: referrals.OURS.map((r) => ({ id: r.id, name: r.name, code: r.code, accessCode: r.accessCode || null, link: r.link, perk: r.perk, ready: referrals.ready(r) })),
      developer: referrals.DEVELOPER,
      rules: analytics.RULES.map(({ id, label, quote, why, bench, unit, cmp, target }) => ({ id, label, quote, why, bench, unit, cmp, default: target })),
      bulkHold: this.prepared ? (({ perHour, base, oiHour }) => ({ perHour, base, oiHour, week: 168 }))(this.bulkRates()) : { perHour: estimate.BULK_HOLD.perHour, week: 168 },
      bulkRules: analytics.BULK_RULES.map(({ id, label, why, bench, unit, cmp, target }) => ({ id, label, why, bench, unit, cmp, default: target })),
      windows: analytics.WINDOWS,
      pointSeries: points.POINT_SERIES,
      programs: points.PROGRAMS,
      exchanges: EXCHANGES.map((ex) => ({ id: ex.id, name: ex.name, appUrl: ex.appUrl, addressKind: ex.addressKind, addressHint: ex.addressHint })),
      sync: { running: this.syncing, lastStart: this.lastSyncStart, lastEnd: this.lastSyncEnd, wallets: this.walletStatus },
      stats: this.stats ? { ...this.stats, hedges: this.freshHedges() } : this.stats,
      watch: { at: this.watch.at || null, errors: this.watch.errors },
      alerts: { recent: this.alertCenter.recent(8), settings: c.alerts },
    };
  }

  exportFile(what) {
    if (!this.prepared) this.recompute();
    const day = new Date().toISOString().slice(0, 10);
    const c = this.config;
    if (what === 'all') {
      const caches = {};
      for (const ex of EXCHANGES) for (const w of c.wallets[ex.id] || []) caches[`${ex.id}:${w.address}`] = store.get(ex.id, w.address);
      const config = { wallets: c.wallets, points: c.points, leagueRewards: c.leagueRewards, arcusPointsName: c.arcusPointsName, alerts: c.alerts, profile: c.profile, targets: c.targets, disabled: c.disabled, bulkTargets: c.bulkTargets, bulkDisabled: c.bulkDisabled, myCodes: c.myCodes, referees: c.referees, refInEstimates: c.refInEstimates };
      return { name: `perps-tracker-${day}.json`, type: 'application/json; charset=utf-8', body: JSON.stringify({ app: 'perps-tracker', exportedAt: new Date().toISOString(), config, caches, balances: this.balanceBook.points, stats: this.stats }, null, 1) };
    }
    if (what === 'trades.csv') {
      const rows = [['exchange', 'wallet', 'address', 'time_utc', 'market', 'side', 'size', 'price', 'notional_usd', 'fee_usd', 'role', 'realised_pnl_usd', 'counted']];
      for (const ex of this.prepared.exchanges) {
        for (const w of ex.wallets) {
          for (const f of [...store.get(ex.id, w.address).fills].sort((a, b) => a.ts - b.ts)) rows.push([ex.name, w.label, w.address, iso(f.ts), f.mkt, f.side === 'B' ? 'buy' : 'sell', f.sz, f.px, (f.sz * f.px).toFixed(6), f.fee, f.role === 'M' ? 'maker' : 'taker', f.pnl == null ? '' : f.pnl, f.ext ? 'no (placed in another app)' : 'yes']);
        }
      }
      return { name: `perps-trades-${day}.csv`, type: 'text/csv; charset=utf-8', body: csv(rows) };
    }
    if (what === 'positions.csv') {
      const rows = [['exchange', 'wallet', 'market', 'side', 'opened_utc', 'closed_utc', 'held_minutes', 'volume_usd']];
      const all = this.prepared.exchanges.flatMap((ex) => ex.wallets.flatMap((w) => w.cycles.map((cy) => ({ ex, w, cy }))));
      all.sort((a, b) => a.cy.closeTs - b.cy.closeTs);
      for (const { ex, w, cy } of all) rows.push([ex.name, w.label, cy.mkt, cy.side === 'L' ? 'long' : 'short', iso(cy.openTs), iso(cy.closeTs), ((cy.closeTs - cy.openTs) / 60000).toFixed(2), cy.vol == null ? '' : cy.vol.toFixed(2)]);
      return { name: `perps-closed-positions-${day}.csv`, type: 'text/csv; charset=utf-8', body: csv(rows) };
    }
    if (what === 'points.csv') {
      const view = this.pointsView();
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
      return { name: `perps-points-${day}.csv`, type: 'text/csv; charset=utf-8', body: csv(rows) };
    }
    return null;
  }

  // One person's API.
  async handle(req, res, url, body) {
    const c = this.config;
    const p = url.pathname;
    if (req.method === 'GET') {
      if (p === '/api/state') return sendJson(req, res, 200, this.snapshot());
      if (p === '/api/live') return sendJson(req, res, 200, this.liveView());
      if (p === '/api/leagues') return sendJson(req, res, 200, this.cachedView(`leagues|${this.pointsStore.version}|${c.leagueRewards.length}|${season.version || 0}|${Math.floor(Date.now() / 300000)}`, () => this.leaguesView()));
      if (p === '/api/referrals') return sendJson(req, res, 200, { ...referrals.view(c, { bulk: this.bulkReferralInfo() }), bulkRef: this.referralView() });
      if (p === '/api/alerts') return sendJson(req, res, 200, { alerts: this.alertCenter.recent(50), settings: c.alerts });
      if (p === '/api/points') {
        const r = this.referralView();
        const referral = { included: r.included, wallets: r.wallets.length, volume: r.live.volume, aura: r.aura ? r.aura.soFar : null, factor: r.aura ? r.aura.factor : null, lastWeek: r.lastWeek };
        return sendJson(req, res, 200, { ...this.cachedView(`points|${this.pointsStore.version}`, () => this.pointsView()), gauntlet: this.gauntletView(), referral });
      }
      if (p === '/api/planner') return sendJson(req, res, 200, this.plannerView());
      if (p === '/api/strategy' || p === '/api/playbook') {
        if (!this.prepared) this.recompute();
        const platform = analytics.parsePlatform(url.searchParams.get('platform')).key; // one exchange, several, or "all"
        const win = analytics.WINDOWS[url.searchParams.get('window')] ? url.searchParams.get('window') : 'thisWeek';
        if (platform === 'bulk') {
          // Bulk alone: trading AURA habits, with your own AURA rate from the points estimate.
          return sendJson(req, res, 200, this.cachedView(`st|bulk|${win}|${this.pointsStore.version}`, () => analytics.computeStrategy(this.prepared, { platform, window: win, bulkTargets: c.bulkTargets, bulkDisabled: c.bulkDisabled, aura: this.bulkAura() })));
        }
        return sendJson(req, res, 200, this.cachedView(`st|${platform}|${win}`, () => analytics.computeStrategy(this.prepared, { platform, window: win, targets: c.targets, disabled: c.disabled })));
      }
      if (p === '/api/portfolio') {
        if (!this.prepared) this.recompute();
        if (url.searchParams.get('live') === '1') {
          const job = this.liveBalances.refresh(EXCHANGES, c.wallets, store, plainHttp).then(() => this.recordBalances()).catch(() => {});
          await Promise.race([job, new Promise((r) => setTimeout(r, 4000))]);
        }
        return sendJson(req, res, 200, portfolio.computePortfolio(this.prepared, this.liveBalances, this.balanceBook, Date.now()));
      }
      if (p === '/api/fees') {
        if (!this.prepared) this.recompute();
        const win = analytics.WINDOWS[url.searchParams.get('window')] ? url.searchParams.get('window') : '30d';
        return sendJson(req, res, 200, this.cachedView(`fees|${win}`, () => analytics.computeFees(this.prepared, { window: win })));
      }
      if (p.startsWith('/api/export/')) {
        const f = this.exportFile(p.slice('/api/export/'.length));
        if (!f) return sendJson(req, res, 404, { error: 'Unknown export' });
        res.writeHead(200, { ...BASE_HEADERS, ...corsHeaders(req), 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="${f.name}"`, 'Cache-Control': 'no-store' });
        return res.end(f.body);
      }
      return sendJson(req, res, 404, { error: 'Not found' });
    }

    // POST
    if (p === '/api/sync') {
      if (!this.lastSyncStart || Date.now() - this.lastSyncStart > 15 * 1000) this.syncAll();
      return sendJson(req, res, 200, this.snapshot());
    }
    if (p === '/api/profile') {
      if (body.tourDone != null) c.tourDone = Boolean(body.tourDone);
      if (body.name != null) c.profile = cleanProfile({ ...(c.profile || {}), name: body.name });
      this.save();
      return sendJson(req, res, 200, this.snapshot());
    }
    if (p === '/api/onboarding') {
      const { wallets, errors } = cleanWallets(body.wallets || {});
      if (errors.length) return sendJson(req, res, 400, { error: errors.join('\n') });
      c.wallets = wallets;
      c.profile = cleanProfile(body.profile);
      if (body.arcusPointsName != null) c.arcusPointsName = cleanName(body.arcusPointsName);
      if (body.alerts) c.alerts = alerts.cleanSettings({ ...c.alerts, ...body.alerts });
      c.onboardedAt = Date.now();
      this.save();
      this.recompute();
      this.syncAll();
      return sendJson(req, res, 200, this.snapshot());
    }
    if (p === '/api/points') {
      const value = Number(body.value);
      const at = body.at == null ? Date.now() : Number(body.at);
      if (!SERIES_KEYS.has(body.series)) return sendJson(req, res, 400, { error: 'Unknown points series' });
      if (!Number.isFinite(value) || value < 0) return sendJson(req, res, 400, { error: 'Enter a number of points (0 or more)' });
      if (!Number.isFinite(at) || at > Date.now() + 60000) return sendJson(req, res, 400, { error: 'That date is in the future' });
      c.points = cleanPoints([...c.points, { id: crypto.randomUUID(), series: body.series, value, at }]);
      this.save();
      this.bump();
      return sendJson(req, res, 200, { ok: true });
    }
    if (p === '/api/points/bulk-import') {
      // AURA sent from Bulk's website by the one-click bookmark (or pasted by hand), and the wallets
      // you referred if the bookmark could read them from Bulk's Referrals page.
      let refs = null;
      const refObj = points.jsonObjects(String(body.text || '').slice(0, 500000)).find((o) => o && o.kind === 'perps-referees' && Array.isArray(o.list));
      if (refObj) {
        const list = refObj.list.filter((x) => x && typeof x.wallet === 'string').slice(0, 500).map((x) => ({ wallet: x.wallet.trim(), volume: Number(x.volume) || 0 }));
        refs = this.addBulkReferees(list);
        this.save();
        this.prepareReferees();
        if (refs.added && (!this.lastSyncStart || Date.now() - this.lastSyncStart > 15 * 1000)) setImmediate(() => this.syncAll());
      }
      const r = points.importBulk(this.pointsStore, c.wallets.bulk || [], body.text);
      if (r.error && !refs) return sendJson(req, res, 400, { error: r.error });
      this.bump();
      return sendJson(req, res, 200, { ok: true, ...(r.error ? { wallet: 0, weeks: [] } : r), referees: refs });
    }
    if (p === '/api/points/delete') {
      c.points = c.points.filter((x) => x.id !== String(body.id));
      this.save();
      this.bump();
      return sendJson(req, res, 200, { ok: true });
    }
    if (p === '/api/settings') {
      if (body.arcusPointsName != null) c.arcusPointsName = cleanName(body.arcusPointsName);
      this.save();
      this.syncPointsSoon();
      this.bump();
      return sendJson(req, res, 200, this.snapshot());
    }
    if (p === '/api/alerts/settings') {
      c.alerts = alerts.cleanSettings({ ...c.alerts, ...(body.settings || {}) });
      this.save();
      return sendJson(req, res, 200, { ok: true, settings: c.alerts });
    }
    if (p === '/api/alerts/test') {
      this.alertCenter.test(body.level === 'warn' ? 'warn' : 'danger');
      return sendJson(req, res, 200, { ok: true });
    }
    if (p === '/api/leagues/received') {
      const now = Date.now();
      const v = this.leaguesView();
      const WEEK = 7 * 24 * 3600 * 1000;
      const payoutAt = Number(body.payoutAt) || leagues.FIRST_PAYOUT + Math.floor((now - leagues.FIRST_PAYOUT) / WEEK) * WEEK;
      if (!(payoutAt >= leagues.FIRST_PAYOUT) || payoutAt > now) return sendJson(req, res, 400, { error: 'That payout hasn’t happened yet.' });
      if ((payoutAt - leagues.FIRST_PAYOUT) % WEEK !== 0) return sendJson(req, res, 400, { error: 'Payouts are on AURA Saturdays.' });
      if (body.remove) c.leagueRewards = c.leagueRewards.filter((r) => r.payoutAt !== payoutAt);
      else {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount < 0 || amount > 1e7) return sendJson(req, res, 400, { error: 'Enter the amount in dollars, like 4.60.' });
        const league = v.you ? v.you.league : null;
        const bp = this.pointsView().programs.find((x) => x.id === 'bulk');
        const estimated = leagues.estimateFor(payoutAt, league, points.bulkHours(this.pointsStore.state), bp && bp.data, season.cutoffs());
        c.leagueRewards = leagues.cleanReceived([...c.leagueRewards.filter((r) => r.payoutAt !== payoutAt), { payoutAt, amount, league, estimated }]);
      }
      this.save();
      this.bump();
      return sendJson(req, res, 200, this.leaguesView());
    }
    if (p === '/api/targets') {
      // Strategy: your own targets and which habits count.
      if (body.mode === 'bulk') {
        c.bulkTargets = analytics.cleanTargets({ ...c.bulkTargets, ...(body.targets || {}) }, analytics.BULK_RULES);
        if (body.disabled) c.bulkDisabled = analytics.cleanDisabled(body.disabled, analytics.BULK_RULES);
        this.save();
        this.bump();
        return sendJson(req, res, 200, { ok: true, targets: c.bulkTargets, disabled: c.bulkDisabled });
      }
      c.targets = analytics.cleanTargets({ ...c.targets, ...(body.targets || {}) });
      if (body.disabled) c.disabled = analytics.cleanDisabled(body.disabled);
      this.save();
      this.bump();
      return sendJson(req, res, 200, { ok: true, targets: c.targets, disabled: c.disabled });
    }
    if (p === '/api/referrals/bulk') {
      // Referral wallets and whether referral AURA counts in your estimates (Referrals page).
      if (body.referees != null) {
        const { referees, errors } = cleanReferees(body.referees);
        if (errors.length) return sendJson(req, res, 400, { error: errors.join('\n') });
        const added = referees.bulk.some((w) => !(c.referees.bulk || []).some((x) => x.address === w.address));
        c.referees = referees;
        this.prepareReferees();
        if (added && (!this.lastSyncStart || Date.now() - this.lastSyncStart > 15 * 1000)) this.syncAll();
      }
      if (body.inEstimates != null) c.refInEstimates = body.inEstimates === true;
      this.save();
      this.bump();
      return sendJson(req, res, 200, { ...referrals.view(c, { bulk: this.bulkReferralInfo() }), bulkRef: this.referralView() });
    }
    if (p === '/api/referrals/mine') {
      // Your own referral codes (Referrals page).
      c.myCodes = referrals.cleanMine(body.myCodes);
      this.save();
      return sendJson(req, res, 200, referrals.view(c, { bulk: this.bulkReferralInfo() }));
    }
    if (p === '/api/config') {
      const { wallets, errors } = cleanWallets(body.wallets || {});
      if (errors.length) return sendJson(req, res, 400, { error: errors.join('\n') });
      c.wallets = wallets;
      if (body.refreshSeconds != null) c.refreshSeconds = Math.min(3600, Math.max(MIN_REFRESH, Math.round(Number(body.refreshSeconds) || 120)));
      if (body.arcusPointsName != null) c.arcusPointsName = cleanName(body.arcusPointsName);
      if (body.alerts) c.alerts = alerts.cleanSettings({ ...c.alerts, ...body.alerts });
      this.save();
      this.recompute();
      this.syncAll();
      return sendJson(req, res, 200, this.snapshot());
    }
    return sendJson(req, res, 404, { error: 'Not found' });
  }
}

// ---------- workspaces ----------
const workspaces = new Map();
const KEY_RE = /^pt_[A-Za-z0-9_-]{32,64}$/;
const idOf = (key) => crypto.createHash('sha256').update(`perps-tracker:${key}`).digest('hex').slice(0, 32);
const newKey = () => `pt_${crypto.randomBytes(32).toString('base64url')}`;

function openWorkspace(id) {
  let ws = workspaces.get(id);
  if (ws) return ws;
  if (!fs.existsSync(path.join(USERS_DIR, id, 'config.json'))) return null;
  ws = new Workspace(id);
  workspaces.set(id, ws);
  ws.recompute();
  return ws;
}

// Coming from 2.x (one dashboard per folder): its config.json next to server.js and its data folder
// carry over into the first dashboard opened in local mode. Copied: the old files stay as they were.
const V2_FIELDS = ['wallets', 'refreshSeconds', 'points', 'leagueRewards', 'arcusPointsName', 'alerts', 'profile', 'onboardedAt', 'tourDone', 'targets', 'disabled', 'bulkTargets', 'bulkDisabled', 'myCodes'];
function v2Files() {
  const cfg = path.join(ROOT, 'config.json');
  const mark = path.join(DATA_DIR, 'v2-carried-over');
  if (!OPEN || !fs.existsSync(cfg) || fs.existsSync(mark)) return null;
  return { cfg, mark, data: path.join(ROOT, 'data') };
}
function carryOverV2(id) {
  const v2 = v2Files();
  if (!v2) return null;
  const dir = path.join(USERS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  let wallets = 0;
  try {
    for (const name of fs.existsSync(v2.data) ? fs.readdirSync(v2.data) : []) {
      const from = path.join(v2.data, name);
      if (!fs.statSync(from).isFile()) continue;
      if (['points.json', 'balances.json', 'alerts.json'].includes(name)) fs.copyFileSync(from, path.join(dir, name));
      else if (/^(bulk|arcus|entropy)_[A-Za-z0-9]+\.json$/.test(name)) {
        const to = path.join(DATA_DIR, 'wallets', name);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (!fs.existsSync(to)) fs.copyFileSync(from, to);
        wallets += 1;
      }
    }
  } catch (e) {
    console.error(`  [!] Couldn't copy all of the 2.x data: ${e.message}`);
  }
  return { cfg: loadConfig(v2.cfg), raw: JSON.parse(fs.readFileSync(v2.cfg, 'utf8')), mark: v2.mark, wallets };
}
function createWorkspace(inviteCode) {
  const key = newKey();
  const id = idOf(key);
  let old = null;
  try {
    old = carryOverV2(id);
  } catch (e) {
    console.error(`  [!] Couldn't read the 2.x config.json: ${e.message}`);
  }
  const ws = new Workspace(id);
  ws.config.invite = inviteCode;
  if (old) {
    for (const k of V2_FIELDS) if (old.raw[k] !== undefined) ws.config[k] = old.cfg[k];
    fs.writeFileSync(old.mark, `${new Date().toISOString()} -> ${id.slice(0, 8)}\n`);
    console.log(`  Carried over your 2.x settings and data (${old.wallets} wallet histor${old.wallets === 1 ? 'y' : 'ies'}).`);
  }
  ws.save();
  workspaces.set(id, ws);
  ws.recompute();
  return { key, ws };
}

// Sync open dashboards on their own refresh time; let closed ones rest, then leave memory.
setInterval(() => {
  const now = Date.now();
  for (const ws of workspaces.values()) {
    const idle = now - ws.lastSeen;
    if (idle > UNLOAD_MS && !ws.syncing) {
      ws.close();
      workspaces.delete(ws.id);
      continue;
    }
    if (idle > ACTIVE_MS) {
      ws.stopWatch();
      continue;
    }
    if (!ws.syncing && (!ws.lastSyncStart || now - ws.lastSyncStart >= ws.config.refreshSeconds * 1000)) ws.syncAll();
    else if (now - ws.alertsAt >= 60 * 1000) ws.runAlerts(); // the cutoff reminder runs on the clock
    if (!ws.watchTimer && !ws.closed) ws.scheduleWatch(5000);
  }
}, 10 * 1000).unref();

const userIds = () => {
  try {
    return fs.readdirSync(USERS_DIR).filter((d) => /^[0-9a-f]{32}$/.test(d));
  } catch {
    return [];
  }
};

function adminOverview() {
  const now = Date.now();
  const users = [];
  for (const id of userIds()) {
    const live = workspaces.get(id);
    const cfg = live ? live.config : loadConfig(path.join(USERS_DIR, id, 'config.json'));
    const lastSeen = live ? live.lastSeen : cfg.lastSeen;
    users.push({ id: id.slice(0, 8), name: cfg.profile ? cfg.profile.name : '', invite: cfg.invite, createdAt: cfg.createdAt, lastSeen, active: Boolean(lastSeen && now - lastSeen < ACTIVE_MS), wallets: Object.fromEntries(EXCHANGES.map((ex) => [ex.id, (cfg.wallets[ex.id] || []).length])) });
  }
  users.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const weekStart = analytics.bulkWeekStart(now);
  const seasonInfo = { weekStart, weekEnd: weekStart + 7 * markettime.DAY, gauntlet: season.gauntlet(weekStart), goals: gauntlet.GOALS, reward: gauntlet.REWARD, cutoffs: season.cutoffs(), markets: points.bulkSymbols(market).filter((s) => { const m = points.bulkMarketMeta(market)[s]; return !m || !m.status || m.status === 'TRADING'; }) };
  return { version: VERSION, model: estimate.model.status.edition, users, invites: [...invites.list].reverse(), loaded: workspaces.size, uptime: Math.round(process.uptime()), season: seasonInfo };
}

// How the open dashboards' syncs are going, without wallet addresses (/api/health?check=1).
function syncOverview() {
  const now = Date.now();
  return [...workspaces.values()].map((ws) => ({
    id: ws.id.slice(0, 4),
    open: now - ws.lastSeen < ACTIVE_MS,
    syncing: ws.syncing,
    runningFor: ws.syncing && ws.lastSyncStart ? Math.round((now - ws.lastSyncStart) / 1000) : null,
    lastDoneAgo: ws.lastSyncEnd ? Math.round((now - ws.lastSyncEnd) / 1000) : null,
    wallets: Object.entries(ws.walletStatus).map(([k, v]) => ({ exchange: k.split(':')[0], state: v.state, progress: v.progress || null, error: v.error ? String(v.error).slice(0, 160) : null })),
    points: { busy: ws.pointsStore.busy, errors: Object.fromEntries(Object.entries(ws.pointsStore.state.errors || {}).map(([k, v]) => [k, String(v).slice(0, 160)])) },
  }));
}

// Can the server reach every exchange? (/api/health?check=1, at most once a minute.) Shows the HTTP
// status each one answers with; Bulk's AURA page is expected to turn servers away (429/403).
let lastCheck = null;
async function exchangeCheck() {
  if (lastCheck && Date.now() - lastCheck.at < 60 * 1000) return lastCheck.result;
  const probe = async (url, opts = {}) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000), headers: { 'User-Agent': `perps-tracker/${VERSION}`, ...(opts.headers || {}) } });
      return { status: r.status, ms: Date.now() - t0 };
    } catch (e) {
      return { error: String((e.cause && e.cause.code) || e.name || e.message), ms: Date.now() - t0 };
    }
  };
  const [bulk, bulkAura, arcus, arcusPoints, hyperliquid] = await Promise.all([
    probe('https://mainnet-api1.bulk.trade/api/v1/exchangeInfo'),
    probe('https://app.bulk.trade/api/aura/v1/aura/wallet/11111111111111111111111111111111'),
    probe('https://api.arcus.xyz/v1/markets'),
    probe('https://points-api.arcus.xyz/v1/meta'),
    probe('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"meta"}' }),
  ]);
  const result = { bulk, bulkAura, arcus, arcusPoints, hyperliquid };
  lastCheck = { at: Date.now(), result };
  return result;
}

// ---------- http ----------
const csvCell = (v) => {
  const t = v == null ? '' : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const iso = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString() : '');

// Websites allowed to call the API from a browser: deploy/site.json (in the repository, so a push
// updates it) plus PERPS_ORIGINS.
const SITE = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy', 'site.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const ORIGIN_LIST = [...(Array.isArray(SITE.origins) ? SITE.origins : []), ...(process.env.PERPS_ORIGINS || '').split(',')];
const ORIGINS = ORIGIN_LIST
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean)
  .map((o) => new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i'));
function originAllowed(origin, host) {
  if (!origin) return true; // not a cross-site browser request
  if (ORIGINS.some((re) => re.test(origin))) return true;
  if (DEV && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  try {
    return new URL(origin).host === host; // the page this server serves itself
  } catch {
    return false;
  }
}
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(origin, req.headers.host)) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Content-Disposition' };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
function send(req, res, status, body, type, cache = 'no-store') {
  res.writeHead(status, { ...BASE_HEADERS, ...corsHeaders(req), 'Content-Type': type, 'Cache-Control': cache });
  res.end(body);
}
const sendJson = (req, res, status, obj) => send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function readBody(req, limit = 512 * 1024) {
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

// The visitor's address (Caddy in front adds X-Forwarded-For).
function clientIp(req) {
  const direct = req.socket.remoteAddress || '';
  const local = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  const fwd = local ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return fwd || direct;
}

// Simple rate limits per address: everything, and invite attempts.
const buckets = new Map();
function allow(kind, who, max, perMs) {
  const k = `${kind}|${who}`;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || now - b.start > perMs) b = { start: now, n: 0 };
  b.n += 1;
  buckets.set(k, b);
  return b.n <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > 60 * 60 * 1000) buckets.delete(k);
}, 10 * 60 * 1000).unref();

const bearer = (req) => {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
};
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const isApi = url.pathname.startsWith('/api/');

  if (isApi) {
    if (!originAllowed(req.headers.origin, req.headers.host)) return send(req, res, 403, 'This website isn’t allowed to use the tracker’s API.', 'text/plain; charset=utf-8');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const ip = clientIp(req);
    if (!allow('api', ip, 600, 60 * 1000)) return sendJson(req, res, 429, { error: 'Too many requests. Wait a minute.' });

    if (url.pathname === '/api/health') {
      const out = { ok: true, version: VERSION, open: OPEN, users: userIds().length, loaded: workspaces.size, uptime: Math.round(process.uptime()) };
      if (url.searchParams.get('check') === '1') {
        out.exchanges = await exchangeCheck();
        out.sync = syncOverview();
        out.market = { bulk: points.bulkVolumeStatus(market) };
      }
      return sendJson(req, res, 200, out);
    }

    let body = {};
    if (req.method === 'POST') {
      if (!/application\/json/i.test(req.headers['content-type'] || '')) return sendJson(req, res, 415, { error: 'Send JSON' });
      try {
        const text = await readBody(req);
        body = text ? JSON.parse(text) : {};
      } catch (e) {
        return sendJson(req, res, 400, { error: `Bad request: ${e.message}` });
      }
    } else if (req.method !== 'GET') return sendJson(req, res, 405, { error: 'Method not allowed' });

    // Open a new dashboard with an invite code.
    if (url.pathname === '/api/join' && req.method === 'POST') {
      if (!allow('join', ip, 10, 15 * 60 * 1000)) return sendJson(req, res, 429, { error: 'Too many tries. Wait 15 minutes.' });
      // Run with --local: your own computer, no invite needed.
      let code = 'local';
      if (!OPEN || String(body.invite || '').trim()) {
        const r = invites.check(body.invite);
        if (r.error) return sendJson(req, res, 400, { error: r.error });
        invites.redeem(r.invite.code);
        code = r.invite.code;
      }
      const { key, ws } = createWorkspace(code);
      console.log(`  New dashboard ${ws.id.slice(0, 8)} ${code === 'local' ? '(local)' : `with invite ${code}`}`);
      return sendJson(req, res, 200, { key });
    }

    // Admin: invite codes and who's using the tracker.
    if (url.pathname.startsWith('/api/admin/')) {
      if (!allow('admin', ip, 120, 60 * 1000)) return sendJson(req, res, 429, { error: 'Too many requests.' });
      if (!sameSecret(bearer(req), ADMIN_KEY)) return sendJson(req, res, 401, { error: 'Wrong admin key.', code: 'admin' });
      if (url.pathname === '/api/admin/overview') return sendJson(req, res, 200, adminOverview());
      if (url.pathname === '/api/admin/season' && req.method === 'POST') {
        const now = Date.now();
        const weekStart = analytics.bulkWeekStart(now);
        if (body.gauntlet !== undefined) {
          const r = season.setGauntlet(body.gauntlet, weekStart, points.bulkSymbols(market));
          if (r.error) return sendJson(req, res, 400, { error: r.error });
        }
        if (body.cutoffs) {
          const c = body.cutoffs;
          const ok = season.offerCutoffs({ at: now, population: c.population, cutoffs: c }, 'admin');
          if (!ok) return sendJson(req, res, 400, { error: 'Give all four league cutoffs (Challenger, Diamond, Platinum and Gold).' });
        }
        return sendJson(req, res, 200, adminOverview());
      }
      if (url.pathname === '/api/admin/invites' && req.method === 'POST') {
        const r = invites.create({ note: body.note, uses: body.uses, code: body.code });
        if (r.error) return sendJson(req, res, 400, { error: r.error });
        return sendJson(req, res, 200, { invite: r.invite, ...adminOverview() });
      }
      if (url.pathname === '/api/admin/invites/revoke' && req.method === 'POST') {
        const r = invites.revoke(body.code, body.revoked !== false);
        if (r.error) return sendJson(req, res, 400, { error: r.error });
        return sendJson(req, res, 200, adminOverview());
      }
      return sendJson(req, res, 404, { error: 'Not found' });
    }

    // Everything else is one person's dashboard.
    const key = bearer(req);
    const ws = key && KEY_RE.test(key) ? openWorkspace(idOf(key)) : null;
    if (!ws) return sendJson(req, res, 401, { error: 'This dashboard needs an invite code.', code: 'auth' });
    ws.touch();
    return ws.handle(req, res, url, body);
  }

  // The website itself (Vercel serves it too; this copy works straight from the server's address).
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed', 'text/plain');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(req, res, 404, 'Not found', 'text/plain');
  const ext = path.extname(file).toLowerCase();
  return send(req, res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream', ext === '.woff2' || ext === '.png' || ext === '.svg' ? 'public, max-age=604800' : 'no-cache');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    try {
      sendJson(req, res, 500, { error: 'Something went wrong on the server.' });
    } catch {}
  });
});

function shutdown() {
  for (const ws of workspaces.values()) ws.close();
  marketSavedAt = 0;
  saveMarket();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => {
  console.log('');
  const shown = HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(OPEN ? `  PERPS TRACKER ${VERSION} is running: open http://${shown}:${PORT} in your browser` : `  PERPS TRACKER ${VERSION} (hosted) on http://${HOST}:${PORT}`);
  if (OPEN) console.log('  Keep this window open while you use it. Close it (or press Ctrl+C) to stop.');
  console.log(`  Data: ${DATA_DIR}   Dashboards: ${userIds().length}   Points model: ${estimate.model.status.edition}`);
  console.log(`  Websites allowed: ${ORIGIN_LIST.map((o) => o.trim()).filter(Boolean).join(', ') || '(only this server)'}${DEV ? ' + localhost (dev)' : ''}`);
  console.log('');
});
