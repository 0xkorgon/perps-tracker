/* Shared helpers: formatting, API calls, preferences, tooltip. Everything hangs off window.PT. */
(() => {
  'use strict';

  const PT = (window.PT = window.PT || {});

  PT.ORDER = ['bulk', 'arcus', 'entropy'];
  PT.NAMES = { bulk: 'Bulk', arcus: 'Arcus', entropy: 'Entropy', all: 'All exchanges' };
  PT.COLOR = { bulk: 'var(--ex-bulk)', arcus: 'var(--ex-arcus)', entropy: 'var(--ex-entropy)' };
  PT.MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  PT.DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  PT.$ = (sel, root = document) => root.querySelector(sel);
  PT.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  PT.esc = (v) =>
    String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  PT.prefs = {
    get(k) {
      try {
        return localStorage.getItem(`perps.${k}`);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`perps.${k}`, v);
      } catch {}
    },
  };

  // ---------- formatting ----------
  PT.money = (n, opts = {}) => {
    if (n == null || !Number.isFinite(n)) return '–';
    const abs = Math.abs(n);
    const sign = n < 0 ? '−' : opts.plus && n > 0 ? '+' : '';
    if (opts.compact && abs >= 1000) {
      for (const [v, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
        if (abs >= v) {
          const x = abs / v;
          return `${sign}$${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)}${u}`;
        }
      }
    }
    let dp = opts.dp;
    if (dp == null) dp = abs >= 1000 ? 0 : abs >= 1 || abs === 0 ? 2 : 4;
    const shown = abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return `${Number(abs.toFixed(dp)) === 0 ? '' : sign}$${shown}`; // never show a sign on $0.00
  };
  PT.compact = (n) => PT.money(n, { compact: true });
  // Short money for axes and targets: $7K, $2.5M, $150 (no trailing zeros).
  PT.short = (n) => {
    if (n == null || !Number.isFinite(n)) return '–';
    const abs = Math.abs(n);
    const sign = n < 0 ? '−' : '';
    const trim = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1).replace(/\.0$/, '') : x.toFixed(2).replace(/\.?0+$/, ''));
    for (const [v, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (abs >= v) return `${sign}$${trim(abs / v)}${u}`;
    return `${sign}$${trim(abs)}`;
  };
  PT.signed = (n, opts = {}) => (Number.isFinite(n) ? PT.money(n, { dp: 2, ...opts, plus: true }) : '–');
  PT.count = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '–');
  PT.pct = (x, dp = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(dp)}%` : '–');
  PT.bps = (x) => (Number.isFinite(x) ? `${x.toFixed(2)} bps` : '–');
  PT.plain = (n, dp = 2) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: dp }) : '–');

  PT.dur = (ms) => {
    if (ms == null || !Number.isFinite(ms)) return '–';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  };
  PT.ago = (ts) => {
    if (!ts) return 'not yet';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };
  PT.dateShort = (ts) => {
    const d = new Date(ts);
    return `${d.getDate()} ${PT.MONTHS[d.getMonth()]}`;
  };
  PT.dateTime = (ts) => {
    const d = new Date(ts);
    return `${d.getDate()} ${PT.MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  PT.dayLabel = (key) => {
    const [, m, d] = key.split('-').map(Number);
    return `${PT.MONTHS[m - 1]} ${d}`;
  };
  PT.price = (n) => {
    if (!Number.isFinite(n) || n === 0) return '–';
    const a = Math.abs(n);
    if (a >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n.toLocaleString('en-US', { maximumFractionDigits: a >= 1 ? 4 : 6 });
  };
  PT.size = (n) => Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 4 : 8 });
  PT.pnlClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

  // New York wall clock (for the US-session indicator), DST-aware.
  PT.nyClock = (ts = Date.now()) => {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
    return `${parts.weekday} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  };

  // ---------- API ----------
  // The server's address: config.js sets it for the website on Vercel; empty means this same site.
  PT.API = String((window.PT_CONFIG && window.PT_CONFIG.api) || '').replace(/\/+$/, '');
  // Your dashboard's private key (no sign-up): kept in this browser. Anyone with it can open your
  // dashboard, so it's only ever sent to the tracker's server.
  let memKey = null;
  PT.key = () => PT.prefs.get('key') || memKey;
  PT.setKey = (k) => {
    memKey = k || null;
    try {
      if (k) localStorage.setItem('perps.key', k);
      else localStorage.removeItem('perps.key');
    } catch {}
  };
  const authHeaders = () => {
    const k = PT.key();
    return k ? { Authorization: `Bearer ${k}` } : {};
  };
  const failed = async (r) => {
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.code === 'auth' && PT.onAuthLost) PT.onAuthLost();
    const e = new Error(j.error || `HTTP ${r.status}`);
    e.status = r.status;
    e.code = j.code;
    return e;
  };
  PT.getJSON = async (path) => {
    const r = await fetch(PT.API + path, { cache: 'no-store', headers: authHeaders() });
    if (!r.ok) throw await failed(r);
    return r.json();
  };
  PT.post = async (path, body, extraHeaders) => {
    const r = await fetch(PT.API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(extraHeaders || {}) }, body: JSON.stringify(body || {}) });
    if (!r.ok) throw await failed(r);
    return r.json().catch(() => ({}));
  };
  // A file from the server (exports), saved through the browser.
  PT.download = async (path) => {
    const r = await fetch(PT.API + path, { cache: 'no-store', headers: authHeaders() });
    if (!r.ok) throw await failed(r);
    const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || path.split('/').pop();
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // ---------- tooltip ----------
  const tip = () => document.getElementById('tooltip');
  PT.showTip = (html, x, y) => {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    const r = t.getBoundingClientRect();
    let left = x + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    let top = y - r.height / 2;
    top = Math.max(8, Math.min(window.innerHeight - r.height - 40, top));
    t.style.left = `${Math.max(8, left)}px`;
    t.style.top = `${top}px`;
  };
  PT.hideTip = () => {
    tip().hidden = true;
  };
  PT.tipRows = (title, rows, total) =>
    `<div class="tt-title">${PT.esc(title)}</div>${rows
      .map((r) => `<div class="tt-row"><span class="nm"><i class="${r.box ? 'key' : 'linekey'}" style="background:${r.color}"></i>${PT.esc(r.name)}</span><b>${PT.esc(r.value)}</b></div>`)
      .join('')}${total ? `<div class="tt-row tt-total"><span class="nm">${PT.esc(total.name)}</span><b>${PT.esc(total.value)}</b></div>` : ''}`;

  // Exchange logo tile (img/bulk.png, img/arcus.svg, img/entropy.svg), plus name.
  PT.LOGO = { bulk: 'img/bulk.png', arcus: 'img/arcus.svg', entropy: 'img/entropy.svg' };
  PT.exm = (id, size = '') =>
    PT.LOGO[id]
      ? `<span class="exm exm-${id}${size ? ` ${size}` : ''}" aria-hidden="true"><img src="${PT.LOGO[id]}" alt=""></span>`
      : `<span class="exm${size ? ` ${size}` : ''}" style="--c:${PT.COLOR[id] || 'var(--ink-4)'}" aria-hidden="true">${PT.esc((PT.NAMES[id] || '?')[0])}</span>`;
  // <span data-exm="arcus" class="sm"></span> placeholders in static HTML become logo tiles.
  PT.hydrateLogos = (root = document) => {
    root.querySelectorAll('[data-exm]').forEach((el) => {
      el.insertAdjacentHTML('afterend', PT.exm(el.dataset.exm, el.dataset.size || ''));
      el.remove();
    });
  };
  PT.exName = (id, size = 'sm') => `<span class="exname">${PT.exm(id, size)}${PT.esc(PT.NAMES[id])}</span>`;

  // Board cells: the row of headline numbers at the top of each page.
  PT.cell = ({ icon, label, value, sub, cls = '', title = '' }) =>
    `<div class="cell"${title ? ` title="${PT.esc(title)}"` : ''}><span class="cell-l">${icon ? PT.icon(icon) : ''}${PT.esc(label)}</span><span class="cell-v ${cls}">${PT.esc(value)}</span>${sub != null ? `<span class="cell-s">${PT.esc(sub)}</span>` : ''}</div>`;
  PT.leadCell = ({ icon, label, value, sub, title = '' }) =>
    `<div class="cell lead"${title ? ` title="${PT.esc(title)}"` : ''}><span class="cell-l">${icon ? PT.icon(icon) : ''}${PT.esc(label)}</span><span class="lead-v">${PT.esc(value)}</span>${sub != null ? `<span class="cell-s">${PT.esc(sub)}</span>` : ''}</div>`;

  // Long / short badge.
  PT.sideBadge = (side) => `<span class="side ${side === 'L' ? 'L' : 'S'}">${PT.icon(side === 'L' ? 'trending' : 'trendingDown')}${side === 'L' ? 'Long' : 'Short'}</span>`;

  // ---------- motion ----------
  // Animation frames from the window that's showing: Pulse's floating window sets PT.rafWin, because
  // a background tab gets no frames.
  PT.raf = (f) => (PT.rafWin || window).requestAnimationFrame(f);
  // Bulk's hold multiplier: what an hour open adds (from the AURA model on the server).
  PT.bulkPerHour = (m) => (m && m.perHour > 0 ? m.perHour : (PT.state && PT.state.bulkHold && PT.state.bulkHold.perHour) || 0);
  PT.holdKnown = () => Boolean(PT.state && PT.state.bulkHold && PT.state.bulkHold.perHour > 0);
  PT.bulkMult = (h, m) => 1 + PT.bulkPerHour(m) * Math.max(0, h);
  PT.reduceMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Count a number up (or down) in place: el shows fmt(value) at every frame.
  PT.countUp = (el, to, { from = 0, dur = 900, fmt = (v) => PT.plain(v, 0) } = {}) => {
    if (!el) return;
    if (PT.reduceMotion() || !Number.isFinite(to) || !Number.isFinite(from) || from === to) {
      el.textContent = fmt(to);
      return;
    }
    const t0 = performance.now();
    const token = (el._countToken = {});
    const step = (t) => {
      if (el._countToken !== token) return; // a newer count took over
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(k < 1 ? from + (to - from) * e : to);
      if (k < 1) PT.raf(step);
    };
    el.textContent = fmt(from);
    PT.raf(step);
  };

  // ---------- hold clocks ----------
  // 1d 04:13:05 (or 04:13:05 under a day).
  PT.clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const p2 = (n) => String(n).padStart(2, '0');
    const hms = `${p2(Math.floor((s % 86400) / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
    return d ? `${d}d ${hms}` : hms;
  };
  // Live hold clocks: any element with data-held-since="<ms timestamp>", ticked every second by the app.
  PT.tickHeld = (root = document) => {
    const now = Date.now();
    root.querySelectorAll('[data-held-since]').forEach((el) => {
      const t = PT.clock(now - Number(el.dataset.heldSince));
      if (el.textContent !== t) el.textContent = t;
    });
  };

  // ---------- countdowns ----------
  // "2d 4h", "4h 12m", "12m 05s" (short) or "2d 04h 12m 05s" (full).
  PT.countdown = (ms, full = false) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p2 = (n) => String(n).padStart(2, '0');
    if (full) return d ? `${d}d ${p2(h)}h ${p2(m)}m ${p2(sec)}s` : h ? `${h}h ${p2(m)}m ${p2(sec)}s` : `${m}m ${p2(sec)}s`;
    return d ? `${d}d ${h}h` : h ? `${h}h ${p2(m)}m` : `${m}m ${p2(sec)}s`;
  };
  // "Sat 10 Oct, 14:00" in the viewer's own time zone.
  PT.localWhen = (ts) => {
    const d = new Date(ts);
    return `${PT.DAYS[d.getDay()]} ${d.getDate()} ${PT.MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  // Live countdowns: any element with data-countdown="<ms timestamp>" (data-full for seconds).
  PT.tickCountdowns = (root = document) => {
    const now = Date.now();
    root.querySelectorAll('[data-countdown]').forEach((el) => {
      const left = Number(el.dataset.countdown) - now;
      el.textContent = left > 0 ? PT.countdown(left, el.hasAttribute('data-full')) : el.dataset.done || 'Any moment now';
    });
  };

  // Segmented control helper: buttons with data-v; calls onPick(value).
  PT.seg = (el, value, onPick) => {
    PT.$$('button', el).forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.v === value));
      b.onclick = () => onPick(b.dataset.v);
    });
  };
})();
