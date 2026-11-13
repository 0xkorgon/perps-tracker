/* Display preferences, kept on this browser: the Pulse widget's layout (move, resize, stay open)
   and a live browser tab. The tab's title carries the numbers you pick (liquidation warning, open
   PnL, Bulk multiplier, time to the AURA cutoff) and its icon is drawn live: gold within 15% of
   liquidation, flashing red within 5%, the tallest bar green or red with your open PnL, and a line
   under the bars that fills as your Bulk multiplier grows toward a week held. */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc, NAMES } = PT;
  const HOUR = 3600e3;
  const KEY = 'display';
  const PAGES = [
    ['overview', 'Overview'],
    ['live', 'Live'],
    ['strategy', 'Strategy'],
    ['fees', 'Fees'],
    ['points', 'Points'],
    ['leagues', 'Leagues'],
    ['referrals', 'Referrals'],
  ];
  const DEFAULTS = { pages: Object.fromEntries(PAGES.map(([id]) => [id, true])), pulseMove: false, pulsePin: false, pulsePop: false, title: true, tLiq: true, tPnl: true, tHold: true, tMult: true, tCut: true, favicon: true };

  let prefs = load();
  const listeners = [];
  function load() {
    let p = {};
    try {
      p = JSON.parse(PT.prefs.get(KEY) || '{}') || {};
    } catch {
      p = {};
    }
    return { ...DEFAULTS, ...p, pages: { ...DEFAULTS.pages, ...(p.pages || {}) } };
  }
  // A page shows unless you switched it off; at least one always stays on.
  const pageOn = (id) => prefs.pages[id] !== false || PAGES.every(([p]) => prefs.pages[p] === false);
  function set(k, v) {
    prefs = { ...prefs, [k]: v };
    PT.prefs.set(KEY, JSON.stringify(prefs));
    listeners.forEach((f) => f(prefs, k));
    tick(lastPage, lastOffline);
  }
  const get = (k) => (k ? prefs[k] : { ...prefs });
  function setPage(id, on) {
    const pages = { ...prefs.pages, [id]: on };
    if (!PAGES.some(([p]) => pages[p] !== false)) return false; // keep one
    set('pages', pages);
    return true;
  }
  const on = (f) => listeners.push(f);

  // ---------- the live numbers ----------
  function liveNumbers(st) {
    const out = { pnl: null, mult: null, multP: 0, cutoff: null, near: null, open: 0, hold: null };
    if (!st || !st.stats) return out;
    const hedges = st.stats.hedges || [];
    const legs = hedges.flatMap((g) => g.legs || []);
    out.open = legs.length;
    // At the latest price the tracker has (the risk watch refreshes it between syncs).
    if (legs.length) out.pnl = legs.reduce((a, l) => a + (l.entry > 0 && l.mark > 0 ? l.size * (l.mark - l.entry) : Number.isFinite(l.upnl) ? l.upnl : 0), 0);
    const m = st.bulkHold || null;
    const now = Date.now();
    let wn = 0;
    let wm = 0;
    for (const l of legs) {
      if (l.exchange !== 'bulk' || !l.openTs || !(l.notional > 0)) continue;
      const h = Math.max(0, now - l.openTs) / HOUR;
      wn += l.notional;
      wm += l.notional * PT.bulkMult(h, m);
    }
    if (wn > 0 && PT.holdKnown()) {
      out.mult = wm / wn;
      out.multP = Math.min(1, (out.mult - 1) / (PT.bulkMult(168, m) - 1 || 1));
    }
    // Hold time: your biggest Bulk position (the one earning AURA), else your biggest position.
    const timed = legs.filter((l) => l.openTs);
    const pool = timed.some((l) => l.exchange === 'bulk') ? timed.filter((l) => l.exchange === 'bulk') : timed;
    const main = pool.reduce((a, l) => (!a || (l.notional || 0) > (a.notional || 0) ? l : a), null);
    if (main) out.hold = { mkt: main.mkt, exchange: main.exchange, openTs: main.openTs };
    const drop = (st.drops || []).find((d) => d.id === 'bulk');
    if (drop && PT.hasWallets('bulk') && drop.at - 30 * 60e3 > now) out.cutoff = drop.at - 30 * 60e3; // Bulk closes the week 30 minutes before the reveal
    const near = hedges.filter((g) => g.nearest).map((g) => g.nearest).sort((a, b) => a.dist - b.dist)[0];
    if (near && near.dist < 0.15) out.near = near;
    return out;
  }
  const baseName = (mkt) => String(mkt || '').replace(/^.*:/, '').replace(/[-_/]?(USDC|USDT|USD|PERP)$/i, '') || mkt;
  const signedShort = (x) => (Math.abs(x) < 1000 ? PT.signed(x) : `${x > 0 ? '+' : '−'}${PT.short(Math.abs(x))}`);

  function titleParts(n) {
    const parts = [];
    if (prefs.tLiq && n.near) parts.push(`⚠ ${NAMES[n.near.exchange]} ${n.near.mkt} ${(n.near.dist * 100).toFixed(1)}% from liquidation`);
    if (prefs.tPnl && n.pnl != null) parts.push(signedShort(n.pnl));
    if (prefs.tHold && n.hold) parts.push(`${baseName(n.hold.mkt)} ${PT.clock(Date.now() - n.hold.openTs)}`);
    if (prefs.tMult && n.mult != null) parts.push(`${n.mult.toFixed(2)}×`);
    if (prefs.tCut && n.cutoff) parts.push(`AURA ${PT.countdown(n.cutoff - Date.now())}`);
    return parts;
  }

  // ---------- the live icon ----------
  const link = document.querySelector('link[rel="icon"]');
  const ORIGINAL = link ? link.getAttribute('href') : '';
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  let lastIcon = '';
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => {
    const x = hex(a);
    const y = hex(b);
    return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
  };
  function rr(c, x, y, w, h, r, fill) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
  }
  function iconFor(n) {
    const danger = Boolean(n.near && n.near.dist < 0.05);
    const watch = Boolean(n.near && !danger);
    const flash = danger && Math.floor(Date.now() / 1000) % 2 === 1;
    const p = Math.round(n.multP * 40) / 40;
    const sign = n.pnl == null ? 0 : n.pnl > 0.005 ? 1 : n.pnl < -0.005 ? -1 : 0;
    const showBar = n.mult != null;
    const key = [danger, watch, flash, p, sign, n.pnl == null, showBar].join('|');
    if (key === lastIcon) return null;
    lastIcon = key;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, 64, 64);
    rr(c, 0, 0, 64, 64, 15, danger && !flash ? '#e5484d' : watch ? '#e5b13a' : '#000000');
    const ink = watch ? '#17120a' : '#f4f4f5';
    const top = n.near ? ink : n.pnl == null ? '#ee5a24' : sign < 0 ? '#e5484d' : '#4fb8a0';
    const floor = showBar ? 44 : 52;
    const span = floor - 10;
    [
      [12, 0.45, ink],
      [27.5, 0.72, ink],
      [43, 1, top],
    ].forEach(([x, k, col]) => rr(c, x, floor - span * k, 9, span * k, 2.5, col));
    if (showBar) {
      rr(c, 12, 50, 40, 6, 3, watch ? 'rgba(23,18,10,0.25)' : 'rgba(244,244,245,0.22)');
      if (p > 0) rr(c, 12, 50, Math.max(6, 40 * p), 6, 3, n.near ? ink : mix('#3f86f5', '#4fb8a0', p));
    }
    return canvas.toDataURL('image/png');
  }
  function favicon(n) {
    if (!link) return;
    if (!prefs.favicon || !n) {
      if (link.getAttribute('href') !== ORIGINAL) link.setAttribute('href', ORIGINAL);
      lastIcon = '';
      return;
    }
    const url = iconFor(n);
    if (url) link.setAttribute('href', url);
  }

  // Called every second by the app with the page's name.
  let lastPage = 'Overview';
  let lastOffline = false;
  function tick(page = lastPage, offline = lastOffline) {
    lastPage = page;
    lastOffline = offline;
    const st = PT.state;
    const n = st && !offline ? liveNumbers(st) : null;
    let t = `${page} · Perps Tracker`;
    if (offline) t = `Offline · ${t}`;
    else if (prefs.title && n) {
      const parts = titleParts(n);
      if (parts.length) t = `${parts.join(' · ')} · ${page}`;
    }
    if (document.title !== t) document.title = t;
    favicon(n);
    const pv = document.getElementById('ds-preview');
    if (pv) {
      pv.textContent = t;
      const img = document.getElementById('ds-fav');
      if (img && link && img.getAttribute('src') !== link.getAttribute('href')) img.setAttribute('src', link.getAttribute('href'));
    }
  }

  // ---------- Settings > Display ----------
  function settingsPanel() {
    const t = (k, title, hint, off = false) => `<label class="al-opt"><input type="checkbox" class="toggle" data-ds="${k}"${prefs[k] && !off ? ' checked' : ''}${off ? ' disabled' : ''}><span><b>${esc(title)}</b><span>${esc(hint)}</span></span></label>`;
    const pip = 'documentPictureInPicture' in window;
    const c = (k, label) => `<label class="ds-chk"><input type="checkbox" data-ds="${k}"${prefs[k] ? ' checked' : ''}>${esc(label)}</label>`;
    return `<div class="ds">
      <p class="ds-note">${PT.icon('info', 'sm')}<span>Saved on this browser and applied right away.</span></p>
      <div class="wsec">
        <div class="wsec-head">${PT.icon('layers')}<h3>Pages</h3></div>
        <p class="wsec-hint">Pick the pages in the menu. The ones you turn off are hidden, not deleted.</p>
        <div class="ds-items ds-pages" id="ds-pages">${PAGES.map(([id, name]) => `<label class="ds-chk"><input type="checkbox" data-page="${id}"${pageOn(id) ? ' checked' : ''}>${esc(name)}</label>`).join('')}</div>
      </div>
      <div class="wsec">
        <div class="wsec-head">${PT.icon('activity')}<h3>Browser tab</h3></div>
        <p class="wsec-hint">Live numbers in the tab's title and icon, so you can keep an eye on your trades from another tab or window.</p>
        ${t('title', 'Live tab title', 'Puts the numbers you pick below at the front of the tab title, updated every second. Hold time is your biggest Bulk position (or your biggest position if none is on Bulk).')}
        <div class="ds-items" id="ds-items">${c('tLiq', 'Liquidation warning')}${c('tPnl', 'Open PnL')}${c('tHold', 'Hold time')}${PT.holdKnown() ? c('tMult', 'Bulk multiplier') : ''}${c('tCut', 'Time to AURA cutoff')}</div>
        ${t('favicon', 'Live tab icon', 'Turns gold within 15% of liquidation and flashes red within 5%. Otherwise the tallest bar is green or red with your open PnL, and the line under the bars fills as your Bulk multiplier grows.')}
        <div class="ds-preview"><span class="ds-tab" title="Your tab right now"><img id="ds-fav" src="" alt=""><span id="ds-preview">…</span></span><span class="ds-cap">Your tab right now</span></div>
      </div>
      <div class="wsec">
        <div class="wsec-head">${PT.icon('move')}<h3>Pulse widget</h3></div>
        <p class="wsec-hint">The quick view behind the round button in the corner.</p>
        ${t('pulseMove', 'Move and resize', 'Drag Pulse by its header to put it anywhere on the page, and resize it from its bottom-right corner. The round button can be dragged too. Off: Pulse sits in the bottom-right corner at its usual size. Where you put it is remembered, so turning this on again puts it back there.')}
        ${t('pulsePop', 'Pop-out window', pip ? 'Adds a button to Pulse’s header that floats it in its own small window, on top of other tabs and apps (YouTube too). Close that window to bring Pulse back.' : 'Needs Chrome or Edge (version 116 or newer).', !pip)}
        ${t('pulsePin', 'Stay open', 'Keeps Pulse open while you click around and switch pages, and opens it again next time if you left it open. Off: it closes when you click elsewhere.')}
        <div class="ds-actions"><button type="button" class="btn btn-sm" data-ds-reset>${PT.icon('refresh', 'sm')}Put Pulse back in the corner</button><span class="ds-msg" id="ds-msg" role="status"></span></div>
      </div>
    </div>`;
  }
  function wire(root) {
    const el = root.querySelector('.ds');
    if (!el) return;
    const sync = () => {
      const items = el.querySelector('#ds-items');
      items.classList.toggle('off', !prefs.title);
      items.querySelectorAll('input').forEach((i) => (i.disabled = !prefs.title));
    };
    el.addEventListener('change', (ev) => {
      const page = ev.target && ev.target.dataset ? ev.target.dataset.page : null;
      if (page) {
        if (!setPage(page, ev.target.checked)) ev.target.checked = true; // the last page stays on
        return;
      }
      const k = ev.target && ev.target.dataset ? ev.target.dataset.ds : null;
      if (!k) return;
      set(k, ev.target.checked);
      sync();
    });
    el.querySelector('[data-ds-reset]').addEventListener('click', () => {
      if (PT.pulse && PT.pulse.resetLayout) PT.pulse.resetLayout();
      el.querySelector('#ds-msg').textContent = 'Pulse is back in the corner.';
    });
    sync();
    lastIcon = '';
    tick();
  }

  PT.display = { get, set, on, tick, settingsPanel, wire, liveNumbers, pageOn, setPage, PAGES };
})();
