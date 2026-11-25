/* App shell: state polling, page routing, theme, status bar, settings dialog. */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, $$, esc, NAMES, ORDER } = PT;
  const ADDRESS = {
    bulk: { re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, placeholder: 'Solana address', bad: 'Bulk uses a Solana address (base58, no 0x).' },
    arcus: { re: /^0x[0-9a-fA-F]{40}$/, placeholder: '0x… address', bad: 'Arcus needs a 0x… address (42 characters).' },
    entropy: { re: /^0x[0-9a-fA-F]{40}$/, placeholder: '0x… address', bad: 'Entropy needs a 0x… address (your Hyperliquid account).' },
  };
  const VIEWS = ['overview', 'live', 'strategy', 'planner', 'fees', 'points', 'leagues', 'referrals'];
  const TITLES = { overview: 'Overview', live: 'Live', strategy: 'Strategy', planner: 'AURA Planner', fees: 'Fees', points: 'Points', leagues: 'Leagues', referrals: 'Referrals', admin: 'Admin' };
  // Pages you've switched off in Settings > Display are left out of the menu and skipped.
  const shown = () => VIEWS.filter((v) => PT.display.pageOn(v));
  const ALIASES = { playbook: 'strategy', tips: 'strategy' };

  PT.hydrateLogos();
  PT.access.boot(); // a private link (#k=…) in the address

  let offline = false;
  let pollTimer = null;
  PT.state = null;

  // ---------- shared state helpers ----------
  PT.hasWallets = (id) => Boolean(PT.state && (PT.state.config.wallets[id] || []).length);
  PT.activeExchanges = () => ORDER.filter(PT.hasWallets);
  PT.multiWallet = () => ORDER.some((id) => (PT.state.config.wallets[id] || []).length > 1);
  PT.walletStatuses = (id) =>
    (PT.state.config.wallets[id] || []).map((w) => ({ wallet: w, status: (PT.state.sync.wallets || {})[`${id}:${w.address}`] || { state: 'pending' } }));
  // Changes whenever trades or points data change; pages refetch their views when it does.
  PT.dataVersion = () => (PT.state ? `${PT.state.stats ? PT.state.stats.generatedAt : 0}|${PT.state.pointsSync ? PT.state.pointsSync.version : 0}` : '0');

  const currentView = () => {
    const h = location.hash.replace('#', '');
    if (h === 'admin') return 'admin';
    if (ALIASES[h]) {
      history.replaceState(null, '', `#${ALIASES[h]}`);
      return ALIASES[h];
    }
    const on = shown();
    return on.includes(h) ? h : on[0] || 'overview';
  };

  // ---------- polling ----------
  async function refresh() {
    const prevVersion = PT.dataVersion();
    clearTimeout(pollTimer);
    if (!PT.key()) {
      // No dashboard in this browser yet: the invite screen (or the admin page).
      PT.state = null;
      offline = false;
      renderShell();
      return;
    }
    try {
      PT.state = await PT.getJSON('/api/state');
      offline = false;
    } catch (e) {
      offline = e.status !== 401;
      if (e.status === 401) return renderShell();
    }
    renderShell();
    if (!offline && PT.state && PT.dataVersion() !== prevVersion) renderView(false);
    else if (!offline && currentView() === 'live' && PT.activeExchanges().length) PT.live.load(false); // fresh prices between syncs
    if (!offline && PT.pulse) PT.pulse.update();
    if (!offline && PT.alerts) PT.alerts.update(PT.state);
    clearTimeout(pollTimer);
    const busy = PT.state && (PT.state.sync.running || (PT.state.pointsSync && PT.state.pointsSync.running) || Object.values(PT.state.sync.wallets || {}).some((w) => w.state === 'syncing'));
    pollTimer = setTimeout(refresh, offline ? 5000 : busy ? 2000 : 10000);
  }

  function renderShell() {
    renderSync();
    renderTicker();
    const view = currentView();
    document.body.classList.toggle('no-key', !PT.key());
    document.body.classList.toggle('is-admin', view === 'admin');
    if (view === 'admin') {
      // The admin page works without a dashboard of your own.
      $('#join').hidden = true;
      $('#onboarding').hidden = true;
      $$('[data-view-panel]').forEach((p) => (p.hidden = p.dataset.viewPanel !== 'admin'));
      $$('.dock a').forEach((t) => t.removeAttribute('aria-current'));
      PT.display.tick(TITLES.admin, offline);
      return;
    }
    if (!PT.key()) {
      $('#onboarding').hidden = true;
      $$('[data-view-panel]').forEach((p) => (p.hidden = true));
      PT.access.showJoin();
      PT.display.tick('Invite', false);
      return;
    }
    $('#join').hidden = true;
    $$('.dock a').forEach((t) => {
      t.hidden = !PT.display.pageOn(t.dataset.view);
      if (t.dataset.view === view) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    $('.dock').style.setProperty('--dock-n', String(shown().length));
    if (location.hash && location.hash !== `#${view}` && !ALIASES[location.hash.slice(1)]) history.replaceState(null, '', `#${view}`);
    // The tab title and icon carry live numbers (Settings > Display), refreshed every second.
    PT.display.tick(TITLES[view], offline);
    if (!PT.state) return;
    // A greeting with your name from the setup.
    const who = PT.state.config.profile && PT.state.config.profile.name;
    const hello = $('#hello');
    if (hello) {
      const h = new Date().getHours();
      hello.hidden = !who;
      if (who) hello.textContent = `${h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, ${who}`;
    }
    const any = PT.activeExchanges().length > 0;
    // No wallets yet: the setup (or a short prompt). The Referrals page works without wallets, so
    // new users can sign up from it. The setup stays up until you leave its last step.
    const setup = PT.onboarding && PT.onboarding.active;
    const onboard = (!any && view !== 'referrals') || setup;
    $('#onboarding').hidden = !onboard;
    if (onboard && PT.onboarding) PT.onboarding.show();
    $$('[data-view-panel]').forEach((p) => (p.hidden = onboard || (!any && p.dataset.viewPanel !== 'referrals') || p.dataset.viewPanel !== view));
    maybeOfferTour(any, setup);
    maybeWhatsNew(any, setup);
    maybeOfferFollow(any, setup);
    if (any && !setup) PT.access.maybeNudgeLink();
  }
  PT.rerender = () => renderShell();

  // Once, a few minutes into using the tracker (after the tour, if it's showing): follow the
  // developer on X. Closing it, or following, means it doesn't come back.
  let followTimer = null;
  function maybeOfferFollow(any, setup) {
    if (followTimer || setup || !any || !PT.state || !PT.state.developer || PT.prefs.get('x.offered')) return;
    followTimer = setTimeout(function tryShow() {
      if (popupBusy()) {
        followTimer = setTimeout(tryShow, 60 * 1000);
        return;
      }
      const dev = PT.state.developer;
      PT.prefs.set('x.offered', true);
      const el = document.createElement('div');
      el.className = 'tour-offer follow-offer';
      el.innerHTML = `<span class="x-mark" aria-hidden="true">𝕏</span><span><b>Enjoying the tracker?</b> Follow ${esc(dev.handle)} on X for updates, new features and what's coming next.</span><a class="btn btn-primary btn-sm" href="${esc(dev.x)}" target="_blank" rel="noopener noreferrer" data-follow>Follow on X</a><button type="button" class="icon-btn" data-follow-close aria-label="Not now">${PT.icon('x')}</button>`;
      document.body.appendChild(el);
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-follow], [data-follow-close]')) el.remove();
      });
    }, PT.state.config.onboardedAt && Date.now() - PT.state.config.onboardedAt < 10 * 60 * 1000 ? 4 * 60 * 1000 : 90 * 1000);
  }

  // Pop-ups wait their turn: one at a time, never over the tour or a dialog.
  const OTHER_POPUPS = '.tour-offer, .import-offer, .link-offer, dialog[open]';
  const popupBusy = () => Boolean((PT.tour && PT.tour.active()) || document.querySelector(OTHER_POPUPS) || document.querySelector('.whatsnew'));

  // ---------- what's new ----------
  // One card for everyone who was already using the tracker, the first time they open it after a
  // release (once per browser), listing what's new since they last saw a card. New dashboards skip
  // it: the tour covers everything. New tabs wear a dot until they're opened.
  const RELEASES = [
    {
      id: '3.6',
      at: Date.UTC(2026, 10, 25, 12, 30), // when 3.6.0 went live
      lede: 'Your referrals now find themselves: no wallets to paste.',
      cta: ['referrals', 'gift', 'Open Referrals'],
      items: [
        { view: 'referrals', icon: 'sparkles', title: 'Referrals, automatic', body: 'Click your “Send AURA to tracker” bookmark on Bulk’s Referrals page while logged in: the wallets you referred are added for you. Drag the bookmark from Points again once first.' },
        { view: 'referrals', icon: 'wallet', title: 'Your own wallets count', body: 'Any of your tracked Bulk wallets that one of your codes referred is counted in your referral volume automatically.' },
      ],
    },
    {
      id: '3.5',
      at: Date.UTC(2026, 10, 25, 11, 30), // when 3.5.0 went live
      lede: 'Referral AURA is here: your referrals’ live volume and the AURA it earns you.',
      cta: ['referrals', 'gift', 'Open Referrals'],
      items: [
        { view: 'referrals', icon: 'gift', title: 'Referral AURA, live', body: 'Watch your referrals’ Bulk wallets: their volume this week, read live, and the referral AURA it earns you (1 for every 4 Trading AURA they earn).' },
        { view: 'referrals', icon: 'check', title: 'Count it in your estimates', body: 'One switch adds referral AURA and volume to your Bulk estimate on Points and the drop card. Leagues stay trading-only, as Bulk counts them.' },
        { view: 'referrals', icon: 'chart', title: 'Checked against Bulk', body: 'Each revealed week shows Bulk’s referral volume and AURA next to the estimate, and corrects it.' },
      ],
    },
    {
      id: '3.4',
      at: Date.UTC(2026, 10, 20, 1, 30), // when 3.4.0 went live
      lede: 'Weekly gauntlets are in, and their estimates check themselves against Bulk.',
      cta: ['leagues', 'trophy', 'Open Leagues'],
      items: [
        { view: 'leagues', icon: 'trophy', title: 'Weekly gauntlet', body: 'This week’s 50,000 AURA gauntlet and your share of it, on Leagues, Points and in the Planner. The Leagues pool and your share work again too.' },
        { view: 'leagues', icon: 'check', title: 'Checked against Bulk', body: 'After each reveal the tracker compares its gauntlet estimate with the AURA Bulk paid, and scales later estimates to match.' },
        { view: 'planner', icon: 'calculator', title: 'Price at close', body: 'Set how far the price moves before you close: the closing volume, its fee and its AURA follow.' },
      ],
    },
    {
      id: '3.2',
      at: Date.UTC(2026, 10, 18, 9, 0), // when 3.2.0 went live
      lede: 'The AURA Planner is here, and Leagues now follow Bulk’s rules.',
      cta: ['planner', 'calculator', 'Open the Planner'],
      items: [
        { view: 'planner', icon: 'calculator', title: 'AURA Planner', tag: 'Experimental', body: 'Pick a Bulk market, size, how you open and close and how long you hold: the AURA it should earn and the fees.' },
        { view: 'leagues', icon: 'trophy', title: 'Leagues, fixed', body: 'Shares split pro-rata by trading AURA as Bulk pays them, the season week, and Bulk’s $5 minimum claim.' },
        { view: 'fees', icon: 'coins', title: 'Stock markets on Bulk', body: 'TSLA, QQQ, US500 and other stocks and indices are counted at their lower 1.5 bps fee.' },
      ],
    },
    {
      id: '3.1',
      at: Date.UTC(2026, 10, 18, 1, 50), // when 3.1.0 went live
      lede: 'Perps Tracker now shows everything it works out.',
      cta: ['strategy', 'strategy', 'Open Strategy'],
      items: [
        { view: 'strategy', icon: 'strategy', title: 'Strategy page', body: 'A top Arcus trader’s points routine and Bulk’s AURA habits, checked against your trades.' },
        { view: 'points', icon: 'sigma', title: 'The math behind every estimate', body: 'Your AURA rates, your Arcus rate and how close each estimate has been.' },
        { view: 'live', icon: 'hourglass', title: 'Bulk hold multiplier', body: 'Each position’s multiplier and the AURA it earns if you close now.' },
        { view: 'referrals', icon: 'gift', title: 'Your own codes', body: 'Keep your referral links ready to share, with your Bulk referral stats.' },
      ],
    },
  ];
  const releaseAt = (id) => (RELEASES.find((r) => r.id === id) || {}).at || 0;
  const NEW_TABS = { strategy: releaseAt('3.1'), planner: releaseAt('3.2'), referrals: releaseAt('3.5') };
  // Using the tracker before `at` (set up before that release went live).
  const wasHere = (at) => Boolean(PT.state && PT.state.config && (!PT.state.config.onboardedAt || PT.state.config.onboardedAt < at));
  const unseen = () => RELEASES.filter((r) => wasHere(r.at) && !PT.prefs.get(`whatsnew.${r.id}`));
  function markNewTabs() {
    for (const [view, at] of Object.entries(NEW_TABS)) {
      const tab = document.querySelector(`.dock a[data-view="${view}"]`);
      if (tab) tab.classList.toggle('is-new', wasHere(at) && !PT.prefs.get(`seen.${view}`));
    }
  }
  let wnTimer = null;
  function maybeWhatsNew(any, setup) {
    markNewTabs();
    if (wnTimer || setup || !any || !unseen().length) return;
    wnTimer = setTimeout(function tryShow() {
      const list = unseen();
      if (!list.length) return;
      if (currentView() === 'admin' || popupBusy() || (PT.onboarding && PT.onboarding.active)) {
        wnTimer = setTimeout(tryShow, 10 * 1000);
        return;
      }
      for (const r of list) PT.prefs.set(`whatsnew.${r.id}`, String(Date.now()));
      const items = list.flatMap((r) => r.items).slice(0, 6);
      const [ctaView, ctaIcon, ctaText] = list[0].cta;
      const el = document.createElement('div');
      el.className = 'whatsnew';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-labelledby', 'wn-title');
      el.innerHTML = `
        <div class="wn-top"><span class="wn-new">New</span><span class="wn-kicker">${PT.icon('sparkles', 'sm')}Version ${esc((PT.state && PT.state.version) || list[0].id)}</span><button type="button" class="icon-btn" data-wn="close" aria-label="Close">${PT.icon('x')}</button></div>
        <h2 id="wn-title">New features are live</h2>
        <p>${esc(list[0].lede)}${list.length > 1 ? ' Here’s everything since your last visit:' : ' Here’s what’s new:'}</p>
        <ul class="wn-list">${items
          .map((it) => `<li><a href="#${esc(it.view)}" data-wn="go"><span class="wn-ic">${PT.icon(it.icon)}</span><span><b>${esc(it.title)}${it.tag ? ` <i class="chip exp">${esc(it.tag)}</i>` : ''}</b><span>${esc(it.body)}</span></span>${PT.icon('chevron', 'sm wn-go')}</a></li>`)
          .join('')}</ul>
        <div class="wn-actions"><a class="btn btn-primary btn-sm" href="#${ctaView}" data-wn="go">${PT.icon(ctaIcon, 'sm')}${esc(ctaText)}</a><button type="button" class="btn btn-sm" data-wn="close">Got it</button></div>`;
      document.body.appendChild(el);
      const close = () => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 220);
      };
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-wn]')) close();
      });
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') close();
      });
    }, 2500);
  }

  // Existing users (wallets already set up) get the tour offered once.
  let tourOffered = false;
  function maybeOfferTour(any, setup) {
    if (tourOffered || setup || !any || !PT.state || PT.state.config.tourDone || !PT.tour || PT.tour.active() || PT.tour.started) return;
    tourOffered = true;
    if (PT.prefs.get('tour.offered')) return;
    PT.prefs.set('tour.offered', true);
    const el = document.createElement('div');
    el.className = 'tour-offer';
    el.innerHTML = `${PT.icon('book')}<span><b>New here, or new to this version?</b> A 1-minute tour shows what’s where, including the new Referrals page.</span><button type="button" class="btn btn-primary btn-sm" data-offer="go">Take the tour</button><button type="button" class="icon-btn" data-offer="no" aria-label="No thanks">${PT.icon('x')}</button>`;
    document.body.appendChild(el);
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-offer]');
      if (!b) return;
      el.remove();
      if (b.dataset.offer === 'go') PT.tour.start();
      else PT.post('/api/profile', { tourDone: true }).catch(() => {});
    });
  }

  // entered: the page was just opened, so it plays its entrance animation.
  function renderView(force, entered = false) {
    const view = currentView();
    if (view === 'admin') return PT.access.loadAdmin();
    if (!PT.state) return;
    if (view === 'referrals') {
      if (!PT.prefs.get('seen.referrals')) {
        PT.prefs.set('seen.referrals', String(Date.now()));
        markNewTabs();
      }
      return PT.referrals.load(force);
    }
    if (!PT.activeExchanges().length) return;
    if (view === 'overview') PT.overview.render(PT.state);
    else if (view === 'live') PT.live.load(force);
    else if (view === 'strategy') {
      if (!PT.prefs.get('seen.strategy')) {
        PT.prefs.set('seen.strategy', String(Date.now()));
        markNewTabs();
      }
      PT.strategy.load(force, entered);
    } else if (view === 'planner') {
      if (!PT.prefs.get('seen.planner')) {
        PT.prefs.set('seen.planner', String(Date.now()));
        markNewTabs();
      }
      PT.planner.load(force);
    }
    else if (view === 'fees') PT.fees.load(force);
    else if (view === 'points') PT.points.load(force, entered);
    else if (view === 'leagues') PT.leagues.load(force);
  }
  // A page switched on or off in Settings: update the menu, and leave a page that was switched off.
  PT.display.on((p, k) => {
    if (k !== 'pages') return;
    renderShell();
    renderView(false, true);
  });
  PT.refresh = refresh; // Pulse's floating window keeps this going while the tab is in the background
  // Poll again soon (after saving settings, say).
  PT.kick = (ms = 800) => {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(refresh, ms);
  };

  function renderSync() {
    const el = $('#sync');
    el.className = 'sync';
    if (offline) {
      el.classList.add('off');
      el.innerHTML = '<span class="dot"></span><span class="txt">Can’t reach the tracker’s server. Retrying…</span>';
      return;
    }
    if (!PT.state) {
      el.innerHTML = '<span class="spinner"></span><span class="txt">Loading…</span>';
      return;
    }
    const all = ORDER.flatMap((id) => PT.walletStatuses(id).map((x) => ({ id, ...x })));
    const syncing = all.find((x) => x.status.state === 'syncing');
    const errors = all.filter((x) => x.status.state === 'error').length;
    if (PT.state.sync.running || syncing) {
      const what = syncing ? `${NAMES[syncing.id]}${syncing.status.progress ? `: ${syncing.status.progress}` : ''}` : '';
      el.innerHTML = `<span class="spinner"></span><span class="txt" title="${esc(what)}">Syncing${what ? ` ${esc(what)}` : '…'}</span>`;
    } else if (errors) {
      el.classList.add('warn');
      el.innerHTML = `${PT.icon('alert', 'sm')}<span class="txt">${errors} wallet${errors > 1 ? 's need' : ' needs'} attention</span>`;
    } else if (all.length) {
      el.classList.add('ok');
      el.innerHTML = `<span class="dot"></span><span class="txt">Synced ${esc(PT.ago(PT.state.sync.lastEnd))}</span>`;
    } else el.innerHTML = '<span class="txt">No wallets yet</span>';
  }

  // Bottom status bar: clocks, US session, points-week countdown, exchange health.
  function renderTicker() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const offMin = -now.getTimezoneOffset();
    const gmt = `GMT${offMin >= 0 ? '+' : '−'}${Math.floor(Math.abs(offMin) / 60)}${Math.abs(offMin) % 60 ? `:${pad(Math.abs(offMin) % 60)}` : ''}`;
    const open = usSessionOpen(now.getTime());
    // Next points drops (Bulk AURA reveal, Arcus points drop), soonest first.
    const unit = { bulk: 'AURA', arcus: 'points' };
    const drops = ((PT.state && PT.state.drops) || [])
      .filter((d) => d.at > now.getTime())
      .slice(0, 2)
      .map((d) => `<a class="tk-drop" href="#points" title="${esc(`${d.title}: ${PT.localWhen(d.at)}`)}">${PT.exm(d.id, 'sm')}${esc(unit[d.id] || 'points')} in <b>${esc(PT.countdown(d.at - now.getTime()))}</b></a>`)
      .join('');
    const health = PT.state
      ? PT.activeExchanges()
          .map((id) => {
            const ws = PT.walletStatuses(id);
            const bad = ws.some((x) => x.status.state === 'error');
            const busy = ws.some((x) => x.status.state === 'syncing');
            return `<span title="${esc(`${NAMES[id]}: ${bad ? 'needs attention' : busy ? 'syncing' : 'ok'}`)}">${PT.exm(id, 'sm')}${esc(NAMES[id])}${bad ? PT.icon('alert', 'sm') : ''}</span>`;
          })
          .join('')
      : '';
    // Warn here, on every page, when a leg is getting close to liquidation.
    let liqAlert = '';
    const hedges = PT.state && PT.state.stats && PT.state.stats.hedges;
    if (hedges) {
      const near = hedges.filter((g) => g.nearest).map((g) => g.nearest).sort((a, b) => a.dist - b.dist)[0];
      if (near && near.dist < 0.15) liqAlert = `<span class="alert-liq${near.dist < 0.05 ? ' danger' : ''}">${PT.icon('alert')}${esc(NAMES[near.exchange])} ${esc(near.mkt)} is <b>${(near.dist * 100).toFixed(1)}%</b> from liquidation</span>`;
    }
    $('#ticker').innerHTML = `<span>${PT.icon('clock')}<b>${local}</b>${gmt}</span><span>New York <b>${esc(PT.nyClock(now.getTime()))}</b><span class="${open ? 'open' : 'closed'}">${open ? 'US session open' : 'US session closed'}</span></span>${drops ? `<span class="tk-drops">${PT.icon('star')}${drops}</span>` : ''}${liqAlert}<span class="health">${health}</span>`;
  }

  // Mirror of the server's US-session rule (4am–8pm New York, weekdays, NYSE holidays off).
  const HOLIDAYS = new Set(['2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
  const nyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  function nyParts(ts) {
    const p = Object.fromEntries(nyFmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
  }
  function usSessionOpen(ts) {
    const p = nyParts(ts);
    if (p.weekday === 'Sat' || p.weekday === 'Sun' || HOLIDAYS.has(p.date)) return false;
    return p.minutes >= 240 && p.minutes < 1200;
  }
  PT.usSessionOpen = usSessionOpen;

  // ---------- theme ----------
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    PT.prefs.set('theme', t);
    // Charts read CSS variables at draw time; redraw so they pick up the new tokens.
    redrawCharts();
  }
  function redrawCharts() {
    if (!PT.state || !PT.state.stats) return;
    const view = currentView();
    if (view === 'overview') PT.overview.redrawChart(PT.state);
    if (view === 'strategy') PT.strategy.redraw();
    if (view === 'fees') PT.fees.redraw();
    if (view === 'points') PT.points.redraw();
  }
  $('#btn-theme').addEventListener('click', () => setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'));

  // ---------- settings dialog (wallets, points, data) ----------
  const dialog = $('#wallets-dialog');
  const SET_TABS = ['wallets', 'points', 'alerts', 'display', 'data'];
  function showSettingsTab(tab) {
    const t = SET_TABS.includes(tab) ? tab : 'wallets';
    PT.seg($('#set-tabs'), t, showSettingsTab);
    $$('#set-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === t)));
    $$('[data-set-panel]', dialog).forEach((p) => (p.hidden = p.dataset.setPanel !== t));
    PT.prefs.set('settings.tab', t);
  }
  const walletRow = (id, w = {}) => `<div class="wrow">
      <input class="lbl" type="text" placeholder="Label (optional)" maxlength="40" value="${esc(w.label || '')}" aria-label="${esc(NAMES[id])} wallet label">
      <input class="addr" type="text" placeholder="${esc(ADDRESS[id].placeholder)}" value="${esc(w.address || '')}" spellcheck="false" autocomplete="off" aria-label="${esc(NAMES[id])} wallet address">
      <button type="button" class="icon-btn rmw" title="Remove" aria-label="Remove this wallet">${PT.icon('trash')}</button>
      <div class="wrow-err"></div>
    </div>`;

  function openSettings(tab) {
    if (!PT.state) return;
    $('#wallets-body').innerHTML = ORDER.map((id) => {
      const meta = (PT.state.exchanges || []).find((x) => x.id === id) || {};
      const ws = PT.state.config.wallets[id] || [];
      const su = (PT.state.signup || []).find((x) => x.id === id && x.ready && x.link);
      return `<section class="wsec" data-ex="${id}">
        <div class="wsec-head">${PT.exm(id)}<h3>${esc(NAMES[id])}</h3>${su && !ws.length ? `<a class="wsec-signup" href="${esc(su.link)}" target="_blank" rel="noopener noreferrer">${PT.icon('gift', 'sm')}No account? Sign up${su.code ? ` with ${esc(su.code)}` : ''}</a>` : ''}</div>
        <p class="wsec-hint">${esc(meta.addressHint || '')}</p>
        <div class="wrows">${(ws.length ? ws : [{}]).map((w) => walletRow(id, w)).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm" data-add="${id}">${PT.icon('plus', 'sm')}Add another ${esc(NAMES[id])} wallet</button>
      </section>`;
    }).join('');
    const sel = $('#refresh-seconds');
    const rs = String(PT.state.config.refreshSeconds || 60);
    if (![...sel.options].some((o) => o.value === rs)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(rs)}">${esc(rs)} seconds</option>`);
    sel.value = rs;
    $('#arcus-name').value = PT.state.config.arcusPointsName || '';
    const ab = $('#alerts-body');
    ab.innerHTML = PT.alerts.settingsPanel(PT.state);
    PT.hydrateIcons(ab);
    PT.alerts.wire(ab);
    const db = $('#display-body');
    db.innerHTML = PT.display.settingsPanel();
    PT.hydrateIcons(db);
    PT.display.wire(db);
    PT.system.load($('#system-body'));
    $('#wallets-error').textContent = '';
    showSettingsTab(tab || 'wallets');
    dialog.showModal();
    const first = tab === 'points' ? $('#arcus-name') : tab === 'data' ? null : dialog.querySelector('input.addr');
    if (first) first.focus();
  }

  function collectWallets() {
    const wallets = {};
    let ok = true;
    for (const sec of $$('.wsec[data-ex]', dialog)) {
      const id = sec.dataset.ex;
      wallets[id] = [];
      for (const row of $$('.wrow', sec)) {
        const addrEl = $('.addr', row);
        const address = addrEl.value.trim();
        const label = $('.lbl', row).value.trim();
        const err = $('.wrow-err', row);
        err.textContent = '';
        addrEl.classList.remove('bad');
        if (!address) continue;
        if (!ADDRESS[id].re.test(address)) {
          ok = false;
          addrEl.classList.add('bad');
          err.textContent = ADDRESS[id].bad;
          continue;
        }
        wallets[id].push({ address, label });
      }
    }
    return ok ? wallets : null;
  }

  dialog.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t.closest('[data-close]')) return dialog.close();
    const add = t.closest('[data-add]');
    if (add) {
      const sec = add.closest('.wsec');
      $('.wrows', sec).insertAdjacentHTML('beforeend', walletRow(sec.dataset.ex));
      const inputs = $$('input.addr', sec);
      inputs[inputs.length - 1].focus();
      return;
    }
    const rm = t.closest('.rmw');
    if (rm) {
      const row = rm.closest('.wrow');
      if (row.parentElement.querySelectorAll('.wrow').length > 1) row.remove();
      else $$('input', row).forEach((i) => (i.value = ''));
    }
  });

  $('#wallets-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const wallets = collectWallets();
    if (!wallets) {
      showSettingsTab('wallets');
      $('#wallets-error').textContent = 'Fix the highlighted addresses first.';
      return;
    }
    const btn = $('#btn-save');
    btn.disabled = true;
    try {
      PT.state = await PT.post('/api/config', { wallets, refreshSeconds: Number($('#refresh-seconds').value), arcusPointsName: $('#arcus-name').value.trim(), alerts: PT.alerts.collect($('#alerts-body')) });
      dialog.close();
      renderShell();
      renderView(true);
      PT.kick(1200);
    } catch (e) {
      $('#wallets-error').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- events ----------
  document.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-open-wallets]')) openSettings('wallets');
    const st = ev.target.closest('[data-open-settings]');
    if (st) openSettings(st.dataset.openSettings);
  });
  $('#btn-wallets').addEventListener('click', () => openSettings(PT.prefs.get('settings.tab'))); // reopens the last tab
  $('#btn-tour').addEventListener('click', () => {
    if (!PT.activeExchanges().length && !(PT.state && PT.state.config.onboardedAt)) return PT.onboarding.restart();
    PT.tour.start();
  });
  $('#btn-refresh').addEventListener('click', async () => {
    const btn = $('#btn-refresh');
    btn.disabled = true;
    try {
      PT.state = await PT.post('/api/sync');
      renderShell();
    } catch {}
    setTimeout(() => (btn.disabled = false), 1500);
    PT.kick(800);
  });
  window.addEventListener('hashchange', () => {
    if (/^#k=/.test(location.hash)) {
      PT.access.boot();
      return refresh().then(() => renderView(true, true));
    }
    renderShell();
    renderView(false, true);
    window.scrollTo(0, 0);
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawCharts, 150);
  });
  setInterval(() => {
    renderSync();
    renderTicker();
    PT.display.tick(TITLES[currentView()], offline);
    PT.tickHeld();
  }, 1000);
  // Back to the tab: catch up.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && PT.key()) refresh();
  });
  // Exports: fetched with your dashboard key, then saved by the browser.
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-export]');
    if (!b) return;
    b.disabled = true;
    try {
      await PT.download(`/api/export/${b.dataset.export}`);
    } catch (e) {
      $('#wallets-error').textContent = `Couldn't download: ${e.message}`;
    } finally {
      b.disabled = false;
    }
  });

  // AURA sent from app.bulk.trade by the "Send AURA to tracker" bookmark (Points page). Asks first:
  // any website could open this address, so nothing is imported without your click.
  function bulkImportFromHash() {
    const m = /^#bulk-import=(.+)$/.exec(location.hash);
    if (!m) return;
    let text = '';
    try {
      text = decodeURIComponent(m[1]);
    } catch {
      text = '';
    }
    history.replaceState(null, '', '#points');
    let objs = [];
    try {
      objs = JSON.parse(text);
    } catch {
      objs = [];
    }
    if (!Array.isArray(objs) || !objs.length) return;
    const wallet = objs.find((o) => o && o.categories);
    const weeks = objs.filter((o) => o && o.week_index != null).map((o) => o.week_index);
    const el = document.createElement('div');
    el.className = 'import-offer';
    el.innerHTML = `${PT.icon('star')}<span><b>Import your AURA from Bulk?</b> ${esc(wallet ? `${Number(wallet.aura).toLocaleString('en-US')} AURA in total` : 'Weekly results')}${weeks.length ? `, weeks ${esc(Math.min(...weeks))}–${esc(Math.max(...weeks))}` : ''}.</span><button type="button" class="btn btn-primary btn-sm" data-imp="yes">Import</button><button type="button" class="icon-btn" data-imp="no" aria-label="Don't import">${PT.icon('x')}</button>`;
    document.body.appendChild(el);
    el.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-imp]');
      if (!b) return;
      if (b.dataset.imp === 'no') return el.remove();
      b.disabled = true;
      try {
        const r = await PT.post('/api/points/bulk-import', { text });
        const rf = r.referees;
        const refText = rf ? ` Referrals: ${rf.found} wallet${rf.found === 1 ? '' : 's'} found on Bulk${rf.added ? `, ${rf.added} new now watched` : ''}${rf.skipped ? ` (${rf.skipped} over the limit of 25)` : ''}.` : '';
        const saved = `${r.wallet ? 'Your AURA' : ''}${r.wallet && r.weeks && r.weeks.length ? ' and ' : ''}${r.weeks && r.weeks.length ? `weeks ${r.weeks.join(', ')}` : ''}`;
        el.innerHTML = `${PT.icon('check')}<span><b>Imported.</b> ${esc(`${saved ? `${saved} saved.` : ''}${refText}`)} You can close this tab.</span><button type="button" class="icon-btn" data-imp="no" aria-label="Close">${PT.icon('x')}</button>`;
        if (PT.referrals && rf) PT.referrals.load(true);
        PT.kick(300);
        if (PT.points) PT.points.load(true);
      } catch (e) {
        el.innerHTML = `${PT.icon('alert')}<span>${esc(e.message)}</span><button type="button" class="icon-btn" data-imp="no" aria-label="Close">${PT.icon('x')}</button>`;
      }
    });
  }

  (async () => {
    bulkImportFromHash();
    await refresh();
    renderView(true, true);
  })();
})();
