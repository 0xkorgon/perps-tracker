/* Alerts in the dashboard: a card in the top-right corner for each new alert, with a sound while
   the page is open and visible, and a browser notification while it's open in the background.
   Sounds are synthesised (Web Audio), so there are no files to load:
     warn    a soft two-note chime
     danger  three urgent beeps, twice
   Settings → Alerts: what to be alerted about, the distances, sounds on or off, and test buttons. */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, $$, esc } = PT;
  const ICON = { danger: 'alert', warn: 'alert', info: 'info' };
  const KIND = { liq: 'Near liquidation', hedge: 'Hedge', liquidated: 'Liquidated', milestone: 'Multiplier', cutoff: 'AURA cutoff', test: 'Test' };
  // Where each alert's button goes.
  const GO = { milestone: ['#live', 'Open Live'], cutoff: ['#live', 'Open Live'] };

  // ---------- sounds ----------
  let ctx = null;
  const audio = () => {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  };
  // Browsers only allow sound after the page has been clicked or typed in once; unlock it then.
  const unlock = () => {
    audio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  function tone(ac, { f, at, dur, type = 'sine', gain = 0.18, f2 = null }) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, at);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(ac.destination);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  function play(level) {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime + 0.02;
    if (level === 'danger') {
      for (let r = 0; r < 2; r++) for (let i = 0; i < 3; i++) tone(ac, { f: 1046, at: t + r * 0.75 + i * 0.16, dur: 0.11, type: 'square', gain: 0.07 });
    } else if (level === 'warn') {
      tone(ac, { f: 659.25, at: t, dur: 0.32, gain: 0.16 });
      tone(ac, { f: 987.77, at: t + 0.16, dur: 0.5, gain: 0.14 });
    } else tone(ac, { f: 880, at: t, dur: 0.18, gain: 0.1, f2: 1320 });
  }

  // ---------- cards ----------
  const host = document.createElement('div');
  host.className = 'al-stack';
  host.setAttribute('aria-live', 'assertive');
  document.body.append(host);

  function card(a) {
    const el = document.createElement('div');
    el.className = `al-card ${a.level || 'info'}`;
    el.setAttribute('role', a.level === 'danger' ? 'alert' : 'status');
    el.innerHTML = `
      <span class="al-ic">${PT.icon(ICON[a.level] || 'info')}</span>
      <div class="al-txt"><span class="al-kind">${esc(KIND[a.kind] || 'Alert')} · ${esc(new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span><b>${esc(a.title)}</b>${a.body ? `<p>${esc(a.body)}</p>` : ''}
        <div class="al-act">${a.kind === 'test' ? '' : `<a class="btn btn-sm" href="${(GO[a.kind] || ['#overview'])[0]}" data-al-view>${esc((GO[a.kind] || [0, 'View hedges'])[1])}</a>`}<button type="button" class="btn btn-ghost btn-sm" data-al-close>Dismiss</button></div></div>
      <button type="button" class="icon-btn al-x" aria-label="Dismiss" data-al-close>${PT.icon('x', 'sm')}</button>`;
    const close = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), PT.reduceMotion() ? 0 : 220);
    };
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-al-close]') || ev.target.closest('[data-al-view]')) close();
    });
    // Danger stays until dismissed; warnings and tests fade after a while.
    if (a.level !== 'danger') setTimeout(close, 14000);
    host.prepend(el);
    while (host.children.length > 4) host.lastElementChild.remove();
  }

  // ---------- new alerts from the tracker ----------
  const seenKey = 'alerts.seen';
  let seen = Number(PT.prefs.get(seenKey)) || 0;
  let first = true;

  function update(state) {
    const al = state && state.alerts;
    if (!al) return;
    const recent = (al.recent || []).slice().sort((a, b) => a.at - b.at);
    // On first load, only show what came in while the page was closed in the last 10 minutes.
    const cutoff = first ? Math.max(seen, Date.now() - 10 * 60 * 1000) : seen;
    first = false;
    // A pop-up test is heard from the pop-up itself, not as a card here.
    const fresh = recent.filter((a) => a.at > cutoff && !(a.kind === 'test' && a.quiet));
    const newest = recent.reduce((m, a) => Math.max(m, a.at), seen);
    if (newest > seen) {
      seen = newest;
      PT.prefs.set(seenKey, String(seen));
    }
    if (!fresh.length) return;
    for (const a of fresh.slice(-3)) card(a);
    if (al.settings && al.settings.desktop && document.visibilityState !== 'visible') for (const a of fresh.slice(-3)) notify(a);
    const loudest = fresh.some((a) => a.level === 'danger' && !a.quiet) ? 'danger' : fresh.some((a) => a.level === 'warn' && !a.quiet) ? 'warn' : null;
    if (loudest && al.settings && al.settings.sound && document.visibilityState === 'visible' && canPlay()) play(loudest);
  }

  // ---------- browser notifications (while the dashboard is open in another tab) ----------
  const canNotify = () => 'Notification' in window;
  function notify(a) {
    if (!canNotify() || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(a.title, { body: a.body || '', tag: a.id || String(a.at), requireInteraction: a.level === 'danger' });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // some browsers only allow notifications from a service worker
    }
  }
  async function askPermission() {
    if (!canNotify()) return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }

  // ---------- Settings → Alerts ----------
  const pctIn = (v) => +(v * 100).toFixed(1);
  function settingsPanel(state) {
    const s = (state && state.alerts && state.alerts.settings) || {};
    const recent = (state && state.alerts && state.alerts.recent) || [];
    const perm = canNotify() ? Notification.permission : 'unsupported';
    const toggle = (k, title, hint) => `<label class="al-opt"><input type="checkbox" class="toggle" data-al="${k}"${s[k] ? ' checked' : ''}><span><b>${esc(title)}</b><span>${esc(hint)}</span></span></label>`;
    return `
      <div class="wsec">
        <div class="wsec-head"><i data-icon="alert"></i><h3>What to alert you about</h3></div>
        ${toggle('nearLiq', 'A position getting close to liquidation', 'Once at each level; again only after it has moved away and come back.')}
        <div class="al-dist"><label>Warning at <input type="number" min="1" max="50" step="0.5" data-al-pct="liqWarn" value="${pctIn(s.liqWarn || 0.1)}"> %</label><label>Danger at <input type="number" min="0.5" max="30" step="0.5" data-al-pct="liqDanger" value="${pctIn(s.liqDanger || 0.05)}"> %</label><span>from the liquidation price</span></div>
        ${toggle('hedges', 'A hedge breaking', 'One side closes, is liquidated or hits a TP/SL, or long and short stop matching.')}
        ${toggle('liquidations', 'A liquidation', 'Any position liquidated on any exchange.')}
        ${toggle('cutoff', 'AURA week about to end', 'An hour before Saturday’s 12:30 UTC cutoff: what each open Bulk position has earned this week and earns a day while open.')}
        ${PT.holdKnown() ? `<label class="al-opt al-sel"><span class="al-sel-ic">${PT.icon('hourglass', 'sm')}</span><span><b>Bulk multiplier milestones</b><span>When a position reaches its next multiplier.</span></span><select class="select sm" data-al-sel="milestones"><option value="daily"${s.milestones === 'daily' || !s.milestones ? ' selected' : ''}>Every day held</option><option value="full"${s.milestones === 'full' ? ' selected' : ''}>Only at a week held</option><option value="off"${s.milestones === 'off' ? ' selected' : ''}>Off</option></select></label>` : ''}
      </div>
      <div class="wsec">
        <div class="wsec-head"><i data-icon="zap"></i><h3>How</h3></div>
        ${toggle('desktop', 'Browser notifications', 'While the dashboard is open in a background tab. Danger notifications stay until dismissed.')}
        ${toggle('sound', 'Sounds', 'An alarm for danger, a chime for warnings, while the dashboard is open.')}
        ${s.desktop && perm === 'denied' ? `<div class="alert flat">${PT.icon('alert')}<span>This browser is blocking notifications from the tracker. Allow them in the site settings (the icon left of the address), or rely on the cards and sounds.</span></div>` : ''}
        ${s.desktop && perm === 'unsupported' ? `<div class="alert flat">${PT.icon('alert')}<span>This browser can't show notifications. Alerts still appear here with a sound.</span></div>` : ''}
        <p class="wsec-hint">Alerts are checked while your dashboard is open somewhere. With every tab closed, nothing is checked.</p>
        <div class="al-tests">
          <span>Hear them:</span>
          <button type="button" class="btn btn-sm" data-al-play="warn">${PT.icon('zap', 'sm')}Warning sound</button>
          <button type="button" class="btn btn-sm" data-al-play="danger">${PT.icon('alert', 'sm')}Danger sound</button>
          <button type="button" class="btn btn-sm" data-al-test="danger">${PT.icon('external', 'sm')}Send a test alert</button>
        </div>
        <div class="al-test-msg" data-al-msg></div>
      </div>
      <div class="wsec">
        <div class="wsec-head"><i data-icon="history"></i><h3>Recent alerts</h3></div>
        ${
          recent.length
            ? `<ul class="al-list">${recent
                .map((a) => `<li class="${a.level}"><span class="al-dot"></span><span class="al-l"><b>${esc(a.title)}</b><span>${esc(PT.ago(a.at))}</span></span></li>`)
                .join('')}</ul>`
            : '<p class="wsec-hint">No alerts yet.</p>'
        }
      </div>`;
  }

  function collect(root) {
    const out = {};
    $$('[data-al]', root).forEach((el) => (out[el.dataset.al] = el.checked));
    $$('[data-al-sel]', root).forEach((el) => (out[el.dataset.alSel] = el.value));
    $$('[data-al-pct]', root).forEach((el) => {
      const v = Number(el.value);
      if (Number.isFinite(v)) out[el.dataset.alPct] = v / 100;
    });
    return out;
  }

  function wire(root) {
    $$('[data-al-play]', root).forEach((b) => (b.onclick = () => play(b.dataset.alPlay)));
    const dt = $('[data-al="desktop"]', root);
    if (dt)
      dt.addEventListener('change', async () => {
        if (!dt.checked) return;
        const p = await askPermission();
        const msg = $('[data-al-msg]', root);
        if (msg && p === 'denied') msg.textContent = 'Notifications are blocked for this site in your browser settings.';
      });
    $$('[data-al-test]', root).forEach((b) => {
      b.onclick = async () => {
        const msg = $('[data-al-msg]', root);
        b.disabled = true;
        msg.textContent = 'Sending…';
        try {
          if ($('[data-al="desktop"]', root) && $('[data-al="desktop"]', root).checked) await askPermission();
          await PT.post('/api/alerts/test', { level: 'danger' });
          msg.textContent = 'Sent. It shows up here in a few seconds, with the alarm if sounds are on.';
          setTimeout(() => PT.refresh && PT.refresh(), 800);
        } catch (e) {
          msg.textContent = e.message;
        } finally {
          b.disabled = false;
        }
      };
    });
  }

  // Sound only works once the page has been clicked or typed in (browser rule).
  const canPlay = () => Boolean(ctx && ctx.state === 'running');

  PT.alerts = { update, play, canPlay, settingsPanel, collect, wire };
})();
