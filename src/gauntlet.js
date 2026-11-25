'use strict';

// Bulk's weekly Gauntlets and the league cutoffs every dashboard shares (data/season.json).
//
// Gauntlets (docs.bulk.trade, The Challenger Series): each AURA week has a new Gauntlet with its own
// goal and a 50,000 AURA reward, split in proportion to results ("if the goal is taker volume and
// you traded $5M of $500M total, you receive 1% of the reward, or 500 AURA"). It comes out of the
// weekly 1,000,000 AURA and counts toward your league. Bulk announces each one on Saturday in the
// app's Challenger tab, so the admin sets it on the admin page; the tracker then estimates what each
// dashboard's trading earns from it when the goal is measurable (taker volume, on every market or on
// some), from your fills and Bulk's public hourly volume.
//
// Self-check: each dashboard logs its gauntlet estimate through the week, and once Bulk's reveal
// brings the gauntlet AURA it actually paid, the ratio (paid / estimated) is shared here without the
// dashboard's identity. Every estimate is then scaled by what those checks show, so a goal Bulk
// scores differently from plain taker volume (or volume Bulk doesn't count) corrects itself.
//
// League cutoffs: Bulk's reveal brings each league's trading-AURA cutoff with your weekly AURA. The
// newest anyone's AURA import brought (or the admin typed in) is shared with every dashboard.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./store');

const REWARD = 50000;
const GOALS = {
  taker: 'Taker volume on every market',
  markets: 'Taker volume on some markets',
  other: 'Another goal (not estimated)',
};
const LEAGUE_IDS = ['challenger', 'diamond', 'platinum', 'gold'];
const text = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

class Season {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'season.json');
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.state = {};
    }
    if (!this.state || typeof this.state !== 'object') this.state = {};
  }

  save() {
    this.version = (this.version || 0) + 1; // dashboards' cached views follow it
    try {
      writeJsonAtomic(this.file, this.state);
    } catch (e) {
      console.error(`Couldn't save season data: ${e.message}`);
    }
  }

  // The gauntlet set for the AURA week starting at `weekStart` (this week's or a past one), or null.
  gauntlet(weekStart) {
    const g = this.state.gauntlet;
    if (g && g.week === weekStart) return g;
    return (this.state.past || []).find((x) => x && x.week === weekStart) || null;
  }

  // Keep a gauntlet that's being replaced by a later week's, for the self-check.
  archive(weekStart) {
    const g = this.state.gauntlet;
    if (!g || g.week === weekStart) return;
    this.state.past = [g, ...(this.state.past || []).filter((x) => x && x.week !== g.week)].sort((a, b) => b.week - a.week).slice(0, 10);
  }

  // A dashboard's check of a finished gauntlet week: what Bulk paid over what the tracker estimated.
  offerCheck(weekStart, id, ratio) {
    if (!(weekStart > 0) || !id || !Number.isFinite(ratio) || ratio < 0) return false;
    const r = Math.round(Math.min(ratio, 20) * 1000) / 1000;
    const checks = (this.state.checks = this.state.checks || {});
    const wk = (checks[weekStart] = checks[weekStart] || {});
    if (wk[id] === r || (!(id in wk) && Object.keys(wk).length >= 500)) return false;
    wk[id] = r;
    for (const k of Object.keys(checks).map(Number).sort((a, b) => b - a).slice(8)) delete checks[k];
    this.save();
    return true;
  }

  // How far estimates have been off: each checked week's median ratio, averaged (geometrically) over
  // the last four, and pulled toward 1 while there are few checks. Between 0.25x and 4x.
  calibration() {
    const weeks = Object.entries(this.state.checks || {})
      .map(([k, v]) => ({ week: Number(k), ratios: Object.values(v).filter((x) => Number.isFinite(x)) }))
      .filter((w) => w.ratios.length)
      .sort((a, b) => b.week - a.week)
      .slice(0, 4);
    const checks = weeks.reduce((n, w) => n + w.ratios.length, 0);
    if (!checks) return { factor: 1, checks: 0, weeks: 0 };
    const med = (a) => {
      const s = a.slice().sort((x, y) => x - y);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    // Weeks with more dashboards checked weigh more (one dashboard that missed a gauntlet's entry
    // rule shouldn't swing everyone's estimate).
    const mean = weeks.reduce((a, w) => a + w.ratios.length * Math.log(Math.min(4, Math.max(0.25, med(w.ratios)))), 0) / checks;
    const factor = Math.min(4, Math.max(0.25, Math.exp((mean * checks) / (checks + 2))));
    return { factor: Math.round(factor * 1000) / 1000, checks, weeks: weeks.length };
  }

  setGauntlet(raw, weekStart, symbols) {
    if (raw == null || raw.clear) {
      if (this.state.gauntlet && this.state.gauntlet.week === weekStart) delete this.state.gauntlet;
      this.save();
      return { ok: true, gauntlet: null };
    }
    const title = text(raw.title, 60);
    if (!title) return { error: 'Give the gauntlet a name, as Bulk shows it.' };
    const goal = GOALS[raw.goal] ? raw.goal : 'other';
    const known = new Set(symbols || []);
    const list = (Array.isArray(raw.markets) ? raw.markets : String(raw.markets || '').split(/[\s,]+/))
      .map((m) => text(m, 30).toUpperCase())
      .filter(Boolean)
      .map((m) => (/-USD$/.test(m) ? m : `${m}-USD`))
      .filter((m, i, a) => a.indexOf(m) === i);
    if (goal === 'markets') {
      if (!list.length) return { error: 'Name the markets the gauntlet counts, like SOXL or QQQ.' };
      const unknown = known.size ? list.filter((m) => !known.has(m)) : [];
      if (unknown.length) return { error: `Bulk doesn’t list ${unknown.join(', ')}.` };
    }
    const reward = Number(raw.reward) > 0 && Number(raw.reward) <= 1e6 ? Math.round(Number(raw.reward)) : REWARD;
    this.archive(weekStart);
    this.state.gauntlet = { week: weekStart, title, goal, markets: goal === 'markets' ? list : [], reward, note: text(raw.note, 240), setAt: Date.now() };
    this.save();
    return { ok: true, gauntlet: this.state.gauntlet };
  }

  // Shared league cutoffs: { at, population, cutoffs: { challenger, diamond, platinum, gold }, source }.
  cutoffs() {
    return this.state.cutoffs || null;
  }

  // Keep the newest cutoffs (from an AURA import or the admin).
  offerCutoffs(c, source) {
    if (!c || !c.cutoffs || !(c.at > 0)) return false;
    const clean = Object.fromEntries(LEAGUE_IDS.filter((k) => Number(c.cutoffs[k]) > 0).map((k) => [k, Math.round(Number(c.cutoffs[k]))]));
    if (Object.keys(clean).length < 4) return false;
    const cur = this.state.cutoffs;
    if (cur && cur.at >= c.at && source !== 'admin') return false;
    this.state.cutoffs = { at: c.at, population: Number(c.population) > 0 ? Math.round(Number(c.population)) : cur ? cur.population : null, cutoffs: clean, source };
    this.save();
    return true;
  }
}

// Whether a trade on `symbol` counts toward this gauntlet (and the planner can price it).
function applies(g, symbol) {
  if (!g) return false;
  if (g.goal === 'taker') return true;
  if (g.goal === 'markets') return g.markets.includes(symbol);
  return false;
}

// Your share of the reward from your goal volume and everyone's, so far and at the pace of both.
function estimate(g, { yourSoFar = 0, yourProjected = 0, totalSoFar = 0, totalProjected = 0 } = {}) {
  if (!g || g.goal === 'other') return null;
  const share = (y, t) => (t > 0 && y > 0 ? Math.min(1, y / Math.max(t, y)) : 0);
  return {
    yours: { soFar: yourSoFar, projected: yourProjected },
    total: { soFar: totalSoFar, projected: totalProjected },
    share: share(yourProjected, totalProjected),
    aura: { soFar: g.reward * share(yourSoFar, totalSoFar), projected: g.reward * share(yourProjected, totalProjected) },
  };
}

module.exports = { Season, applies, estimate, REWARD, GOALS };
