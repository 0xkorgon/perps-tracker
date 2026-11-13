/* Leagues: Bulk's Challenger Series. Every AURA Saturday from 17 Oct, Bulk pays 12.5% of its net
   fees to the top trading leagues. What the pool should be this week, what each league's wallets get,
   your share, what the next league up would take, and (after a payout) what it actually paid you. */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc, money, compact, count } = PT;
  const DOT = { challenger: 'var(--lg-challenger)', diamond: 'var(--lg-diamond)', platinum: 'var(--lg-platinum)', gold: 'var(--lg-gold)' };
  let data = null;
  let loading = false;

  const usd = (n) => (n == null || !Number.isFinite(n) ? '–' : money(n, { dp: n >= 100 ? 0 : 2 }));
  const dot = (id) => `<i class="lg-dot" style="background:${DOT[id] || 'var(--ink-4)'}"></i>`;

  async function load(force = false) {
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

  function render() {
    const d = data;
    const main = $('#lg-main');
    if (!d.hasBulk) {
      main.innerHTML = `<div class="panel"><div class="empty">${PT.icon('trophy')}Add your Bulk wallet in Settings to see your share.<button class="btn btn-sm" data-open-wallets>${PT.icon('wallet', 'sm')}Add wallet</button></div></div>`;
      return;
    }
    const y = d.you;
    const mineId = y ? String(y.league).toLowerCase() : null;
    const parts = [];

    // ---- board ----
    parts.push(`<div class="board"><div class="board-row even">
      ${PT.cell({ icon: 'coins', label: 'Pool this week', value: d.pool != null ? `≈ ${compact(d.pool)}` : '–', sub: d.fees != null ? `12.5% of ≈ ${compact(d.fees)} in Bulk fees` : 'Waiting for Bulk’s volume' })}
      <div class="cell"><span class="cell-l">${PT.icon('trophy')}Your league</span><span class="cell-v lg-you">${y ? `${dot(mineId)}${esc(y.league)}` : '–'}</span><span class="cell-s">${esc(y ? `Rank ${count(y.rank)} of ${count(y.population)}` : 'Import your AURA on the Points page')}</span></div>
      <div class="cell"><span class="cell-l">${PT.icon('sparkles')}Your share</span><span class="cell-v ${y && y.inPool ? 'lv-gold' : ''}">${y ? (y.inPool ? `≈ ${esc(usd(y.each))}` : 'None yet') : '–'}</span><span class="cell-s">${esc(y && y.inPool && y.covers != null ? `≈ ${Math.round(y.covers * 100)}% of your Bulk fees this week` : y && !y.inPool ? 'Gold and up share the pool' : 'This week, if the estimate holds')}</span></div>
      <div class="cell"><span class="cell-l">${PT.icon('clock')}Paid in</span><span class="cell-v" data-countdown="${d.payAt}">${esc(PT.countdown(d.payAt - Date.now()))}</span><span class="cell-s">${esc(PT.localWhen(d.payAt))}</span></div>
    </div></div>`);

    // ---- who gets what ----
    const rows = d.leagues
      .map((l) => {
        const share = l.weight ? `30% · ${l.weight} share${l.weight > 1 ? 's' : ''}` : `${Math.round(l.share * 100)}%`;
        return `<tr class="${l.id === mineId ? 'lg-mine' : ''}"><td><span class="lg-name">${dot(l.id)}${esc(l.name)}</span>${l.id === mineId ? ' <span class="chip gold">You</span>' : ''}</td><td class="num">${l.ranks ? `${count(l.ranks[0])}–${count(l.ranks[1])}` : '–'}</td><td class="num">${count(l.wallets)}</td><td class="num">${esc(share)}</td><td class="num"><b class="lv-gold">${l.each != null ? `≈ ${esc(usd(l.each))}` : '–'}</b></td><td class="num">${l.cutoff != null ? count(l.cutoff) : '–'}</td></tr>`;
      })
      .join('');
    parts.push(`<section class="panel">
      <div class="ph ruled"><div><h2 class="ph-title">${PT.icon('list')}Who gets what this week</h2><p class="ph-sub">Platinum and Gold split 30%: each Platinum wallet gets twice a Gold wallet’s share.</p></div></div>
      <div class="table-wrap"><table class="lg-table"><thead><tr><th>League</th><th class="num">Ranks</th><th class="num">Wallets</th><th class="num">Share of pool</th><th class="num">≈ Each</th><th class="num" title="Trading AURA the last wallet in the league had">AURA cutoff</th></tr></thead><tbody>${rows}<tr class="lg-none"><td colspan="6">Silver and below get no share.</td></tr></tbody></table></div>
    </section>`);

    // ---- the next league up ----
    if (y && y.next) {
      const n = y.next;
      const stat = (label, value, sub) => `<div class="lg-stat"><span>${esc(label)}</span><b>${value}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
      parts.push(`<section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('trending')}Next: ${dot(n.league.toLowerCase())}${esc(n.league)}</h2><p class="ph-sub">${esc(`Its cutoff is ${count(n.cutoff)} trading AURA and rises a little each week as everyone trades.`)}</p></div></div>
        <div class="pb"><div class="lg-stats">
          ${stat('You need', `${count(Math.round(n.need))} AURA`, `You have ${count(y.tradingAura)}`)}
          ${stat('This week adds', n.week > 0 ? `≈ ${count(Math.round(n.week))}` : '–', 'At your pace, by Saturday')}
          ${n.gap > 0 ? stat('Still short', `≈ ${count(Math.round(n.gap))} AURA`, n.volume != null ? `≈ ${compact(n.volume)} more volume, ${usd(n.fees)} in fees` : '') : stat('Still short', '<span class="pos">None</span>', 'On track if the cutoff holds')}
          ${stat('It pays', n.extra != null ? `<span class="lv-gold">+${esc(usd(n.extra))}</span>` : '–', 'More each week than now')}
        </div></div>
      </section>`);
    }

    // ---- payouts (from the first one on) ----
    if (Date.now() >= d.firstPayout) {
      const WEEK = 7 * 24 * 3600 * 1000;
      const last = d.firstPayout + Math.floor((Date.now() - d.firstPayout) / WEEK) * WEEK; // the latest payout so far
      const logged = d.received.find((r) => r.payoutAt === last);
      const list = d.received
        .map((r) => `<li><span>${esc(PT.localWhen(r.payoutAt))}${r.league ? ` · ${esc(r.league)}` : ''}</span><b>${esc(usd(r.amount))}</b><em>${r.estimated != null ? esc(`estimated ${usd(r.estimated)}`) : ''}</em><button type="button" class="icon-btn" data-lg-remove="${r.payoutAt}" aria-label="Remove">${PT.icon('x', 'sm')}</button></li>`)
        .join('');
      parts.push(`<section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('receipt')}Payouts</h2><p class="ph-sub">Log what each payout paid you: the estimate corrects itself from it.</p></div></div>
        <div class="pb">
          <form class="lg-form" id="lg-form" data-payout="${last}"><label for="lg-amount">${esc(`Received on ${PT.localWhen(last)}`)}</label><input id="lg-amount" type="number" min="0" step="0.01" placeholder="$ amount" value="${logged ? logged.amount : ''}"><button type="submit" class="btn btn-sm">${PT.icon('check', 'sm')}Save</button><span class="ds-msg" id="lg-msg" role="status"></span></form>
          ${list ? `<ul class="lg-paid">${list}</ul>` : ''}
        </div>
      </section>`);
    }

    // ---- where the numbers come from ----
    const src = d.source.kind === 'import' ? `your AURA import (${PT.localWhen(d.source.at)})` : `Bulk’s leaderboard (${PT.localWhen(d.source.at)}; your next AURA import updates them)`;
    parts.push(`<p class="lg-foot">${PT.icon('info', 'sm')}<span>${esc(`League sizes and cutoffs: ${src}. The pool assumes Bulk’s net fees are ${d.feeBps.toFixed(2)} bps of its volume${d.calibrated ? ' (corrected from your payouts)' : ''}, and each league’s share is split evenly between its wallets. Bulk hasn’t said how it splits within a league, so the first payout will show how close this is.`)}</span></p>`);

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
