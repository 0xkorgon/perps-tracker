/* Overview: volume, open interest and hold time per exchange. Data: state.stats */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc, money, compact, count, dur, ago, dateShort, dateTime, pct, NAMES, COLOR, ORDER } = PT;
  const RANGE_TAG = { '24h': '24H', '7d': '7D', '30d': '30D', all: 'all time' };
  const RANGE_TEXT = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'all tracked history' };
  const RANGE_MS = { '24h': 864e5, '7d': 6048e5, '30d': 2592e6, all: Infinity };

  let range = RANGE_TAG[PT.prefs.get('range')] ? PT.prefs.get('range') : '7d';
  let closedLimit = 25;
  let chartAsTable = false;

  function render(state) {
    const s = state.stats;
    if (!s) return;
    const exs = PT.activeExchanges();
    PT.seg($('#ov-range'), range, (v) => {
      range = v;
      PT.prefs.set('range', v);
      closedLimit = 25;
      render(state);
    });
    $('#ov-sub').textContent = `Showing ${RANGE_TEXT[range]} across ${exs.length === 1 ? NAMES[exs[0]] : `${exs.length} exchanges`}. Open interest is live.`;

    const t = s.totals.ranges[range];
    const oi = s.totals.oi;
    const tag = RANGE_TAG[range];
    const split = exs.map((id) => ({ name: NAMES[id], color: COLOR[id], v: Math.max(0, s.exchanges[id].ranges[range].volume || 0) }));
    $('#ov-board').innerHTML = `
      <div class="board-row">
        ${PT.leadCell({ icon: 'chart', label: `Volume, ${tag}`, value: compact(t.volume), sub: `${count(t.fills)} fills`, title: money(t.volume, { dp: 2 }) })}
        ${PT.cell({ icon: 'layers', label: oi.count ? `Open interest, ${oi.count} open` : 'Open interest now', value: compact(oi.notional), sub: oi.count ? `Long ${compact(oi.long)}, short ${compact(oi.short)}` : 'No open positions', title: money(oi.notional, { dp: 2 }) })}
        ${PT.cell({ icon: 'gauge', label: `Average OI, ${tag}`, value: compact(t.twOi), sub: 'Time-weighted' })}
        ${PT.cell({ icon: 'hourglass', label: `Average hold, ${tag}`, value: dur(t.avgHoldMs), sub: t.closed ? `Median ${dur(t.medianHoldMs)}` : 'No closed positions' })}
        ${PT.cell({ icon: 'receipt', label: `Fees, ${tag}`, value: money(t.fees, { dp: 2 }), sub: t.volume > 0 ? PT.bps((t.fees / t.volume) * 1e4) : '–' })}
      </div>
      ${exs.length > 1 ? `<div class="board-foot">${PT.shareBar(split)}</div>` : ''}`;

    $('#ov-venues').innerHTML = ORDER.map((id) => venueCard(state, id, s.exchanges[id])).join('');
    $('#ov-venues').onclick = (ev) => {
      const b = ev.target.closest('[data-dismiss-check]');
      if (!b) return;
      try {
        localStorage.setItem('perps.entropyCheck', b.dataset.dismissCheck);
      } catch {}
      render(state);
    };
    renderChart(s, exs);
    renderHold(t);
    renderHedges(s);
    renderPositions(state, s);
    renderClosed(state, s);
  }

  function renderHold(t) {
    $('#ov-hold-sub').textContent = t.closed ? `${count(t.closed)} closed in ${RANGE_TEXT[range]}` : `None closed in ${RANGE_TEXT[range]}`;
    $('#ov-hold').innerHTML = t.closed
      ? `${PT.hbars(
          t.buckets.map((b) => ({ label: b.label, value: b.count, color: 'var(--n-hi)' })),
          { aria: `Closed positions by hold time: ${t.buckets.map((b) => `${b.label} ${b.count}`).join(', ')}` }
        )}<dl class="kv" style="margin-top:16px"><dt>Average hold</dt><dd>${esc(dur(t.avgHoldMs))}</dd><dt>Median hold</dt><dd>${esc(dur(t.medianHoldMs))}</dd><dt>Most common</dt><dd>${esc(t.buckets.reduce((a, b) => (b.count > a.count ? b : a), t.buckets[0]).label)}</dd></dl>`
      : `<div class="empty">${PT.icon('hourglass')}Close a position to see how long you hold.</div>`;
  }

  function statusChip(id) {
    const ws = PT.walletStatuses(id);
    if (ws.some((x) => x.status.state === 'syncing')) return '<span class="chip"><span class="spinner"></span>Syncing</span>';
    if (ws.some((x) => x.status.state === 'error')) return `<span class="chip gold">${PT.icon('alert')}Needs attention</span>`;
    const times = ws.map((x) => x.status.syncedAt).filter(Boolean);
    return times.length ? `<span class="chip up">${PT.icon('check')}${esc(ago(Math.min(...times)))}</span>` : '<span class="chip">Waiting</span>';
  }

  function venueCard(state, id, e) {
    const meta = (state.exchanges || []).find((x) => x.id === id) || { appUrl: '#' };
    const has = PT.hasWallets(id);
    const head = `<div class="venue-head">${PT.exm(id, 'lg')}<h3>${esc(NAMES[id])}</h3><a class="open" href="${esc(meta.appUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(NAMES[id])}" aria-label="Open ${esc(NAMES[id])} in a new tab">${PT.icon('external')}</a>${has ? statusChip(id) : ''}</div>`;
    if (!has || !e) {
      return `<article class="panel venue">${head}<div class="venue-empty">No ${esc(NAMES[id])} wallet added yet.<button class="btn btn-sm" data-open-wallets>${PT.icon('plus', 'sm')}Add wallet</button></div></article>`;
    }
    const r = e.ranges[range];
    const statuses = PT.walletStatuses(id);
    const errors = statuses.filter((x) => x.status.state === 'error');
    const syncing = statuses.find((x) => x.status.state === 'syncing');
    const multi = statuses.length > 1;
    const labelOf = (w) => w.label || `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;
    const subs = e.wallets.reduce((a, w) => a + ((w.subAccounts || []).length || 0), 0);
    const idx = e.wallets.flatMap((w) => (w.accountIndexes || []).filter((i) => i !== 0));
    let line = `${statuses.length} wallet${statuses.length > 1 ? 's' : ''}`;
    if (subs) line += ` and ${subs} sub-account${subs > 1 ? 's' : ''}`;
    if (idx.length) line += `, including sub-account${idx.length > 1 ? 's' : ''} ${idx.join(', ')}`;
    if (e.firstTs) line += `. History from ${dateShort(e.firstTs)}`;
    const foot = [`<span>${PT.icon('wallet')}${esc(line)}</span>`];
    if (id === 'entropy') foot.push(`<span>${PT.icon('info')}Counts trades placed on entropy.io, on any Hyperliquid market</span>`);
    if (e.official) {
      const off = range === 'all' ? e.official.lifetimeVolume : e.official.windows[range];
      if (Number.isFinite(off) && off > 0) {
        const diff = Math.abs(off - r.volume) / off;
        foot.push(diff <= 0.01 ? `<span class="ok">${PT.icon('passed')}Matches ${esc(NAMES[id])}'s own volume figure</span>` : `<span>${PT.icon('info')}${esc(NAMES[id])} reports ${esc(compact(off))} for this range${syncing ? ' (still syncing)' : ''}</span>`);
      }
    }
    if (syncing) foot.push(`<span class="inline-progress"><span class="spinner"></span>${esc(multi ? `${labelOf(syncing.wallet)}: ` : '')}${esc(syncing.status.progress || 'syncing')}</span>`);
    const errHtml = errors.map((x) => `<div class="alert">${PT.icon('alert')}<span>${multi ? `<b>${esc(labelOf(x.wallet))}:</b> ` : ''}${esc(x.status.error)}</span></div>`).join('') + trackingAlerts(e, multi);
    const maker = r.volume > 0 ? r.makerVolume / r.volume : null;
    const equity = e.wallets.reduce((a, w) => (Number.isFinite(w.equity) ? (a || 0) + w.equity : a), null);
    return `<article class="panel venue">
      ${head}
      <div class="trio">
        <div title="${esc(money(r.volume, { dp: 2 }))}"><span class="l">Volume, ${esc(RANGE_TAG[range])}</span><span class="v">${esc(compact(r.volume))}</span><span class="n">${esc(`${count(r.fills)} fills`)}</span></div>
        <div title="${esc(money(e.oi.notional, { dp: 2 }))}"><span class="l">OI now</span><span class="v">${esc(compact(e.oi.notional))}</span><span class="n">${esc(e.oi.count ? `${e.oi.count} position${e.oi.count > 1 ? 's' : ''}` : 'nothing open')}</span></div>
        <div><span class="l">Average hold</span><span class="v">${esc(dur(r.avgHoldMs))}</span><span class="n">${r.closed ? esc(`median ${dur(r.medianHoldMs)}`) : 'no closes yet'}</span></div>
      </div>
      <dl class="rows">
        <div><dt>Average OI</dt><dd>${esc(compact(r.twOi))}</dd></div>
        <div><dt>Closed</dt><dd>${esc(count(r.closed))}</dd></div>
        <div><dt>Fees paid</dt><dd>${esc(money(r.fees, { dp: 2 }))}</dd></div>
        <div><dt>Maker share</dt><dd>${maker == null ? '–' : esc(pct(maker, 0))}</dd></div>
        ${equity != null ? `<div><dt>Account value</dt><dd>${esc(money(equity, { dp: equity >= 1000 ? 0 : 2 }))}</dd></div>` : ''}
      </dl>
      ${errHtml}
      <div class="venue-foot">${foot.join('')}</div>
    </article>`;
  }

  function renderChart(s, exs) {
    $('#ov-chart-legend').innerHTML = exs.length > 1 ? exs.map((id) => `<span><i class="key" style="background:${COLOR[id]}"></i>${esc(NAMES[id])}</span>`).join('') : '';
    const btn = $('#ov-chart-table');
    btn.innerHTML = chartAsTable ? `${PT.icon('chart', 'sm')}Chart` : `${PT.icon('table', 'sm')}Table`;
    btn.setAttribute('aria-pressed', String(chartAsTable));
    btn.onclick = () => {
      chartAsTable = !chartAsTable;
      renderChart(s, exs);
    };
    $('#ov-chart').hidden = chartAsTable;
    $('#ov-chart-tbl').hidden = !chartAsTable;
    const labels = s.daily.map((d) => PT.dayLabel(d.day));
    if (chartAsTable) {
      const rows = s.daily
        .slice()
        .reverse()
        .map((d) => {
          const total = exs.reduce((a, id) => a + (d.values[id] || 0), 0);
          return `<tr><td>${esc(PT.dayLabel(d.day))}</td>${exs.map((id) => `<td class="num">${esc(money(d.values[id] || 0, { dp: 2 }))}</td>`).join('')}<td class="num"><b>${esc(money(total, { dp: 2 }))}</b></td></tr>`;
        })
        .join('');
      $('#ov-chart-tbl').innerHTML = `<table><thead><tr><th>Day</th>${exs.map((id) => `<th class="num">${esc(NAMES[id])}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>`;
      return;
    }
    PT.stackedColumns($('#ov-chart'), {
      labels,
      series: exs.map((id) => ({ name: NAMES[id], color: COLOR[id], values: s.daily.map((d) => d.values[id] || 0) })),
      fmt: (v) => money(v, { dp: 2 }),
      empty: 'No volume in the last 30 days yet.',
      aria: 'Daily volume for the last 30 days, stacked by exchange',
    });
  }

  // Entropy: warn when trades keep landing on the Hyperliquid account without Entropy's tag.
  function trackingAlerts(e, multi) {
    let dismissed = 0;
    try {
      dismissed = Number(localStorage.getItem('perps.entropyCheck')) || 0;
    } catch {}
    return (e.wallets || [])
      .filter((w) => w.check && w.check.newest > dismissed)
      .map((w) => {
        const c = w.check;
        const since = c.lastOwn ? `since your last recognised Entropy trade (${dateTime(c.lastOwn)})` : 'in the last two weeks';
        return `<div class="alert">${PT.icon('alert')}<div>${multi ? `<b>${esc(w.label)}:</b> ` : ''}${esc(`${c.trades} trades on this Hyperliquid account ${since} weren't recognised as Entropy trades (${c.markets.join(', ')}). If you placed them on entropy.io, Entropy may have changed how it tags orders and the tracker needs an update. If you used another app, dismiss this.`)}<div><button class="btn btn-sm" data-dismiss-check="${esc(c.newest)}">${PT.icon('check', 'sm')}Dismiss</button></div></div></div>`;
      })
      .join('');
  }

  // ---------- hedges ----------
  const distClass = (d) => (d == null ? '' : d < 0.05 ? 'danger' : d < 0.15 ? 'watch' : '');
  const pctDist = (d) => (d == null ? '–' : `${(d * 100).toFixed(d < 0.1 ? 1 : 0)}%`);

  // When a hedge pays funding, swapping which exchange holds the long and which the short earns it instead.
  function swapHint(g) {
    const sw = g.fundNow && g.fundNow.swap;
    if (!sw) return '';
    const long = g.legs.filter((l) => l.size > 0).map((l) => NAMES[l.exchange]);
    const short = g.legs.filter((l) => l.size < 0).map((l) => NAMES[l.exchange]);
    const pay = Number.isFinite(sw.paybackDays) ? (sw.paybackDays < 1 ? 'pays back in under a day' : `pays back in about ${Math.ceil(sw.paybackDays)} day${Math.ceil(sw.paybackDays) === 1 ? '' : 's'}`) : '';
    return `<div class="swap-hint">${PT.icon('swap', 'sm')}<span>This pair pays <b>${esc(PT.money(-g.fundNow.perDay, { dp: 2 }))}/day</b> in funding right now. With the long on ${esc(short.join(' and '))} and the short on ${esc(long.join(' and '))} it would earn <b>${esc(PT.signed(sw.perDay))}/day</b> instead; switching costs about ${esc(PT.money(sw.cost, { dp: 2 }))} in fees (${esc(pay)}). Rates change every hour.</span></div>`;
  }

  function renderHedges(s) {
    const groups = s.hedges || [];
    const host = $('#ov-hedges');
    const chips = $('#ov-hedge-chips');
    if (!groups.length) {
      chips.innerHTML = '';
      host.innerHTML = `<div class="empty">${PT.icon('scale')}No open positions.</div>`;
      return;
    }
    const n = (st) => groups.filter((g) => g.status === st).length;
    const near = groups.filter((g) => g.nearest).map((g) => g.nearest).sort((a, b) => a.dist - b.dist)[0];
    const chipList = [];
    if (n('hedged')) chipList.push(`<span class="chip up">${PT.icon('check')}${n('hedged')} hedged</span>`);
    if (n('uneven')) chipList.push(`<span class="chip gold">${PT.icon('alert')}${n('uneven')} uneven</span>`);
    if (n('open')) chipList.push(`<span class="chip">${n('open')} one-sided</span>`);
    if (near) chipList.push(`<span class="chip ${near.dist < 0.05 ? 'down' : near.dist < 0.15 ? 'gold' : ''}" title="Closest leg to its liquidation price">${PT.icon('shield')}Nearest liquidation ${esc(NAMES[near.exchange])} ${esc(near.mkt)}, ${esc(pctDist(near.dist))} away</span>`);
    chips.innerHTML = chipList.join('');

    const status = {
      hedged: `<span class="chip up">${PT.icon('check')}Hedged</span>`,
      uneven: `<span class="chip gold">${PT.icon('alert')}Uneven</span>`,
      open: '<span class="chip">One-sided</span>',
    };
    const rows = groups
      .map((g) => {
        const netTxt =
          g.status === 'open'
            ? `${g.netSize > 0 ? 'Long' : 'Short'} <b>${esc(money(g.gross, { dp: 2 }))}</b>, nothing on the other side`
            : `Net <b>${esc(`${g.netSize > 0 ? '+' : g.netSize < 0 ? '−' : ''}${PT.size(g.netSize)}`)}</b> ${esc(g.asset)} (≈ <b>${esc(money(Math.abs(g.netUsd), { dp: 2 }))}</b>${g.status === 'uneven' ? `, ${esc(pct(g.imbalance, 0))} off` : ''})`;
        const head = `<tr class="grp"><td colspan="9"><div class="grp-row"><span class="asset">${esc(g.asset)}</span><span class="chip">${PT.icon(g.cls === 'stocks' ? 'building' : 'coins')}${g.cls === 'stocks' ? 'Stock / RWA' : 'Crypto'}</span>${status[g.status]}<span class="meta">${netTxt}</span><span class="push"><span class="meta">uPnL <b class="${PT.pnlClass(g.upnl)}">${esc(PT.signed(g.upnl))}</b></span><span class="meta" title="Funding since each leg opened. Positive is received">Funding <b class="${PT.pnlClass(g.fund)}">${g.fund == null ? '–' : esc(PT.signed(g.fund))}</b>${g.fundPartial ? ' (some legs unknown)' : ''}</span>${g.fundNow ? `<span class="meta fund-now" title="At the current hourly funding rates on each exchange. Positive is received">Now <b class="${PT.pnlClass(Math.round(g.fundNow.perDay * 100))}">${esc(PT.signed(g.fundNow.perDay))}</b>/day</span>` : ''}</span></div>${swapHint(g)}</td></tr>`;
        const legs = g.legs
          .map((l) => {
            const liq = l.liq ? `${l.liqEst ? '≈ ' : ''}${PT.price(l.liq)}` : '–';
            const exits = l.exits && l.exits.length ? `<span class="td-sub">Exit orders at ${esc(l.exits.map(PT.price).join(' / '))}</span>` : '';
            const dc = distClass(l.liqDist);
            const width = l.liqDist == null ? 0 : Math.min(1, l.liqDist / 0.3) * 100;
            return `<tr><td>${PT.exName(l.exchange)}<span class="td-sub">${esc(l.mkt)}${PT.multiWallet() && l.wallet ? `, ${esc(l.wallet)}` : ''}</span></td><td>${PT.sideBadge(l.side)}</td><td class="num">${esc(PT.size(l.size))}</td><td class="num">${esc(money(l.notional, { dp: 2 }))}</td><td class="num">${l.lev ? `${esc(PT.plain(l.lev, 1))}×` : '–'}</td><td class="num"><span title="${esc(l.liqEst ? "Estimated from the market's maintenance margin" : 'Reported by the exchange')}">${esc(liq)}</span>${exits}</td><td class="num"><span class="dist ${dc}">${esc(pctDist(l.liqDist))}<span class="bar"><i style="width:${width.toFixed(0)}%"></i></span></span></td><td class="num ${PT.pnlClass(l.upnl)}">${esc(PT.signed(l.upnl))}</td><td class="num ${PT.pnlClass(l.fund)}">${l.fund == null ? '–' : esc(PT.signed(l.fund))}${l.fundHour != null ? `<span class="td-sub" title="${esc(`Funding rate now ${(l.fundRate * 100).toFixed(4)}% an hour`)}">now ${esc(PT.signed(l.fundHour * 24))}/day</span>` : ''}</td></tr>`;
          })
          .join('');
        return head + legs;
      })
      .join('');
    host.innerHTML = `<table><thead><tr><th>Exchange</th><th>Side</th><th class="num">Size</th><th class="num">Notional</th><th class="num">Leverage</th><th class="num">Liquidation</th><th class="num">Distance</th><th class="num">uPnL</th><th class="num">Funding since open</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderPositions(state, s) {
    const rows = s.positions || [];
    $('#ov-pos-sub').textContent = rows.length ? `${rows.length} open, ${money(s.totals.oi.notional, { dp: 2 })} at mark price` : 'Nothing open right now';
    if (!rows.length) {
      $('#ov-positions').innerHTML = `<div class="empty">${PT.icon('layers')}No open positions.</div>`;
      return;
    }
    const mw = PT.multiWallet();
    $('#ov-positions').innerHTML = `<table><thead><tr><th>Exchange</th>${mw ? '<th>Wallet</th>' : ''}<th>Market</th><th>Side</th><th class="num">Size</th><th class="num">Entry</th><th class="num">Mark</th><th class="num">Notional</th><th class="num">Unrealised PnL</th><th class="num">Open for</th></tr></thead><tbody>${rows
      .map((p) => {
        const openFor = p.openTs ? `<b class="mono" data-held-since="${p.openTs}">${esc(PT.clock(Date.now() - p.openTs))}</b><span class="td-sub">${esc(`since ${PT.localWhen(p.openTs)}`)}</span>` : '<span class="muted" title="Opened before the history the exchange shares">–</span>';
        return `<tr><td>${PT.exName(p.exchange)}</td>${mw ? `<td>${esc(p.wallet)}</td>` : ''}<td class="mkt">${esc(p.mkt)}${p.lev ? ` <span class="chip mono">${esc(PT.plain(p.lev, 0))}×</span>` : ''}</td><td>${PT.sideBadge(p.side)}</td><td class="num">${esc(PT.size(p.size))}</td><td class="num">${esc(PT.price(p.entry))}</td><td class="num">${esc(PT.price(p.mark))}</td><td class="num"><b>${esc(money(p.notional, { dp: 2 }))}</b></td><td class="num ${PT.pnlClass(p.upnl)}">${esc(PT.signed(p.upnl))}</td><td class="num">${openFor}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  }

  function renderClosed(state, s) {
    const start = range === 'all' ? -Infinity : Date.now() - RANGE_MS[range];
    const rows = (s.closed || []).filter((c) => c.closeTs >= start);
    const total = s.totals.ranges[range].closed;
    $('#ov-closed-sub').textContent = total ? `${count(total)} closed in ${RANGE_TEXT[range]}, newest first${total > rows.length ? `. Showing the latest ${rows.length}` : ''}` : `None closed in ${RANGE_TEXT[range]}`;
    const moreRow = $('#ov-more-row');
    if (!rows.length) {
      $('#ov-closed').innerHTML = `<div class="empty">${PT.icon('history')}No closed positions in this range.</div>`;
      moreRow.hidden = true;
      return;
    }
    const mw = PT.multiWallet();
    $('#ov-closed').innerHTML = `<table><thead><tr><th>Exchange</th>${mw ? '<th>Wallet</th>' : ''}<th>Market</th><th>Side</th><th>Opened</th><th>Closed</th><th class="num">Held</th><th class="num">Volume</th></tr></thead><tbody>${rows
      .slice(0, closedLimit)
      .map((c) => `<tr><td>${PT.exName(c.exchange)}</td>${mw ? `<td>${esc(c.wallet)}</td>` : ''}<td class="mkt">${esc(c.mkt)}</td><td>${PT.sideBadge(c.side)}</td><td class="mono">${esc(dateTime(c.openTs))}</td><td class="mono">${esc(dateTime(c.closeTs))}</td><td class="num"><b>${esc(dur(c.holdMs))}</b></td><td class="num">${c.vol ? esc(money(c.vol, { dp: 2 })) : '<span class="muted">–</span>'}</td></tr>`)
      .join('')}</tbody></table>`;
    moreRow.hidden = rows.length <= closedLimit;
    $('#ov-more').onclick = () => {
      closedLimit += 25;
      renderClosed(state, s);
    };
  }

  PT.overview = { render, redrawChart: (state) => state && state.stats && !chartAsTable && renderChart(state.stats, PT.activeExchanges()) };
})();
