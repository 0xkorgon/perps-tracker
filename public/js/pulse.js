/* Pulse: a floating quick view, opened from the button in the corner.
   Portfolio total balance on all exchanges (live while open), since you deposited, where it went (/api/portfolio)
   Live      open positions grouped as hedges, liquidation distance, recent closes   (PT.state)
   Habits    this points week's checklist score for the exchanges picked on Strategy (/api/strategy)
   Next drop what the next Bulk and Arcus drops should pay, with a what-if slider    (/api/points) */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, $$, esc, money, compact, count, pct, NAMES } = PT;
  const TABS = [
    { id: 'portfolio', label: 'Portfolio', icon: 'wallet' },
    { id: 'live', label: 'Live', icon: 'activity' },
    { id: 'habits', label: 'Habits', icon: 'target' },
    { id: 'drop', label: 'Points', icon: 'sparkles' },
  ];
  const STATUS = {
    hedged: { label: 'Hedged', icon: 'check' },
    uneven: { label: 'Uneven', icon: 'alert' },
    open: { label: 'One-sided', icon: 'scale' },
  };
  const CONF = { good: 'Good estimate', fair: 'Fair estimate', rough: 'Rough estimate' };

  let isOpen = false;
  let pipWin = null; // Pulse's floating window, while it's popped out
  let pipTimers = [];
  let themeWatch = null;
  let tab = TABS.some((t) => t.id === PT.prefs.get('pulse.tab')) ? PT.prefs.get('pulse.tab') : 'portfolio';
  let port = null; // /api/portfolio
  let portTimer = null;
  let shownTotal = null; // last total shown, so live updates count from it
  let habits = null;
  let habitsKey = '';
  let points = null;
  let pointsKey = '';
  let enter = true; // play the entrance on the next render of the tab
  const what = {}; // what-if slider value per program, in $ (undefined = your pace)

  // ---------- markup ----------
  const BARS = '<svg class="pf-bars" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2" y="13" width="5.5" height="9" rx="1.4"/><rect x="9.25" y="7.5" width="5.5" height="14.5" rx="1.4"/><rect x="16.5" y="2" width="5.5" height="20" rx="1.4"/></svg>'; // the dashboard's own logo mark
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'pulse-fab';
  fab.id = 'pulse-fab';
  fab.hidden = true;
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'pulse');
  fab.setAttribute('aria-label', 'Pulse: balance, open positions, habits and the next points drop');
  fab.title = 'Pulse';
  fab.innerHTML = `<span class="pf-glow" aria-hidden="true"></span><span class="pf-icon">${BARS}</span><span class="pf-x">${PT.icon('x')}</span><span class="pf-badge" hidden></span>`;

  const panel = document.createElement('section');
  panel.className = 'pulse';
  panel.id = 'pulse';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'pulse-title');
  panel.innerHTML = `
    <header class="pu-head">
      <span class="pu-logo">${BARS}</span>
      <div class="pu-title"><h2 id="pulse-title">Pulse</h2><p class="pu-sub" aria-live="polite"></p></div>
      <button type="button" class="icon-btn pu-pop" aria-pressed="false" aria-label="Pop out" title="Pop out: float Pulse over other tabs and apps" hidden>${PT.icon('popout')}</button>
      <button type="button" class="icon-btn pu-pin" aria-pressed="false" aria-label="Stay open" title="Stay open while you click around">${PT.icon('pin')}</button>
      <button type="button" class="icon-btn pu-close" aria-label="Close Pulse">${PT.icon('x')}</button>
    </header>
    <div class="pu-tabs" role="tablist" aria-label="Pulse views">
      ${TABS.map((t) => `<button type="button" role="tab" id="pu-tab-${t.id}" data-tab="${t.id}" aria-controls="pu-body">${PT.icon(t.icon)}<span>${t.label}</span></button>`).join('')}
      <span class="pu-ink" aria-hidden="true"></span>
    </div>
    <div class="pu-body" id="pu-body" role="tabpanel" tabindex="0"></div>
    <span class="pu-grip" aria-hidden="true" title="Drag to resize"></span>`;
  document.body.append(panel, fab);
  const body = $('#pu-body', panel);

  // ---------- small builders ----------
  // Margin to add so a leg sits 10% / 15% from liquidation (each $ of margin moves it $1 / size).
  const marginNeed = (l, dist) => {
    if (!(l.liq > 0) || !(l.mark > 0) || !l.size) return 0;
    const sz = Math.abs(l.size);
    return Math.max(0, l.size > 0 ? (l.liq - l.mark * (1 - dist)) * sz : (l.mark * (1 + dist) - l.liq) * sz);
  };
  const marginTip = (l) => {
    const a = marginNeed(l, 0.1);
    return a > 0 ? `. Add about ${money(a, { dp: 0 })} margin to get to 10% away, ${money(marginNeed(l, 0.15), { dp: 0 })} to 15%` : '';
  };
  const distClass = (d) => (d == null ? '' : d < 0.05 ? 'danger' : d < 0.15 ? 'watch' : 'safe');
  const distText = (d) => (d == null ? '–' : `${(d * 100).toFixed(d < 0.1 ? 1 : 0)}%`);
  const side = (s) => `<span class="pu-side ${s === 'L' ? 'L' : 'S'}">${PT.icon(s === 'L' ? 'trending' : 'trendingDown')}${s === 'L' ? 'Long' : 'Short'}</span>`;
  const amount = (n, unit) => (Number.isFinite(n) ? (unit === 'AURA' || Math.abs(n) >= 100 ? PT.plain(Math.round(n), 0) : PT.plain(n, Math.abs(n) >= 10 ? 1 : 2)) : '–');
  const tile = (icon, label, value, sub, cls = '') => `<div class="pu-tile ${cls}"><span class="pu-tl">${PT.icon(icon)}${esc(label)}</span><span class="pu-tv">${value}</span>${sub ? `<span class="pu-ts">${esc(sub)}</span>` : ''}</div>`;
  const empty = (icon, text, action = '') => `<div class="pu-empty">${PT.icon(icon, 'lg')}<p>${text}</p>${action}</div>`;
  const loading = () => `<div class="pu-empty"><span class="spinner"></span><p>Loading…</p></div>`;
  const go = (hash, label) => `<a class="pu-go" href="#${hash}" data-close-pulse>${esc(label)}${PT.icon('chevron', 'sm rot')}</a>`;

  // ---------- Portfolio ----------
  async function loadPortfolio() {
    try {
      port = await PT.getJSON('/api/portfolio?live=1');
    } catch {
      // keep the last one
    }
  }

  // While the portfolio tab is open, balances refresh every 10 seconds (the tracker re-reads them
  // from the exchanges at most every 15).
  function portfolioTimer(on) {
    clearInterval(portTimer);
    portTimer = null;
    if (!on) return;
    portTimer = setInterval(async () => {
      if (!isOpen || tab !== 'portfolio') return portfolioTimer(false);
      await loadPortfolio();
      if (isOpen && tab === 'portfolio') render();
    }, 10000);
  }

  // 7-day balance line (SVG), from the tracker's own readings.
  function balanceLine(points) {
    const W = 340;
    const H = 74;
    if (points.length < 2 || points[points.length - 1][0] - points[0][0] < 30 * 60e3) {
      return `<div class="pu-hist-empty">${PT.icon('history', 'sm')}<span>The line fills in from now: the tracker notes your balance every 5 minutes while it runs.</span></div>`;
    }
    const t0 = points[0][0];
    const t1 = points[points.length - 1][0];
    const vs = points.map((p) => p[1]);
    let lo = Math.min(...vs);
    let hi = Math.max(...vs);
    if (hi - lo < 1) {
      lo -= 0.5;
      hi += 0.5;
    }
    const x = (t) => ((t - t0) / (t1 - t0)) * W;
    const y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (H - 12);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const last = points[points.length - 1];
    const up = last[1] >= points[0][1];
    const when = (t) => `${PT.DAYS[new Date(t).getDay()]} ${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}`;
    return `<div class="pu-hist ${up ? 'up' : 'down'}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`Total balance from ${money(points[0][1], { dp: 0 })} to ${money(last[1], { dp: 0 })}`)}">
        <path class="area" d="${d}L${W},${H}L0,${H}Z"/>
        <path class="line" d="${d}" pathLength="1"/>
        <circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="3.2"/>
      </svg>
      <div class="pu-hist-ax"><span>${esc(when(t0))}</span><span>Low ${esc(money(lo, { dp: 0 }))} · high ${esc(money(hi, { dp: 0 }))}</span><span>now</span></div>
    </div>`;
  }

  function portfolioView() {
    if (!port) return loading();
    const t = port.total;
    const xs = port.exchanges.filter((x) => x.equity != null);
    if (!port.exchanges.length) return empty('wallet', 'Add your wallets in Settings to see your balances here.', `<button class="btn btn-primary btn-sm" data-open-wallets data-close-pulse>${PT.icon('plus', 'sm')}Add wallet</button>`);
    const tot = t.equity || 0;
    const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
    const split = tot > 0 ? xs.map((x) => `<span style="--w:${((x.equity / tot) * 100).toFixed(2)}%;background:${PT.COLOR[x.id]}" title="${esc(`${NAMES[x.id]} ${money(x.equity, { dp: 2 })}`)}"></span>`).join('') : '';
    const rows = port.exchanges
      .map(
        (x, i) => `<li style="--i:${i}">
          ${PT.exm(x.id)}
          <div class="pu-pf-n"><b>${esc(NAMES[x.id])}</b><span>${x.available != null ? `${esc(money(x.available, { dp: 0 }))} free` : x.equity == null ? 'not loaded yet' : 'balance'}${Math.abs(x.upnl) >= 0.01 ? ` · uPnL <span class="${cls(x.upnl)}">${esc(PT.signed(x.upnl))}</span>` : ''}</span></div>
          <div class="pu-pf-v"><b>${esc(x.equity == null ? '–' : money(x.equity, { dp: 2 }))}</b><span class="${cls(x.result)}" title="${esc(x.netDeposits != null ? `Deposited ${money(x.netDeposits, { dp: 2 })} net` : '')}">${x.result == null ? (x.equity != null ? '–' : '') : esc(`${PT.signed(x.result)} since deposit`)}</span></div>
        </li>`
      )
      .join('');
    const b = port.breakdown;
    const price = b.realised + b.upnl;
    const parts = [
      { k: 'Fees paid', v: -b.fees, icon: 'receipt', note: 'Every fill on every exchange' },
      { k: 'Funding', v: b.funding, icon: 'swap', note: 'Positive is received' },
      { k: 'Price moves', v: price, icon: 'trending', note: `Realised ${PT.signed(b.realised)}, open ${PT.signed(b.upnl)}` },
    ];
    if (b.other != null && Math.abs(b.other) >= 0.5) parts.push({ k: 'Other', v: b.other, icon: 'info', note: 'Trades outside the tracker (other apps on Hyperliquid, older history)' });
    const maxAbs = Math.max(1, ...parts.map((p) => Math.abs(p.v)));
    const feesLead = b.fees > Math.abs(price) && b.fees > 1;
    const where = `<div class="pu-where">
      ${parts
        .map(
          (p) => `<div class="pu-wrow" title="${esc(p.note)}">${PT.icon(p.icon, 'sm')}<span>${esc(p.k)}</span><span class="pu-wbar"><i class="${p.v < 0 ? 'neg' : 'pos'}" style="--w:${((Math.abs(p.v) / maxAbs) * 100).toFixed(1)}%"></i></span><b class="${cls(p.v)}">${esc(PT.signed(p.v))}</b></div>`
        )
        .join('')}
      ${feesLead ? `<p class="pu-note">${PT.icon('scale', 'sm')}<span>Your hedges cancel most price moves, so fees are most of the change. Maker orders and fewer round trips cut them.</span></p>` : ''}
    </div>`;
    const chg = (label, v) => (v == null ? '' : `<span>${label} <b class="${cls(v)}">${esc(PT.signed(v))}</b></span>`);
    return `<div class="pu-pf-hero">
        <div class="pu-pf-l"><span class="pu-livedot ${port.live ? 'on' : ''}"><i></i>${port.live ? 'Live' : 'From the last sync'}</span><span class="muted">${esc(port.asOf ? PT.ago(port.asOf) : '')}</span></div>
        <div class="pu-pf-big"><b class="pu-pf-total" data-total="${tot}">${esc(money(tot, { dp: 2 }))}</b></div>
        <div class="pu-pf-cap">Total balance on ${xs.length === 1 ? NAMES[xs[0].id] : `${xs.length} exchanges`}</div>
        ${t.result != null ? `<div class="pu-pf-res"><span class="pu-delta ${cls(t.result)}">${PT.icon(t.result >= 0 ? 'trending' : 'trendingDown', 'sm')}${esc(PT.signed(t.result))}${t.resultPct != null ? ` (${esc(pct(t.resultPct, 1))})` : ''}</span><span>since you deposited ${esc(money(t.deposits, { dp: 2 }))}${t.partial ? ' (some exchanges unknown)' : ''}</span></div>` : ''}
        ${t.change24h != null || t.change7d != null ? `<div class="pu-pf-chg">${chg('24h', t.change24h)}${chg('7d', t.change7d)}</div>` : ''}
      </div>
      <div class="pu-split" role="img" aria-label="${esc(xs.map((x) => `${NAMES[x.id]} ${pct(tot > 0 ? x.equity / tot : 0, 0)}`).join(', '))}">${split}</div>
      <ul class="pu-pf-rows">${rows}</ul>
      <div class="pu-tiles">
        ${tile('wallet', 'Free to use', esc(t.available == null ? '–' : compact(t.available)), 'Not used as margin')}
        ${tile('trending', 'Unrealised', `<span class="${cls(t.upnl)}">${esc(PT.signed(t.upnl))}</span>`, 'Open positions')}
        ${tile('download', 'Deposited', esc(t.deposits == null ? '–' : compact(t.deposits)), 'Net of withdrawals')}
      </div>
      <h3 class="pu-h">${PT.icon('sigma')}Where the change came from</h3>
      ${where}
      <h3 class="pu-h">${PT.icon('chart')}Total balance, last 7 days</h3>
      ${balanceLine(port.history.points)}
      ${Object.keys(port.errors || {}).length ? `<p class="pu-fine">${esc(`Couldn't refresh ${Object.keys(port.errors).map((k) => NAMES[k.split(':')[0]]).join(', ')} just now; showing the last known balance.`)}</p>` : ''}
      ${go('overview', 'Open Overview')}`;
  }

  // ---------- hold time on each leg (minutes, never seconds) ----------
  // 45m, 8h 56m, 2d 4h 13m
  const heldShort = (ms) => {
    const m = Math.max(0, Math.floor(ms / 6e4));
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    return d ? `${d}d ${h}h ${m % 60}m` : h ? `${h}h ${m % 60}m` : `${m % 60}m`;
  };
  // Bulk: its hold multiplier, when the AURA model rates open positions (the bar runs to a week).
  // Arcus: the 1–24 h zone of its points routine. Entropy has no points yet: just how long.
  function holdState(ex, openTs, now = Date.now()) {
    const held = Math.max(0, now - openTs);
    const h = held / 36e5;
    const out = { held: heldShort(held), width: 0, note: '', cls: '', p: 0 };
    if (ex === 'bulk' && PT.holdKnown()) {
      const x = PT.bulkMult(h);
      out.p = Math.min(1, (x - 1) / (PT.bulkMult(168) - 1 || 1));
      out.width = Math.min(100, (h / 168) * 100);
      const next = (Math.floor(h / 24) + 1) * 24;
      out.note = `${x.toFixed(2)}× now, ${PT.bulkMult(next).toFixed(2)}× in ${heldShort(next * 36e5 - held)}`;
    } else if (ex === 'arcus') {
      out.width = Math.min(100, (h / 24) * 100);
      if (h < 1) [out.cls, out.note] = ['early', `${heldShort(36e5 - held)} until it reaches 1 h`];
      else if (h <= 24) [out.cls, out.note] = ['zone', `In the 1–24 h zone, ${heldShort(24 * 36e5 - held)} left`];
      else [out.cls, out.note] = ['late', `${heldShort(held - 24 * 36e5)} past 24 h`];
    }
    return out;
  }
  function holdBlock(l) {
    if (!l.openTs) return '';
    const s = holdState(l.exchange, l.openTs);
    const bar = l.exchange === 'bulk' || l.exchange === 'arcus';
    const cap = l.exchange === 'bulk' ? ' / 7d' : l.exchange === 'arcus' ? ' / 24h' : '';
    return `<div class="pu-hold ${esc(l.exchange)}${s.cls ? ` ${s.cls}` : ''}" data-ex="${esc(l.exchange)}" data-open-ts="${l.openTs}" style="--p:${s.p.toFixed(3)}">
      <div class="pu-hold-top"><span class="pu-opened" title="Opened">${PT.icon('clock', 'sm')}${esc(PT.localWhen(l.openTs))}</span><span class="t"><b>${esc(s.held)}</b>${cap}</span></div>
      ${bar ? `<div class="hold-bar" role="img" aria-label="${esc(`Held ${s.held}`)}"><i style="width:${s.width.toFixed(1)}%"></i></div><div class="pu-hold-note">${esc(s.note)}</div>` : ''}
    </div>`;
  }

  // ---------- Live ----------
  function liveView() {
    const s = PT.state && PT.state.stats;
    if (!s) return loading();
    const pos = s.positions || [];
    const hedges = s.hedges || [];
    const upnl = pos.reduce((a, p) => a + (p.upnl || 0), 0);
    const near = hedges.filter((g) => g.nearest).map((g) => g.nearest).sort((a, b) => a.dist - b.dist)[0];
    const tiles = `<div class="pu-tiles">
      ${tile('gauge', 'Open interest', esc(compact(s.totals.oi.notional)), `${pos.length} open`)}
      ${tile('trending', 'Unrealised', `<span class="${PT.pnlClass(upnl)}">${esc(PT.signed(upnl))}</span>`, 'All positions')}
      ${tile('shield', 'Nearest liq.', `<span class="pu-dist ${distClass(near && near.dist)}">${esc(near ? distText(near.dist) : '–')}</span>`, near ? `${NAMES[near.exchange]} ${near.mkt}` : 'Nothing at risk', near ? `t-${distClass(near.dist)}` : '')}
    </div>`;
    const cards = hedges.length
      ? hedges
          .map((g, gi) => {
            const st = STATUS[g.status] || STATUS.open;
            const net =
              g.status === 'open'
                ? `${g.netSize > 0 ? 'Long' : 'Short'} ${money(g.gross, { dp: 0 })}`
                : g.status === 'hedged'
                  ? 'Net ≈ 0'
                  : `${pct(g.imbalance, 0)} off, ≈ ${money(Math.abs(g.netUsd), { dp: 0 })}`;
            const legs = g.legs
              .map((l) => {
                const dc = distClass(l.liqDist);
                const w = l.liqDist == null ? 0 : Math.min(1, l.liqDist / 0.3) * 100;
                return `<div class="pu-leg">
                  <div class="pu-leg-a">${PT.exm(l.exchange, 'sm')}<span class="pu-mkt" title="${esc(`${NAMES[l.exchange]} ${l.mkt}`)}">${esc(l.mkt)}</span>${side(l.side)}</div>
                  <div class="pu-leg-b"><span>${esc(PT.size(l.size))}${l.lev ? ` · ${esc(PT.plain(l.lev, 1))}×` : ''}</span><span class="${PT.pnlClass(l.upnl)}">${esc(PT.signed(l.upnl))}</span></div>
                  ${holdBlock(l)}
                  <div class="pu-liq ${dc}" title="${esc(l.liq ? `Liquidation ${l.liqEst ? '≈ ' : ''}${PT.price(l.liq)}${marginTip(l)}` : 'No liquidation price')}"><span class="pu-liq-bar"><i style="--w:${w.toFixed(0)}%"></i></span><span>${esc(distText(l.liqDist))} to liq.</span></div>
                </div>`;
              })
              .join('');
            const fn = g.fundNow;
            const fund = fn
              ? `<div class="pu-fund">${PT.icon('swap', 'sm')}<span>Funding now <b class="${PT.pnlClass(Math.round(fn.perDay * 100))}">${esc(PT.signed(fn.perDay))}</b>/day</span>${fn.swap ? `<span class="pu-swap" title="${esc(`Switching costs about ${money(fn.swap.cost, { dp: 2 })} in fees`)}">Swap sides: ${esc(PT.signed(fn.swap.perDay))}/day${Number.isFinite(fn.swap.paybackDays) ? `, pays back in ${esc(fn.swap.paybackDays < 1 ? '<1' : Math.ceil(fn.swap.paybackDays))}d` : ''}</span>` : ''}</div>`
              : '';
            return `<article class="pu-hedge s-${g.status}" style="--i:${gi}">
              <div class="pu-hh"><b>${esc(g.asset)}</b><span class="pu-chip c-${g.status}">${PT.icon(st.icon)}${st.label}</span><span class="pu-net">${esc(net)}</span></div>
              ${legs}
              ${fund}
            </article>`;
          })
          .join('')
      : empty('layers', 'Nothing open right now.');
    const closed = (s.closed || []).slice(0, 4);
    const recent = closed.length
      ? `<h3 class="pu-h">${PT.icon('history')}Recently closed</h3><ul class="pu-recent">${closed
          .map((c) => `<li>${PT.exm(c.exchange, 'sm')}<span class="pu-mkt">${esc(c.mkt)}</span>${side(c.side)}<span class="pu-r-held">${esc(PT.dur(c.closeTs - c.openTs))}</span><span class="muted">${esc(PT.ago(c.closeTs))}</span></li>`)
          .join('')}</ul>`
      : '';
    return `${tiles}<h3 class="pu-h">${PT.icon('scale')}Positions and hedges</h3>${cards}${recent}${go('overview', 'Open Overview')}`;
  }

  // ---------- Habits ----------
  async function loadHabits(force) {
    const key = `${PT.strategy ? PT.strategy.selection() : 'arcus'}|${PT.dataVersion()}`;
    if (!force && habits && key === habitsKey) return;
    try {
      habits = await PT.getJSON(`/api/strategy?platform=${encodeURIComponent(PT.strategy ? PT.strategy.selection() : 'arcus')}&window=thisWeek`);
      habitsKey = key;
    } catch {
      // keep the last one
    }
  }

  function habitsView() {
    if (!habits) return loading();
    const ck = habits.checklist;
    const S = PT.strategy;
    const items = ck.items.map((it) => ({ ...it, st: it.disabled ? 'off' : it.state, p: S.progress(it) }));
    const passed = items.filter((i) => i.st === 'pass').length;
    const failed = items.filter((i) => i.st === 'fail');
    const na = items.filter((i) => i.st === 'na').length;
    const R = 38;
    const C = 2 * Math.PI * R;
    const frac = ck.total ? ck.passed / ck.total : 0;
    const closest = failed.slice().sort((a, b) => b.p - a.p)[0];
    const stateIcon = { pass: 'check', fail: 'x', na: 'na', off: 'off' };
    const rows = items
      .map(
        (it, i) => `<li class="pu-hab ${it.st}" style="--i:${i}">
          <span class="pu-hab-ic">${PT.icon(S.icon(it.id))}<span class="pu-hab-st">${PT.icon(stateIcon[it.st])}</span></span>
          <div><div class="pu-hab-t">${esc(it.label)}</div><div class="pu-hab-v">You <b>${esc(S.fmtVal(it, it.value))}</b> · target <b>${esc(S.fmtTarget(it))}</b></div><div class="pu-hab-bar"><i style="--w:${(it.st === 'na' || it.st === 'off' ? 0 : it.p * 100).toFixed(0)}%"></i></div></div>
        </li>`
      )
      .join('');
    return `<div class="pu-score">
        <svg class="pu-ring" viewBox="0 0 96 96" role="img" aria-label="${esc(`${ck.passed} of ${ck.total} habits matched`)}">
          <circle class="trk" cx="48" cy="48" r="${R}"/>
          <circle class="val" cx="48" cy="48" r="${R}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(enter && !PT.reduceMotion() ? C : C * (1 - frac)).toFixed(2)}" data-off="${(C * (1 - frac)).toFixed(2)}"/>
        </svg>
        <div class="pu-ring-n"><b data-count-to="${ck.passed}">${ck.passed}</b><span>/${ck.total}</span></div>
        <div class="pu-score-t">
          <b>habits matched</b>
          <span>This points week · ${esc(S.selectionName())}</span>
          <div class="pu-counts"><span class="pass">${PT.icon('check', 'sm')}${passed} matched</span><span class="fail">${PT.icon('x', 'sm')}${failed.length} to go</span>${na ? `<span class="na">${na} not measured</span>` : ''}</div>
        </div>
      </div>
      ${closest ? `<div class="pu-callout">${PT.icon('trending')}<span>Closest to green: <b>${esc(closest.label)}</b>, ${esc(`${S.fmtVal(closest, closest.value)} of ${S.fmtTarget(closest).replace(/^[≥≤] /, '')}`)}</span></div>` : ''}
      <ul class="pu-habs">${rows}</ul>
      ${go('strategy', 'Open Strategy')}`;
  }

  // ---------- Next drop ----------
  async function loadPoints(force) {
    const key = PT.dataVersion();
    if (!force && points && key === pointsKey) return;
    try {
      points = await PT.getJSON('/api/points');
      pointsKey = key;
    } catch {
      // keep the last one
    }
  }

  // Slider range for the extra volume you might add before the cutoff.
  function sliderSpec(e) {
    const expected = Math.max(0, e.volume.projected - e.volume.soFar);
    const weekly = Math.max(e.volume.daily * 7, e.volume.soFar);
    const raw = Math.max(expected * 3, weekly * 1.5, 10000);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const max = Math.ceil(raw / mag) * mag;
    const step = max / 200;
    return { max, step, expected };
  }

  // Last revealed week: what the tracker expected at the cutoff (or, if it wasn't running then, what
  // the model gives for that week from the weeks before it) next to what was paid.
  // e.g. "Week 9: estimated 143 trading AURA, Bulk paid 132 (−8%) + 77 gauntlet".
  function track(p, e) {
    const r = e.lastResult;
    if (!r || !(r.actual >= 0)) return '';
    const exp = r.estimated > 0 ? r.estimated : r.model > 0 ? r.model : null;
    if (!exp) return '';
    const d = r.actual / exp - 1;
    const off = Math.abs(d) < 0.005 ? 'spot on' : `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%`;
    const tip = r.estimated > 0 ? 'What the tracker estimated at that week’s cutoff' : 'What the estimate gives for your trades that week, worked out from the weeks before it only';
    const unit = p.id === 'bulk' ? 'trading AURA' : e.unit;
    const payer = p.id === 'bulk' ? 'Bulk' : NAMES[p.id] || '';
    const g = r.gauntlet > 0 ? ` + <b>${esc(amount(r.gauntlet, e.unit))}</b> gauntlet` : '';
    return `<p class="pu-track" title="${esc(tip)}">${PT.icon('target', 'sm')}<span>${esc(r.label || `Week ${r.week}`)}: estimated <b>${esc(amount(exp, e.unit))}</b> ${esc(unit)}, ${esc(payer)} paid <b>${esc(amount(r.actual, e.unit))}</b> (${esc(off)})${g}</span></p>`;
  }

  function estCard(p, i) {
    const e = p.estimate;
    const settled = e.window.settled;
    const spec = sliderSpec(e);
    const x = settled ? 0 : what[p.id] != null ? Math.min(what[p.id], spec.max) : spec.expected;
    const val = (e.fixed || 0) + (e.volume.soFar + x) * e.perDollar;
    const lockedShare = val > 0 ? Math.min(1, e.points.soFar / val) : 0;
    const pace = e.volume.basis === 'recent' ? 'your recent daily average' : e.volume.basis === 'blend' ? 'this week’s pace and your recent average' : 'this week’s pace';
    const basis = e.basis.map((b) => `<dt>${esc(b.label)}</dt><dd>${esc(b.money ? compact(b.value) : b.value)}<span>${esc(b.note || '')}</span></dd>`).join('');
    // On Bulk the big number is trading AURA; gauntlet AURA sits on its own line under it.
    const bulk = p.id === 'bulk';
    const unitBig = bulk ? 'trading AURA' : e.unit;
    const gx = bulk ? (e.extras || []).find((x2) => x2.kind === 'gauntlet') : null;
    const others = (e.extras || []).filter((x2) => x2 !== gx);
    return `<article class="pu-est" data-prog="${p.id}" style="--c:${PT.COLOR[p.id]};--i:${i}">
      <div class="pu-est-h">${PT.exm(p.id)}<div><b>${esc(p.title)}</b><span>${esc(settled ? 'Week settled, waiting for the reveal' : `Drop ${PT.localWhen(e.dropAt)}`)}</span></div><span class="pu-cd" data-countdown="${e.dropAt}" data-done="Dropping now">${esc(PT.countdown(e.dropAt - Date.now()))}</span></div>
      <div class="pu-big"><span class="pu-approx">≈</span><b class="pu-val" data-count-to="${val}" data-unit="${esc(e.unit)}">${esc(amount(val, e.unit))}</b><small>${esc(unitBig)}</small><span class="pu-conf c-${e.confidence}">${esc(CONF[e.confidence])}</span></div>
      ${gx ? `<div class="pu-range" title="${esc(gx.label)}">+ about <b>${esc(amount(gx.value, e.unit))}</b> gauntlet AURA</div>` : ''}
      <div class="pu-range">Likely <b class="pu-lo">${esc(amount(val * e.range.low, e.unit))}</b> to <b class="pu-hi">${esc(amount(val * e.range.high, e.unit))}</b>${bulk ? ' trading' : ` ${esc(e.unit)}`}</div>
      ${track(p, e)}
      <div class="pu-lock" title="Share already earned by what you've traded (and, on Bulk, the hours your positions have been open)"><span class="pu-lock-bar"><i class="done" style="--w:${(lockedShare * 100).toFixed(1)}%"></i></span><span><b class="pu-locked">${esc(amount(e.points.soFar, e.unit))}</b> earned so far${p.id === 'bulk' ? ` (${esc(compact(e.volume.soFar))} taker${e.fixedSoFar > 0.5 ? ' + open positions' : ''})` : ` by your ${esc(compact(e.volume.soFar))}`}</span></div>
      ${
        settled
          ? ''
          : `<label class="pu-what"><span>If you trade <b class="pu-x">${esc(compact(x))}</b> more${p.id === 'bulk' ? ' as taker' : ''} before the cutoff</span>
        <input type="range" min="0" max="${spec.max}" step="${spec.step}" value="${x}" data-what="${p.id}" aria-label="${esc(`Volume you add on ${NAMES[p.id]} before the cutoff`)}">
        <span class="pu-what-s"><span>$0</span><button type="button" class="pu-reset" data-reset="${p.id}"${what[p.id] == null ? ' hidden' : ''}>Back to my pace (${esc(compact(spec.expected))})</button><span>${esc(compact(spec.max))}</span></span></label>
        <p class="pu-pace">${PT.icon('clock', 'sm')}<span>At ${esc(pace)}, about <b>${esc(compact(e.volume.daily))}</b> a day, you'd add ${esc(compact(spec.expected))} in the ${esc(PT.countdown(e.window.end - Date.now()))} left.</span></p>`
      }
      <details class="pu-how"><summary>${PT.icon('info', 'sm')}How it's worked out${PT.icon('chevron', 'sm chev')}</summary>
        <dl>${basis}</dl>
        ${e.notes.map((n) => `<p>${esc(n)}</p>`).join('')}
        ${others.map((x2) => `<p class="pu-extra">${PT.icon('plus', 'sm')}${esc(x2.label)}: <b>+${esc(amount(x2.value, e.unit))}</b> ${esc(e.unit)} (not included above)</p>`).join('')}
      </details>
    </article>`;
  }

  function dropView() {
    if (!points) return loading();
    const withEst = points.programs.filter((p) => p.estimate);
    const missing = points.programs.filter((p) => !p.estimate && p.live);
    if (!withEst.length) {
      // An older tracker (started before the update) doesn't work out estimates at all.
      if (PT.outdated || !points.programs.some((p) => 'estimate' in p)) {
        return empty('refresh', '<b>Restart the tracker to see estimates.</b><br>The black window is still running the version from before this update. Close it, then double-click <code>start.bat</code>.');
      }
      if (!PT.hasWallets('bulk') && !PT.hasWallets('arcus')) {
        return empty('sparkles', 'Add a Bulk or Arcus wallet in Settings to see what your next drops should pay.', `<button class="btn btn-primary btn-sm" data-open-wallets data-close-pulse>${PT.icon('plus', 'sm')}Add wallet</button>`);
      }
      return empty('sparkles', 'Estimates show up after the first sync with your Bulk and Arcus history. Give it a minute.');
    }
    const cards = withEst.sort((a, b) => a.estimate.dropAt - b.estimate.dropAt).map(estCard).join('');
    const others = [
      ...missing.map((p) => `<li>${PT.exm(p.id, 'sm')}<span>${esc(p.title)}: ${esc(p.hasWallet ? 'no estimate yet' : `add a ${NAMES[p.id]} wallet`)}</span></li>`),
      ...points.programs.filter((p) => !p.live).map((p) => `<li>${PT.exm(p.id, 'sm')}<span>${esc(p.title)} haven't launched yet</span></li>`),
    ].join('');
    return `${cards}${others ? `<ul class="pu-others">${others}</ul>` : ''}<p class="pu-fine">Estimates, not promises: neither exchange publishes its formula. Bulk's is calibrated on the weeks Bulk has paid you (each checked against the weeks before it); Arcus's comes from your own paid weeks and all trading on Arcus.</p>${go('points', 'Open Points')}`;
  }

  // Slider moved: recompute that card in place (estimates are linear in your volume).
  function onWhat(input) {
    const id = input.dataset.what;
    const p = points && points.programs.find((q) => q.id === id);
    if (!p || !p.estimate) return;
    const e = p.estimate;
    const x = Number(input.value);
    what[id] = x;
    const card = input.closest('.pu-est');
    const val = (e.fixed || 0) + (e.volume.soFar + x) * e.perDollar;
    const valEl = $('.pu-val', card);
    PT.countUp(valEl, val, { from: Number(valEl.dataset.shown || val), dur: 220, fmt: (v) => amount(v, e.unit) });
    valEl.dataset.shown = val;
    $('.pu-lo', card).textContent = amount(val * e.range.low, e.unit);
    $('.pu-hi', card).textContent = amount(val * e.range.high, e.unit);
    $('.pu-x', card).textContent = compact(x);
    $('.pu-lock-bar i', card).style.setProperty('--w', `${(val > 0 ? Math.min(1, e.points.soFar / val) * 100 : 0).toFixed(1)}%`);
    $('[data-reset]', card).hidden = false;
  }

  // ---------- render ----------
  function render() {
    if (!isOpen) return;
    // Don't redraw under a dragging finger; the next poll will catch up.
    const a = panel.ownerDocument.activeElement;
    if (a && a.type === 'range' && panel.contains(a) && a.matches(':active')) return;
    const html = tab === 'portfolio' ? portfolioView() : tab === 'live' ? liveView() : tab === 'habits' ? habitsView() : dropView();
    body.innerHTML = html;
    body.classList.toggle('enter', enter && !PT.reduceMotion());
    PT.hydrateLogos && PT.hydrateLogos(body);
    // Ring and bars animate from empty on entry.
    PT.raf(() =>
      PT.raf(() => {
        $$('.pu-ring .val', body).forEach((c) => (c.style.strokeDashoffset = c.dataset.off));
        $$('[data-count-to]', body).forEach((el) => {
          const to = Number(el.dataset.countTo);
          if (!enter || !Number.isFinite(to)) return;
          const unit = el.dataset.unit;
          PT.countUp(el, to, { from: 0, dur: 900, fmt: unit ? (v) => amount(v, unit) : (v) => String(Math.round(v)) });
          el.dataset.shown = to;
        });
      })
    );
    // The total counts from what was shown before (or from zero on entry).
    const totEl = $('.pu-pf-total', body);
    if (totEl) {
      const to = Number(totEl.dataset.total);
      const from = enter ? 0 : shownTotal;
      if (Number.isFinite(to) && from != null && from !== to && !PT.reduceMotion()) PT.countUp(totEl, to, { from, dur: enter ? 1000 : 700, fmt: (v) => money(v, { dp: 2 }) });
      if (!enter && shownTotal != null && Number.isFinite(to) && Math.abs(to - shownTotal) >= 0.01) {
        totEl.classList.remove('tick-up', 'tick-down');
        void totEl.offsetWidth;
        totEl.classList.add(to > shownTotal ? 'tick-up' : 'tick-down');
      }
      shownTotal = Number.isFinite(to) ? to : shownTotal;
    }
    enter = false;
    tick();
    renderHead();
  }

  function renderHead() {
    const st = PT.state;
    const next = st && st.drops && st.drops.find((d) => d.at > Date.now());
    $('.pu-sub', panel).textContent = st && st.sync ? `Synced ${PT.ago(st.sync.lastEnd)}${next ? ` · next drop in ${PT.countdown(next.at - Date.now())}` : ''}` : 'Loading…';
  }

  function moveInk() {
    const btn = $(`.pu-tabs [data-tab="${tab}"]`, panel);
    const ink = $('.pu-ink', panel);
    if (!btn || !ink) return;
    ink.style.setProperty('--x', `${btn.offsetLeft}px`);
    ink.style.setProperty('--w', `${btn.offsetWidth}px`);
  }

  async function show(id, force = false, animate = true) {
    tab = id;
    PT.prefs.set('pulse.tab', id);
    enter = animate;
    $$('.pu-tabs [data-tab]', panel).forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === id));
      b.tabIndex = b.dataset.tab === id ? 0 : -1;
    });
    body.setAttribute('aria-labelledby', `pu-tab-${id}`);
    moveInk();
    if (id === 'habits' && !habits) body.innerHTML = loading();
    if (id === 'drop' && !points) body.innerHTML = loading();
    if (id === 'portfolio' && !port) body.innerHTML = loading();
    portfolioTimer(id === 'portfolio');
    if (id === 'habits') await loadHabits(force);
    if (id === 'drop') await loadPoints(force);
    if (id === 'portfolio' && (force || animate || !port)) await loadPortfolio();
    if (tab === id) render();
  }

  function setOpen(v) {
    if (!v && pipWin) return pipWin.close(); // closing the floating window brings Pulse home, closed
    if (v === isOpen) return;
    isOpen = v;
    fab.setAttribute('aria-expanded', String(v));
    PT.prefs.set('pulse.open', v ? '1' : '0');
    if (v) {
      panel.hidden = false;
      applyLayout();
      panel.classList.remove('closing');
      panel.classList.add('opening');
      show(tab, false);
      PT.raf(moveInk);
      const sel = $(`.pu-tabs [data-tab="${tab}"]`, panel);
      if (sel) sel.focus({ preventScroll: true });
    } else {
      portfolioTimer(false);
      panel.classList.remove('opening');
      if (PT.reduceMotion()) panel.hidden = true;
      else {
        panel.classList.add('closing');
        setTimeout(() => {
          if (!isOpen) panel.hidden = true;
        }, 180);
      }
    }
  }

  // Badge on the button: a liquidation warning first, otherwise this week's habit score.
  async function updateBadge() {
    const badge = $('.pf-badge', fab);
    const hedges = PT.state && PT.state.stats && PT.state.stats.hedges;
    const near = (hedges || []).filter((g) => g.nearest).map((g) => g.nearest).sort((a, b) => a.dist - b.dist)[0];
    fab.classList.toggle('pf-alert', Boolean(near && near.dist < 0.05));
    fab.classList.toggle('pf-watch', Boolean(near && near.dist >= 0.05 && near.dist < 0.15));
    if (near && near.dist < 0.15) {
      badge.hidden = false;
      badge.className = `pf-badge ${near.dist < 0.05 ? 'danger' : 'watch'}`;
      badge.textContent = '!';
      fab.title = `Pulse: ${NAMES[near.exchange]} ${near.mkt} is ${distText(near.dist)} from liquidation`;
      return;
    }
    await loadHabits(false);
    if (habits) {
      badge.hidden = false;
      badge.className = 'pf-badge';
      badge.textContent = `${habits.checklist.passed}/${habits.checklist.total}`;
      fab.title = `Pulse: ${habits.checklist.passed} of ${habits.checklist.total} habits matched this points week`;
    }
  }

  // Called by the app after every poll.
  let lastVersion = null;
  let restored = false;
  async function update() {
    const has = Boolean(PT.state && PT.activeExchanges && PT.activeExchanges().length);
    if (fab.hidden === has) {
      fab.hidden = !has;
      if (has) applyLayout();
    }
    if (!has) return setOpen(false);
    // "Stay open": open again where you left it.
    if (!restored) {
      restored = true;
      if (pinned() && PT.prefs.get('pulse.open') === '1') setOpen(true);
    }
    const v = PT.dataVersion();
    const changed = v !== lastVersion;
    lastVersion = v;
    if (changed) updateBadge();
    if (!isOpen) return;
    if (tab === 'live') render();
    else if (tab === 'portfolio') renderHead(); // has its own 10-second refresh
    else if (changed) show(tab, true, false); // new data: refresh quietly, no entrance
    else renderHead();
  }

  // Live clocks inside the panel.
  function tick() {
    if (!isOpen) return;
    PT.tickCountdowns(panel);
    const now = Date.now();
    $$('.pu-hold[data-open-ts]', panel).forEach((el) => {
      const s = holdState(el.dataset.ex, Number(el.dataset.openTs), now);
      el.querySelector('.t b').textContent = s.held;
      el.style.setProperty('--p', s.p.toFixed(3));
      el.classList.remove('early', 'zone', 'late');
      if (s.cls) el.classList.add(s.cls);
      const bar = el.querySelector('.hold-bar i');
      if (bar) bar.style.width = `${s.width.toFixed(1)}%`;
      const note = el.querySelector('.pu-hold-note');
      if (note) note.textContent = s.note;
    });
  }
  setInterval(() => {
    tick();
    if (isOpen) renderHead();
  }, 1000);

  // ---------- layout: move, resize, stay open (Settings > Display) ----------
  // Positions are kept on this browser. Small screens always use the default corner.
  const LAYOUT = 'pulse.layout';
  const TOP = 62; // keep clear of the top bar
  const MIN_W = 340;
  const MIN_H = 300;
  let layout = readLayout();
  function readLayout() {
    try {
      const l = JSON.parse(PT.prefs.get(LAYOUT) || '{}');
      return l && typeof l === 'object' ? l : {};
    } catch {
      return {};
    }
  }
  const saveLayout = () => PT.prefs.set(LAYOUT, JSON.stringify(layout));
  const small = () => window.matchMedia('(max-width: 760px)').matches;
  const movable = () => Boolean(PT.display && PT.display.get('pulseMove')) && !small();
  const pinned = () => Boolean(PT.display && PT.display.get('pulsePin'));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));
  const px = (v) => `${Math.round(v)}px`;
  const clearPos = (el) => ['left', 'top', 'right', 'bottom'].forEach((k) => (el.style[k] = ''));
  const clearSize = () => ['width', 'height', 'maxHeight', 'transformOrigin'].forEach((k) => (panel.style[k] = ''));
  function applyLayout() {
    panel.classList.toggle('movable', movable());
    fab.classList.toggle('movable', movable());
    $('.pu-head', panel).title = movable() && !pipWin ? 'Drag to move. Double-click to put it back next to the button' : '';
    fab.title = movable() ? 'Pulse. Drag to move' : 'Pulse';
    // Move and resize off (or a narrow window): the usual corner and size. Where you put it is
    // still saved, so turning Move and resize back on returns it there.
    if (small() || !movable()) {
      clearPos(fab);
      clearPos(panel);
      clearSize();
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (layout.fab) Object.assign(fab.style, { left: px(clamp(layout.fab.x, 8, W - 54)), top: px(clamp(layout.fab.y, TOP, H - 54)), right: 'auto', bottom: 'auto' });
    else clearPos(fab);
    if (pipWin) {
      panel.classList.remove('movable');
      clearPos(panel);
      clearSize();
      return;
    }
    const P = layout.panel || {};
    panel.style.width = P.w ? px(clamp(P.w, MIN_W, W - 16)) : '';
    panel.style.height = P.h ? px(clamp(P.h, MIN_H, H - TOP - 8)) : '';
    panel.style.maxHeight = P.h ? 'none' : '';
    if (panel.hidden) return;
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    let x = null;
    let y = null;
    if (Number.isFinite(P.x) && Number.isFinite(P.y)) {
      x = P.x;
      y = P.y;
    } else if (layout.fab) {
      // Not placed yet: open next to the button, toward the middle of the screen.
      const r = fab.getBoundingClientRect();
      x = r.left + r.width / 2 > W / 2 ? r.right - pw : r.left;
      y = r.top - ph - 12 >= TOP ? r.top - ph - 12 : r.bottom + 12;
    }
    if (x == null) {
      clearPos(panel);
      panel.style.transformOrigin = '';
    } else Object.assign(panel.style, { left: px(clamp(x, 8, W - pw - 8)), top: px(clamp(y, TOP, H - ph - 8)), right: 'auto', bottom: 'auto', transformOrigin: 'center' });
    moveInk();
  }
  function resetLayout() {
    layout = {};
    saveLayout();
    clearPos(fab);
    clearPos(panel);
    clearSize();
    applyLayout();
  }
  function syncPin() {
    const b = $('.pu-pin', panel);
    b.setAttribute('aria-pressed', String(pinned()));
    b.title = pinned() ? 'Staying open. Click so it closes when you click elsewhere' : 'Stay open while you click around';
  }
  // Pointer drags: follow the pointer, keep inside the window, save on release.
  function drag(handle, ev, { onMove, onEnd, threshold = 0, cls }) {
    const sx = ev.clientX;
    const sy = ev.clientY;
    let moved = threshold === 0;
    if (cls) panel.classList.add(cls);
    // No text selection while dragging: a stray selection would turn the drag into a text drag.
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount) sel.removeAllRanges();
    document.documentElement.classList.add('pu-dragging');
    try {
      handle.setPointerCapture(ev.pointerId);
    } catch {
      // the pointer is already gone
    }
    const move = (e) => {
      if (!moved) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < threshold) return;
        moved = true;
      }
      onMove(e.clientX - sx, e.clientY - sy);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      if (cls) panel.classList.remove(cls);
      document.documentElement.classList.remove('pu-dragging');
      onEnd(moved);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  const head = $('.pu-head', panel);
  head.addEventListener('pointerdown', (ev) => {
    if (!movable() || ev.button !== 0 || ev.target.closest('button, a, input')) return;
    ev.preventDefault();
    const r = panel.getBoundingClientRect();
    drag(head, ev, {
      cls: 'dragging',
      onMove: (dx, dy) => {
        const x = clamp(r.left + dx, 8, window.innerWidth - r.width - 8);
        const y = clamp(r.top + dy, TOP, window.innerHeight - r.height - 8);
        Object.assign(panel.style, { left: px(x), top: px(y), right: 'auto', bottom: 'auto', transformOrigin: 'center' });
        layout.panel = { ...(layout.panel || {}), x, y };
      },
      onEnd: saveLayout,
    });
  });
  head.addEventListener('dblclick', (ev) => {
    if (!movable() || ev.target.closest('button, a, input')) return;
    layout.panel = {};
    saveLayout();
    clearSize();
    applyLayout();
  });
  const grip = $('.pu-grip', panel);
  grip.addEventListener('pointerdown', (ev) => {
    if (!movable() || ev.button !== 0) return;
    ev.preventDefault();
    const r = panel.getBoundingClientRect();
    // Hold the top-left corner still so the panel grows right and down.
    Object.assign(panel.style, { left: px(r.left), top: px(r.top), right: 'auto', bottom: 'auto', transformOrigin: 'center', maxHeight: 'none' });
    layout.panel = { ...(layout.panel || {}), x: r.left, y: r.top };
    drag(grip, ev, {
      cls: 'resizing',
      onMove: (dx, dy) => {
        const w = clamp(r.width + dx, MIN_W, window.innerWidth - r.left - 8);
        const h = clamp(r.height + dy, MIN_H, window.innerHeight - r.top - 8);
        panel.style.width = px(w);
        panel.style.height = px(h);
        layout.panel = { ...layout.panel, w, h };
        moveInk();
      },
      onEnd: saveLayout,
    });
  });
  let fabDragged = false;
  fab.addEventListener('pointerdown', (ev) => {
    if (!movable() || ev.button !== 0) return;
    const r = fab.getBoundingClientRect();
    drag(fab, ev, {
      threshold: 6, // a short press is still a click
      onMove: (dx, dy) => {
        fab.classList.add('dragging');
        const x = clamp(r.left + dx, 8, window.innerWidth - r.width - 8);
        const y = clamp(r.top + dy, TOP, window.innerHeight - r.height - 8);
        Object.assign(fab.style, { left: px(x), top: px(y), right: 'auto', bottom: 'auto' });
        layout.fab = { x, y };
        if (isOpen && !(layout.panel && Number.isFinite(layout.panel.x))) applyLayout();
      },
      onEnd: (moved) => {
        fab.classList.remove('dragging');
        if (!moved) return;
        fabDragged = true;
        setTimeout(() => (fabDragged = false), 60);
        saveLayout();
      },
    });
  });
  $('.pu-pin', panel).addEventListener('click', () => PT.display && PT.display.set('pulsePin', !pinned()));
  if (PT.display) {
    PT.display.on((p, k) => {
      if (k === 'pulseMove') applyLayout();
      if (k === 'pulsePin') syncPin();
      if (k === 'pulsePop') syncPop();
    });
  }
  syncPin();
  syncPop();
  window.addEventListener('resize', () => applyLayout());

  // ---------- floating window (Settings > Display > Pop-out window) ----------
  // Chrome and Edge can show part of a page in its own small window that stays on top of other tabs
  // and apps (Document Picture-in-Picture). Pulse moves into it as it is, tabs and all, and comes back
  // when the window closes. It needs a click to open (a browser rule). Its clocks and refresh run on
  // the floating window's own timers, because the dashboard's tab gets throttled in the background.
  function canPop() {
    return 'documentPictureInPicture' in window;
  }
  function popOn() {
    return Boolean(PT.display && PT.display.get('pulsePop')) && canPop();
  }
  function syncPop() {
    const b = $('.pu-pop', panel);
    b.hidden = !popOn() && !pipWin;
    b.setAttribute('aria-pressed', String(Boolean(pipWin)));
    b.title = pipWin ? 'Put Pulse back in the page' : 'Pop out: float Pulse over other tabs and apps';
    b.setAttribute('aria-label', pipWin ? 'Put back in the page' : 'Pop out');
    fab.classList.toggle('popped', Boolean(pipWin));
    if (pipWin) fab.title = 'Pulse is floating in its own window. Click to bring it back';
  }
  async function popOut() {
    if (pipWin || !canPop()) return;
    const r = panel.hidden ? null : panel.getBoundingClientRect();
    let win;
    try {
      win = await window.documentPictureInPicture.requestWindow({ width: Math.round(Math.max(360, (r && r.width) || 400)), height: Math.round(Math.max(460, (r && r.height) || 640)) });
    } catch (e) {
      return;
    }
    pipWin = win;
    PT.rafWin = win;
    const d = win.document;
    d.title = 'Pulse · Perps Tracker';
    d.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') || 'dark');
    for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
      const n = d.createElement('link');
      n.rel = 'stylesheet';
      n.href = l.href;
      d.head.append(n);
    }
    d.body.className = 'pip-body';
    panel.classList.add('popped');
    panel.classList.remove('opening', 'closing', 'movable');
    clearPos(panel);
    clearSize();
    d.body.append(panel);
    if (isOpen) {
      panel.hidden = false;
      show(tab, false, false);
    } else setOpen(true);
    themeWatch = new MutationObserver(() => d.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') || 'dark'));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    pipTimers = [
      win.setInterval(() => {
        tick();
        renderHead();
      }, 1000),
      win.setInterval(() => PT.refresh && PT.refresh(), 10000),
    ];
    win.addEventListener('pagehide', () => bringHome(false));
    win.addEventListener('resize', () => moveInk());
    syncPop();
    PT.raf(moveInk);
  }
  // reopen: show Pulse in the page afterwards (the round button or "put back"); otherwise it closes.
  function bringHome(reopen) {
    if (!pipWin) return;
    const win = pipWin;
    pipWin = null;
    PT.rafWin = null;
    pipTimers.forEach((t) => win.clearInterval(t));
    pipTimers = [];
    if (themeWatch) themeWatch.disconnect();
    panel.classList.remove('popped');
    document.body.append(panel);
    panel.hidden = true;
    isOpen = false;
    fab.setAttribute('aria-expanded', 'false');
    portfolioTimer(false);
    syncPop();
    fab.title = 'Pulse';
    try {
      win.close();
    } catch {
      // already closing
    }
    if (reopen) setOpen(true);
  }

  // ---------- events ----------
  fab.addEventListener('click', () => {
    if (fabDragged) return; // that was a drag, not a click
    if (pipWin) return bringHome(true); // floating: bring it back into the page
    setOpen(!isOpen);
  });
  $('.pu-close', panel).addEventListener('click', () => {
    if (pipWin) return pipWin.close();
    setOpen(false);
    fab.focus();
  });
  $('.pu-pop', panel).addEventListener('click', () => (pipWin ? bringHome(true) : popOut()));
  $('.pu-tabs', panel).addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tab]');
    if (b && b.dataset.tab !== tab) show(b.dataset.tab);
  });
  $('.pu-tabs', panel).addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (ev.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
    show(next).then(() => $(`.pu-tabs [data-tab="${next}"]`, panel).focus());
    ev.preventDefault();
  });
  body.addEventListener('input', (ev) => {
    if (ev.target.matches('input[type="range"][data-what]')) onWhat(ev.target);
  });
  body.addEventListener('click', (ev) => {
    const r = ev.target.closest('[data-reset]');
    if (r) {
      delete what[r.dataset.reset];
      render();
      return;
    }
    if (ev.target.closest('[data-close-pulse]') && !pinned()) setOpen(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isOpen && !pipWin && !document.querySelector('dialog[open]')) {
      setOpen(false);
      fab.focus();
    }
  });
  // Click outside closes (but not the button itself, which toggles), unless it's set to stay open.
  document.addEventListener('pointerdown', (ev) => {
    if (!isOpen || pipWin || pinned() || panel.contains(ev.target) || fab.contains(ev.target) || ev.target.closest('dialog')) return;
    setOpen(false);
  });
  window.addEventListener('resize', () => isOpen && moveInk());

  PT.pulse = { update, open: (t) => (setOpen(true), t && show(t)), close: () => setOpen(false), resetLayout, isOpen: () => isOpen, popOut, isPopped: () => Boolean(pipWin) };
})();
