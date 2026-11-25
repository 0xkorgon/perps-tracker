/* First-run setup: a few questions that shape the dashboard around you (your name, the exchanges
   you use, what you want from it), your wallets, and sign-up links with the developer's referral
   codes for any exchange you don't have an account on yet. Ends with an offer of the tour. */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, $$, esc, NAMES, ORDER } = PT;

  const ADDRESS = {
    bulk: { re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, placeholder: 'Solana address', hint: 'The Solana wallet you connected at app.bulk.trade.', bad: 'Bulk uses a Solana address (base58, no 0x).' },
    arcus: { re: /^0x[0-9a-fA-F]{40}$/, placeholder: '0x… address', hint: 'Copy the 0x address shown inside the Arcus app (not your MetaMask one).', bad: 'Arcus needs a 0x… address (42 characters).' },
    entropy: { re: /^0x[0-9a-fA-F]{40}$/, placeholder: '0x… address', hint: 'The 0x wallet you log in to entropy.io with.', bad: 'Entropy needs a 0x… address.' },
  };
  const ABOUT = { bulk: 'Solana perps, weekly AURA', arcus: 'Stock & crypto perps, weekly points', entropy: 'Hyperliquid front end, own markets' };
  const GOALS = [
    { id: 'aura', icon: 'star', title: 'Farm Bulk AURA', sub: 'Weekly AURA estimate, leagues, previous weeks' },
    { id: 'arcus', icon: 'sparkles', title: 'Farm Arcus points', sub: 'The points routine checklist and drops' },
    { id: 'hedge', icon: 'scale', title: 'Hedge across exchanges', sub: 'Hedges grouped by asset, funding, broken-hedge alerts' },
    { id: 'alerts', icon: 'alert', title: 'Liquidation alerts', sub: 'Alerts before a leg gets close' },
    { id: 'fees', icon: 'receipt', title: 'Track volume & fees', sub: 'Fees, tiers and maker/taker split' },
  ];
  const STEPS = ['welcome', 'exchanges', 'goals', 'wallets', 'ready'];

  const st = { step: 0, name: '', exchanges: [], noAccount: [], goals: [], wallets: { bulk: '', arcus: '', entropy: '' }, arcusName: '', error: '' };

  const signup = (id) => ((PT.state && PT.state.signup) || []).find((s) => s.id === id && s.ready) || null;
  const dots = () => `<ol class="ob-dots" aria-label="Step ${st.step + 1} of ${STEPS.length}">${STEPS.map((_, i) => `<li class="${i < st.step ? 'done' : i === st.step ? 'now' : ''}"></li>`).join('')}</ol>`;
  const nav = (next = 'Continue', { back = true, disabled = false } = {}) =>
    `<div class="ob-nav">${back && st.step > 0 ? '<button type="button" class="btn btn-ghost" data-ob="back">Back</button>' : '<span></span>'}<button type="button" class="btn btn-primary" data-ob="next"${disabled ? ' disabled' : ''}>${esc(next)}</button></div>`;

  function signupBox(id) {
    const s = signup(id);
    if (!s) return `<p class="ob-note">${PT.icon('info', 'sm')}Create an account on ${esc(NAMES[id])} first, then add its wallet in Settings.</p>`;
    return `<div class="ob-signup">${PT.icon('gift', 'sm')}<span>No account yet? Sign up${s.code ? ` with code <b>${esc(s.code)}</b>` : ''}${s.accessCode ? ` (access code <b>${esc(s.accessCode)}</b>)` : ''}${s.perk ? `: ${esc(s.perk)}` : ''}. It supports the tracker.</span>${s.link ? `<a class="btn btn-sm btn-primary" href="${esc(s.link)}" target="_blank" rel="noopener noreferrer">Sign up on ${esc(NAMES[id])}${PT.icon('external', 'sm')}</a>` : ''}</div>`;
  }

  function body() {
    const step = STEPS[st.step];
    if (step === 'welcome') {
      return `<p class="ob-kicker">Welcome</p>
        <h1>Every perp you trade, in one place.</h1>
        <p class="ob-lede">Volume, open interest, hedges, fees and points across Bulk, Arcus and Entropy. The tracker reads each exchange's public data with your public wallet address. No keys, no signing, nothing it can move.</p>
        <label class="ob-field"><span>What should we call you?</span><input type="text" id="ob-name" maxlength="30" placeholder="Your name or handle" value="${esc(st.name)}" autocomplete="nickname"></label>
        ${nav('Get started', { back: false })}`;
    }
    if (step === 'exchanges') {
      const cards = ORDER.map((id) => {
        const on = st.exchanges.includes(id);
        const none = st.noAccount.includes(id);
        return `<div class="ob-ex${on ? ' on' : ''}${none ? ' none' : ''}">
          <button type="button" class="ob-ex-pick" data-ex="${id}" aria-pressed="${on}">${PT.exm(id, 'lg')}<span><b>${esc(NAMES[id])}</b><span>${esc(ABOUT[id])}</span></span><span class="ob-check">${PT.icon('check', 'sm')}</span></button>
          <label class="ob-none"><input type="checkbox" data-none="${id}"${none ? ' checked' : ''}> I don't have an account yet</label>
          ${none ? signupBox(id) : ''}
        </div>`;
      }).join('');
      return `<p class="ob-kicker">${esc(st.name ? `Hi ${st.name}` : 'Your exchanges')}</p>
        <h2>Where do you trade?</h2>
        <p class="ob-lede">Pick every exchange you use. New to one? Tick “no account yet” for a sign-up link.</p>
        <div class="ob-exs">${cards}</div>
        ${nav('Continue', { disabled: !st.exchanges.length && !st.noAccount.length })}`;
    }
    if (step === 'goals') {
      return `<p class="ob-kicker">Make it yours</p>
        <h2>What do you want from the tracker?</h2>
        <p class="ob-lede">Pick any. The pages and alerts you get follow from this, and you can change everything later in Settings.</p>
        <div class="ob-goals">${GOALS.map((g) => `<button type="button" class="ob-goal" data-goal="${g.id}" aria-pressed="${st.goals.includes(g.id)}">${PT.icon(g.icon)}<span><b>${esc(g.title)}</b><span>${esc(g.sub)}</span></span><span class="ob-check">${PT.icon('check', 'sm')}</span></button>`).join('')}</div>
        ${nav('Continue')}`;
    }
    if (step === 'wallets') {
      const ids = ORDER.filter((id) => st.exchanges.includes(id));
      const rows = ids.length
        ? ids.map((id) => `<label class="ob-field ob-wallet">${PT.exm(id)}<span><b>${esc(NAMES[id])}</b><span>${esc(ADDRESS[id].hint)}</span></span><input type="text" data-wallet="${id}" placeholder="${esc(ADDRESS[id].placeholder)}" value="${esc(st.wallets[id])}" spellcheck="false" autocomplete="off"></label>`).join('')
        : `<p class="ob-note">${PT.icon('info', 'sm')}No exchange picked yet. You can add wallets any time in Settings.</p>`;
      const arcus = st.exchanges.includes('arcus') ? `<label class="ob-field"><span>Your Arcus points name <span class="muted">(optional)</span></span><input type="text" id="ob-arcus" maxlength="60" placeholder="Like Rustic Owl, from Arcus's points page" value="${esc(st.arcusName)}" spellcheck="false"></label>` : '';
      return `<p class="ob-kicker">Your wallets</p>
        <h2>Paste your public addresses</h2>
        <p class="ob-lede">Only public addresses: the tracker never asks for keys or signatures.</p>
        <div class="ob-wallets">${rows}${arcus}</div>
        <div class="ob-error" role="alert">${esc(st.error)}</div>
        ${nav(ids.length ? 'Save wallets' : 'Skip for now')}`;
    }
    // ready
    const pages = pagesFor();
    const names = { overview: 'Overview', live: 'Live', strategy: 'Strategy', planner: 'Planner', fees: 'Fees', points: 'Points', leagues: 'Leagues', referrals: 'Referrals' };
    return `<p class="ob-kicker">All set${st.name ? `, ${esc(st.name)}` : ''}</p>
      <h2>Your dashboard is ready.</h2>
      <p class="ob-lede">The first sync takes a minute or two for a busy account.</p>
      <ul class="ob-summary">
        <li>${PT.icon('layers', 'sm')}<span>Pages: <b>${esc(pages.map((p) => names[p]).join(', '))}</b></span></li>
        ${st.goals.includes('alerts') || st.goals.includes('hedge') ? `<li>${PT.icon('alert', 'sm')}<span>Alerts on for near-liquidation${st.goals.includes('hedge') ? ' and broken hedges' : ''}</span></li>` : ''}
        ${st.noAccount.length ? `<li>${PT.icon('gift', 'sm')}<span>Sign-up links for ${esc(st.noAccount.map((id) => NAMES[id]).join(' and '))} are on the Referrals page</span></li>` : ''}
        ${PT.state && PT.state.developer ? `<li><span class="x-mark sm" aria-hidden="true">𝕏</span><span>Made by ${esc(PT.state.developer.handle)}: <a href="${esc(PT.state.developer.x)}" target="_blank" rel="noopener noreferrer">follow on X</a> for updates</span></li>` : ''}
      </ul>
      <div class="ob-nav"><button type="button" class="btn btn-ghost" data-ob="skip-tour">Go to the dashboard</button><button type="button" class="btn btn-primary" data-ob="tour">${PT.icon('book', 'sm')}Take the 1-minute tour</button></div>`;
  }

  // The pages your answers call for (the rest stay switched on in Settings, just hidden).
  function pagesFor() {
    const g = new Set(st.goals);
    const ex = new Set(st.exchanges);
    const on = ['overview', 'live'];
    if (g.has('aura') || g.has('arcus') || !g.size) on.push('strategy');
    if (g.has('aura') || !g.size) on.push('planner');
    if (g.has('fees') || !g.size) on.push('fees');
    if (g.has('aura') || g.has('arcus') || ex.has('bulk') || ex.has('arcus')) on.push('points');
    if (ex.has('bulk') && (g.has('aura') || !g.size)) on.push('leagues');
    on.push('referrals');
    return on;
  }

  function render() {
    const host = $('#onboarding');
    if (!host) return;
    host.innerHTML = `<div class="ob">${dots()}<div class="ob-body" data-step="${STEPS[st.step]}">${body()}</div></div>`;
    PT.hydrateIcons(host);
    const first = host.querySelector('input:not([type=checkbox])');
    if (first && document.activeElement === document.body) first.focus();
  }

  function collect() {
    const host = $('#onboarding');
    const name = $('#ob-name', host);
    if (name) st.name = name.value.trim();
    $$('[data-wallet]', host).forEach((el) => (st.wallets[el.dataset.wallet] = el.value.trim()));
    const ar = $('#ob-arcus', host);
    if (ar) st.arcusName = ar.value.trim();
  }

  async function finishSetup() {
    st.error = '';
    // Wallets you already have stay; a new address is added (running setup again never removes one).
    const have = (PT.state && PT.state.config.wallets) || {};
    const wallets = { bulk: [...(have.bulk || [])], arcus: [...(have.arcus || [])], entropy: [...(have.entropy || [])] };
    for (const id of st.exchanges) {
      const a = st.wallets[id];
      if (!a) continue;
      if (!ADDRESS[id].re.test(a)) {
        st.error = ADDRESS[id].bad;
        return false;
      }
      if (!wallets[id].some((w) => w.address.toLowerCase() === a.toLowerCase())) wallets[id].push({ address: a, label: st.name || '' });
    }
    const alerts = {};
    if (st.goals.includes('alerts') || st.goals.includes('hedge')) Object.assign(alerts, { nearLiq: true, hedges: st.goals.includes('hedge') });
    try {
      PT.state = await PT.post('/api/onboarding', { wallets, arcusPointsName: st.arcusName, profile: { name: st.name, exchanges: st.exchanges, noAccount: st.noAccount, goals: st.goals }, alerts });
    } catch (e) {
      st.error = e.message;
      return false;
    }
    // Pages for what you said you want (Settings > Display can turn the others back on).
    const want = new Set(pagesFor());
    for (const [id] of PT.display.PAGES) PT.display.setPage(id, want.has(id));
    return true;
  }

  async function go(action) {
    collect();
    if (action === 'back') st.step = Math.max(0, st.step - 1);
    else if (action === 'next') {
      if (STEPS[st.step] === 'wallets') {
        const btn = $('#onboarding [data-ob="next"]');
        if (btn) btn.disabled = true;
        if (!(await finishSetup())) return render();
      }
      st.step = Math.min(STEPS.length - 1, st.step + 1);
    } else if (action === 'tour' || action === 'skip-tour') {
      $('#onboarding').hidden = true;
      PT.onboarding.active = false;
      location.hash = '#overview';
      if (PT.kick) PT.kick(300);
      if (action === 'tour' && PT.tour) setTimeout(() => PT.tour.start(), 700);
      return;
    }
    render();
  }

  document.addEventListener('click', (ev) => {
    const host = $('#onboarding');
    if (!host || host.hidden || !host.contains(ev.target)) return;
    const b = ev.target.closest('[data-ob]');
    if (b) return go(b.dataset.ob);
    const ex = ev.target.closest('[data-ex]');
    if (ex) {
      collect();
      const id = ex.dataset.ex;
      st.exchanges = st.exchanges.includes(id) ? st.exchanges.filter((x) => x !== id) : [...st.exchanges, id];
      if (st.exchanges.includes(id)) st.noAccount = st.noAccount.filter((x) => x !== id);
      return render();
    }
    const g = ev.target.closest('[data-goal]');
    if (g) {
      const id = g.dataset.goal;
      st.goals = st.goals.includes(id) ? st.goals.filter((x) => x !== id) : [...st.goals, id];
      return render();
    }
  });
  document.addEventListener('change', (ev) => {
    const n = ev.target.closest('#onboarding [data-none]');
    if (!n) return;
    collect();
    const id = n.dataset.none;
    st.noAccount = n.checked ? [...new Set([...st.noAccount, id])] : st.noAccount.filter((x) => x !== id);
    if (n.checked) st.exchanges = st.exchanges.filter((x) => x !== id);
    render();
  });
  document.addEventListener('keydown', (ev) => {
    const host = $('#onboarding');
    if (ev.key === 'Enter' && host && !host.hidden && ev.target.matches('#onboarding input[type=text]')) {
      ev.preventDefault();
      go('next');
    }
  });

  // Setup finished but no wallets (you skipped them): a short prompt instead of the whole setup.
  function emptyState() {
    const host = $('#onboarding');
    const p = (PT.state && PT.state.config.profile) || {};
    host.innerHTML = `<div class="ob"><div class="ob-body"><p class="ob-kicker">${esc(p.name ? `Hi ${p.name}` : 'Almost there')}</p><h2>Add a wallet to start tracking.</h2>
      <p class="ob-lede">Paste the public address you trade with on Bulk, Arcus or Entropy. New to an exchange? The Referrals page has sign-up links.</p>
      <div class="ob-nav"><a class="btn btn-ghost" href="#referrals">${PT.icon('gift', 'sm')}Referrals</a><span class="ob-gap"></span><button type="button" class="btn" data-ob-restart>Run setup again</button><button type="button" class="btn btn-primary" data-open-wallets>${PT.icon('wallet', 'sm')}Add your wallets</button></div></div></div>`;
    PT.hydrateIcons(host);
  }
  document.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-ob-restart]')) PT.onboarding.restart();
  });

  // Shown while there are no wallets: the setup until it's been finished once, then a short prompt.
  function show() {
    const host = $('#onboarding');
    if (!host) return;
    const p = (PT.state && PT.state.config.profile) || null;
    if (PT.state && PT.state.config.onboardedAt && !PT.onboarding.active) return emptyState();
    if (!PT.onboarding.active) {
      PT.onboarding.active = true;
      if (p) Object.assign(st, { name: p.name || '', exchanges: p.exchanges || [], noAccount: p.noAccount || [], goals: p.goals || [] });
      render();
    }
  }

  // Run setup again (Settings > System): starts from your current answers and wallets.
  function restart() {
    const c = (PT.state && PT.state.config) || {};
    const p = c.profile || {};
    const ws = c.wallets || {};
    const withWallet = ORDER.filter((id) => (ws[id] || []).length);
    Object.assign(st, { step: 0, error: '', name: p.name || '', exchanges: [...new Set([...(p.exchanges || []), ...withWallet])], noAccount: (p.noAccount || []).filter((id) => !withWallet.includes(id)), goals: p.goals || [], arcusName: c.arcusPointsName || '' });
    for (const id of ORDER) st.wallets[id] = (ws[id] && ws[id][0] && ws[id][0].address) || '';
    PT.onboarding.active = true;
    $('#onboarding').hidden = false;
    $$('[data-view-panel]').forEach((x) => (x.hidden = true));
    window.scrollTo(0, 0);
    render();
  }

  PT.onboarding = { show, render, active: false, restart };
})();
