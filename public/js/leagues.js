/* Leagues: Bulk's Challenger Series (season 1: league cash every AURA Saturday, 17 Oct to 5 Dec).
   Bulk pays 12.5% of its net fees to the top trading leagues, split within each league pro-rata by
   trading AURA. What the pool should be this week, what each league gets, your share at the pace
   you're on, what the next league up would take, and (after a payout) what it actually paid you. */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc, money, compact, count } = PT;
  const DOT = { challenger: 'var(--lg-challenger)', diamond: 'var(--lg-diamond)', platinum: 'var(--lg-platinum)', gold: 'var(--lg-gold)' };
  const WEEK = 7 * 24 * 3600 * 1000;
  let data = null;
  let loading = false;

  const usd = (n) => (n == null || !Number.isFinite(n) ? '–' : money(n, { dp: n >= 100 ? 0 : 2 }));
  const dot = (id) => `<i class="lg-dot" style="background:${DOT[id] || 'var(--ink-4)'}"></i>`;
  const pctTxt = (x) => `${(x * 100).toFixed(x * 100 < 10 ? 1 : 0)}%`;

  async function load() {
    if (loading) return;
    loading = true;
    try {
      data = await PT.getJSON('/api/leagues');
      render();
    } catch (e) {
      if (!data) $('#lg-main').innerHTML = `<div class="panel"><div class="empty">${PT.icon('alert')}${esc(`Couldn't load the leagues: ${e.message}`)}</div></div>`;
    } finally {
      loading = false;
    }
  }

  // This week's gauntlet: Bulk's 50,000 AURA side goal (set on the admin page) and your share of it.
  // The self-check: how past gauntlet estimates compared with what Bulk paid.
  function gauntletCheck(g) {
    const c = g.calibration;
    if (!c) return '';
    const bits = [];
    if (c.last) bits.push(`Last checked gauntlet${c.last.title ? ` (${c.last.title})` : ''}: the tracker estimated ≈ ${count(c.last.estimated)} AURA for you, Bulk paid ${count(c.last.paid)}.`);
    if (c.checks && Math.abs(c.factor - 1) >= 0.02) bits.push(`Estimates are scaled ×${c.factor.toFixed(2)} from ${c.checks} result${c.checks === 1 ? '' : 's'} over ${c.weeks} week${c.weeks === 1 ? '' : 's'} across dashboards.`);
    else if (c.checks) bits.push(`Past results across dashboards match the estimate, so it isn’t scaled.`);
    else bits.push('After each reveal the tracker checks this against the gauntlet AURA Bulk actually paid, and corrects later estimates.');
    return `<p class="pl-note">${PT.icon('check', 'sm')}<span>${esc(bits.join(' '))}</span></p>`;
  }

  function gauntletPanel(g) {
    if (!g) return '';
    if (!g.set) return `<p class="lg-foot">${PT.icon('trophy', 'sm')}<span>${esc(`This week’s gauntlet (${(g.reward || 50000).toLocaleString('en-US')} AURA, announced on Saturday in Bulk’s Challenger tab) isn’t in the tracker yet. Once it is, your share is added to your league this week.`)}</span></p>`;
    const where = g.goal === 'markets' ? `Taker volume on ${g.markets.map((m) => m.replace(/-USD$/, '')).join(', ')}` : g.goalLabel;
    const stat = (label, value, sub) => `<div class="lg-stat"><span>${esc(label)}</span><b>${value}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
    let body;
    if (!g.measurable) body = `<p class="pl-note">${PT.icon('info', 'sm')}<span>${esc('The tracker can’t measure this goal from your trades, so it isn’t in your estimates. Your gauntlet AURA shows on the Points page after Bulk’s reveal.')}</span></p>`;
    else if (!g.totalKnown) body = `<p class="pl-note">${PT.icon('clock', 'sm')}<span>Waiting for Bulk’s volume on these markets to work out your share.</span></p>`;
    else
      body = `<div class="lg-stats">
        ${stat('Your goal volume', `≈ ${compact(g.yours.projected)}`, `${compact(g.yours.soFar)} so far, at your pace by Saturday`)}
        ${stat('Everyone’s', `≈ ${compact(g.total.projected)}`, `${compact(g.total.soFar)} so far on Bulk`)}
        ${stat('Your share', g.share > 0 ? `${(g.share * 100).toFixed(g.share < 0.01 ? 3 : 2)}%` : '–', 'Of the reward, split by results')}
        ${stat('Gauntlet AURA', `<span class="lv-gold">≈ ${count(Math.round(g.aura.projected))}</span>`, `≈ ${count(Math.round(g.aura.soFar))} so far · counts toward your league`)}
      </div>${gauntletCheck(g)}`;
    return `<section class="panel">
      <div class="ph"><div><h2 class="ph-title">${PT.icon('trophy')}This week’s gauntlet: ${esc(g.title)}</h2><p class="ph-sub">${esc(`${where} · ${g.reward.toLocaleString('en-US')} AURA split in proportion to results, out of Bulk’s weekly 1,000,000. It counts toward your league.${g.note ? ` ${g.note}` : ''}`)}</p></div></div>
      <div class="pb">${body}</div>
    </section>`;
  }

  function render() {
    const d = data;
    const main = $('#lg-main');
    if (!d.hasBulk) {
      main.innerHTML = `<div class="panel"><div class="empty">${PT.icon('trophy')}Add your Bulk wallet in Settings to see your share.<button class="btn btn-sm" data-open-wallets>${PT.icon('wallet', 'sm')}Add wallet</button></div></div>`;
      return;
    }
    const y = d.you;
    const mineId = y && y.projectedId;
    const parts = [];

    // ---- season over ----
    if (d.seasonOver) {
      parts.push(`<div class="panel pad"><div class="alert flat">${PT.icon('trophy')}<span>${esc(`Season 1’s regular season ended on ${PT.localWhen(d.lastPayout)}. The top traders go on to the Playoffs, which have their own prize pool: Bulk announces the format. Weekly league cash returns with the next season.`)}</span></div></div>`);
    }

    // ---- league numbers out of date ----
    if (d.source.stale) {
      parts.push(`<div class="panel pad"><div class="alert flat">${PT.icon('refresh')}<span>${esc(`League cutoffs are from ${PT.localWhen(d.source.at)}, so the leagues below are rough. Open app.bulk.trade and press your “Send AURA to tracker” bookmark (Points page): your next AURA update brings Bulk’s latest cutoffs.`)}</span></div></div>`);
    }

    // ---- board ----
    const shareSub = !y
      ? 'This week'
      : !y.qualified
        ? `Bulk’s leagues need ${usd(y.threshold || 10000)} of volume`
        : !y.inPool
          ? 'Gold and up share the pool'
          : y.belowMin
            ? `Under Bulk’s ${usd(d.minClaim)} minimum claim: it carries over until it reaches ${usd(d.minClaim)}`
            : y.vsAverage != null
              ? `${y.vsAverage.toFixed(2)}× the ${y.projected} average, pro-rata by your AURA`
              : 'Pro-rata by your trading AURA';
    parts.push(`<div class="board"><div class="board-row even">
      ${PT.cell({ icon: 'coins', label: 'Pool this week', value: d.pool != null ? `≈ ${compact(d.pool)}` : '–', sub: d.seasonOver ? 'Regular season over' : d.fees != null ? `12.5% of ≈ ${compact(d.fees)} in Bulk’s net fees` : 'Waiting for Bulk’s volume' })}
      <div class="cell"><span class="cell-l">${PT.icon('trophy')}Your league this week</span><span class="cell-v lg-you">${y ? (y.projected ? `${dot(mineId)}${esc(y.projected)}` : esc(y.qualified ? 'Below Gold' : 'Not qualified')) : '–'}</span><span class="cell-s">${esc(y ? `≈ ${count(Math.round(y.endAura))} AURA by Saturday${y.rank ? ` · was #${count(y.rank)} of ${count(y.population)}` : ''}` : 'Import your AURA on the Points page')}</span></div>
      <div class="cell"><span class="cell-l">${PT.icon('sparkles')}Your share</span><span class="cell-v ${y && y.inPool ? 'lv-gold' : ''}">${y ? (y.inPool ? `≈ ${esc(usd(y.each))}` : 'None yet') : '–'}</span><span class="cell-s">${esc(shareSub)}</span></div>
      <div class="cell"><span class="cell-l">${PT.icon('clock')}Paid in</span>${d.payAt ? `<span class="cell-v" data-countdown="${d.payAt}">${esc(PT.countdown(d.payAt - Date.now()))}</span><span class="cell-s">${esc(`Week ${d.week} of ${d.seasonWeeks} · ${PT.localWhen(d.payAt)}`)}</span>` : '<span class="cell-v">–</span><span class="cell-s">No payout scheduled</span>'}</div>
    </div></div>`);

    // ---- this week's gauntlet ----
    parts.push(gauntletPanel(d.gauntlet));

    // ---- who gets what ----
    const rows = d.leagues
      .map((l) => {
        const share = l.weight ? `${pctTxt(l.potShare)} <span class="muted">of 30%</span>` : pctTxt(l.potShare);
        return `<tr class="${l.id === mineId ? 'lg-mine' : ''}"><td><span class="lg-name">${dot(l.id)}${esc(l.name)}</span>${l.id === mineId ? ' <span class="chip gold">You</span>' : ''}</td><td class="num">${l.ranks ? `${count(l.ranks[0])}–${count(l.ranks[1])}` : '–'}</td><td class="num">${count(l.wallets)}</td><td class="num">${share}</td><td class="num"><b class="lv-gold">${l.each != null ? `≈ ${esc(usd(l.each))}` : '–'}</b></td><td class="num">${l.typicalAura != null ? count(l.typicalAura) : '–'}</td><td class="num">${l.cutoff != null ? count(l.cutoff) : '–'}</td></tr>`;
      })
      .join('');
    parts.push(`<section class="panel">
      <div class="ph ruled"><div><h2 class="ph-title">${PT.icon('list')}Who gets what this week</h2><p class="ph-sub">Within each league Bulk splits its share pro-rata by trading AURA, so a wallet above its league’s typical AURA gets more than the average. Platinum and Gold share 30%, a Platinum wallet averaging twice a Gold one.</p></div></div>
      <div class="table-wrap"><table class="lg-table"><thead><tr><th>League</th><th class="num">Ranks</th><th class="num">Wallets</th><th class="num">Share of pool</th><th class="num">≈ Average each</th><th class="num" title="A typical wallet's trading AURA in this league, between its cutoffs">Typical AURA</th><th class="num" title="Trading AURA the last wallet in the league had at the last reveal">AURA cutoff</th></tr></thead><tbody>${rows}<tr class="lg-none"><td colspan="7">Silver (top 25–50%) and Bronze get no share. Challenger also qualifies for the Playoffs.</td></tr></tbody></table></div>
    </section>`);

    // ---- the next league up ----
    if (y && y.next) {
      const n = y.next;
      const stat = (label, value, sub) => `<div class="lg-stat"><span>${esc(label)}</span><b>${value}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
      parts.push(`<section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('trending')}Next: ${dot(n.id)}${esc(n.league)}</h2><p class="ph-sub">${esc(`Its cutoff was ${count(n.cutoff)} trading AURA at the last reveal. Bulk ranks total trading AURA (gauntlets included), so cutoffs rise a little every week.`)}</p></div></div>
        <div class="pb"><div class="lg-stats">
          ${stat('You need', `${count(Math.round(n.need))} AURA`, `You have ${count(y.tradingAura)}${y.pending > 0 ? ` + ≈ ${count(Math.round(y.pending))} revealed, not imported` : ''}`)}
          ${stat('This week adds', n.week > 0 ? `≈ ${count(Math.round(n.week))}` : '–', 'At your pace, by Saturday')}
          ${n.gap > 0 ? stat('Still short', `≈ ${count(Math.round(n.gap))} AURA`, n.volume != null ? `≈ ${compact(n.volume)} more taker volume, ${usd(n.fees)} in fees` : '') : stat('Still short', '<span class="pos">None</span>', 'On track if the cutoff holds')}
          ${stat('It pays', n.extra != null ? `<span class="lv-gold">${n.extra >= 0 ? '+' : '−'}${esc(usd(Math.abs(n.extra)))}</span>` : '–', 'This week, against your share now')}
        </div></div>
      </section>`);
    }

    // ---- payouts (from the first one on) ----
    if (Date.now() >= d.firstPayout) {
      const last = Math.min(d.lastPayout, d.firstPayout + Math.floor((Date.now() - d.firstPayout) / WEEK) * WEEK); // the latest payout so far
      const logged = d.received.find((r) => r.payoutAt === last);
      const list = d.received
        .map((r) => `<li><span>${esc(PT.localWhen(r.payoutAt))}${r.league ? ` · ${esc(r.league)}` : ''}</span><b>${esc(usd(r.amount))}</b><em>${r.estimated != null ? esc(`estimated ${usd(r.estimated)}`) : ''}</em><button type="button" class="icon-btn" data-lg-remove="${r.payoutAt}" aria-label="Remove">${PT.icon('x', 'sm')}</button></li>`)
        .join('');
      parts.push(`<section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('receipt')}Payouts</h2><p class="ph-sub">Log what each payout paid you (USDC, claimable from ${esc(usd(d.minClaim))}): the pool estimate corrects itself from it.</p></div></div>
        <div class="pb">
          <form class="lg-form" id="lg-form" data-payout="${last}"><label for="lg-amount">${esc(`Received on ${PT.localWhen(last)}`)}</label><input id="lg-amount" type="number" min="0" step="0.01" placeholder="$ amount" value="${logged ? logged.amount : ''}"><button type="submit" class="btn btn-sm">${PT.icon('check', 'sm')}Save</button><span class="ds-msg" id="lg-msg" role="status"></span></form>
          ${list ? `<ul class="lg-paid">${list}</ul>` : ''}
        </div>
      </section>`);
    }

    // ---- where the numbers come from ----
    const src = d.source.kind === 'import' ? `Bulk’s reveal of ${PT.localWhen(d.source.at)} (from your AURA import)` : `Bulk’s leaderboard on ${PT.localWhen(d.source.at)}`;
    const trad = d.tradShare != null ? `; ${pctTxt(d.tradShare)} of this week’s volume is on TradFi markets` : '';
    parts.push(`<p class="lg-foot">${PT.icon('info', 'sm')}<span>${esc(`Rules (Bulk’s docs): leagues by trading AURA rank, $10K of volume to qualify; the pool is 12.5% of Bulk’s net fees (trading fees minus maker rebates), split pro-rata by trading AURA within each league; claims from ${usd(d.minClaim)}; market makers aren’t eligible and wash-trading or Sybil accounts are excluded. Estimates: cutoffs from ${src}, ${count(d.population)} ranked traders; Bulk’s net fees at ${d.netBps.crypto.toFixed(2)} bps of crypto volume and ${d.netBps.tradfi.toFixed(2)} bps on stocks, ETFs and indices${trad}${d.calibrated ? ' (corrected from your payouts)' : ''}; each league’s total AURA from its cutoffs.`)}</span></p>`);

    main.innerHTML = parts.join('');
    const form = $('#lg-form', main);
    if (form)
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const msg = $('#lg-msg', main);
        try {
          data = await PT.post('/api/leagues/received', { payoutAt: Number(form.dataset.payout), amount: Number($('#lg-amount', main).value) });
          render();
          $('#lg-msg').textContent = 'Saved.';
        } catch (e) {
          msg.textContent = e.message;
        }
      });
    main.querySelectorAll('[data-lg-remove]').forEach((b) =>
      b.addEventListener('click', async () => {
        data = await PT.post('/api/leagues/received', { payoutAt: Number(b.dataset.lgRemove), remove: true });
        render();
      })
    );
  }

  setInterval(() => {
    if (location.hash.replace('#', '') === 'leagues') PT.tickCountdowns($('#lg-main'));
  }, 1000);

  PT.leagues = { load };
})();
