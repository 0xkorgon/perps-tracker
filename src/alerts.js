'use strict';

// Alerts: things worth hearing about even when the dashboard isn't open.
//
//   Near liquidation   a leg moves within the warning distance (10%) or the danger distance (5%)
//                      of its liquidation price. Fires once per level; re-arms once the leg is back
//                      a point above the line.
//   Hedge broken       a pair that was hedged loses a leg (closed, liquidated, a TP/SL filled) or
//                      goes uneven, and is still that way a minute later (so closing both legs one
//                      after the other doesn't raise a false alarm).
//   Liquidated         a fill marked as a liquidation appears on any exchange.
//   Multiplier         a Bulk position reaches its next day of holding, up to a week (or only a
//                      week), as you choose (builds whose AURA model rates open positions).
//   AURA cutoff        an hour before Saturday's 12:30 UTC cutoff, what each open Bulk position has
//                      earned this week and earns a day while open (it keeps earning after the
//                      cutoff, for next week).
//
// Alerts are kept in data/alerts.json (last 100) and delivered by notify.js and the dashboard.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./store');

const NAMES = { bulk: 'Bulk', arcus: 'Arcus', entropy: 'Entropy' };
const DEFAULTS = {
  desktop: true, // Windows / macOS / Linux pop-up from the tracker
  sound: true, // sounds (pop-up sound, or the dashboard's own when it's open)
  nearLiq: true, // a leg gets close to liquidation
  liqWarn: 0.1, // warn at this distance to liquidation
  liqDanger: 0.05, // danger at this distance
  hedges: true, // a hedge loses a leg or goes uneven
  liquidations: true, // a position is liquidated
  milestones: 'daily', // Bulk multiplier: 'daily' (each new day held, up to a week), 'full' (only a week held) or 'off'
  cutoff: true, // an hour before the AURA week ends
};
const CUTOFF_LEAD = 60 * 60 * 1000;
const HOUR = 3600 * 1000;

function cleanSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const bool = (k) => (typeof r[k] === 'boolean' ? r[k] : DEFAULTS[k]);
  const frac = (k, lo, hi) => {
    const v = Number(r[k]);
    return Number.isFinite(v) && v >= lo && v <= hi ? v : DEFAULTS[k];
  };
  const out = {
    desktop: bool('desktop'),
    sound: bool('sound'),
    nearLiq: bool('nearLiq'),
    hedges: bool('hedges'),
    liquidations: bool('liquidations'),
    cutoff: bool('cutoff'),
    milestones: ['daily', 'full', 'off'].includes(r.milestones) ? r.milestones : DEFAULTS.milestones,
    liqWarn: frac('liqWarn', 0.01, 0.5),
    liqDanger: frac('liqDanger', 0.005, 0.3),
  };
  if (out.liqDanger >= out.liqWarn) out.liqDanger = Math.max(0.005, out.liqWarn / 2);
  return out;
}

const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
// Distance to liquidation, rounded down so 9.97% reads 9.9% (not "10.0%" in a 10% warning).
const pctDist = (x) => (x < 0.1 ? `${(Math.floor(x * 1000) / 10).toFixed(1)}%` : `${Math.floor(x * 100)}%`);
const usd = (n) => `$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 })}`;
const price = (n) => Number(n).toLocaleString('en-US', { maximumSignificantDigits: 6 });
const sideWord = (s) => (s === 'L' || s > 0 ? 'long' : 'short');
const aura = (x) => (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1));
const mins = (ms) => Math.max(1, Math.round(ms / 60000));

// Margin to add so a leg sits `dist` away from its liquidation price (linear perps: each $ of margin
// moves the liquidation price by $1 / size). An estimate: it assumes the margin goes to this position.
function marginFor(l, dist) {
  if (!(l.liq > 0) || !(l.mark > 0) || !l.size) return null;
  const size = Math.abs(l.size);
  const need = l.size > 0 ? (l.liq - l.mark * (1 - dist)) * size : (l.mark * (1 + dist) - l.liq) * size;
  return need > 0 ? need : 0;
}

class AlertCenter {
  constructor(dir, { hedgeGraceMs = 60 * 1000 } = {}) {
    this.file = path.join(dir, 'alerts.json');
    this.hedgeGraceMs = hedgeGraceMs;
    this.log = [];
    this.state = { levels: {}, hedges: {}, lastFillTs: null, pendingHedges: {}, milestones: {}, cutoffSent: null };
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s && s.v === 1) {
        this.log = Array.isArray(s.log) ? s.log : [];
        this.state = { ...this.state, ...(s.state || {}) };
      }
    } catch {
      // first run
    }
  }

  save() {
    try {
      writeJsonAtomic(this.file, { v: 1, log: this.log.slice(-100), state: this.state });
    } catch (e) {
      console.error(`Couldn't save alerts: ${e.message}`);
    }
  }

  add(a) {
    const alert = { id: crypto.randomUUID(), at: Date.now(), ...a };
    this.log.push(alert);
    if (this.log.length > 100) this.log = this.log.slice(-100);
    return alert;
  }

  recent(n = 20) {
    return this.log.slice(-n).reverse();
  }

  // hedges: fresh hedge groups (watch.fresh). fills: every counted fill, { exchange, ts, mkt, side, sz, px, liq }.
  // bulk (optional): { legs: open Bulk positions with openTs, notional, weekVol (taker volume this
  // AURA week); base: AURA per $ of taker volume; oiHour: AURA per $ open for an hour; model:
  // { perHour }; cutoff: when this AURA week ends }.
  evaluate({ hedges, fills, settings, bulk = null, now = Date.now() }) {
    const s = cleanSettings(settings);
    const out = [];

    // ---- near liquidation ----
    const levels = {};
    for (const g of hedges || []) {
      for (const l of g.legs) {
        if (l.liqDist == null) continue;
        const key = `${l.exchange}|${l.wallet || ''}|${l.mkt}|${l.side}`;
        const prev = this.state.levels[key] || 0; // 0 none, 1 warn, 2 danger
        let lvl = l.liqDist < s.liqDanger ? 2 : l.liqDist < s.liqWarn ? 1 : 0;
        // Hysteresis: stay at a level until a point clear of its line, so it doesn't flap.
        if (lvl < prev) {
          const line = prev === 2 ? s.liqDanger : s.liqWarn;
          if (l.liqDist < line + 0.01) lvl = prev;
        }
        levels[key] = lvl;
        if (lvl > prev && s.nearLiq) {
          const other = g.legs.filter((x) => x !== l && Math.sign(x.size) !== Math.sign(l.size));
          // Margin to get back to the warning line, and to 15%. A leg that has only just crossed the
          // line needs pennies to get back to it ("$0.43"), so then the 15% figure leads.
          const line = Math.max(0.1, s.liqWarn);
          const far = Math.max(0.15, line + 0.05);
          const m10 = marginFor(l, line);
          const m15 = marginFor(l, far);
          const tiny = !(m10 > Math.max(5, Math.abs(l.size) * l.mark * 0.005));
          let add = '';
          if (m10 > 0 && !tiny) add = ` Adding about ${usd(m10)} margin moves it to ${pct(line)} away${m15 > m10 ? ` (${usd(m15)} for ${pct(far)})` : ''}.`;
          else if (m15 > 0) add = ` Adding about ${usd(m15)} margin moves it to ${pct(far)} away.`;
          out.push(
            this.add({
              kind: 'liq',
              level: lvl === 2 ? 'danger' : 'warn',
              exchange: l.exchange,
              mkt: l.mkt,
              title: `${NAMES[l.exchange]} ${l.mkt} ${sideWord(l.side)} is ${pctDist(l.liqDist)} from liquidation`,
              body: `Mark ${price(l.mark)} vs liquidation ${l.liqEst ? '≈ ' : ''}${price(l.liq)}${l.lev ? ` at ${l.lev}×` : ''}.${other.length ? ` If it's liquidated, your ${other.map((x) => `${NAMES[x.exchange]} ${sideWord(x.side)}`).join(' and ')} is left unhedged.` : ''}${add}`,
            })
          );
        }
      }
    }
    this.state.levels = levels;

    // ---- hedge broken ----
    const nowHedges = {};
    for (const g of hedges || []) {
      nowHedges[g.asset] = { status: g.status, legs: g.legs.map((l) => ({ exchange: l.exchange, side: l.side, mkt: l.mkt, notional: l.notional })) };
    }
    const before = this.state.hedges || {};
    // A pair listed under two names (SPY / US500) is renamed when one side goes, so look for the
    // group that still holds one of its legs.
    const findNow = (asset, was) => nowHedges[asset] || Object.values(nowHedges).find((n) => n.legs.some((l) => was.legs.some((w) => w.exchange === l.exchange && w.mkt === l.mkt)));
    const pending = this.state.pendingHedges || {};
    if (this.state.init) {
      for (const [asset, was] of Object.entries(before)) {
        if (was.status !== 'hedged' || pending[asset]) continue;
        const now0 = findNow(asset, was);
        if (now0 && now0.status !== 'hedged') pending[asset] = { since: now, was };
      }
    }
    // Still broken after the grace period: tell you. Closed completely or hedged again: forget it.
    for (const [asset, p] of Object.entries(pending)) {
      const cur = findNow(asset, p.was);
      if (!cur || cur.status === 'hedged') {
        delete pending[asset];
        continue;
      }
      if (now - p.since < this.hedgeGraceMs) continue;
      delete pending[asset];
      if (!s.hedges) continue;
      const was = p.was;
      const gone = was.legs.filter((w) => !cur.legs.some((n) => n.exchange === w.exchange && n.side === w.side));
      const left = cur.legs.map((n) => `${NAMES[n.exchange]} ${sideWord(n.side)} ${usd(n.notional)}`).join(', ');
      out.push(
        this.add({
          kind: 'hedge',
          level: cur.status === 'open' ? 'danger' : 'warn',
          mkt: asset,
          title: cur.status === 'open' ? `${asset} hedge broken: ${gone.length ? `${gone.map((w) => `${NAMES[w.exchange]} ${sideWord(w.side)}`).join(' and ')} closed` : 'one side left'}` : `${asset} hedge is uneven`,
          body: cur.status === 'open' ? `Still open: ${left}. You're exposed to the price until you close it or hedge it again.` : `Long and short no longer match (${left}).`,
        })
      );
    }
    this.state.pendingHedges = pending;
    this.state.hedges = nowHedges;

    // ---- Bulk multiplier milestones and the AURA cutoff ----
    // Without a model for open positions (bulk.hold false: the public build) there are no
    // multiplier milestones, and the cutoff reminder only says when the week ends.
    if (bulk && Array.isArray(bulk.legs) && bulk.hold === false) {
      const left = bulk.cutoff ? bulk.cutoff - now : null;
      if (s.cutoff && left != null && left > 0 && left <= CUTOFF_LEAD && this.state.cutoffSent !== bulk.cutoff) {
        this.state.cutoffSent = bulk.cutoff;
        out.push(this.add({ kind: 'cutoff', level: 'warn', exchange: 'bulk', title: `AURA week ends in ${mins(left)} min`, body: 'Trades before Saturday’s 12:30 UTC cutoff count this week; later ones count next week.' }));
      }
    } else if (bulk && Array.isArray(bulk.legs)) {
      const perHour = bulk.model && bulk.model.perHour > 0 ? bulk.model.perHour : 0;
      const base = bulk.base || 0;
      const oiHour = bulk.oiHour || 2 * perHour * base;
      const mult = (h) => 1 + perHour * Math.max(0, h);
      const weekStart = bulk.cutoff ? bulk.cutoff - 7 * 24 * HOUR : -Infinity;
      // What a position has earned this AURA week, and what closing it now adds.
      const earned = (l) => (l.weekVol || 0) * base + oiHour * (l.notional || 0) * (Math.max(0, now - Math.max(l.openTs, weekStart)) / HOUR);
      const days = 7;
      const seenNow = {};
      for (const l of bulk.legs) {
        if (!l.openTs) continue;
        const key = `${l.wallet || ''}|${l.mkt}|${l.openTs}`;
        const h = (now - l.openTs) / HOUR;
        const day = Math.min(days, Math.floor(h / 24));
        const prev = this.state.milestones[key];
        seenNow[key] = day;
        if (prev == null || day <= prev) continue; // first sight: no replay of days already passed
        const week = day >= days;
        if (s.milestones === 'off' || (s.milestones === 'full' && !week)) continue;
        const perDay = oiHour * (l.notional || 0) * 24;
        const close = earned(l) + (l.notional || 0) * base;
        out.push(
          this.add({
            kind: 'milestone',
            level: 'info',
            exchange: 'bulk',
            mkt: l.mkt,
            title: week ? `${l.mkt} held a week: ${mult(h).toFixed(2)}×` : `${l.mkt} reached ${mult(day * 24).toFixed(2)}× (${day} day${day > 1 ? 's' : ''} held)`,
            body: `It earns about ${aura(perDay)} AURA a day while it stays open. Closing now: about ${aura(close)} AURA this week.`,
          })
        );
      }
      this.state.milestones = seenNow;

      const left = bulk.cutoff ? bulk.cutoff - now : null;
      const open = bulk.legs.filter((l) => l.openTs);
      if (s.cutoff && left != null && left > 0 && left <= CUTOFF_LEAD && open.length && this.state.cutoffSent !== bulk.cutoff) {
        this.state.cutoffSent = bulk.cutoff;
        const list = open
          .slice(0, 3)
          .map((l) => `${l.mkt}: ≈ ${aura(earned(l))} this week, ≈ ${aura(oiHour * (l.notional || 0) * 24)} a day while open`)
          .join('. ');
        out.push(
          this.add({
            kind: 'cutoff',
            level: 'warn',
            exchange: 'bulk',
            title: `AURA week ends in ${mins(left)} min`,
            body: `${list}${open.length > 3 ? `, and ${open.length - 3} more` : ''}. Open positions keep earning after the cutoff (for next week), so there's no need to close them for AURA. Trades before the cutoff count this week.`,
          })
        );
      }
    }

    // ---- liquidated ----
    const liqs = (fills || []).filter((f) => f.liq);
    const newest = liqs.reduce((a, f) => Math.max(a, f.ts), 0);
    if (this.state.lastFillTs == null) this.state.lastFillTs = Math.max(newest, Date.now() - 60 * 60 * 1000); // don't replay old ones
    else if (s.liquidations) {
      const fresh = liqs.filter((f) => f.ts > this.state.lastFillTs);
      const byPos = new Map();
      for (const f of fresh) {
        const k = `${f.exchange}|${f.mkt}`;
        if (!byPos.has(k)) byPos.set(k, []);
        byPos.get(k).push(f);
      }
      for (const fs2 of byPos.values()) {
        const f = fs2[0];
        const size = fs2.reduce((a, x) => a + x.sz, 0);
        out.push(
          this.add({
            kind: 'liquidated',
            level: 'danger',
            exchange: f.exchange,
            mkt: f.mkt,
            title: `Liquidated on ${NAMES[f.exchange]}: ${f.mkt}`,
            body: `${+size.toPrecision(4)} ${f.mkt} ${f.side === 'B' ? 'bought back' : 'sold'} at ${f.px}. Check the other side of the hedge.`,
          })
        );
      }
    }
    if (newest > this.state.lastFillTs) this.state.lastFillTs = newest;

    this.state.init = true;
    // Only write when something changed (this runs every 30 seconds while a leg is close).
    const sig = JSON.stringify(this.state);
    if (out.length || sig !== this.savedSig) {
      this.savedSig = sig;
      this.save();
    }
    return out;
  }

  test(level = 'danger') {
    const a = this.add({ kind: 'test', level, title: level === 'danger' ? 'Test: danger alert' : 'Test: warning', body: 'This is what an alert from the Perps Tracker looks and sounds like.' });
    this.save();
    return a;
  }
}

module.exports = { AlertCenter, cleanSettings, marginFor, DEFAULTS };
