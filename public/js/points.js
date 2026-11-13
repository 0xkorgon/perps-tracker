/* Points: Bulk AURA and Arcus points from the exchanges' public points data, Entropy kept ready
   for when its program launches, the next drops, and what your points cost in fees.
   Data: /api/points */
(() => {
  'use strict';
  // Bulk sends league shares like 9.999535840824347; show 10.
  const topPct = (x) => { const n = Number(x); return Number.isFinite(n) ? String(n >= 1 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100).replace(/\.0$/, '') : x; };

  const PT = window.PT;
  const { $, $$, esc, money, compact, count, pct, NAMES } = PT;

  // AURA sources (validated categorical: violet, yellow, aqua), and Gauntlet in the Challenger
  // league's own colour (it's the Challenger Series' AURA).
  const AURA = [
    { key: 'predeposit', name: 'Pre-deposit', color: 'var(--aura-pre)' },
    { key: 'trading', name: 'Trading', color: 'var(--aura-trade)' },
    { key: 'referrals', name: 'Referrals', color: 'var(--aura-ref)' },
    { key: 'gauntlet', name: 'Gauntlet', color: 'var(--lg-challenger)' },
  ];
  const signedPct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0)}%` : '');

  let data = null;
  let lastKey = '';
  let loading = false;
  let animate = true; // count up and grow bars on the next render (entering the page)
  const shown = {}; // last value shown per counter, so updates count from there
  let pasteMsg = null; // "Saved …" after pasting AURA, shown for a few seconds

  const pts = (n) => (Number.isFinite(n) ? PT.plain(n, Math.abs(n) >= 100 ? 0 : 2) : '–');
  const share = (x) => (Number.isFinite(x) ? pct(x, x >= 0.01 ? 2 : x >= 0.0001 ? 3 : 4) : '–');
  const prog = (id) => (data ? data.programs.find((p) => p.id === id) : null);

  async function load(force, entered) {
    if (entered) animate = true;
    const key = PT.dataVersion();
    if (!force && key === lastKey && data) return render();
    if (loading) return;
    loading = true;
    try {
      data = await PT.getJSON('/api/points');
      lastKey = key;
    } catch {
      // keep the previous render
    } finally {
      loading = false;
    }
    render(force);
  }

  // ---------- small builders ----------
  const counter = (key, value, fmt = 'pts') => `<span data-count="${Number.isFinite(value) ? value : ''}" data-key="${esc(key)}" data-fmt="${fmt}">${esc(fmt === 'money' ? money(value, { dp: 2 }) : pts(value))}</span>`;
  const cell = ({ icon, label, value, sub, cls = '' }) =>
    `<div class="cell"><span class="cell-l">${PT.icon(icon)}${esc(label)}</span><span class="cell-v ${cls}">${value}</span>${sub != null ? `<span class="cell-s">${esc(sub)}</span>` : ''}</div>`;
  const panelHead = (icon, title, sub, right = '') =>
    `<div class="ph"><div><h2 class="ph-title">${PT.icon(icon)}${esc(title)}</h2>${sub ? `<p class="ph-sub">${esc(sub)}</p>` : ''}</div>${right}</div>`;
  const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const alertBox = (text, icon = 'alert') => `<div class="alert flat">${PT.icon(icon)}<span>${esc(text)}</span></div>`;
  const loadingPanel = (text) => `<div class="panel empty"><span class="spinner"></span>${esc(text)}</div>`;

  function sectionHead(p, chips = '') {
    const d = p.data;
    const updated = d && d.updatedAt ? `${d.source === 'pasted' ? 'Pasted' : 'Updated'} ${PT.ago(d.updatedAt)}` : '';
    const sched = p.schedule ? `Drops ${p.schedule.replace(/^Weekly, /, 'weekly, ')}` : 'No drop schedule yet';
    return `<div class="section-head pts-sec">${PT.exm(p.id, 'lg')}<div><h2>${esc(p.title)}</h2><p>${esc([sched, updated].filter(Boolean).join(' · '))}</p></div>${chips}<a class="btn btn-ghost btn-sm push" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Open on ${esc(NAMES[p.id])}${PT.icon('external', 'sm')}</a></div>`;
  }

  // ---------- page ----------
  function render(fromUser = false) {
    const main = $('#pts-main');
    if (!data) {
      main.innerHTML = loadingPanel('Loading…');
      return;
    }
    // Don't wipe a box someone is typing in when new data arrives; redraw a little later.
    const el = document.activeElement;
    if (!fromUser && el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && main.contains(el) && el.value) {
      clearTimeout(render.later);
      render.later = setTimeout(() => render(), 4000);
      return;
    }
    main.classList.toggle('anim', animate && !PT.reduceMotion());
    main.innerHTML = `${board()}${dropsPanel()}${bulkSection(prog('bulk'))}${arcusSection(prog('arcus'))}${entropySection(prog('entropy'))}
      <details class="panel howto">
        <summary>${PT.icon('book')}Where these numbers come from${PT.icon('chevron', 'chev')}</summary>
        <ul>
          <li><b>Bulk AURA</b> is read from Bulk's public AURA data for your Bulk wallet: your total, AURA per pre-deposit week, trading and referral AURA per mainnet week, your leagues, and each week's reveal time. Bulk settles a week on Saturday at 12:30 UTC and reveals it at 13:00 UTC. When Bulk's website turns away automatic requests (it sometimes only answers web browsers), the tracker backs off and you can paste the same data in from your browser.</li>
          <li><b>Arcus points</b> come from Arcus's public points leaderboard. Arcus only shows your own points when you're logged in, so the tracker finds you by your points name (set it in Settings, Points). Arcus hands out 250,000 points a week, on Wednesdays at 3 PM New York time.</li>
          <li><b>Each week's volume</b> on Bulk is shown twice when that week's results are loaded: as Bulk counted it for AURA, and from your own fills in that week's window. Fees and taker volume are always from your fills.</li>
          <li><b>Gauntlet AURA</b> is what Bulk pays in its Challenger Series (season 1 started with the week from Saturday 17 October), listed by challenger week. Challenger week 1 is mainnet week 7, so each one shows in the mainnet week it was earned.</li>
          <li><b>Previous weeks</b> are filled in from your AURA total even when that week's results weren't pasted: each shows what Bulk paid, your taker volume and fees, and what the estimate gives for it from the weeks before it only. A week revealed after your AURA was last read shows as not loaded yet.</li>
          <li><b>Fees per 1,000</b> is the trading fees you paid in a period divided by the points earned for trading in it, so you can compare what a point costs on each exchange.</li>
          <li><b>Entropy</b> hasn't launched points yet. Your Entropy trading is recorded from your first trade, and the page fills in as soon as there's a program to read.</li>
        </ul>
      </details>`;
    afterRender(main);
  }

  function afterRender(main) {
    // Count values up from zero on entering the page, or from what was shown before on updates.
    $$('[data-count]', main).forEach((el) => {
      const to = el.dataset.count === '' ? NaN : Number(el.dataset.count);
      const key = el.dataset.key;
      const fmt = el.dataset.fmt === 'money' ? (v) => money(v, { dp: 2 }) : el.dataset.fmt === 'int' ? (v) => PT.plain(Math.round(v), 0) : (v) => pts(Number.isFinite(to) && Math.abs(to) >= 100 ? Math.round(v) : v);
      const from = animate ? 0 : shown[key] != null ? shown[key] : to;
      if (Number.isFinite(to)) {
        PT.countUp(el, to, { from, fmt, dur: animate ? 1100 : 700 });
        shown[key] = to;
      }
    });
    animate = false;
    drawCharts();
    wire(main);
    tick();
  }

  // ---------- board ----------
  function board() {
    const bulk = prog('bulk');
    const arcus = prog('arcus');
    const entropy = prog('entropy');
    const next = data.drops[0];
    const lead = next
      ? `<div class="cell lead"><span class="cell-l">${PT.icon('timer')}Next points drop</span><span class="lead-v" data-countdown="${next.at}">${esc(PT.countdown(next.at - Date.now()))}</span><span class="cell-s">${esc(`${next.title}, ${PT.localWhen(next.at)}`)}</span></div>`
      : PT.leadCell({ icon: 'timer', label: 'Next points drop', value: '–', sub: 'Add a Bulk or Arcus wallet' });

    const b = bulk.data;
    const bulkCell = !bulk.hasWallet
      ? cell({ icon: 'star', label: 'Bulk AURA', value: '–', sub: 'No Bulk wallet' })
      : b
        ? cell({ icon: 'star', label: 'Bulk AURA', value: counter('b-total', b.total), sub: [b.rank ? `Rank ${count(b.rank)}` : null, b.league ? b.league.name : null].filter(Boolean).join(' · ') })
        : bulk.blocked
          ? cell({ icon: 'star', label: 'Bulk AURA', value: 'Update needed', sub: 'One click: see Bulk AURA below', cls: 'small' })
          : cell({ icon: 'star', label: 'Bulk AURA', value: '…', sub: bulk.error || 'Loading' });

    const a = arcus.data;
    let arcusCell;
    if (a.me) arcusCell = cell({ icon: 'star', label: `Arcus points, ${a.season ? a.season.name : 'this season'}`, value: counter('a-total', a.me.points), sub: `Rank ${count(a.me.rank)} of ${count(a.me.of)}${a.me.tier ? ` · ${a.me.tier}` : ''}` });
    else if (a.searching) arcusCell = cell({ icon: 'star', label: 'Arcus points', value: '…', sub: `Looking up ${a.name}` });
    else if (a.notFound) arcusCell = cell({ icon: 'star', label: 'Arcus points', value: 'Not found', sub: 'Check your points name', cls: 'small' });
    else if (a.manual.latest) arcusCell = cell({ icon: 'star', label: 'Arcus points', value: counter('a-manual', a.manual.latest.value), sub: `Logged by hand ${PT.ago(a.manual.latest.at)}` });
    else arcusCell = cell({ icon: 'star', label: 'Arcus points', value: 'Not set', sub: 'Add your points name', cls: 'small' });

    const e = entropy.data;
    const entropyCell = e.manual.latest
      ? cell({ icon: 'star', label: 'Entropy points', value: counter('e-manual', e.manual.latest.value), sub: `Logged by hand ${PT.ago(e.manual.latest.at)}` })
      : cell({ icon: 'star', label: 'Entropy points', value: 'Not live yet', sub: entropy.hasWallet ? `${compact(entropy.lifetime.volume)} traded so far` : 'No Entropy wallet', cls: 'small' });

    const feeIds = ['bulk', 'arcus'].filter((id) => prog(id).hasWallet);
    const fees = feeIds.reduce((s, id) => s + prog(id).lifetime.fees, 0);
    const feesCell = cell({ icon: 'receipt', label: 'Fees paid, all time', value: counter('fees', fees, 'money'), sub: feeIds.map((id) => `${NAMES[id]} ${money(prog(id).lifetime.fees, { dp: 0 })}`).join(' · ') || 'All time' });

    return `<div class="board"><div class="board-row">${lead}${bulkCell}${arcusCell}${entropyCell}${feesCell}</div></div>`;
  }

  // ---------- drops timeline ----------
  function dropsPanel() {
    const now = Date.now();
    const rows = data.programs.map((p) => {
      const d = p.data;
      const tracked = p.id === 'arcus' ? p.hasWallet || Boolean(d.name) : p.hasWallet;
      if (!p.live) {
        return `<div class="drop muted-row">
          <div class="drop-name">${PT.exm(p.id)}<div><b>${esc(p.title)}</b><span>Not announced yet</span></div></div>
          <div class="drop-bar"><div class="track"><i style="width:0"></i></div><span class="drop-note">The countdown starts here once ${esc(NAMES[p.id])} sets a schedule.</span></div>
          <div class="drop-when"><span>–</span></div><div class="drop-left">–</div>
        </div>`;
      }
      if (tracked && !d && p.nextDrop) {
        // The schedule is known even when the AURA itself couldn't be read.
        const prev = p.nextDrop - 7 * 864e5;
        return `<div class="drop">
          <div class="drop-name">${PT.exm(p.id)}<div><b>${esc(p.title)}</b><span>${esc(p.schedule || '')}</span></div></div>
          <div class="drop-bar"><div class="track" data-from="${prev}" data-to="${p.nextDrop}"><i style="width:${Math.min(100, Math.max(0, ((now - prev) / (p.nextDrop - prev)) * 100)).toFixed(1)}%"></i></div><span class="drop-note">${esc(p.blocked ? 'Update your AURA in one click: see Bulk AURA below' : 'Loading your AURA…')}</span></div>
          <div class="drop-when"><span>${esc(PT.localWhen(p.nextDrop))}</span><span class="muted">your time</span></div>
          <div class="drop-left"><span data-countdown="${p.nextDrop}" data-full>${esc(PT.countdown(p.nextDrop - now, true))}</span></div>
        </div>`;
      }
      if (!tracked || !d || !d.nextDrop) {
        return `<div class="drop muted-row">
          <div class="drop-name">${PT.exm(p.id)}<div><b>${esc(p.title)}</b><span>${esc(p.schedule || '')}</span></div></div>
          <div class="drop-bar"><div class="track"><i style="width:0"></i></div><span class="drop-note">${esc(p.hasWallet ? 'Loading…' : `Add a ${NAMES[p.id]} wallet to follow its drops.`)}</span></div>
          <div class="drop-when"><span>${d && d.nextDrop ? esc(PT.localWhen(d.nextDrop)) : '–'}</span></div><div class="drop-left">${d && d.nextDrop ? `<span data-countdown="${d.nextDrop}" data-full></span>` : '–'}</div>
        </div>`;
      }
      const last = d.lastDrop && d.lastDrop < d.nextDrop ? d.lastDrop : d.nextDrop - 7 * 864e5;
      const cur = d.current || {};
      const label = p.id === 'bulk' && cur.week ? `Week ${cur.week}` : 'This week';
      const so = Number.isFinite(cur.volume) ? `${label} so far: ${compact(cur.volume)} volume, ${money(cur.fees, { dp: 2 })} fees` : label;
      return `<div class="drop">
        <div class="drop-name">${PT.exm(p.id)}<div><b>${esc(p.title)}</b><span>${esc(p.schedule || '')}</span></div></div>
        <div class="drop-bar"><div class="track" data-from="${last}" data-to="${d.nextDrop}"><i style="width:${Math.min(100, Math.max(0, ((now - last) / (d.nextDrop - last)) * 100)).toFixed(1)}%"></i></div><span class="drop-note">${esc(so)}</span></div>
        <div class="drop-when"><span>${esc(PT.localWhen(d.nextDrop))}</span><span class="muted">your time</span></div>
        <div class="drop-left"><span data-countdown="${d.nextDrop}" data-full>${esc(PT.countdown(d.nextDrop - now, true))}</span></div>
      </div>`;
    });
    return `<section class="panel">${panelHead('calendar', 'Upcoming drops', 'When each exchange hands out its next batch, and how far through the week you are')}<div class="drops">${rows.join('')}</div></section>`;
  }

  // ---------- Bulk ----------
  function bulkSection(p) {
    const d = p.data;
    if (!p.hasWallet) return `${sectionHead(p)}<div class="panel"><div class="venue-empty" style="padding:22px">${PT.icon('wallet', 'lg')}<div>Add your Bulk wallet and your AURA loads here automatically.</div><button class="btn btn-primary btn-sm" data-open-wallets>${PT.icon('plus', 'sm')}Add wallet</button></div></div>`;
    if (!d) {
      if (p.blocked) return `${sectionHead(p)}<div class="panel pad">${alertBox(`${p.error} Set up the one-click update below: it takes about 20 seconds.`)}</div>${pastePanel(p, true)}`;
      return `${sectionHead(p)}${p.error ? `<div class="panel pad">${alertBox(p.error)}</div>` : loadingPanel('Loading your AURA from Bulk…')}`;
    }
    const chips = d.league ? `<span class="chip gold">${PT.icon('trophy')}${esc(d.league.name)}${d.league.top ? `, top ${esc(topPct(d.league.top))}%` : ''}</span>` : '';
    const bd = d.breakdown;
    const parts = [
      { ...AURA[0], v: bd.predeposit },
      { ...AURA[1], v: bd.trading + bd.maker + bd.boost },
      { ...AURA[2], v: bd.referrals },
    ];
    if (bd.gauntlet > 0) parts.push({ ...AURA[3], v: bd.gauntlet });
    if (bd.other > 0) parts.push({ key: 'other', name: 'Other', color: 'var(--n-lo)', v: bd.other });
    const t = d.trading;
    const g = d.gauntlet || { total: 0, weeks: [] };
    const gauntletRow = g.total > 0 ? ['Gauntlet by week', `<span title="Challenger Series AURA: challenger week N is mainnet week N + ${esc(g.offset)}">${esc(g.weeks.map((x) => `Wk ${x.week}: ${pts(x.aura)}`).join(' · '))}</span>`] : null;

    // Trading league: progress from the current league's cutoff to the next one.
    let league = '';
    if (t.next) {
      const span = Math.max(1, t.next.at - t.floor);
      const frac = Math.min(1, Math.max(0, (t.aura - t.floor) / span));
      league = `<div class="ladder-bar" role="img" aria-label="${esc(`${pts(t.aura)} trading AURA, ${pts(t.next.need)} short of ${t.next.name} at ${pts(t.next.at)}`)}"><i style="width:${(frac * 100).toFixed(1)}%"></i></div>
        <div class="ladder-cap"><span>${esc(t.league || 'Now')} ${esc(pts(t.floor))}</span><span>${esc(t.next.name)} ${esc(pts(t.next.at))}</span></div>
        <p class="pts-note">${PT.icon('trending', 'sm')}<span><b>${esc(pts(t.next.need))}</b> more trading AURA to reach ${esc(t.next.name)}.</span></p>`;
    } else if (t.ladder.length) league = `<p class="pts-note">${PT.icon('trophy', 'sm')}<span>Top league reached.</span></p>`;
    const ladder = t.ladder.length
      ? `<ol class="ladder">${t.ladder
          .map((l) => `<li class="${t.league && l.name === t.league ? 'now' : l.at <= t.aura ? 'done' : ''}"><span>${esc(l.name)}</span><b>${esc(pts(l.at))}</b></li>`)
          .join('')}</ol>`
      : '';

    const preMax = Math.max(1, ...d.predeposit.weeks.map((w) => w.aura));
    const pre = d.predeposit.weeks.length
      ? `<div class="hbars">${d.predeposit.weeks
          .map((w, i) => `<span class="lbl">Week ${w.week}</span><div class="track"><div class="fill grow" style="--i:${i};width:${((w.aura / preMax) * 100).toFixed(1)}%;background:var(--aura-pre)"></div></div><span class="val">${esc(pts(w.aura))}</span>`)
          .join('')}</div>`
      : `<div class="empty">${PT.icon('piggy')}No pre-deposit AURA on this wallet.</div>`;

    const c = d.cost;
    // Bulk's website only answers browsers. Your AURA is only out of date once a week has been
    // revealed since it was read; until then it's complete.
    const pend = d.pendingWeeks || [];
    const through = d.lastWeek ? `week ${d.lastWeek}` : 'the latest reveal';
    const notice = p.blocked || pend.length || p.error
      ? `<div class="panel pad">${
          p.error && !p.blocked && !pend.length
            ? alertBox(`${p.error} Showing what was loaded before.`)
            : pend.length
            ? alertBox(`Week${pend.length > 1 ? 's' : ''} ${pend.join(', ')} ${pend.length > 1 ? 'were' : 'was'} revealed after your last AURA update (${PT.ago(d.updatedAt)}), so ${pend.length > 1 ? 'they show' : 'it shows'} as estimated (≈ ${pts(d.pendingExpected || 0)} trading AURA) until you update. One click: open app.bulk.trade and press your “Send AURA to tracker” bookmark.`, 'alert')
            : `<div class="alert flat ok">${PT.icon('check')}<span>Up to date: your AURA covers every week revealed so far (through ${esc(through)}, updated ${esc(PT.ago(d.updatedAt))}). The next reveal is ${esc(PT.localWhen(d.nextReveal || p.nextDrop))}; after it, update with one click.</span></div>`
        }</div>${pastePanel(p, Boolean(pend.length))}`
      : '';
    return `${sectionHead(p, chips)}
      ${notice}
      <div class="grid g3">
        <section class="panel">
          ${panelHead('star', 'Your AURA', d.rank ? `Rank ${count(d.rank)} on Bulk${d.wallets > 1 ? `, ${d.wallets} wallets added up` : ''}` : null)}
          <div class="pb">
            <div class="big">${counter('b-total2', d.total)}<small>AURA</small></div>
            ${d.pendingExpected > 0 ? `<p class="pts-note">${PT.icon('clock', 'sm')}<span>+ ≈ <b>${esc(pts(d.pendingExpected))}</b> estimated for week${pend.length > 1 ? 's' : ''} ${esc(pend.join(', '))}, revealed but not loaded yet</span></p>` : ''}
            <div class="share grow-x" role="img" aria-label="${esc(parts.map((x) => `${x.name} ${pts(x.v)}`).join(', '))}">${d.total > 0 ? parts.filter((x) => x.v > 0).map((x) => `<span style="flex:${x.v};background:${x.color}"></span>`).join('') : ''}</div>
            <div class="legend" style="margin-top:9px">${parts.map((x) => `<span><i class="key" style="background:${x.color}"></i>${esc(x.name)} <b>${esc(pts(x.v))}</b></span>`).join('')}</div>
            ${kv([
              bd.maker > 0 ? ['Maker AURA (in trading)', esc(pts(bd.maker))] : null,
              bd.boost > 0 ? ['Boost AURA (in trading)', esc(pts(bd.boost))] : null,
              gauntletRow,
              d.referral.code ? ['Your referral code', `<span class="copyable">${esc(d.referral.code)}<button type="button" class="rm" data-copy="${esc(d.referral.code)}" title="Copy" aria-label="Copy referral code">${PT.icon('copy', 'sm')}</button></span>`] : null,
              ['People you referred', esc(`${count(d.referral.sent)}${d.referral.qualified ? `, ${count(d.referral.qualified)} qualified` : ''}`)],
              d.referral.referredBy ? ['Referred by', esc(d.referral.referredBy)] : null,
            ])}
          </div>
        </section>
        <section class="panel">
          ${panelHead('trophy', 'Trading league', t.rank ? `Rank ${count(t.rank)} of ${count(t.population)} traders` : 'Ranked by trading AURA')}
          <div class="pb">
            <div class="league-now"><b>${esc(t.league || '–')}</b>${t.top ? `<span class="chip gold">Top ${esc(topPct(t.top))}%</span>` : ''}<span class="muted">${counter('b-trading', t.aura)} trading AURA</span></div>
            ${league}
            ${ladder}
            ${kv([
              t.volume != null ? ['Volume Bulk counted', esc(money(t.volume, { dp: 0 }))] : null,
              t.threshold != null ? ['Needed to qualify', `${esc(money(t.threshold, { dp: 0 }))} ${t.qualified ? `<span class="pos">${PT.icon('check', 'sm')}</span>` : `<span class="neg">${PT.icon('x', 'sm')}</span>`}`] : null,
            ])}
          </div>
        </section>
        <section class="panel">
          ${panelHead('receipt', 'What AURA costs you', 'Your Bulk fees against the trading AURA they earned')}
          <div class="pb">
            ${c ? `<div class="big sm">${counter('b-cost', c.feesPer1k, 'money')}<small>per 1,000 AURA</small></div>` : `<div class="big sm muted">–</div>`}
            ${kv([
              ['Fees paid on Bulk', esc(money(p.lifetime.fees, { dp: 2 }))],
              ['Volume on Bulk', esc(money(p.lifetime.volume, { dp: 0 }))],
              ['Trading AURA earned', esc(pts(bd.trading + bd.maker + bd.boost))],
              ['AURA per $10K volume', esc(c && Number.isFinite(c.perTenK) ? PT.plain(c.perTenK, 2) : '–')],
              ['Volume per AURA', esc(bd.trading + bd.maker + bd.boost > 0 ? money(p.lifetime.volume / (bd.trading + bd.maker + bd.boost), { dp: 0 }) : '–')],
            ])}
          </div>
        </section>
      </div>
      <div class="grid g-wide">
        <section class="panel">
          ${panelHead('chart', 'AURA per mainnet week', `Trading${g.total > 0 ? ', gauntlet' : ''} and referral AURA, by the week it was earned`, `<div class="legend"><span><i class="key" style="background:var(--aura-trade)"></i>Trading</span>${g.total > 0 ? '<span><i class="key" style="background:var(--lg-challenger)"></i>Gauntlet</span>' : ''}<span><i class="key" style="background:var(--aura-ref)"></i>Referrals</span></div>`)}
          <div class="pb"><div class="chart" id="pts-bulk-chart"></div></div>
        </section>
        <section class="panel">
          ${panelHead('piggy', 'Pre-deposit AURA', `${pts(d.predeposit.total)} AURA from depositing before mainnet`)}
          <div class="pb">
            ${pre}
            ${kv([
              d.predeposit.deposited != null ? ['Deposited', esc(money(d.predeposit.deposited, { dp: 2 }))] : null,
              d.predeposit.withdrawn != null ? ['Withdrawn', esc(money(d.predeposit.withdrawn, { dp: 2 }))] : null,
              d.predeposit.current != null ? ['Still deposited', esc(money(d.predeposit.current, { dp: 2 }))] : null,
            ])}
          </div>
        </section>
      </div>
      ${previousWeeks(d, p.estimate)}
      <section class="panel">
        ${panelHead('table', 'Week by week', 'Each mainnet week as Bulk settled it, next to your own fills from the same window. Model: what the estimate gives for your trades that week, worked out from the weeks before it only')}
        <div class="table-wrap">${bulkTable(d, p.estimate)}</div>
      </section>`;
  }

  // The last four revealed weeks side by side: what each paid, where it came from, and how close
  // the estimate got.
  function previousWeeks(d, e) {
    const done = d.weeks.filter((w) => w.publishAt <= Date.now()).slice(-4).reverse();
    if (!done.length) return '';
    const cellFor = (w) => {
      if (w.pending) {
        return `<div class="cell"><span class="cell-l">${PT.icon('calendar')}Week ${esc(w.week)} · ${esc(`${PT.dateShort(w.start)} – ${PT.dateShort(w.end)}`)}</span><span class="cell-v">${Number.isFinite(w.expected) ? `≈ ${esc(pts(w.expected))}` : '–'}<small class="muted"> AURA</small></span><span class="cell-s">Estimated trading AURA: revealed after your last update</span><span class="cell-s">${esc(w.taker != null ? `${compact(w.taker)} taker, ${money(w.fees, { dp: 2 })} fees` : `${compact(w.volume)} volume`)}</span></div>`;
      }
      const src = [w.trading + w.maker + w.boost > 0 ? `${pts(w.trading + w.maker + w.boost)} trading` : null, w.gauntlet > 0 ? `${pts(w.gauntlet)} gauntlet` : null, w.referrals > 0 ? `${pts(w.referrals)} referral` : null, w.other > 0 ? `${pts(w.other)} other` : null].filter(Boolean).join(' + ');
      const exp = w.estimated ? `expected ${pts(w.estimated.points)} at the cutoff` : Number.isFinite(w.model) ? `model ${pts(w.model)}` : null;
      const off = w.estimated && w.trading > 0 ? signedPct(w.trading / w.estimated.points - 1) : Number.isFinite(w.modelErr) ? signedPct(w.modelErr) : '';
      const act = w.taker != null ? `${compact(w.taker)} taker${w.oiHours > 0 ? `, ${compact(w.oiHours / 24)} open·days` : ''}` : `${compact(w.volume)} volume`;
      return `<div class="cell"><span class="cell-l">${PT.icon('calendar')}Week ${esc(w.week)} · ${esc(`${PT.dateShort(w.start)} – ${PT.dateShort(w.end)}`)}</span><span class="cell-v">${esc(pts(w.total))}<small class="muted"> AURA</small></span><span class="cell-s" title="${esc(src)}">${esc(src || 'No AURA this week')}</span><span class="cell-s" title="${esc(`${act}, ${money(w.fees, { dp: 2 })} fees`)}">${esc(`${act}, ${money(w.fees, { dp: 2 })} fees`)}</span>${exp ? `<span class="cell-s">${esc(exp)}${off ? ` <b class="${Math.abs(w.modelErr || 0) < 0.1 ? 'pos' : ''}">${esc(off)}</b>` : ''}</span>` : ''}</div>`;
    };
    const chk = e && e.check && e.check.backtest && e.check.backtest.length ? `Checked on your weeks ${e.check.backtest.map((b) => b.week).join(', ')}: typical miss ±${(e.check.rms * 100).toFixed(1)}%` : 'Your last revealed weeks';
    return `<section class="panel">${panelHead('history', 'Previous weeks', chk)}<div class="board" style="border:0;border-radius:0"><div class="board-row even">${done.map(cellFor).join('')}</div></div></section>`;
  }

  // Bulk's website only answers browsers at times, so AURA can be copied from the browser and pasted here.
  function pastePanel(p, open) {
    const pa = p.paste || { wallets: [] };
    const multi = pa.wallets.length > 1;
    const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
    const link = (href, text) => `<a class="paste-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}${PT.icon('external', 'sm')}</a>`;
    const links = pa.wallets
      .map((w) => {
        // Earlier weeks' results that aren't saved yet (each adds Bulk's own volume count and the
        // AURA before its credit, which sharpens the estimate).
        const missing = (w.past || []).filter((x) => !x.have && x.week !== pa.week);
        const older = missing.length ? `<span class="muted">Earlier weeks:</span>${missing.map((x) => link(x.url, `Week ${x.week}`)).join('')}` : '';
        return `<div class="paste-links">${multi ? `<span class="muted">${esc(w.label || shortAddr(w.address))}</span>` : ''}${link(w.url, 'Your AURA page')}${w.weekUrl ? link(w.weekUrl, `Week ${pa.week} results${w.haveWeek ? ', saved' : ''}`) : ''}</div>${older ? `<div class="paste-links">${older}</div>` : ''}`;
      })
      .join('');
    const msg = pasteMsg && Date.now() - pasteMsg.at < 8000 ? `<div class="pts-ok">${PT.icon('check', 'sm')}${esc(pasteMsg.text)}</div>` : '';
    const bm = bookmarklet(pa.wallets.map((w) => w.address));
    return `<details class="panel paste"${open ? ' open' : ''}>
      <summary>${PT.icon('refresh')}Update AURA in one click${p.retryAt ? `<span class="muted">The tracker also tries Bulk itself at ${esc(PT.localWhen(p.retryAt).split(', ')[1] || '')}</span>` : ''}${PT.icon('chevron', 'chev')}</summary>
      <div class="pb">
        <p class="pts-lede">Bulk's website only answers web browsers, so your browser fetches your AURA and hands it to the tracker. Nothing else is read or sent.</p>
        <ol class="steps">
          <li><span><b>Once:</b> drag this button to your bookmarks bar (press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> if you don't see the bar):</span><div class="paste-links"><a class="btn btn-primary btn-sm bm-link" href="${esc(bm)}" data-bookmarklet title="Drag me to your bookmarks bar">${PT.icon('star', 'sm')}Send AURA to tracker</a></div></li>
          <li><span><b>After each Saturday reveal:</b> open <a href="https://app.bulk.trade" target="_blank" rel="noopener noreferrer">app.bulk.trade</a> and click the bookmark. A tab opens here and asks to import.</span></li>
        </ol>
        ${msg}
      </div>
    </details>
    <details class="panel paste">
      <summary>${PT.icon('copy')}Or paste it by hand${PT.icon('chevron', 'chev')}</summary>
      <div class="pb">
        <ol class="steps">
          <li><span>Open your AURA page${pa.week ? `, and once a week after Saturday's reveal, that week's results (they add Bulk's volume count and the league cut-offs)` : ''}:</span>${links}</li>
          <li><span>On that page press <kbd>Ctrl</kbd> + <kbd>A</kbd>, then <kbd>Ctrl</kbd> + <kbd>C</kbd>.</span></li>
          <li><span>Paste it here and press <b>Update</b>. Both pages can go in at once.</span></li>
        </ol>
        <form class="paste-form" data-bulk-paste>
          <textarea rows="3" spellcheck="false" placeholder='Paste here, e.g. {"wallet":"…","aura":1523,…}' aria-label="Pasted AURA data"></textarea>
          <button class="btn btn-primary btn-sm" type="submit">${PT.icon('check', 'sm')}Update</button>
        </form>
        <div class="pts-error" data-paste-err></div>
      </div>
    </details>`;
  }

  // A bookmark that runs on app.bulk.trade (where your browser is let in): it reads your AURA and
  // the last eight weeks' results for your Bulk wallets, then opens the tracker with them.
  function bookmarklet(addresses) {
    const code = `(async()=>{const A=${JSON.stringify(addresses)},T=${JSON.stringify(location.origin)};if(location.hostname!=='app.bulk.trade'){alert('Open app.bulk.trade first, then click this bookmark again.');location.href='https://app.bulk.trade';return}const B='/api/aura/v1/aura',L=Math.floor((Date.now()-Date.UTC(2026,8,26,13))/6048e5)+3,g=u=>fetch(B+u,{credentials:'include'}).then(r=>r.ok?r.json():null).catch(()=>null),o=[];for(const a of A){const w=await g('/wallet/'+a);if(w)o.push(w);for(let n=Math.max(1,L-7);n<=L;n++){const k=await g('/mainnet/weekly/'+n+'/wallet/'+a);if(k&&k.week_index!=null)o.push(k)}}if(!o.length){alert('Bulk did not send your AURA. Reload app.bulk.trade and try again.');return}if(!window.open(T+'/#bulk-import='+encodeURIComponent(JSON.stringify(o)),'_blank'))alert('Allow pop-ups for app.bulk.trade, then click the bookmark again.')})()`;
    return `javascript:${encodeURIComponent(code)}`;
  }

  function bulkTable(d, e) {
    if (!d.weeks.length) return `<div class="empty">${PT.icon('calendar')}No mainnet weeks revealed yet.</div>`;
    const rows = [...d.weeks].reverse();
    const dash = '<span class="muted">–</span>';
    const off = (x) => (Number.isFinite(x) ? ` <span class="${Math.abs(x) < 0.1 ? 'pos' : 'muted'}">${esc(signedPct(x))}</span>` : '');
    const r1 = (w) => {
      const earned = w.trading + w.maker + w.boost;
      if (w.pending) {
        return `<tr>
        <td><b>Week ${w.week}</b></td>
        <td class="mono">${esc(`${PT.dateShort(w.start)} – ${PT.dateShort(w.end)}`)}</td>
        <td class="mono">${esc(PT.localWhen(w.publishAt))}</td>
        <td class="num">${Number.isFinite(w.expected) ? `≈ ${esc(pts(w.expected))}` : '–'}</td>
        <td colspan="5"><span class="muted">Estimated: revealed after your last AURA update. Update in one click (above) to load it</span></td>
        <td class="num">${esc(w.taker == null ? '–' : money(w.taker, { dp: 0 }))}</td>
        <td class="num">${esc(money(w.volume, { dp: 0 }))}</td>
        <td class="num">${esc(money(w.fees, { dp: 2 }))}</td>
        <td class="num">${dash}</td><td class="num">${dash}</td>
      </tr>`;
      }
      const est = w.estimated ? `<span title="What the tracker expected at the cutoff">${esc(pts(w.estimated.points))}</span>${w.trading > 0 ? off(w.trading / w.estimated.points - 1) : ''}` : dash;
      const model = Number.isFinite(w.model) ? `<span title="What the estimate gives for your trades that week, from the weeks before it only">${esc(pts(w.model))}</span>${off(w.modelErr)}` : dash;
      return `<tr>
        <td><b>Week ${w.week}</b>${w.tier ? ` <span class="chip gold mono">${esc(w.tier)}</span>` : ''}${w.challenger ? ` <span class="muted" title="Challenger Series week ${esc(w.challenger)}">C${esc(w.challenger)}</span>` : ''}</td>
        <td class="mono">${esc(`${PT.dateShort(w.start)} – ${PT.dateShort(w.end)}`)}</td>
        <td class="mono">${esc(PT.localWhen(w.publishAt))}</td>
        <td class="num">${esc(pts(earned))}</td>
        <td class="num">${est}</td>
        <td class="num">${model}</td>
        <td class="num">${w.gauntlet > 0 ? esc(pts(w.gauntlet)) : dash}</td>
        <td class="num">${esc(pts(w.referrals))}</td>
        <td class="num"><b>${esc(pts(w.total))}</b></td>
        <td class="num">${esc(w.taker == null ? '–' : money(w.taker, { dp: 0 }))}</td>
        <td class="num">${esc(money(w.countedVolume == null ? w.volume : w.countedVolume, { dp: 0 }))}${w.countedVolume == null || !(w.countedVolume > 0) ? '' : `<span class="muted" title="From your own fills"> / ${esc(compact(w.volume))}</span>`}</td>
        <td class="num">${esc(money(w.fees, { dp: 2 }))}</td>
        <td class="num">${esc(Number.isFinite(w.perTenK) ? PT.plain(w.perTenK, 2) : '–')}</td>
        <td class="num">${esc(Number.isFinite(w.feesPer1k) ? money(w.feesPer1k, { dp: 2 }) : '–')}</td>
      </tr>`;
    };
    // The week being traded now, with what it's on course for.
    const c = d.current;
    const now =
      c && e && !e.window.settled
        ? `<tr>
        <td><b>Week ${esc(c.week)}</b> <span class="chip">${PT.icon('clock', 'sm')}Now</span></td>
        <td class="mono">${esc(`${PT.dateShort(c.start)} – ${PT.dateShort(c.end)}`)}</td>
        <td class="mono">${esc(PT.localWhen(c.end + 30 * 60000))}</td>
        <td class="num" title="Earned so far by your taker volume and open hours">${esc(pts(e.points.soFar))}<span class="muted"> so far</span></td>
        <td class="num" title="${esc(`Likely ${pts(e.points.low)} to ${pts(e.points.high)}`)}">≈ ${esc(pts(e.points.projected))}</td>
        <td class="num">${dash}</td><td class="num">${dash}</td><td class="num">${dash}</td><td class="num">${dash}</td>
        <td class="num">${esc(c.taker == null ? '–' : money(c.taker, { dp: 0 }))}</td>
        <td class="num">${esc(money(c.volume, { dp: 0 }))}</td>
        <td class="num">${esc(money(c.fees, { dp: 2 }))}</td>
        <td class="num">${dash}</td><td class="num">${dash}</td>
      </tr>`
        : '';
    return `<table><thead><tr><th>Week</th><th>Traded</th><th>Revealed</th><th class="num">Trading AURA</th><th class="num" title="What the tracker expected at the cutoff">Expected</th><th class="num" title="What the estimate gives for your trades that week, worked out from the weeks before it only">Model</th><th class="num" title="Challenger Series AURA">Gauntlet</th><th class="num">Referral AURA</th><th class="num">Total</th><th class="num">Taker volume</th><th class="num" title="As Bulk counted it when that week's results are loaded, otherwise from your fills">Volume</th><th class="num">Fees</th><th class="num">AURA per $10K</th><th class="num">Fees per 1K AURA</th></tr></thead><tbody>${now}${rows.map(r1).join('')}</tbody></table>`;
  }

  // ---------- Arcus ----------
  function nameForm(a, label = 'Find my points') {
    return `<form class="inline-form" data-arcus-name><input type="text" maxlength="60" placeholder="Your Arcus points name" value="${esc(a.name || '')}" spellcheck="false" autocomplete="off" aria-label="Arcus points name"><button class="btn btn-primary btn-sm" type="submit">${PT.icon('star', 'sm')}${esc(label)}</button></form><div class="pts-error" data-arcus-err></div>`;
  }

  function arcusSection(p) {
    const a = p.data;
    const chips = a.season ? `<span class="chip">${esc(a.season.name)}</span>` : '';
    const head = sectionHead(p, chips);
    const err = p.error ? `<div class="panel pad">${alertBox(p.error)}</div>` : '';
    if (!a.me) {
      let lead;
      if (a.searching) lead = `<div class="inline-progress"><span class="spinner"></span>Looking up <b>${esc(a.name)}</b> on the ${esc(a.season ? a.season.name : '')} leaderboard…</div>`;
      else if (a.notFound) lead = `${alertBox(`No account called “${a.name}” on the ${a.season ? a.season.name : 'current'} leaderboard. Check the spelling on Arcus's points page (usually an adjective and an animal, like Rustic Owl) and try again.`)}${nameForm(a, 'Try again')}`;
      else lead = `<p class="pts-lede">Arcus only shows your own points when you're logged in, but its public leaderboard lists every account under a points name. Enter yours, exactly as it appears on <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Arcus's points page</a>, and your points, rank and tier load here every hour.</p>${nameForm(a)}`;
      return `${head}${err}<div class="grid g2">
        <section class="panel">${panelHead('star', 'Your Arcus points', a.season ? `${a.season.name}: ${count(a.season.addresses)} accounts, ${pts(a.season.totalPoints)} points handed out so far` : null)}<div class="pb">${lead}</div></section>
        ${manualCard('arcus:points', 'arcus', 'Or log your total by hand', 'points', a.manual)}
      </div>`;
    }
    const me = a.me;
    const hist = a.history;
    const c = a.cost;
    const tiers = (a.tiers || []).slice().reverse(); // Bronze -> Diamond
    return `${head}${err}
      <div class="grid g3">
        <section class="panel">
          ${panelHead('star', `Your points, ${a.season ? a.season.name : 'this season'}`, `Rank ${count(me.rank)} of ${count(me.of)} accounts`, `<button class="btn btn-ghost btn-sm" data-open-settings="points" title="Change your points name">${PT.icon('settings', 'sm')}${esc(a.name)}</button>`)}
          <div class="pb">
            <div class="big">${counter('a-total2', me.points)}<small>points</small></div>
            ${tiers.length ? `<ol class="ladder tiers">${tiers.map((t) => `<li class="${t === me.tier ? 'now' : ''}"><span>${esc(t)}</span></li>`).join('')}</ol>` : ''}
            ${kv([
              ['Share of all points so far', esc(share(me.share))],
              a.season ? ['Handed out this season', esc(pts(a.season.totalPoints))] : null,
              ['Handed out each week', esc(pts(a.weeklyPool))],
              ...a.past.map((s) => [`${s.season}`, esc(`Rank ${count(s.rank)} of ${count(s.total)}${s.tier ? `, ${s.tier}` : ''}${s.points != null ? `, ${pts(s.points)} points` : ''}`)]),
            ])}
          </div>
        </section>
        <section class="panel">
          ${panelHead('calendar', 'This points week', 'Wednesday 3 PM to Wednesday 3 PM, New York time')}
          <div class="pb">
            <div class="big sm"><span data-countdown="${a.nextDrop}" data-full>${esc(PT.countdown(a.nextDrop - Date.now(), true))}</span><small>to the next drop</small></div>
            ${kv([
              ['Next drop', esc(PT.localWhen(a.nextDrop))],
              a.lastDrop ? ['Last drop', esc(PT.localWhen(a.lastDrop))] : null,
              ['Your Arcus volume so far', esc(money(a.current.volume, { dp: 0 }))],
              ['Your Arcus fees so far', esc(money(a.current.fees, { dp: 2 }))],
              hist.length && Number.isFinite(hist[0].perTenK) ? ['Last drop, points per $10K', esc(PT.plain(hist[0].perTenK, 2))] : null,
            ])}
          </div>
        </section>
        <section class="panel">
          ${panelHead('receipt', 'What points cost you', `Your Arcus fees since ${a.season ? a.season.name : 'the season'} started`)}
          <div class="pb">
            ${c ? `<div class="big sm">${counter('a-cost', c.feesPer1k, 'money')}<small>per 1,000 points</small></div>` : `<div class="big sm muted">–</div>`}
            ${kv([
              c ? ['Fees this season', esc(money(c.fees, { dp: 2 }))] : null,
              c ? ['Volume this season', esc(money(c.volume, { dp: 0 }))] : null,
              ['Points per $10K volume', esc(c && Number.isFinite(c.perTenK) ? PT.plain(c.perTenK, 2) : '–')],
              ['Fees on Arcus, all time', esc(money(p.lifetime.fees, { dp: 2 }))],
            ])}
          </div>
        </section>
      </div>
      <section class="panel">
        ${panelHead('table', 'Drop by drop', 'Your total after each weekly drop, read from the leaderboard; the tracker keeps one reading per drop from the day you set your name')}
        <div class="table-wrap">${hist.length ? `<table><thead><tr><th>Drop</th><th>Week traded</th><th class="num">Points after</th><th class="num">Gained</th><th class="num" title="What the estimate gives for that week, worked out from the weeks before it only">Model</th><th class="num">Rank</th><th>Tier</th><th class="num">Your volume</th><th class="num">Fees</th><th class="num">Points per $10K</th><th class="num">Fees per 1K</th></tr></thead><tbody>${hist
          .map(
            (h) => `<tr><td class="mono">${esc(h.distributedAt ? PT.localWhen(h.distributedAt) : h.week)}</td><td class="mono">${esc(h.start ? `${PT.dateShort(h.start)} – ${PT.dateShort(h.end)}` : '–')}</td><td class="num"><b>${esc(pts(h.points))}</b></td><td class="num">${h.gained == null ? '<span class="muted" title="The first reading only shows the gain when it is the season’s first drop">–</span>' : esc(`+${pts(h.gained)}`)}</td><td class="num">${Number.isFinite(h.model) ? `${esc(pts(h.model))} <span class="${Math.abs(h.modelErr) < 0.2 ? 'pos' : 'muted'}">${esc(signedPct(h.modelErr))}</span>` : '<span class="muted">–</span>'}</td><td class="num">${esc(count(h.rank))}</td><td>${esc(h.tier || '–')}</td><td class="num">${esc(h.volume == null ? '–' : money(h.volume, { dp: 0 }))}</td><td class="num">${esc(h.fees == null ? '–' : money(h.fees, { dp: 2 }))}</td><td class="num">${esc(Number.isFinite(h.perTenK) ? PT.plain(h.perTenK, 2) : '–')}</td><td class="num">${esc(Number.isFinite(h.feesPer1k) ? money(h.feesPer1k, { dp: 2 }) : '–')}</td></tr>`
          )
          .join('')}</tbody></table>` : `<div class="empty">${PT.icon('calendar')}The first reading is saved at the next drop.</div>`}</div>
      </section>`;
  }

  // ---------- Entropy (not live yet) ----------
  function entropySection(p) {
    const d = p.data;
    const chips = `<span class="chip">${PT.icon('clock')}Not live yet</span>`;
    const act = d.activity;
    const body = p.hasWallet
      ? `<p class="pts-lede">When Entropy launches points they'll show up here. Programs often look back at earlier trading, so this is what your account has done on Entropy so far.</p>
        ${kv([
          ['Volume', esc(money(p.lifetime.volume, { dp: 0 }))],
          ['Fees paid', esc(money(p.lifetime.fees, { dp: 2 }))],
          ['Maker volume', esc(money(act.makerVolume, { dp: 0 }))],
          ['Trades', esc(count(act.fills))],
          ['Days traded', esc(count(act.activeDays))],
          ['First trade', esc(act.firstTs ? PT.localWhen(act.firstTs) : '–')],
        ])}`
      : `<div class="venue-empty" style="padding:4px 0 6px">${PT.icon('wallet', 'lg')}<div>Add your Entropy wallet so your trading is on record before points launch.</div><button class="btn btn-primary btn-sm" data-open-wallets>${PT.icon('plus', 'sm')}Add wallet</button></div>`;
    return `${sectionHead(p, chips)}<div class="grid g2">
      <section class="panel">${panelHead('activity', 'Your Entropy trading so far', 'Only trades placed on entropy.io count')}<div class="pb">${body}</div></section>
      ${manualCard('entropy:points', 'entropy', 'Log Entropy points', 'points', d.manual)}
    </div>`;
  }

  // ---------- manual logs ----------
  function manualCard(series, exchange, title, unit, s) {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const latest = s.latest;
    const life = s.lifetime;
    const history = s.rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Logged</th><th class="num">Total</th><th class="num">Gained</th><th class="num">Fees</th><th class="num">Per 1K</th><th><span class="sr-only">Delete</span></th></tr></thead><tbody>${s.rows
          .slice(0, 8)
          .map(
            (r) => `<tr><td class="mono">${esc(PT.dateShort(r.at))}</td><td class="num">${esc(pts(r.value))}</td><td class="num">${r.first ? '<span class="muted" title="First log: counts everything up to this date">first</span>' : esc(`+${pts(r.gained)}`)}</td><td class="num">${esc(money(r.fees, { dp: 2 }))}</td><td class="num">${r.costPer1k == null ? '–' : esc(money(r.costPer1k, { dp: 2 }))}</td><td class="num"><button class="rm" data-del="${esc(r.id)}" title="Delete this log" aria-label="Delete the ${esc(PT.dateShort(r.at))} log">${PT.icon('trash', 'sm')}</button></td></tr>`
          )
          .join('')}</tbody></table></div>`
      : '';
    return `<section class="panel pts">
      ${panelHead('plus', title, latest ? `Last logged ${PT.ago(latest.at)}: ${pts(latest.value)} ${unit}` : `Copy your total from ${NAMES[exchange]} when it shows one`)}
      <div class="pb" style="padding-bottom:${history ? 0 : 18}px">
        ${life ? kv([['Fees up to the last log', esc(money(life.fees, { dp: 2 }))], ['Cost per 1,000 points', esc(money(life.costPer1k, { dp: 2 }))]]) : ''}
        <form class="pts-form" data-form="${esc(series)}" style="margin:${life ? 12 : 0}px 0 0">
          <input type="number" min="0" step="any" inputmode="decimal" placeholder="Current ${esc(unit)} total" aria-label="${esc(`${NAMES[exchange]} ${unit} total`)}" required>
          <input type="date" value="${iso}" max="${iso}" aria-label="As of date">
          <button class="btn btn-primary btn-sm" type="submit">${PT.icon('plus', 'sm')}Log</button>
        </form>
        <div class="pts-error" data-err="${esc(series)}" style="margin:6px 0 0"></div>
      </div>
      ${history}
    </section>`;
  }

  // ---------- charts ----------
  function drawCharts() {
    const host = $('#pts-bulk-chart');
    const b = prog('bulk');
    if (!host || !b || !b.data) return;
    const weeks = b.data.weeks;
    PT.stackedColumns(host, {
      labels: weeks.map((w) => `Week ${w.week}`),
      series: [
        { name: 'Trading', color: 'var(--aura-trade)', values: weeks.map((w) => w.trading + w.maker + w.boost + w.other) },
        ...(weeks.some((w) => w.gauntlet > 0) ? [{ name: 'Gauntlet', color: 'var(--lg-challenger)', values: weeks.map((w) => w.gauntlet || 0) }] : []),
        { name: 'Referrals', color: 'var(--aura-ref)', values: weeks.map((w) => w.referrals) },
      ],
      fmt: (v) => `${pts(v)} AURA`,
      axisFmt: (v) => PT.plain(v, 0),
      title: (i) => `Week ${weeks[i].week}: ${PT.dateShort(weeks[i].start)} – ${PT.dateShort(weeks[i].end)}`,
      height: 210,
      empty: 'No mainnet AURA yet.',
      aria: 'AURA per mainnet week: trading, gauntlet and referrals',
    });
  }

  // ---------- events ----------
  function wire(main) {
    $$('[data-bookmarklet]', main).forEach((el) => {
      el.onclick = (ev) => {
        ev.preventDefault();
        el.classList.add('nudge');
        el.title = 'Drag this button to your bookmarks bar, then click it on app.bulk.trade';
        el.innerHTML = `${PT.icon('star', 'sm')}Drag me to your bookmarks bar`;
        setTimeout(() => el.classList.remove('nudge'), 900);
      };
    });
    $$('form[data-form]', main).forEach((f) => {
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const series = f.dataset.form;
        const [numEl, dateEl] = $$('input', f);
        const err = $(`[data-err="${CSS.escape(series)}"]`, main);
        const value = Number(numEl.value);
        if (!numEl.value || !Number.isFinite(value) || value < 0) {
          err.textContent = 'Enter your current total as a number.';
          return;
        }
        let at = Date.now();
        if (dateEl.value) {
          const [y, m, d] = dateEl.value.split('-').map(Number);
          at = Math.min(Date.now(), new Date(y, m - 1, d, 23, 59, 59).getTime());
        }
        try {
          await PT.post('/api/points', { series, value, at });
          err.textContent = '';
          await load(true);
        } catch (e) {
          err.textContent = e.message;
        }
      };
    });
    $$('button[data-del]', main).forEach((b) => {
      b.onclick = async () => {
        try {
          await PT.post('/api/points/delete', { id: b.dataset.del });
          await load(true);
        } catch {}
      };
    });
    $$('form[data-arcus-name]', main).forEach((f) => {
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const name = $('input', f).value.trim();
        const err = $('[data-arcus-err]', main);
        if (!name) {
          err.textContent = 'Enter your points name.';
          return;
        }
        const btn = $('button', f);
        btn.disabled = true;
        try {
          PT.state = await PT.post('/api/settings', { arcusPointsName: name });
          PT.kick && PT.kick();
          await load(true);
        } catch (e) {
          err.textContent = e.message;
        } finally {
          btn.disabled = false;
        }
      };
    });
    $$('form[data-bulk-paste]', main).forEach((f) => {
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const box = $('textarea', f);
        const err = $('[data-paste-err]', f.parentElement);
        if (!box.value.trim()) {
          err.textContent = 'Paste the page you copied first.';
          return;
        }
        const btn = $('button', f);
        btn.disabled = true;
        try {
          const r = await PT.post('/api/points/bulk-import', { text: box.value });
          const parts = [];
          if (r.wallet) parts.push('your AURA');
          if (r.weeks && r.weeks.length) parts.push(`week ${r.weeks.join(', ')} results`);
          pasteMsg = { at: Date.now(), text: `Saved ${parts.join(' and ')}.${r.wallet ? '' : ' Paste your AURA page too to see your totals.'}` };
          box.value = '';
          await load(true);
        } catch (e) {
          err.textContent = e.message;
        } finally {
          btn.disabled = false;
        }
      };
    });
    $$('button[data-copy]', main).forEach((b) => {
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          b.innerHTML = PT.icon('check', 'sm');
          setTimeout(() => (b.innerHTML = PT.icon('copy', 'sm')), 1400);
        } catch {}
      };
    });
  }

  // Countdowns and week bars move every second while the page is open.
  function tick() {
    const view = $('#view-points');
    if (!view || view.hidden) return;
    PT.tickCountdowns(view);
    const now = Date.now();
    $$('.drop .track[data-from]', view).forEach((t) => {
      const a = Number(t.dataset.from);
      const b = Number(t.dataset.to);
      t.firstElementChild.style.width = `${Math.min(100, Math.max(0, ((now - a) / (b - a)) * 100)).toFixed(2)}%`;
    });
    // A drop has landed: fetch the new numbers.
    if (data && data.drops.some((d) => d.at <= now - 60000) && !loading && now - (tick.lastReload || 0) > 120000) {
      tick.lastReload = now;
      load(true);
    }
  }
  setInterval(tick, 1000);

  PT.points = { load, redraw: () => data && drawCharts() };
})();
