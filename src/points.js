'use strict';

// Points programs, read from each exchange's public points APIs and saved in data/points.json.
//
// Bulk AURA   app.bulk.trade/api/aura: your total, pre-deposit AURA per week, trading / maker /
//             boost / referral AURA per mainnet week, leagues, and each week's settlement time.
//             Bulk's total volume (hourly candles from its exchange API) sets how much AURA a
//             dollar earns each week, so the estimate reads that too.
// Arcus       points-api.arcus.xyz: season info and the next drop are public. Your own points need
//             a login there, but the public leaderboard lists every account's points under its
//             points name, so we find yours by the name you enter in Settings.
// Entropy     no points program yet. Totals can be logged by hand until it launches.

const fs = require('fs');
const path = require('path');
const { num, sleep } = require('./util');
const { writeJsonAtomic } = require('./store');
const markettime = require('./markettime');
const estimate = require('./estimate');

// Arcus's public exchange API, for market-wide volume (hourly candles) behind the points estimate.
const ARCUS_API = process.env.PERPS_ARCUS_API || 'https://api.arcus.xyz';
// Bulk's exchange API (not the website, so its firewall doesn't apply): hourly candles per market.
const BULK_API = process.env.PERPS_BULK_API || 'https://mainnet-api1.bulk.trade/api/v1';

const BULK_AURA = process.env.PERPS_BULK_AURA_API || 'https://app.bulk.trade/api/aura';
// Links for the person's own browser (Bulk's site answers browsers even when it turns the tracker away).
const BULK_AURA_PUBLIC = 'https://app.bulk.trade/api/aura';
// Bulk's website firewall can refuse non-browser requests (HTTP 429/403). Then the tracker backs
// off instead of asking every refresh, and AURA can be pasted in from the browser.
const BULK_BLOCKED = "Bulk's website only answers web browsers, so the tracker can't read your AURA by itself.";
const BLOCK_BACKOFF = [30, 60, 120, 240, 360].map((m) => m * 60000);
const ARCUS_POINTS = process.env.PERPS_ARCUS_POINTS_API || 'https://points-api.arcus.xyz';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Bulk settles each mainnet week on Saturday 12:30 UTC and publishes it at 13:00 UTC.
const BULK_WEEK3_PUBLISH = Date.UTC(2026, 8, 26, 13, 0); // 2026-09-26 13:00 UTC
// The Challenger Series (season 1) started with the AURA week from Saturday 17 Oct 2026 12:30 UTC,
// mainnet week 7. Bulk pays its "gauntlet" AURA per challenger week ("challenger_week_1_gauntlet"),
// so challenger week N is mainnet week N + 6.
const CHALLENGER_START = Date.UTC(2026, 9, 17, 12, 30);
const CHALLENGER_OFFSET = Math.round((CHALLENGER_START + 30 * 60000 + 7 * 24 * 3600 * 1000 - BULK_WEEK3_PUBLISH) / (7 * 24 * 3600 * 1000)) + 3 - 1; // 6

const PROGRAMS = [
  { id: 'bulk', title: 'Bulk AURA', unit: 'AURA', live: true, source: 'auto', schedule: 'Weekly, Saturdays 13:00 UTC', url: 'https://app.bulk.trade/aura' },
  { id: 'arcus', title: 'Arcus points', unit: 'points', live: true, source: 'name', schedule: 'Weekly, Wednesdays 3 PM New York', url: 'https://app.arcus.xyz/rewards?tab=points' },
  { id: 'entropy', title: 'Entropy points', unit: 'points', live: false, source: 'manual', schedule: null, url: 'https://entropy.io' },
];

// Manual logs (config.points): still used for Entropy, and for Arcus until a points name is set.
const POINT_SERIES = [
  { key: 'arcus:points', exchange: 'arcus', kind: 'points', label: 'Arcus points' },
  { key: 'entropy:points', exchange: 'entropy', kind: 'points', label: 'Entropy points' },
  { key: 'bulk:aura', exchange: 'bulk', kind: 'aura', label: 'Bulk AURA' },
];

class PointsStore {
  constructor(dir) {
    this.file = path.join(dir, 'points.json');
    this.state = { v: 1, bulk: {}, arcus: {}, errors: {} };
    this.version = 0; // bumps after every points sync, so the page knows to reload
    this.busy = false;
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // A restart gets one fresh try at Bulk even if it was backing off.
      if (s && s.v === 1) this.state = { ...this.state, ...s, errors: {}, codes: {}, bulkBlock: s.bulkBlock ? { ...s.bulkBlock, until: 0 } : null };
    } catch {
      // first run
    }
  }
  save() {
    try {
      writeJsonAtomic(this.file, this.state);
    } catch (e) {
      console.error(`Couldn't save points: ${e.message}`);
    }
  }
}

// ---------- Bulk AURA ----------
function bulkPublishOf(week) {
  return BULK_WEEK3_PUBLISH + (week - 3) * WEEK;
}

function nextBulkDrop(now, weeks) {
  const published = Object.values(weeks || {}).filter((w) => w && w.publish_at && Date.parse(w.publish_at) <= now);
  let t = published.length ? Math.max(...published.map((w) => Date.parse(w.publish_at))) : bulkPublishOf(3);
  while (t <= now) t += WEEK;
  return t;
}

async function syncBulk(http, wallets, st) {
  st.bulk = st.bulk || {};
  for (const w of wallets) {
    const addr = w.address;
    const entry = (st.bulk[addr] = st.bulk[addr] || { weeks: {} });
    entry.weeks = entry.weeks || {};
    const data = await http.get(`${BULK_AURA}/v1/aura/wallet/${encodeURIComponent(addr)}`, { retries: 1, retry429: false });
    if (!data || typeof data !== 'object' || data.aura == null) throw new Error('Unexpected AURA response from Bulk');
    entry.wallet = data;
    entry.at = Date.now();
    entry.source = 'auto';
    // Weekly settlements (volume, league cutoffs, publish time). Published weeks never change.
    const cats = data.categories || {};
    let maxWeek = 0;
    for (const k of Object.keys(cats)) {
      const m = /^mainnet_week(\d+)_/.exec(k);
      if (m) maxWeek = Math.max(maxWeek, Number(m[1]));
    }
    const sinceLaunch = Math.floor((Date.now() - bulkPublishOf(3)) / WEEK) + 3; // newest week that may be out
    for (let n = 1; n <= Math.max(maxWeek, sinceLaunch); n++) {
      if (entry.weeks[n] && entry.weeks[n].publish_at) continue;
      if (bulkPublishOf(n) > Date.now()) break;
      try {
        const wk = await http.get(`${BULK_AURA}/v1/aura/mainnet/weekly/${n}/wallet/${encodeURIComponent(addr)}`, { retries: 1, retry429: false });
        if (wk && wk.week_index != null) entry.weeks[n] = wk;
      } catch (e) {
        if (e.status !== 404) throw e; // 404: not published (or no activity that week)
      }
    }
  }
}

const LEAGUES = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'challenger'];
const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
// "top_5" -> "Top 5%", "remainder" -> null
const tierLabel = (t) => {
  const m = /^top_(\d+(?:\.\d+)?)$/.exec(String(t || ''));
  return m ? `Top ${m[1]}%` : null;
};

// The tracker's estimate for a week, as logged up to that week's cutoff. Entries logged outside the
// week's own window (older trackers keyed the week by the last revealed one, so while your AURA was
// out of date an entry could cover two or three weeks) aren't that week's estimate, so they're dropped.
function loggedEstimate(st, week, start, end) {
  const e = ((st.estLog || {}).bulk || {})[week];
  if (!e || !Number.isFinite(e.at)) return null;
  if (e.at > end + 60000 || e.at < start) return null;
  if (Number.isFinite(e.start) && Math.abs(e.start - start) > 60000) return null;
  return e;
}

// bulkFor(a, b): your Bulk activity between two times (taker, maker, liq, oiHours), for each week.
function bulkView(st, fillsFor, now, wallets, bulkFor = null) {
  const entries = wallets.map((w) => ({ w, e: (st.bulk || {})[w.address] })).filter((x) => x.e && x.e.wallet);
  if (!entries.length) return null;
  // One program view (first wallet with data); extra wallets are summed in the totals.
  const total = entries.reduce((a, x) => a + num(x.e.wallet.aura), 0);
  const main = entries[0].e;
  const d = main.wallet;
  const cats = {};
  for (const x of entries) for (const [k, v] of Object.entries(x.e.wallet.categories || {})) cats[k] = (cats[k] || 0) + num(v);
  // Your AURA covers every week revealed before it was read (or pasted). Later weeks aren't 0 AURA,
  // they're not loaded yet.
  const dataAt = Math.min(...entries.map((x) => x.e.at || 0));
  const latest = latestBulkWeek(now) || 0;

  const pre = [];
  const weeks = new Map();
  const blank = (n) => ({ week: n, trading: 0, maker: 0, boost: 0, gauntlet: 0, referrals: 0, other: 0, challenger: n > CHALLENGER_OFFSET ? n - CHALLENGER_OFFSET : null });
  // Every published week shows, including weeks with no AURA (they still have your volume).
  for (const k of Object.keys(main.weeks || {})) if (Number(k) > 0) weeks.set(Number(k), blank(Number(k)));
  const breakdown = { predeposit: 0, trading: 0, maker: 0, boost: 0, gauntlet: 0, referrals: 0, other: 0 };
  const gauntletWeeks = [];
  for (const [k, v] of Object.entries(cats)) {
    let m = /^predeposit_week(\d+)$/.exec(k);
    if (m) {
      pre.push({ week: Number(m[1]), aura: v });
      breakdown.predeposit += v;
      continue;
    }
    m = /^mainnet_week(\d+)_(\w+)$/.exec(k);
    if (m) {
      const n = Number(m[1]);
      const kind = ['trading', 'maker', 'boost', 'referrals', 'gauntlet'].includes(m[2]) ? m[2] : 'other';
      if (!weeks.has(n)) weeks.set(n, blank(n));
      weeks.get(n)[kind] += v;
      breakdown[kind] += v;
      continue;
    }
    // Challenger Series AURA ("challenger_week_3_gauntlet"), in the mainnet week it was earned.
    m = /^challenger_week_?(\d+)_(\w+)$/.exec(k);
    if (m) {
      const c = Number(m[1]);
      const n = c + CHALLENGER_OFFSET;
      const kind = m[2] === 'gauntlet' ? 'gauntlet' : 'other';
      if (!weeks.has(n)) weeks.set(n, blank(n));
      weeks.get(n)[kind] += v;
      breakdown[kind] += v;
      if (kind === 'gauntlet') gauntletWeeks.push({ challenger: c, week: n, aura: v });
      continue;
    }
    breakdown.other += v;
  }
  pre.sort((a, b) => a.week - b.week);
  gauntletWeeks.sort((a, b) => a.challenger - b.challenger);
  // Fill the gaps up to the latest reveal: a week with no AURA still shows (with your volume, or
  // marked "not loaded yet" when your AURA was read before its reveal).
  const known = [...weeks.keys()];
  if (known.length) for (let n = Math.min(...known); n <= latest; n++) if (!weeks.has(n)) weeks.set(n, blank(n));

  const mainnet = [...weeks.values()]
    .sort((a, b) => a.week - b.week)
    .map((wk) => {
      const s = main.weeks[wk.week] || {};
      const start = s.window_start_at ? Date.parse(s.window_start_at) : bulkPublishOf(wk.week) - WEEK - 30 * 60000;
      const end = s.cutoff_at ? Date.parse(s.cutoff_at) : bulkPublishOf(wk.week) - 30 * 60000;
      const publishAt = s.publish_at ? Date.parse(s.publish_at) : bulkPublishOf(wk.week);
      const ours = fillsFor('bulk', start, end);
      const act = bulkFor ? bulkFor(start, end) : null;
      const earned = wk.trading + wk.maker + wk.boost;
      return {
        ...wk,
        total: earned + wk.gauntlet + wk.referrals + wk.other,
        start,
        end,
        publishAt,
        // Revealed after your AURA was read: Bulk has paid it, the tracker hasn't seen it yet.
        pending: publishAt <= now && dataAt < publishAt && !main.weeks[wk.week],
        countedVolume: s.trading_volume != null ? num(s.trading_volume) : null, // your volume as Bulk counted it
        rawTrading: s.trading_aura != null ? num(s.trading_aura) : null, // before Bulk's credit on top
        ruleset: s.ruleset_version || null, // Bulk's rules for the week (they changed in week 5)
        estimated: loggedEstimate(st, wk.week, start, end), // what the tracker expected at the cutoff
        refVolume: s.referral_trading_volume != null ? num(s.referral_trading_volume) : null,
        volume: ours.volume,
        fees: ours.fees,
        taker: act ? act.taker : null,
        makerVolume: act ? act.maker : null,
        oiHours: act ? act.oiHours : null, // $ open x hours
        liqVolume: act ? act.liq : null,
        perTenK: ours.volume > 0 ? earned / (ours.volume / 1e4) : null,
        feesPer1k: earned > 0 ? ours.fees / (earned / 1000) : null,
        tier: tierLabel(s.aura_tier),
        league: s.current_league && s.current_league.league ? s.current_league.league : null,
      };
    });

  // Trading league and how far the next one is (cutoffs are cumulative trading AURA).
  const tl = d.trading_league || {};
  const latestWeek = Object.values(main.weeks || {}).filter((w) => w && w.league_cutoffs).sort((a, b) => b.week_index - a.week_index)[0];
  const cutoffs = latestWeek ? latestWeek.league_cutoffs : null;
  const tradingAura = num(tl.trading_aura);
  const ladder = cutoffs ? LEAGUES.filter((n) => cutoffs[n] != null).map((n) => ({ name: cap(n), at: num(cutoffs[n]) })) : [];
  const nextIdx = ladder.findIndex((l) => l.at > tradingAura);
  const nextLeague = nextIdx >= 0 ? { ...ladder[nextIdx], need: ladder[nextIdx].at - tradingAura } : null;
  const floor = nextIdx > 0 ? ladder[nextIdx - 1].at : nextIdx === 0 ? 0 : ladder.length ? ladder[ladder.length - 1].at : 0;

  const published = mainnet.map((w) => w.publishAt).filter((t) => t <= now);
  const lastPublished = published.length ? Math.max(...published) : null;
  const nextDrop = nextBulkDrop(now, main.weeks);
  // The week being traded now: the AURA week (Saturday 12:30 to Saturday 12:30 UTC) that ends at
  // the next cutoff, 30 minutes before the reveal. Always one week long: counting from the last
  // week your AURA covers made it two or three weeks long whenever your AURA was out of date.
  const weekEnd = nextDrop - 30 * 60000;
  const weekStart = weekEnd - WEEK;
  const soFar = fillsFor('bulk', weekStart, now);
  const earnedTrading = breakdown.trading + breakdown.maker + breakdown.boost;
  const allOurs = fillsFor('bulk', -Infinity, Infinity);
  const revealed = mainnet.filter((w) => w.publishAt <= now && !w.pending);
  const lastWeek = revealed.length ? revealed[revealed.length - 1] : null;
  return {
    total,
    rank: d.aura_rank != null ? num(d.aura_rank) : null,
    league: d.league ? { name: d.league.name, top: d.league.top_percent } : null,
    trading: {
      aura: tradingAura,
      league: tl.league ? tl.league.name : null,
      top: tl.league ? tl.league.top_percent : null,
      rank: tl.rank != null ? num(tl.rank) : null,
      population: tl.population != null ? num(tl.population) : null,
      qualified: tl.qualified !== false,
      threshold: tl.qualification_threshold != null ? num(tl.qualification_threshold) : null,
      volume: tl.canonical_root_volume != null ? num(tl.canonical_root_volume) : null,
      next: nextLeague,
      floor,
      ladder,
      // Every league's cutoff at the last reveal, and how many traders qualified then.
      cutoffs: cutoffs ? Object.fromEntries(LEAGUES.filter((k) => cutoffs[k] != null).map((k) => [k, num(cutoffs[k])])) : null,
      cutoffPopulation: cutoffs && cutoffs.population != null ? num(cutoffs.population) : null,
      cutoffsAt: latestWeek && latestWeek.publish_at ? Date.parse(latestWeek.publish_at) : null,
    },
    breakdown,
    predeposit: {
      weeks: pre,
      total: breakdown.predeposit,
      deposited: d.deposited_amount != null ? num(d.deposited_amount) : null,
      withdrawn: d.withdrawn_amount != null ? num(d.withdrawn_amount) : null,
      current: d.current_amount != null ? num(d.current_amount) : null,
    },
    weeks: mainnet,
    lastWeek: lastWeek ? lastWeek.week : null,
    dataAt, // when your AURA was last read or pasted
    nextReveal: nextDrop,
    pendingWeeks: mainnet.filter((w) => w.pending).map((w) => w.week),
    gauntlet: { total: breakdown.gauntlet, weeks: gauntletWeeks, startsAt: CHALLENGER_START, offset: CHALLENGER_OFFSET },
    current: { week: Math.max(latest, ...mainnet.filter((w) => w.publishAt <= now).map((w) => w.week)) + 1, start: weekStart, end: weekEnd, volume: soFar.volume, fees: soFar.fees, ...(bulkFor ? (({ taker, maker, oiHours, liq }) => ({ taker, makerVolume: maker, oiHours, liqVolume: liq }))(bulkFor(weekStart, Math.min(now, weekEnd))) : {}) },
    referral: { code: d.referral_code || null, referredBy: d.referred_by_code || null, sent: num(d.referrals_sent), qualified: num(d.referrals_qualified) },
    nextDrop,
    lastDrop: lastPublished,
    cost: earnedTrading > 0 ? { fees: allOurs.fees, volume: allOurs.volume, feesPer1k: allOurs.fees / (earnedTrading / 1000), perTenK: allOurs.volume > 0 ? earnedTrading / (allOurs.volume / 1e4) : null } : null,
    wallets: entries.length,
    updatedAt: Math.max(...entries.map((x) => x.e.at || 0)),
    source: entries.some((x) => x.e.source === 'pasted') ? 'pasted' : 'auto',
  };
}

// ---------- Arcus points ----------
async function scanLeaderboard(http, name, season) {
  const want = name.trim().toLowerCase();
  let total = null;
  for (let offset = 0; offset < 200000; offset += 500) {
    const q = `limit=500&offset=${offset}${season ? `&season=${encodeURIComponent(season)}` : ''}`;
    const page = await http.get(`${ARCUS_POINTS}/v1/leaderboard?${q}`, { retries: 2 });
    const rows = page && Array.isArray(page.entries) ? page.entries : [];
    if (total == null && page) total = num(page.total) || null;
    const hit = rows.find((r) => String(r.name || '').trim().toLowerCase() === want);
    if (hit) return { found: true, rank: num(hit.rank), name: hit.name, tier: hit.tier || null, points: hit.points == null ? null : num(hit.points), total, visible: page.points_visible !== false };
    if (rows.length < 500) break;
  }
  return { found: false, total };
}

async function syncArcus(http, name, st) {
  const a = (st.arcus = st.arcus || {});
  const meta = await http.get(`${ARCUS_POINTS}/v1/meta`, { retries: 2 });
  if (!meta || !meta.season) throw new Error('Unexpected points response from Arcus');
  a.meta = meta;
  a.metaAt = Date.now();
  if (!name) return;
  const week = meta.latest_week ? meta.latest_week.week_start : null;
  const nameChanged = a.me && a.me.query !== name;
  if (nameChanged) {
    a.history = [];
    a.s0 = null;
  }
  const stale = !a.me || nameChanged || a.me.week !== week || Date.now() - (a.me.at || 0) > HOUR;
  if (stale) {
    const r = await scanLeaderboard(http, name, null);
    a.me = { ...r, query: name, week, season: meta.season.name, at: Date.now() };
    if (r.found && week) {
      a.history = (a.history || []).filter((h) => h.week !== week);
      a.history.push({ week, distributedAt: meta.latest_week.distributed_at ? Date.parse(meta.latest_week.distributed_at) : null, points: r.points, rank: r.rank, tier: r.tier, of: r.total });
      a.history.sort((x, y) => String(x.week).localeCompare(String(y.week)));
    }
  }
  // Earlier seasons' rank (points there may still be hidden). Looked up once per name.
  if (!a.s0 || a.s0.query !== name) {
    const past = (meta.seasons || []).filter((s) => s && !s.active).map((s) => s.name);
    a.s0 = { query: name, seasons: [] };
    for (const season of past) {
      try {
        const r = await scanLeaderboard(http, name, season);
        if (r.found) a.s0.seasons.push({ season, rank: r.rank, tier: r.tier, points: r.visible ? r.points : null, total: r.total });
      } catch {
        // optional
      }
    }
  }
}

// All volume on Arcus per hour (every market added up), for the points estimate: your points
// depend on your share of everyone's trading. Completed hours are kept; the last two are refreshed.
// At most every 2 hours, one request per market.
async function syncArcusVolume(http, st) {
  const v = (st.arcusVol = st.arcusVol || { hours: {}, at: 0, finalUntil: 0 });
  if (Date.now() - (v.at || 0) < 2 * HOUR) return;
  const meta = st.arcus && st.arcus.meta;
  const seasonStart = meta && meta.season ? Date.parse(meta.season.starts_at) : NaN;
  // Kept back to the season start (up to 120 days), so every paid week can calibrate the estimate.
  const oldest = Math.max(Date.now() - 120 * DAY, Math.min(Date.now() - 35 * DAY, Number.isFinite(seasonStart) ? seasonStart - DAY : Infinity));
  const stored = Object.keys(v.hours).map(Number);
  const earliest = stored.length ? Math.min(...stored) : Infinity;
  // Hours before the earliest one kept are fetched once (the season's first weeks).
  const backfill = stored.length && earliest > oldest + 2 * HOUR && v.backfilledTo !== oldest ? [oldest, Math.min(earliest, Date.now())] : null;
  const from = Math.max(oldest, v.finalUntil || (Number.isFinite(seasonStart) ? Math.min(seasonStart, Date.now() - 8 * DAY) : Date.now() - 15 * DAY));
  const to = Date.now();
  const res = await http.get(`${ARCUS_API}/v1/markets`, { retries: 2 });
  const markets = (res && res.markets) || [];
  if (!markets.length) throw new Error('No markets from Arcus');
  // Candles per market, at most 30 days per request.
  const read = async (name, a, b, into) => {
    for (let s0 = a; s0 < b; s0 += 30 * DAY) {
      const s1 = Math.min(b, s0 + 30 * DAY);
      const c = await http.get(`${ARCUS_API}/v1/candles?market=${encodeURIComponent(name)}&timeframe=1h&from=${Math.floor(s0) * 1000}&to=${Math.floor(s1) * 1000}`, { retries: 3 });
      for (const k of (c && c.candles) || []) {
        const t = Math.round(Number(k.openTime) / 1000);
        if (Number.isFinite(t) && t >= s0 && t < s1) into[t] = (into[t] || 0) + num(k.notionalVolume);
      }
    }
  };
  const fresh = {};
  const older = {};
  for (const m of markets) {
    const name = m.marketDisplayName;
    if (!name) continue;
    await read(name, from, to, fresh);
    if (backfill) await read(name, backfill[0], backfill[1], older);
    await sleep(150);
  }
  // Every market answered, so these sums are complete: replace the hours from `from` on.
  for (const t of Object.keys(v.hours)) if (Number(t) >= from || Number(t) < oldest) delete v.hours[t];
  for (const [t, val] of Object.entries(fresh)) if (Number(t) >= from) v.hours[t] = Math.round(val);
  if (backfill) for (const [t, val] of Object.entries(older)) if (Number(t) >= backfill[0] && Number(t) < backfill[1] && v.hours[t] == null) v.hours[t] = Math.round(val);
  v.finalUntil = Math.floor(to / HOUR) * HOUR - HOUR; // hours before this one won't change
  if (backfill) v.backfilledTo = oldest;
  v.at = Date.now();
}

// Bulk's total volume per hour, summed over every market (Bulk's own hourly candles; base volume
// times the hour's average price). Re-read every 30 minutes; finished hours never change.
//
// Each market keeps its own place (`sym[market].until`): finished hours are added to `hours` market
// by market, and the hour still trading sits in `live` until it's done. One market that times out
// (Bulk's gateway answers 504 at times) used to throw away every other market's candles, so the
// volume stopped updating altogether; now that market alone catches up on a later read.
// `coveredUntil` is how far every listed market has been read, so a week's total is only used once
// it's complete.
const KLINE_SPAN = 7 * DAY; // at most a week of candles per request, so no request is heavy
const KLINE_FAIL_SKIP = 6; // a market that keeps failing with "bad request" is left out of coverage
const volumeWarned = new Set(); // problems already printed this run

function klineRow(k) {
  // Bulk sends { t, T, o, c, v }; an array [openTime, open, high, low, close, volume, closeTime] is read too.
  if (Array.isArray(k)) return { t: Number(k[0]), T: Number(k[6]), o: num(k[1]), c: num(k[4]), v: num(k[5]) };
  if (!k || typeof k !== 'object') return null;
  return { t: Number(k.t != null ? k.t : k.openTime), T: Number(k.T != null ? k.T : k.closeTime), o: num(k.o != null ? k.o : k.open), c: num(k.c != null ? k.c : k.close), v: num(k.v != null ? k.v : k.volume) };
}

function marketSymbols(info) {
  const list = Array.isArray(info) ? info : info && (info.symbols || info.markets || info.data || info.result);
  return (Array.isArray(list) ? list : []).map((m) => (typeof m === 'string' ? m : m && (m.symbol || m.name))).filter(Boolean);
}

async function syncBulkVolume(http, st) {
  const v = (st.bulkVol = st.bulkVol || { hours: {}, at: 0, finalUntil: 0 });
  if (!v.sym) {
    // From the all-markets-at-once version: its last hours were still trading when it stopped.
    for (const t of Object.keys(v.hours || {})) if (Number(t) >= (v.finalUntil || 0)) delete v.hours[t];
    v.hours = v.hours || {};
    v.sym = {};
  }
  v.live = v.live || {};
  if (Date.now() - (v.at || 0) < 30 * 60000) return;
  const now = Date.now();
  const oldest = now - 50 * DAY;
  const final = Math.floor(now / HOUR) * HOUR - HOUR; // hours before this one won't change
  const info = await http.get(`${BULK_API}/exchangeInfo`, { retries: 2 });
  const symbols = marketSymbols(info);
  if (!symbols.length) throw new Error('No markets in Bulk’s exchangeInfo');
  // Markets new to the list start where the shared total had got to (older candles are already in it).
  const startFrom = Math.max(oldest, v.finalUntil || oldest);
  const problems = [];
  let okCount = 0;
  for (const sym of symbols) {
    const s = (v.sym[sym] = v.sym[sym] || { until: startFrom, fails: 0 });
    let start = Math.max(oldest, s.until || startFrom);
    const done = {}; // finished hours, added to the total only once this market has been read in full
    const live = {};
    try {
      for (let page = 0; page < 60 && start < now; page++) {
        const end = Math.min(now, start + KLINE_SPAN);
        const rows = await http.get(`${BULK_API}/klines?symbol=${encodeURIComponent(sym)}&interval=1h&startTime=${Math.floor(start)}&endTime=${Math.floor(end)}`, { retries: 2 });
        const list = (Array.isArray(rows) ? rows : rows && Array.isArray(rows.data) ? rows.data : []).map(klineRow).filter((k) => k && Number.isFinite(k.t));
        for (const k of list) {
          if (k.t < start) continue;
          const usd = k.v * ((k.o + k.c) / 2);
          if (k.t < final) done[k.t] = usd;
          else live[k.t] = Math.round(usd);
        }
        const lastT = list.length ? Math.max(...list.map((k) => (Number.isFinite(k.T) && k.T > k.t ? k.T + 1 : k.t + HOUR))) : NaN;
        // Next request: after the last candle, or the next span if this one had none (quiet market).
        start = list.length && lastT > start ? Math.min(lastT, end) : end;
        if (start >= final) break;
      }
      // Finished hours go into `hours`; only this market's unfinished ones stay in `live`.
      for (const [t, usd] of Object.entries(done)) v.hours[t] = Math.round((v.hours[t] || 0) + usd);
      s.until = final;
      s.fails = 0;
      s.err = null;
      v.live[sym] = live;
      okCount += 1;
    } catch (e) {
      // Keep the hours already folded in (s.until moves only after a whole read), and try again later.
      s.fails = (s.fails || 0) + 1;
      s.err = e.status ? `HTTP ${e.status}` : e.message;
      s.bad = e.status >= 400 && e.status < 500; // "no such market" and the like
      problems.push(`${sym} (${s.err})`);
    }
    await sleep(120);
  }
  // Markets no longer listed don't hold coverage back.
  for (const k of Object.keys(v.sym)) if (!symbols.includes(k)) delete v.sym[k];
  for (const k of Object.keys(v.live)) if (!symbols.includes(k)) delete v.live[k];
  for (const t of Object.keys(v.hours)) if (Number(t) < oldest) delete v.hours[t];
  const counted = symbols.map((k) => v.sym[k]).filter((s) => !(s.bad && s.fails >= KLINE_FAIL_SKIP));
  v.coveredUntil = counted.length ? Math.min(...counted.map((s) => s.until || 0)) : 0;
  v.finalUntil = Math.max(v.finalUntil || 0, v.coveredUntil); // everything before this is in `hours` for every market
  v.markets = symbols.length;
  v.problems = problems.slice(0, 8);
  v.at = okCount ? Date.now() : Date.now() - 20 * 60000; // nothing answered: try again in 10 minutes
  if (problems.length) {
    const key = problems.map((p) => p.replace(/^\S+ /, '')).sort().join('|');
    if (!volumeWarned.has(key)) {
      volumeWarned.add(key);
      console.error(`  [!] Bulk market volume (for the AURA estimate): ${problems.length} of ${symbols.length} markets didn't answer: ${problems.slice(0, 4).join(', ')}${problems.length > 4 ? '…' : ''}. They catch up on a later read.`);
    }
  }
}

// Bulk's hourly volume for the estimate: finished hours plus each market's hour in progress.
function bulkHours(st) {
  const v = st && st.bulkVol;
  if (!v) return {};
  const out = { ...(v.hours || {}) };
  for (const live of Object.values(v.live || {})) for (const [t, usd] of Object.entries(live || {})) out[t] = (out[t] || 0) + usd;
  return out;
}
// How far Bulk's hourly volume is complete for every market (older data: up to its last full read).
function bulkCoveredUntil(st) {
  const v = st && st.bulkVol;
  if (!v) return 0;
  return Number.isFinite(v.coveredUntil) ? v.coveredUntil : v.finalUntil || 0;
}

function arcusView(st, fillsFor, now, name, manual) {
  const a = st.arcus || {};
  const meta = a.meta || null;
  const nextDrop = meta && meta.next_drop_at ? Date.parse(meta.next_drop_at) : markettime.pointsWeekStart(markettime.pointsWeekStart(now) + 8 * DAY);
  const lastDrop = meta && meta.latest_week && meta.latest_week.distributed_at ? Date.parse(meta.latest_week.distributed_at) : null;
  const seasonStart = meta && meta.season ? Date.parse(meta.season.starts_at) : null;
  const history = (a.history || []).map((h, i, arr) => {
    const prev = arr[i - 1];
    const end = h.distributedAt || null;
    // The first snapshot only tells us the week's gain if it's the season's first drop.
    const firstDrop = Boolean(end && seasonStart && end - seasonStart <= 8 * DAY);
    // The season's first week runs from the season start (which needn't be a Wednesday 3 PM).
    // Later rows run from the reading before, so a missed week can't mismatch points and fees.
    const start = end ? (firstDrop ? seasonStart : prev && prev.distributedAt ? prev.distributedAt : end - WEEK) : null;
    const gained = prev && prev.points != null && h.points != null ? h.points - prev.points : firstDrop ? h.points : null;
    const ours = start != null ? fillsFor('arcus', start, end) : { fees: null, volume: null };
    return { ...h, gained, start, end, volume: ours.volume, fees: ours.fees, perTenK: gained != null && ours.volume > 0 ? gained / (ours.volume / 1e4) : null, feesPer1k: gained > 0 && ours.fees != null ? ours.fees / (gained / 1000) : null };
  });
  const me = a.me && a.me.query === name ? a.me : null;
  const allOurs = fillsFor('arcus', seasonStart != null ? seasonStart : -Infinity, Infinity);
  // The points week being traded now (Wednesday 3 PM to Wednesday 3 PM New York).
  const weekStart = Math.max(lastDrop || nextDrop - WEEK, nextDrop - WEEK, seasonStart || -Infinity);
  const soFar = fillsFor('arcus', weekStart, now);
  const seasonTotal = meta ? num(meta.season_total_points) : 0;
  return {
    name: (me && me.found && me.name) || name || null, // as Arcus spells it, once found
    season: meta && meta.season ? { name: meta.season.name, start: seasonStart, totalPoints: seasonTotal, addresses: num(meta.season_addresses), visible: meta.season.points_visible !== false } : null,
    weeklyPool: 250000,
    me: me && me.found ? { points: me.points, rank: me.rank, tier: me.tier, of: me.total, at: me.at, share: me.points != null && seasonTotal > 0 ? me.points / seasonTotal : null } : null,
    notFound: Boolean(me && !me.found),
    searching: Boolean(name && !me),
    past: a.s0 && a.s0.query === name ? a.s0.seasons : [],
    history: history.reverse(),
    current: { start: weekStart, end: nextDrop, volume: soFar.volume, fees: soFar.fees },
    nextDrop,
    lastDrop,
    pending: Boolean(meta && meta.drop_pending),
    tiers: meta ? meta.tiers || [] : [],
    cost: me && me.found && me.points > 0 ? { fees: allOurs.fees, volume: allOurs.volume, feesPer1k: allOurs.fees / (me.points / 1000), perTenK: allOurs.volume > 0 ? me.points / (allOurs.volume / 1e4) : null } : null,
    manual,
    updatedAt: a.metaAt || null,
  };
}

// ---------- manual logs ----------
function manualSeries(key, exchange, points, fillsFor) {
  const entries = points.filter((p) => p.series === key).sort((a, b) => a.at - b.at);
  let prev = null;
  const rows = entries.map((e) => {
    const from = prev ? prev.at : -Infinity;
    const gained = prev ? e.value - prev.value : e.value;
    const { fees, volume } = fillsFor(exchange, from, e.at);
    prev = e;
    return { id: e.id, at: e.at, value: e.value, gained, fees, volume, costPer1k: gained > 0 ? fees / (gained / 1000) : null, first: from === -Infinity };
  });
  const latest = rows.length ? rows[rows.length - 1] : null;
  const life = latest ? fillsFor(exchange, -Infinity, latest.at) : null;
  return {
    key,
    latest: latest ? { value: latest.value, at: latest.at, gained: rows.length > 1 ? latest.gained : null } : null,
    lifetime: latest && latest.value > 0 ? { fees: life.fees, volume: life.volume, costPer1k: life.fees / (latest.value / 1000), volPerPoint: life.volume / latest.value } : null,
    rows: rows.reverse(),
  };
}

// ---------- pasted AURA (for when Bulk's website turns the tracker away) ----------
// Every top-level JSON object in pasted text: a page copied with Ctrl+A can carry extra text, and
// the AURA page and a week's results can be pasted together.
function jsonObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"' && depth > 0) inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // not JSON after all; skip it
        }
      }
    }
  }
  return out;
}

function importBulk(store, wallets, text) {
  const objs = jsonObjects(String(text || '').slice(0, 500000));
  const mine = new Set((wallets || []).map((w) => w.address));
  const short = (a) => `${String(a).slice(0, 4)}…${String(a).slice(-4)}`;
  const st = store.state;
  st.bulk = st.bulk || {};
  const got = { wallet: 0, weeks: [] };
  for (const o of objs) {
    const isWallet = o && typeof o.wallet === 'string' && Number.isFinite(Number(o.aura)) && o.categories && typeof o.categories === 'object';
    const isWeek = o && typeof o.root_wallet === 'string' && Number.isFinite(Number(o.week_index)) && typeof o.publish_at === 'string';
    if (!isWallet && !isWeek) continue;
    const addr = isWallet ? o.wallet : o.root_wallet;
    if (!mine.has(addr)) return { error: `That's the AURA data for ${short(addr)}, which isn't one of your Bulk wallets in Settings.` };
    const e = (st.bulk[addr] = st.bulk[addr] || { weeks: {} });
    e.weeks = e.weeks || {};
    if (isWallet) {
      e.wallet = o;
      e.at = Date.now();
      e.source = 'pasted';
      got.wallet += 1;
    } else {
      e.weeks[Number(o.week_index)] = o;
      got.weeks.push(Number(o.week_index));
    }
  }
  if (!got.wallet && !got.weeks.length) return { error: "That doesn't look like Bulk's AURA data. Open the link, press Ctrl+A and then Ctrl+C on that page, and paste it all here." };
  store.version += 1;
  store.save();
  return got;
}

// The newest mainnet week Bulk has revealed (null before the first reveal).
function latestBulkWeek(now) {
  return now >= bulkPublishOf(3) ? Math.floor((now - bulkPublishOf(3)) / WEEK) + 3 : null;
}

// ---------- view ----------
// Your Bulk activity between two times: taker volume (not liquidations), volume liquidated, maker
// volume, and open positions' size x hours.
function bulkActivity(wallets) {
  const fills = wallets.flatMap((w) => w.rich || []);
  const segs = wallets.flatMap((w) => w.segments || []);
  return (a, b) => {
    let taker = 0;
    let liq = 0;
    let maker = 0;
    for (const f of fills) {
      if (!(f.ts > a && f.ts <= b)) continue;
      if (f.role === 'T') {
        if (f.liq) liq += f.n;
        else taker += f.n;
      } else maker += f.n;
    }
    let oiHours = 0;
    for (const x of segs) {
      const ov = Math.min(x.to, b) - Math.max(x.from, a);
      if (ov > 0) oiHours += (x.notional * ov) / 3600e3;
    }
    return { taker, liq, maker, oiHours };
  };
}

// Your Arcus volume between two times split by what Arcus boosts: stocks and other real-world
// assets (and how much of that was off US hours) against crypto.
function arcusMix(wallets) {
  const fills = wallets.flatMap((w) => w.rich || []);
  const segs = wallets.flatMap((w) => w.segments || []);
  return (a, b) => {
    let oiHours = 0;
    for (const x of segs) {
      const ov = Math.min(x.to, b) - Math.max(x.from, a);
      if (ov > 0) oiHours += (x.notional * ov) / 3600e3;
    }
    let volume = 0;
    let stocks = 0;
    let off = 0;
    for (const f of fills) {
      if (!(f.ts > a && f.ts <= b)) continue;
      volume += f.n;
      if (f.cls !== 'crypto') {
        stocks += f.n;
        if (!f.us) off += f.n;
      }
    }
    return { volume, stocks, crypto: volume - stocks, off, oiHours };
  };
}

function computePoints(prepared, st, { points = [], arcusName = '', wallets = {} } = {}) {
  const now = prepared.now;
  const cache = new Map();
  const fillsFor = (exId, a, b) => {
    if (!cache.has(exId)) {
      const ex = prepared.exchanges.find((e) => e.id === exId);
      cache.set(exId, ex ? ex.wallets.flatMap((w) => w.rich) : []);
    }
    let fees = 0;
    let volume = 0;
    for (const f of cache.get(exId)) {
      if (f.ts > a && f.ts <= b) {
        fees += f.fee;
        volume += f.n;
      }
    }
    return { fees, volume };
  };
  const ourLife = (exId) => fillsFor(exId, -Infinity, Infinity);
  const errors = st.errors || {};
  const codes = st.codes || {};
  const programs = PROGRAMS.map((p) => {
    const hasWallet = (wallets[p.id] || []).length > 0;
    const base = { ...p, hasWallet, error: errors[p.id] || null, lifetime: ourLife(p.id) };
    if (p.id === 'bulk') {
      const ws = wallets.bulk || [];
      const entries = ws.map((w) => (st.bulk || {})[w.address]);
      const week = latestBulkWeek(now);
      return {
        ...base,
        blocked: codes.bulk === 'blocked',
        retryAt: st.bulkBlock && st.bulkBlock.until > now ? st.bulkBlock.until : null,
        nextDrop: nextBulkDrop(now, (entries.find((e) => e && e.weeks) || {}).weeks || {}),
        // Links to open in the browser and paste back, when Bulk refuses the tracker.
        paste: {
          week,
          wallets: ws.map((w, i) => ({
            address: w.address,
            label: w.label || null,
            url: `${BULK_AURA_PUBLIC}/v1/aura/wallet/${encodeURIComponent(w.address)}`,
            weekUrl: week ? `${BULK_AURA_PUBLIC}/v1/aura/mainnet/weekly/${week}/wallet/${encodeURIComponent(w.address)}` : null,
            haveWeek: Boolean(week && entries[i] && entries[i].weeks && entries[i].weeks[week]),
            haveWallet: Boolean(entries[i] && entries[i].wallet),
            // Earlier weeks' results too (Bulk's volume count, league cut-offs and the AURA before
            // its credit), for the last six reveals.
            past: week
              ? Array.from({ length: Math.min(6, week - 3) }, (_, k) => week - k)
                  .filter((n) => n >= 4)
                  .reverse()
                  .map((n) => ({ week: n, url: `${BULK_AURA_PUBLIC}/v1/aura/mainnet/weekly/${n}/wallet/${encodeURIComponent(w.address)}`, have: Boolean(entries[i] && entries[i].weeks && entries[i].weeks[n]) }))
              : [],
          })),
        },
        data: hasWallet ? bulkView(st, fillsFor, now, ws, bulkActivity((prepared.exchanges.find((e) => e.id === 'bulk') || { wallets: [] }).wallets)) : null,
      };
    }
    if (p.id === 'arcus') return { ...base, data: arcusView(st, fillsFor, now, arcusName, manualSeries('arcus:points', 'arcus', points, fillsFor)) };
    // Not live yet: what you've done there so far (programs often reward early activity), plus manual logs.
    const ex = prepared.exchanges.find((e) => e.id === p.id);
    const fills = ex ? ex.wallets.flatMap((w) => w.rich) : [];
    const days = new Set(fills.map((f) => new Date(f.ts).toISOString().slice(0, 10)));
    return {
      ...base,
      data: {
        manual: manualSeries(`${p.id}:points`, p.id, points, fillsFor),
        nextDrop: null,
        activity: { fills: fills.length, firstTs: fills.length ? Math.min(...fills.map((f) => f.ts)) : null, activeDays: days.size, makerVolume: fills.filter((f) => f.role === 'M').reduce((a, f) => a + f.n, 0) },
      },
    };
  });
  const nextOf = (p) => (p.data && p.data.nextDrop) || p.nextDrop || null; // Bulk's schedule is known even without AURA data
  const drops = programs
    .filter((p) => nextOf(p) && (p.hasWallet || (p.id === 'arcus' && arcusName)))
    .map((p) => ({ id: p.id, title: p.title, at: nextOf(p), last: (p.data && p.data.lastDrop) || null }))
    .sort((a, b) => a.at - b.at);
  // What the week being traded now should pay at the next drop (see estimate.js).
  const firstOf = (exId) => {
    const ex = prepared.exchanges.find((e) => e.id === exId);
    let t = Infinity;
    if (ex) for (const w of ex.wallets) if (w.firstTs && w.firstTs < t) t = w.firstTs;
    return t;
  };
  for (const p of programs) {
    try {
      if (p.id === 'bulk' && p.hasWallet) {
        const bx = prepared.exchanges.find((e) => e.id === 'bulk') || { wallets: [] };
        const open = bx.wallets.flatMap((w) => w.positions || []).reduce((a, x) => a + (Number.isFinite(x.notional) ? Math.abs(x.notional) : 0), 0);
        p.estimate = estimate.bulkEstimate({ view: p.data, fillsFor, bulkFor: bulkActivity(bx.wallets), open, firstTs: firstOf('bulk'), now, nextDrop: nextOf(p), hours: bulkHours(st), coveredUntil: bulkCoveredUntil(st) });
        const e = p.estimate;
        if (e && p.data) {
          // Each revealed week: what the model gives for your trades in it, using only the weeks
          // before it (an honest check of the estimate), next to what Bulk paid.
          const byWeek = new Map((e.calibration || []).map((c) => [c.week, c]));
          for (const w of p.data.weeks) {
            const c = byWeek.get(w.week);
            w.model = c && Number.isFinite(c.predicted) ? c.predicted : null;
            w.modelErr = c && Number.isFinite(c.predicted) && c.predicted > 0 && w.trading > 0 ? w.trading / c.predicted - 1 : null;
          }
          // The latest revealed week: what the tracker expected at its cutoff (if it was running then)
          // and what the model gives for it, next to what Bulk paid.
          // Weeks Bulk has revealed since your AURA was last read: estimated at this week's rates
          // for your activity in them, until the real numbers come in.
          let pendingExpected = 0;
          for (const w of p.data.weeks) {
            if (!w.pending) continue;
            w.expected = (e.rates.taker || 0) * (w.taker || 0) + (e.rates.oiHour || 0) * (w.oiHours || 0);
            pendingExpected += w.expected;
          }
          p.data.pendingExpected = pendingExpected;
          const lw = p.data.weeks.filter((w) => w.publishAt <= now && !w.pending && (w.trading > 0 || w.estimated)).pop();
          if (lw) e.lastResult = { week: lw.week, estimated: lw.estimated ? lw.estimated.points : null, model: lw.model, actual: lw.trading, gauntlet: lw.gauntlet || 0 };
        }
      }
      else if (p.id === 'arcus' && p.hasWallet) {
        const ax = prepared.exchanges.find((e) => e.id === 'arcus') || { wallets: [] };
        const openArcus = ax.wallets.flatMap((w) => w.positions || []).reduce((t, x) => t + (Number.isFinite(x.notional) ? Math.abs(x.notional) : 0), 0);
        p.estimate = estimate.arcusEstimate({ view: p.data, fillsFor, mixFor: arcusMix(ax.wallets), firstTs: firstOf('arcus'), now, hours: st.arcusVol && st.arcusVol.hours, open: openArcus });
        // Each paid week: what the model gives for it from the weeks before it, next to what Arcus paid.
        const byWeek = new Map(((p.estimate && p.estimate.check && p.estimate.check.backtest) || []).map((b) => [b.week, b]));
        for (const h of (p.data && p.data.history) || []) {
          const b = byWeek.get(h.week);
          h.model = b ? b.predicted : null;
          h.modelErr = b ? b.err : null;
        }
      }
    } catch (e) {
      p.estimate = null;
      console.error(`  [!] ${p.title} estimate: ${e.message}`);
    }
  }
  return { programs, drops, legacy: manualSeries('bulk:aura', 'bulk', points, fillsFor), generatedAt: now };
}

// Next drop times without needing the full view (for the status bar).
function nextDrops(st, now, wallets, arcusName = '') {
  const out = [];
  const bulkEntry = (wallets.bulk || []).map((w) => (st.bulk || {})[w.address]).find((e) => e && e.weeks);
  if ((wallets.bulk || []).length) out.push({ id: 'bulk', title: 'Bulk AURA', at: nextBulkDrop(now, bulkEntry ? bulkEntry.weeks : {}) });
  const meta = st.arcus && st.arcus.meta;
  if ((wallets.arcus || []).length || arcusName) out.push({ id: 'arcus', title: 'Arcus points', at: meta && meta.next_drop_at ? Date.parse(meta.next_drop_at) : markettime.pointsWeekStart(markettime.pointsWeekStart(now) + 8 * DAY) });
  return out.sort((a, b) => a.at - b.at);
}

async function syncPoints(http, store, config) {
  if (store.busy) {
    store.again = true; // one points sync at a time; run once more when this one ends
    return;
  }
  store.busy = true;
  const st = store.state;
  const errors = {};
  const codes = {};
  const jobs = [];
  if ((config.wallets.bulk || []).length) {
    const blk = st.bulkBlock;
    if (blk && Date.now() < blk.until) {
      errors.bulk = BULK_BLOCKED; // still backing off; don't ask again yet
      codes.bulk = 'blocked';
    } else {
      jobs.push(
        syncBulk(http, config.wallets.bulk, st)
          .then(() => {
            st.bulkBlock = null;
          })
          .catch((e) => {
            if (e.status === 429 || e.status === 403) {
              const n = blk ? blk.count + 1 : 1;
              const why = (e.headers && e.headers['x-vercel-mitigated']) || (e.isHtml ? 'html' : null);
              st.bulkBlock = { count: n, since: blk ? blk.since : Date.now(), until: Date.now() + BLOCK_BACKOFF[Math.min(n, BLOCK_BACKOFF.length) - 1], status: e.status, why };
              if (n === 1) console.error(`  [!] Bulk AURA: Bulk's website refused the request (HTTP ${e.status}${why ? `, ${why}` : ''}). Retrying every so often; you can paste AURA on the Points page.`);
              errors.bulk = BULK_BLOCKED;
              codes.bulk = 'blocked';
            } else errors.bulk = `Couldn't load AURA from Bulk (${e.status ? `HTTP ${e.status}` : e.message}).`;
          })
      );
    }
  }
  if ((config.wallets.bulk || []).length) {
    // Bulk's total volume for the AURA estimate; optional, so a failure only means a rougher estimate.
    jobs.push(
      syncBulkVolume(http, st).catch((e) => {
        // Printed once per distinct problem per run (it used to be remembered on disk, so after one
        // failure the tracker never said again that Bulk's volume had stopped updating).
        delete st.bulkVolWarned;
        const msg = e.status ? `HTTP ${e.status}: ${e.message}` : e.message;
        if (!volumeWarned.has(msg)) console.error(`  [!] Bulk market volume (for the AURA estimate): ${msg}. The estimate uses your own revealed weeks until it loads.`);
        volumeWarned.add(msg);
      })
    );
  }
  if ((config.wallets.arcus || []).length || config.arcusPointsName) {
    jobs.push(
      syncArcus(http, config.arcusPointsName || '', st)
        .catch((e) => {
          errors.arcus = `Couldn't load Arcus points (${e.status ? `HTTP ${e.status}` : e.message}).`;
        })
        // Market-wide volume for the estimate; optional, so a failure only means a rougher estimate.
        .then(() => syncArcusVolume(http, st))
        .catch((e) => {
          if (!st.arcusVolWarned) console.error(`  [!] Arcus market volume (for the points estimate): ${e.message}`);
          st.arcusVolWarned = true;
        })
    );
  }
  try {
    await Promise.all(jobs);
  } finally {
    st.errors = errors;
    st.codes = codes;
    store.busy = false;
    store.version += 1;
    store.save();
    if (store.again) {
      store.again = false;
      setImmediate(() => syncPoints(http, store, config).catch(() => {}));
    }
  }
}

// Keep the latest Bulk estimate for the week being traded, up to its cutoff, so that after the
// reveal the page can show what was expected next to what Bulk paid.
function recordEstimates(store, prepared, config) {
  if (!(config.wallets.bulk || []).length) return;
  const view = computePoints(prepared, store.state, { points: config.points, arcusName: config.arcusPointsName, wallets: config.wallets });
  const p = view.programs.find((x) => x.id === 'bulk');
  const e = p && p.estimate;
  if (!e || !p.data || !p.data.current || prepared.now >= e.window.end) return;
  const week = p.data.current.week;
  const log = (store.state.estLog = store.state.estLog || {});
  log.bulk = log.bulk || {};
  log.bulk[week] = { at: prepared.now, start: e.window.start, end: e.window.end, points: Math.round(e.points.projected), perDollar: e.perDollar, volume: Math.round(e.volume.projected), market: e.market ? Math.round(e.market.projected) : null, confidence: e.confidence };
  // Drop old entries, and ones logged outside their own week (older versions could key a week by
  // the last one your AURA covered, so an entry might span two or three weeks).
  for (const [k, v] of Object.entries(log.bulk)) {
    const end = bulkPublishOf(Number(k)) - 30 * 60000;
    if (Number(k) < week - 12 || !v || v.at > end + 60000 || v.at < end - WEEK) delete log.bulk[k];
  }
  store.save();
}

module.exports = { bulkActivity, bulkHours, bulkCoveredUntil, PROGRAMS, POINT_SERIES, PointsStore, syncPoints, computePoints, recordEstimates, nextDrops, nextBulkDrop, bulkPublishOf, latestBulkWeek, importBulk, jsonObjects, CHALLENGER_OFFSET, _test: { syncBulkVolume, klineRow, marketSymbols } };
