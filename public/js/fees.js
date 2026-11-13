/* Fees: trading fees and funding per exchange, taken from your fills. Data: /api/fees */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc, money, compact, count, pct, NAMES, COLOR, ORDER } = PT;

  let windowKey = PT.prefs.get('fees.window') || '30d';
  let data = null;
  let lastKey = '';
  let loading = false;

  async function load(force) {
    const key = `${windowKey}|${PT.dataVersion()}`;
    if (!force && key === lastKey && data) return render();
    if (loading) return;
    loading = true;
    try {
      data = await PT.getJSON(`/api/fees?window=${encodeURIComponent(windowKey)}`);
      lastKey = key;
    } catch {
      // keep the previous render
    } finally {
      loading = false;
    }
    render();
  }

  function render() {
    const sel = $('#fees-window');
    sel.value = windowKey;
    sel.onchange = () => {
      windowKey = sel.value;
      PT.prefs.set('fees.window', windowKey);
      load(true);
    };
    const main = $('#fees-main');
    if (!data) {
      main.innerHTML = '<div class="panel empty"><span class="spinner"></span>Loading…</div>';
      return;
    }
    const t = data.totals;
    const exRows = ORDER.map((id) => data.byExchange.find((r) => r.id === id)).filter((r) => r && PT.hasWallets(r.id));
    const takerShare = t.fees > 0 ? t.takerFees / t.fees : null;
    const byEx = (key) => exRows.map((r) => ({ name: NAMES[r.id], color: COLOR[r.id], value: Math.max(0, r[key]) }));
    const donutPanel = (icon, title, sub, items, opts) =>
      `<section class="panel"><div class="ph"><div><h2 class="ph-title">${PT.icon(icon)}${esc(title)}</h2><p class="ph-sub">${esc(sub)}</p></div></div><div class="pb">${PT.donut(items, opts)}</div></section>`;

    main.innerHTML = `
      <div class="board">
        <div class="board-row">
          ${PT.leadCell({ icon: 'receipt', label: `Fees paid, ${data.window.label.toLowerCase()}`, value: money(t.fees, { dp: t.fees >= 1000 ? 0 : 2 }), sub: `${count(t.fills)} fills`, title: money(t.fees, { dp: 2 }) })}
          ${PT.cell({ icon: 'percent', label: 'Fee rate', value: PT.bps(t.bps), sub: `On ${compact(t.volume)} of volume` })}
          ${PT.cell({ icon: 'zap', label: 'Taker fees', value: money(t.takerFees, { dp: 2 }), sub: takerShare == null ? 'No fees yet' : `${pct(takerShare)} of fees` })}
          ${PT.cell({ icon: 'anchor', label: 'Maker fees', value: money(t.makerFees, { dp: 2 }), sub: 'Negative means rebates' })}
          ${PT.cell({ icon: 'swap', label: 'Funding', value: PT.signed(t.funding), sub: 'Positive is received', cls: PT.pnlClass(t.funding) })}
        </div>
      </div>
      <div class="grid g3">
        ${donutPanel('pie', 'Fees by exchange', 'Where your fees went', byEx('fees'), { fmt: (v) => money(v, { dp: 2 }), centerLabel: 'fees', title: 'Fees by exchange' })}
        ${donutPanel('chart', 'Volume by exchange', 'Where your volume went', byEx('volume'), { centerLabel: 'volume', title: 'Volume by exchange' })}
        ${donutPanel('anchor', 'Maker and taker', 'Share of volume', [
          { name: 'Maker', color: 'var(--n-hi)', value: t.makerVolume },
          { name: 'Taker', color: 'var(--n-lo)', value: t.takerVolume },
        ], { centerValue: t.volume > 0 ? pct(t.makerVolume / t.volume, 0) : '–', centerLabel: 'maker', title: 'Maker and taker volume' })}
      </div>
      <section class="panel">
        <div class="ph ruled"><div><h2 class="ph-title">${PT.icon('table')}Fees per exchange</h2><p class="ph-sub">${esc(`${data.window.label}. Negative maker fees are rebates`)}</p></div></div>
        <div class="table-wrap">${feesTable(exRows, t)}</div>
      </section>
      <section class="panel">
        <div class="ph">
          <div><h2 class="ph-title">${PT.icon('chart')}Fees per ${esc(data.daily.unit)}</h2><p class="ph-sub">${esc(`${data.window.label}, by exchange, UTC ${data.daily.unit === 'week' ? 'weeks from Monday' : 'days'}`)}</p></div>
          <div class="legend">${exRows.map((r) => `<span><i class="key" style="background:${COLOR[r.id]}"></i>${esc(NAMES[r.id])}</span>`).join('')}</div>
        </div>
        <div class="pb"><div class="chart" id="fees-chart"></div></div>
      </section>`;

    drawChart();
  }

  function drawChart() {
    const host = $('#fees-chart');
    if (!host || !data) return;
    const ids = ORDER.filter((id) => PT.hasWallets(id));
    const rows = data.daily.rows;
    PT.stackedColumns(host, {
      labels: rows.map((d) => PT.dayLabel(d.day)),
      series: ids.map((id) => ({ name: NAMES[id], color: COLOR[id], values: rows.map((d) => d[id]) })),
      fmt: (v) => money(v, { dp: 2 }),
      axisFmt: (v) => (v >= 100 ? PT.short(v) : `$${PT.plain(v, 2)}`),
      title: (i) => `${data.daily.unit === 'week' ? 'Week of ' : ''}${PT.dayLabel(rows[i].day)} (UTC)`,
      height: 220,
      empty: 'No fees in this window yet.',
      aria: `Fees per ${data.daily.unit} by exchange`,
    });
  }


  function feesTable(rows, t) {
    if (!rows.length) return `<div class="empty">${PT.icon('wallet')}Add a wallet to see fees.</div>`;
    const tier = (r) => (r.feeTier ? `${PT.plain(r.feeTier.makerBps)} / ${PT.plain(r.feeTier.takerBps)} bps` : '–');
    return `<table><thead><tr><th>Exchange</th><th>Tier, maker / taker</th><th class="num">Volume</th><th class="num">Fills</th><th class="num">Maker fees</th><th class="num">Taker fees</th><th class="num">Total fees</th><th class="num">Rate</th><th class="num">Funding</th><th class="num">Lifetime fees</th></tr></thead><tbody>${rows
      .map(
        (r) => `<tr><td>${PT.exName(r.id)}</td><td class="mono">${esc(tier(r))}</td><td class="num">${esc(money(r.volume, { dp: 0 }))}</td><td class="num">${esc(count(r.fills))}</td><td class="num">${esc(money(r.makerFees, { dp: 2 }))}</td><td class="num">${esc(money(r.takerFees, { dp: 2 }))}</td><td class="num"><b>${esc(money(r.fees, { dp: 2 }))}</b></td><td class="num">${esc(PT.bps(r.bps))}</td><td class="num ${PT.pnlClass(r.funding)}">${esc(PT.signed(r.funding))}</td><td class="num muted">${esc(money(r.lifetimeFees, { dp: 2 }))}</td></tr>`
      )
      .join('')}<tr class="total"><td>Total</td><td></td><td class="num">${esc(money(t.volume, { dp: 0 }))}</td><td class="num">${esc(count(t.fills))}</td><td class="num">${esc(money(t.makerFees, { dp: 2 }))}</td><td class="num">${esc(money(t.takerFees, { dp: 2 }))}</td><td class="num">${esc(money(t.fees, { dp: 2 }))}</td><td class="num">${esc(PT.bps(t.bps))}</td><td class="num ${PT.pnlClass(t.funding)}">${esc(PT.signed(t.funding))}</td><td></td></tr></tbody></table>`;
  }

  PT.fees = { load, redraw: () => data && drawChart() };
})();
