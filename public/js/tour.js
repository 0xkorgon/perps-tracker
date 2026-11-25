/* Product tour: a spotlight that walks through each part of the dashboard, with Back / Next /
   Skip, arrow keys and Esc. Steps whose page is switched off (or that aren't on screen) are
   skipped. Offered at the end of setup, once to existing users, and any time from the book button. */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc } = PT;
  const name = () => (PT.state && PT.state.config.profile && PT.state.config.profile.name) || '';

  // view: the page to open first; sel: what to light up; title/body: what to say.
  const STEPS = [
    { sel: '.dock', title: 'Your pages', body: 'Overview, Live, Strategy, Planner, Fees, Points, Leagues and Referrals. Switch off the ones you don’t use in Settings → Display.' },
    { sel: '#sync', title: 'Always in sync', body: 'While your dashboard is open, the tracker reads each exchange’s public data every couple of minutes. This shows the last sync; the arrow next to it syncs now.' },
    { view: 'overview', sel: '#view-overview .phead', title: 'Overview', body: 'Volume, open interest and hold time per exchange, your hedges grouped by asset, and how far each leg is from liquidation.' },
    { view: 'live', sel: '#view-live .phead', title: 'Live', body: 'Every open position ticking in real time, a hedge’s legs together, with PnL and funding right now.' },
    { view: 'points', sel: '#view-points .phead', title: 'Points', body: 'Bulk AURA and Arcus points, the next drops, what this week is on course for, and every previous week side by side.' },
    { view: 'strategy', sel: '#view-strategy .phead', title: 'Strategy', body: 'Pick one exchange or several. The checklist turns green as your trading matches the habits that earn points.' },
    { view: 'planner', sel: '#view-planner .phead', title: 'AURA Planner', body: 'Experimental: pick a Bulk market, a size, how you open and close and how long you hold, and see the AURA it should earn and what it costs.' },
    { view: 'referrals', sel: '#view-referrals .phead', title: 'Referrals & codes', body: 'Sign up on an exchange with the developer’s codes, and keep your own referral codes ready to share.' },
    { sel: '#pulse-fab', title: 'Pulse', body: 'A quick view from any page: your balance, open positions, this week’s habits and the next drop estimate.' },
    { sel: '#ticker', title: 'Status bar', body: 'Clocks, the US session, countdowns to the next drops, and a warning on every page when a leg nears liquidation.' },
    { sel: '#btn-x', title: 'Follow for updates', body: 'The tracker is made by @Korgonxx. Follow on X for updates, new features and what’s coming next.' },
    { sel: '#btn-wallets', title: 'Settings', body: 'Wallets, alerts, display, exports, and System: your private link for opening this dashboard on another device.' },
  ];

  let i = 0;
  let root = null;
  let active = false;
  let prevHash = '';

  const visible = (el) => {
    if (!el || el.hidden || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function build() {
    root = document.createElement('div');
    root.className = 'tour';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'tour-title');
    root.innerHTML = '<div class="tour-dim" data-d="t"></div><div class="tour-dim" data-d="b"></div><div class="tour-dim" data-d="l"></div><div class="tour-dim" data-d="r"></div><div class="tour-hole"></div><div class="tour-card" tabindex="-1"></div>';
    document.body.appendChild(root);
    root.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-tour]');
      if (b) act(b.dataset.tour);
    });
  }

  async function show(dir = 1) {
    // Find the next step that's on screen.
    while (i >= 0 && i < STEPS.length) {
      const s = STEPS[i];
      if (s.view) {
        if (!PT.display.pageOn(s.view)) {
          i += dir;
          continue;
        }
        if (location.hash !== `#${s.view}`) {
          location.hash = `#${s.view}`;
          await wait(450);
        }
      }
      const el = document.querySelector(s.sel);
      if (visible(el)) return place(s, el);
      i += dir;
    }
    finish();
  }

  function place(s, el) {
    el.scrollIntoView({ block: 'center', behavior: PT.reduceMotion() ? 'auto' : 'smooth' });
    setTimeout(() => position(s, el), PT.reduceMotion() ? 0 : 280);
    const n = STEPS.length;
    const last = i === n - 1;
    const hi = i === 0 && name() ? `Hi ${name()}! ` : '';
    const card = root.querySelector('.tour-card');
    card.innerHTML = `<p class="tour-step">${i + 1} of ${n}</p><h3 id="tour-title">${esc(s.title)}</h3><p>${esc(hi + s.body)}${last ? esc(name() ? ` You’re all set, ${name()}.` : ' You’re all set.') : ''}</p>
      <div class="tour-nav"><button type="button" class="btn btn-ghost btn-sm" data-tour="skip">${last ? 'Close' : 'Skip tour'}</button><span></span>${i > 0 ? '<button type="button" class="btn btn-sm" data-tour="back">Back</button>' : ''}<button type="button" class="btn btn-primary btn-sm" data-tour="next">${last ? 'Finish' : 'Next'}</button></div>`;
    card.focus({ preventScroll: true });
  }

  function position(s, el) {
    if (!root) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    const hole = root.querySelector('.tour-hole');
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    // Dim everything around the spotlight (four panels, so it works in every browser).
    const L = Math.max(0, r.left - pad);
    const T = Math.max(0, r.top - pad);
    const R = Math.min(window.innerWidth, r.right + pad);
    const B = Math.min(window.innerHeight, r.bottom + pad);
    const dim = (d, css) => Object.assign(root.querySelector(`.tour-dim[data-d="${d}"]`).style, css);
    dim('t', { left: '0', top: '0', width: '100%', height: `${T}px` });
    dim('b', { left: '0', top: `${B}px`, width: '100%', height: `${Math.max(0, window.innerHeight - B)}px` });
    dim('l', { left: '0', top: `${T}px`, width: `${L}px`, height: `${Math.max(0, B - T)}px` });
    dim('r', { left: `${R}px`, top: `${T}px`, width: `${Math.max(0, window.innerWidth - R)}px`, height: `${Math.max(0, B - T)}px` });
    const card = root.querySelector('.tour-card');
    const cw = Math.min(340, window.innerWidth - 24);
    card.style.width = `${cw}px`;
    const ch = card.offsetHeight || 180;
    const below = r.bottom + pad + 12;
    const top = below + ch < window.innerHeight - 8 ? below : Math.max(8, r.top - pad - 12 - ch);
    const left = Math.min(window.innerWidth - cw - 12, Math.max(12, r.left + r.width / 2 - cw / 2));
    Object.assign(card.style, { top: `${top}px`, left: `${left}px` });
  }

  function act(a) {
    if (a === 'next') {
      if (i === STEPS.length - 1) return finish();
      i += 1;
      show(1);
    } else if (a === 'back') {
      i = Math.max(0, i - 1);
      show(-1);
    } else finish();
  }

  function finish() {
    active = false;
    if (root) root.remove();
    root = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize);
    if (prevHash && prevHash !== location.hash) location.hash = prevHash;
    PT.post('/api/profile', { tourDone: true }).catch(() => {});
    if (PT.state) PT.state.config.tourDone = true;
  }

  function onKey(ev) {
    if (!active) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      finish();
    } else if (ev.key === 'ArrowRight') act('next');
    else if (ev.key === 'ArrowLeft') act('back');
  }
  function onResize() {
    const s = STEPS[i];
    const el = s && document.querySelector(s.sel);
    if (el) position(s, el);
  }

  function start() {
    if (active) return;
    active = true;
    PT.tour.started = true; // no 'take the tour' offer after this
    document.querySelectorAll('.tour-offer').forEach((el) => el.remove());
    prevHash = location.hash || '#overview';
    i = 0;
    build();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, { passive: true });
    show(1);
  }

  PT.tour = { start, active: () => active, started: false };
})();
