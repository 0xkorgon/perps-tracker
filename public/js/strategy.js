/* Strategy: an Arcus points routine (benchmark trader's dashboard + his own rules), measured on
   your trading on any exchange. Data: /api/strategy */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc, money, compact, count, pct, signed, dur, NAMES } = PT;

  const CLS = [
    { key: 'crypto', name: 'Crypto', color: 'var(--cls-crypto)' },
    { key: 'stocksUs', name: 'Stocks & ETFs, US hours', color: 'var(--cls-us)' },
    { key: 'stocksOff', name: 'Stocks & ETFs, off hours', color: 'var(--cls-off)' },
  ];
  const ZONE = new Set(['h6', 'h24']); // 1–6 h and 6–24 h buckets
  const RULE_ICON = {
    oiNow: 'gauge',
    oi24h: 'clock',
    roundTrips: 'repeat',
    stocks: 'building',
    offHours: 'moon',
    hold: 'hourglass',
    noFlips: 'zap',
    everyDay: 'calendarCheck',
    volume: 'chart',
    maker: 'anchor',
    fees: 'percent',
    breakeven: 'scale',
    // Bulk alone (trading AURA)
    bVolume: 'chart',
    bTaker: 'swap',
    bHold: 'hourglass',
    bCore: 'clock',
    bCost: 'percent',
    bQualify: 'trophy',
    bBreakeven: 'scale',
  };
  const isBulk = () => Boolean(data && data.mode === 'bulk');
  const localFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // Exchanges to measure: any one, any two, or all three (saved as "arcus,entropy" or "all").
  const EX = ['arcus', 'bulk', 'entropy'];
  const pref = (k, fallback) => PT.prefs.get(`st.${k}`) || PT.prefs.get(`pb.${k}`) || fallback;
  const parseSel = (v) => {
    const raw = String(v || '').split(',');
    const ids = raw.includes('all') ? EX.slice() : EX.filter((id) => raw.includes(id));
    return ids.length ? ids : ['arcus'];
  };
  const keyOf = (ids) => (ids.length === EX.length ? 'all' : ids.join(','));
  const nameOf = (ids, joiner = ' + ') => ids.map((id) => NAMES[id]).join(joiner);

  let selected = parseSel(pref('platform'));
  let windowKey = pref('window', 'thisWeek');
  let data = null;
  let editing = false;
  let loading = false;
  let queued = null; // a load asked for while another was in flight (picker clicked quickly)
  let lastKey = '';
  const shownIds = () => (data && data.platforms) || selected; // the exchanges the data on screen covers
  // Entrance and change animations: the score counts up, ticks fill in, bars grow, and a habit
  // that just changed state flashes. They play on opening the page or when the score changes.
  let pendingEnter = true;
  let shownRail = { key: null, passed: null, total: null, states: {} };

  const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  async function load(force, entered) {
    if (entered) pendingEnter = true;
    const key = `${keyOf(selected)}|${windowKey}|${PT.dataVersion()}`;
    if (!force && key === lastKey && data) return render();
    if (loading) {
      queued = { force: Boolean(force) || Boolean(queued && queued.force) };
      return;
    }
    loading = true;
    try {
      data = await PT.getJSON(`/api/strategy?platform=${encodeURIComponent(keyOf(selected))}&window=${encodeURIComponent(windowKey)}`);
      lastKey = key;
    } catch (e) {
      data = data || null;
    } finally {
      loading = false;
    }
    if (queued) {
      const q = queued;
      queued = null;
      return load(q.force); // the pick changed while this was loading; fetch the latest one
    }
    render(force);
  }

  // Exchange picker: each exchange toggles on and off (at least one stays on); "All" picks all three.
  function wirePicker() {
    PT.$$('#st-platform button').forEach((b) => {
      const v = b.dataset.v;
      b.setAttribute('aria-pressed', String(v === 'all' ? selected.length === EX.length : selected.includes(v)));
      b.onclick = () => {
        let next;
        if (v === 'all') next = EX.slice();
        else if (selected.includes(v)) {
          if (selected.length === 1) {
            b.classList.remove('nudge');
            void b.offsetWidth; // restart the nudge animation
            b.classList.add('nudge');
            return; // keep at least one exchange picked
          }
          next = selected.filter((id) => id !== v);
        } else next = EX.filter((id) => id === v || selected.includes(id));
        if (keyOf(next) === keyOf(selected)) return;
        selected = next;
        PT.prefs.set('st.platform', keyOf(selected));
        wirePicker();
        load(true);
      };
    });
  }

  function render(fromUser = false) {
    const sel = $('#st-window');
    sel.value = windowKey;
    sel.onchange = () => {
      windowKey = sel.value;
      PT.prefs.set('st.window', windowKey);
      load(true);
    };
    wirePicker();
    if (!data) {
      $('#st-main').innerHTML = `<div class="panel empty"><span class="spinner"></span>Loading…</div>`;
      return;
    }
    const w = data.window;
    const ids = shownIds();
    const missing = data.hasWallets && data.missing && data.missing.length ? ` No ${nameOf(data.missing, ' or ')} wallet yet, so ${data.missing.length > 1 ? 'they add' : 'it adds'} nothing.` : '';
    $('#st-window-note').innerHTML = isBulk()
      ? `${PT.icon('clock', 'sm')}<span><b>Bulk</b> · ${esc(`${w.label}: ${localFmt.format(new Date(w.start))} to ${w.live ? 'now' : localFmt.format(new Date(w.end))}, your time. Bulk's AURA weeks run Saturday 12:30 to Saturday 12:30 UTC; these habits come from the AURA model in this build.${missing}`)}</span>`
      : `${PT.icon('clock', 'sm')}<span><b>${esc(ids.length === EX.length ? 'All exchanges' : nameOf(ids))}</b> · ${esc(`${w.label}: ${nyFmt.format(new Date(w.start))} to ${w.live ? 'now' : nyFmt.format(new Date(w.end))}, New York time.${w.key === 'thisWeek' || w.key === 'lastWeek' ? ' Arcus points weeks run Wednesday 3 PM to Wednesday 3 PM.' : ''}${missing}`)}</span>`;
    const sub = $('#st-sub');
    if (sub) sub.textContent = isBulk() ? 'How your trading scores on Bulk’s trading AURA habits. Habits turn green as you match them.' : 'An Arcus points routine, measured on your trading. Habits turn green as you match them.';
    const winSel = $('#st-window');
    if (winSel) {
      const labels = isBulk() ? { thisWeek: 'This AURA week', lastWeek: 'Last AURA week' } : { thisWeek: 'This points week', lastWeek: 'Last points week' };
      PT.$$('option', winSel).forEach((o) => { if (labels[o.value]) o.textContent = labels[o.value]; });
    }
    const entering = pendingEnter && !PT.reduceMotion();
    renderMain();
    $('#st-main').classList.toggle('anim-in', entering);
    if (editing && !fromUser) {
      pendingEnter = false; // the entrance has played; don't replay it on every refresh
      return; // keep half-typed targets when new trades arrive
    }
    renderRail();
  }

  function renderMain() {
    const k = data.kpis;
    const main = $('#st-main');
    if (!data.hasWallets) {
      main.innerHTML = `<div class="panel"><div class="venue-empty" style="padding:22px">${PT.icon('wallet', 'lg')}<div><b>No ${esc(nameOf(shownIds(), ' or '))} wallet added yet.</b><br>Add one, or pick another exchange above, to measure your trading against the strategy.</div><button class="btn btn-primary btn-sm" data-open-wallets>${PT.icon('plus', 'sm')}Add wallet</button></div></div>`;
      return;
    }
    if (isBulk()) return renderBulkMain();
    const ids = shownIds();
    const onlyEntropy = ids.length === 1 && ids[0] === 'entropy';
    const tierText = k.feeTier ? `Tier ${k.feeTier.level}, ${PT.plain(k.feeTier.makerBps)} / ${PT.plain(k.feeTier.takerBps)} bps` : `${PT.bps(k.feeBps)} effective`;
    const depNet = k.depIn - k.depOut;
    const where = [
      { key: 'crypto', v: k.cryptoVolume },
      { key: 'stocksUs', v: k.stocksVolume - k.offHoursVolume },
      { key: 'stocksOff', v: k.offHoursVolume },
    ];
    const whereTotal = where.reduce((a, x) => a + x.v, 0);
    const holdItems = data.holdBuckets.map((b) => ({ label: b.label, value: b.count, color: ZONE.has(b.key) ? 'var(--gold)' : 'var(--n-lo)' }));

    main.innerHTML = `
      <div class="board">
        <div class="board-row">
          ${PT.leadCell({ icon: 'chart', label: 'Volume', value: compact(k.volume), sub: `${k.activeDays} active day${k.activeDays === 1 ? '' : 's'} of ${k.periods}`, title: money(k.volume, { dp: 2 }) })}
          ${PT.cell({ icon: 'swap', label: 'Trades', value: count(k.fills), sub: k.fills ? `Average ${money(k.avgFill, { dp: 0 })}` : 'No fills yet' })}
          ${PT.cell({ icon: 'anchor', label: 'Maker share', value: pct(k.makerShare), sub: `Taker ${compact(k.takerVolume)}` })}
          ${PT.cell({ icon: 'receipt', label: 'Fees paid', value: money(k.fees, { dp: 2 }), sub: tierText })}
          ${PT.cell({ icon: 'scale', label: 'Net result', value: signed(k.net, { dp: 2 }), sub: 'PnL + funding − fees', cls: PT.pnlClass(k.net) })}
        </div>
        <div class="board-row even">
          ${PT.cell({ label: 'Realised PnL', value: signed(k.pnl, { dp: 2 }), sub: 'Before fees', cls: PT.pnlClass(k.pnl) })}
          ${PT.cell({ label: 'Funding', value: signed(k.funding, { dp: 2 }), sub: 'Positive is received', cls: PT.pnlClass(k.funding) })}
          ${PT.cell({ label: 'Average OI', value: compact(k.oiAvg), sub: `Peak ${compact(k.oiPeak)}${k.oiNow != null ? `, now ${compact(k.oiNow)}` : ''}` })}
          ${PT.cell({ label: 'Account value', value: k.equity == null ? '–' : money(k.equity, { dp: k.equity >= 1000 ? 0 : 2 }), sub: ids.length === EX.length ? 'All accounts' : ids.length > 1 ? `${nameOf(ids)} accounts` : `${NAMES[ids[0]]} account` })}
          ${PT.cell({ label: 'Net deposits', value: onlyEntropy ? '–' : signed(depNet, { dp: 0 }), sub: onlyEntropy ? 'Not tracked on Entropy' : `In ${money(k.depIn, { dp: 0 })}, out ${money(k.depOut, { dp: 0 })}${ids.includes('entropy') ? ', not Entropy' : ''}` })}
          ${PT.cell({ label: 'Stocks & ETFs', value: pct(k.stocksShare), sub: `${compact(k.stocksVolume)} of volume` })}
          ${PT.cell({ label: 'Off US hours', value: pct(k.offHoursShare), sub: 'Of stock and ETF volume' })}
          ${PT.cell({ label: 'Closed per day', value: Number.isFinite(k.perDay) ? k.perDay.toFixed(1) : '–', sub: `${count(k.closed)} closed` })}
        </div>
      </div>

      <section class="panel">
        <div class="ph">
          <div><h2 class="ph-title">${PT.icon('layers')}Volume by type</h2><p class="ph-sub">Arcus boosts points for stocks and RWA, and for trading outside US hours (4am–8pm New York, trading days). Grey earns no boost.</p></div>
        </div>
        <div class="pb">
          <div class="meter" role="img" aria-label="${esc(where.map((x, i) => `${CLS[i].name} ${compact(x.v)}`).join(', '))}">${whereTotal > 0 ? where.filter((x) => x.v > 0).map((x) => `<span style="flex:${x.v / whereTotal};background:${CLS.find((c) => c.key === x.key).color}"></span>`).join('') : ''}</div>
          <div class="legend" style="margin:10px 0 14px">${where.map((x, i) => `<span><i class="key" style="background:${CLS[i].color}"></i>${esc(CLS[i].name)} <b>${esc(compact(x.v))}</b> <span class="muted">${whereTotal > 0 ? pct(x.v / whereTotal) : ''}</span></span>`).join('')}</div>
          <div class="chart" id="st-vol"></div>
        </div>
      </section>

      <div class="grid g2">
        <section class="panel">
          <div class="ph"><div><h2 class="ph-title">${PT.icon('hourglass')}Hold time</h2><p class="ph-sub">${esc(k.closed ? `${count(k.closed)} closed. Average ${dur(k.avgHoldMs)}, median ${dur(k.medianHoldMs)}` : 'Nothing closed in this window')}</p></div></div>
          <div class="pb">
            ${PT.hbars(holdItems, { aria: `Closed positions by hold time: ${holdItems.map((x) => `${x.label} ${x.value}`).join(', ')}` })}
            <div class="legend" style="margin-top:12px"><span><i class="key" style="background:var(--gold)"></i>Target zone, 1–24 h</span><span><i class="key" style="background:var(--n-lo)"></i>Outside it</span></div>
          </div>
        </section>
        <section class="panel">
          <div class="ph"><div><h2 class="ph-title">${PT.icon('anchor')}Maker and fees</h2><p class="ph-sub">${esc(k.fills ? `${count(k.makerFills)} of ${count(k.fills)} fills were maker` : 'No fills yet')}</p></div></div>
          <div class="pb">
            <div class="meter" role="img" aria-label="${esc(`Maker ${pct(k.makerShare)}, taker ${pct(k.makerShare == null ? null : 1 - k.makerShare)}`)}">${k.volume > 0 ? `<span style="flex:${k.makerVolume};background:var(--n-hi)"></span><span style="flex:${k.takerVolume};background:var(--n-lo)"></span>` : ''}</div>
            <div class="legend" style="margin-top:10px"><span><i class="key" style="background:var(--n-hi)"></i>Maker <b>${esc(pct(k.makerShare))}</b></span><span><i class="key" style="background:var(--n-lo)"></i>Taker <b>${esc(pct(k.makerShare == null ? null : 1 - k.makerShare))}</b></span></div>
            <dl class="kv" style="margin-top:14px">
              <dt>Fees paid</dt><dd>${esc(money(k.fees, { dp: 2 }))}</dd>
              <dt>Fee rate</dt><dd>${esc(PT.bps(k.feeBps))}</dd>
              <dt>Fee tier</dt><dd>${esc(k.feeTier ? `${PT.plain(k.feeTier.makerBps)} / ${PT.plain(k.feeTier.takerBps)} bps` : '–')}</dd>
            </dl>
          </div>
        </section>
      </div>

      <section class="panel">
        <div class="ph">
          <div><h2 class="ph-title">${PT.icon('gauge')}Open interest</h2><p class="ph-sub">Per UTC day, time-weighted average and peak</p></div>
          <div class="legend"><span><i class="linekey" style="background:var(--ink)"></i>Average</span><span><i class="linekey dash" style="--lk:var(--ink-3)"></i>Peak</span><span><i class="linekey dash" style="--lk:var(--gold)"></i>Target</span></div>
        </div>
        <div class="pb"><div class="chart" id="st-oi"></div></div>
      </section>

      <section class="panel">
        <div class="ph">
          <div><h2 class="ph-title">${PT.icon('trending')}Cumulative result</h2><p class="ph-sub">Running totals over the window, by UTC day</p></div>
          <div class="legend"><span><i class="linekey" style="background:var(--gold)"></i>Net</span><span><i class="linekey" style="background:var(--ink-2)"></i>Realised PnL</span><span><i class="linekey dash" style="--lk:var(--ink-3)"></i>Funding</span><span><i class="linekey dash" style="--lk:var(--down)"></i>Fees</span></div>
        </div>
        <div class="pb"><div class="chart" id="st-cum"></div></div>
      </section>

      <section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('calendar')}Activity</h2><p class="ph-sub">${esc(`${data.heatmap.activeDays} active days in the last 16 weeks${data.heatmap.busiest ? `. Busiest: ${compact(data.heatmap.busiest.vol)} on ${PT.dayLabel(data.heatmap.busiest.day)}` : ''} (UTC days)`)}</p></div></div>
        <div class="pb">${PT.heatmap(data.heatmap.days)}</div>
      </section>

      <section class="panel">
        <div class="ph ruled"><div><h2 class="ph-title">${PT.icon('list')}Markets</h2><p class="ph-sub">${esc(`${data.kpis.marketsTraded} traded in this window. PnL is before fees; net is PnL plus funding minus fees`)}</p></div></div>
        <div class="table-wrap">${marketsTable()}</div>
      </section>`;
    drawCharts();
  }

  // ---------- Bulk alone: trading AURA ----------
  // The next Saturday 12:30 UTC (Bulk's weekly AURA cutoff).
  function bulkCutoff(now = Date.now()) {
    const anchor = Date.UTC(2026, 8, 26, 12, 30);
    const W = 7 * 864e5;
    return anchor + (Math.floor((now - anchor) / W) + 1) * W;
  }

  function renderBulkMain() {
    const k = data.kpis;
    const b = data.bulk;
    const main = $('#st-main');
    const rate = b.perDollar * 1000;
    const est = b.weekEstimate;
    const live = data.window.key === 'thisWeek';
    const lw = b.lastWeek;
    const maxVol = Math.max(1, ...b.buckets.map((x) => x.volume));
    const bucketRows = b.buckets
      .map(
        (x) => `<div class="hm-row"><span class="lbl">${esc(x.label)}</span><div class="track"><div class="fill" style="width:${((x.volume / maxVol) * 100).toFixed(1)}%;--m:${Math.min(1, (x.mult - 1) / (PT.bulkMult(168, b.model) - 1 || 1))}"></div></div><span class="val">${esc(x.volume ? compact(x.volume) : '–')}</span><span class="chip mono hm-x">${x.mult.toFixed(2)}×</span></div>`
      )
      .join('');
    const tierText = k.feeTier ? `Tier ${k.feeTier.level}, ${PT.plain(k.feeTier.makerBps)} / ${PT.plain(k.feeTier.takerBps)} bps` : `${PT.bps(k.feeBps)} effective`;
    main.innerHTML = `
      <div class="board">
        <div class="board-row">
          ${PT.leadCell({ icon: 'chart', label: 'Taker volume', value: compact(k.takerVolume), sub: b.holdKnown ? `The volume that earns trading AURA${k.makerVolume > 0 ? `; ${compact(k.makerVolume)} maker doesn't` : ''}` : `Taker volume in this window${k.makerVolume > 0 ? `, plus ${compact(k.makerVolume)} maker` : ''}`, title: money(k.takerVolume, { dp: 2 }) })}
          ${PT.cell({ icon: 'sparkles', label: 'Trading AURA, about', value: count(Math.round(b.auraEstimate)), sub: `${rate.toFixed(2)} per $1K taker${b.oiHours > 0 ? ' + hours open' : ''}${b.perDollarSource === 'week' ? `, week ${b.rateWeek}’s rates` : b.perDollarSource === 'yours' ? ', your rates now' : ', typical rates'}` })}
          ${PT.cell({ icon: 'hourglass', label: b.holdKnown ? 'Hold multiplier' : 'Average hold', value: b.holdKnown ? (b.holdMult ? `${b.holdMult.toFixed(2)}×` : '–') : b.avgHoldH != null ? (b.avgHoldH < 1 ? `${Math.round(b.avgHoldH * 60)} min` : `${b.avgHoldH.toFixed(1)} h`) : '–', sub: !b.holdKnown ? 'Weighted by volume' : b.avgHoldH != null ? `Average hold ${b.avgHoldH < 1 ? `${Math.round(b.avgHoldH * 60)} min` : `${b.avgHoldH.toFixed(1)} h`}` : 'Nothing closed yet' })}
          ${PT.cell({ icon: 'receipt', label: 'Fees per 1,000 AURA', value: b.costPer1k != null ? money(b.costPer1k, { dp: 0 }) : '–', sub: `${money(k.fees, { dp: 2 })} paid · ${tierText}` })}
          ${PT.cell({ icon: 'scale', label: 'Net result', value: signed(k.net, { dp: 2 }), sub: 'PnL + funding − fees', cls: PT.pnlClass(k.net) })}
        </div>
        <div class="board-row even">
          ${PT.cell({ label: live ? 'This AURA week, expected' : 'Expected next drop', value: est ? `≈ ${count(Math.round(est.points))}` : '–', sub: est ? `Likely ${count(Math.round(est.low))}–${count(Math.round(est.high))} AURA at your pace` : 'Shows after your first Bulk sync' })}
          ${PT.cell({ label: lw ? `Week ${lw.week} paid` : 'Last week', value: lw ? `${count(lw.trading)}` : '–', sub: lw ? `Trading AURA on ${compact(lw.volume)}` : 'No revealed week yet' })}
          ${PT.cell({ label: 'Average OI', value: compact(k.oiAvg), sub: `Peak ${compact(k.oiPeak)}${k.oiNow != null ? `, now ${compact(k.oiNow)}` : ''}` })}
          ${PT.cell({ label: 'Time with a position', value: pct(b.oiTimeShare), sub: b.holdKnown ? 'Open positions earn every hour' : 'Share of the window with a Bulk position open' })}
          ${PT.cell({ label: 'Closed per day', value: Number.isFinite(k.perDay) ? k.perDay.toFixed(1) : '–', sub: `${count(k.closed)} closed` })}
          ${PT.cell({ label: 'Realised PnL', value: signed(k.pnl, { dp: 2 }), sub: 'Before fees', cls: PT.pnlClass(k.pnl) })}
          ${PT.cell({ label: 'Funding', value: signed(k.funding, { dp: 2 }), sub: 'Positive is received', cls: PT.pnlClass(k.funding) })}
          ${PT.cell({ label: 'Account value', value: k.equity == null ? '–' : money(k.equity, { dp: k.equity >= 1000 ? 0 : 2 }), sub: 'Bulk account' })}
        </div>
      </div>

      ${b.holdKnown ? `<section class="panel">
        <div class="ph">
          <div><h2 class="ph-title">${PT.icon('hourglass')}Hold time and AURA</h2><p class="ph-sub">${esc(`Your closed volume by how long each position stayed open, with what that hold earns relative to a quick round trip (+${(b.model.perHour * 100).toFixed(2)}% an hour this week, no cap)`)}</p></div>
        </div>
        <div class="pb">
          ${b.closedVolume > 0 ? `<div class="hm">${bucketRows}</div>` : `<div class="empty">${PT.icon('hourglass')}Nothing closed in this window yet.</div>`}
          ${b.plusDayHold > 0.5 ? `<p class="hm-tip">${PT.icon('trending', 'sm')}<span>The same volume, with each position held <b>one day longer</b>, would have earned about <b>${count(Math.round(b.plusDayHold))} more AURA</b> for the same fees.</span></p>` : ''}
        </div>
      </section>` : ''}

      <section class="panel">
        <div class="ph">
          <div><h2 class="ph-title">${PT.icon('swap')}Taker and maker volume</h2><p class="ph-sub">Per UTC day${b.holdKnown ? '. Only taker volume earns trading AURA' : ''}</p></div>
          <div class="legend"><span><i class="key" style="background:var(--ex-bulk)"></i>Taker <b>${esc(compact(k.takerVolume))}</b></span><span><i class="key" style="background:var(--n-lo)"></i>Maker <b>${esc(compact(k.makerVolume))}</b></span></div>
        </div>
        <div class="pb"><div class="chart" id="st-vol"></div></div>
      </section>

      <section class="panel">
        <div class="ph">
          <div><h2 class="ph-title">${PT.icon('gauge')}Open interest</h2><p class="ph-sub">Per UTC day, time-weighted average and peak${b.holdKnown ? '. Every hour a position is open earns AURA' : ''}</p></div>
          <div class="legend"><span><i class="linekey" style="background:var(--ink)"></i>Average</span><span><i class="linekey dash" style="--lk:var(--ink-3)"></i>Peak</span></div>
        </div>
        <div class="pb"><div class="chart" id="st-oi"></div></div>
      </section>

      <section class="panel">
        <div class="ph">
          <div><h2 class="ph-title">${PT.icon('trending')}Cumulative result</h2><p class="ph-sub">Running totals over the window, by UTC day</p></div>
          <div class="legend"><span><i class="linekey" style="background:var(--gold)"></i>Net</span><span><i class="linekey" style="background:var(--ink-2)"></i>Realised PnL</span><span><i class="linekey dash" style="--lk:var(--ink-3)"></i>Funding</span><span><i class="linekey dash" style="--lk:var(--down)"></i>Fees</span></div>
        </div>
        <div class="pb"><div class="chart" id="st-cum"></div></div>
      </section>

      <section class="panel">
        <div class="ph ruled"><div><h2 class="ph-title">${PT.icon('list')}Markets</h2><p class="ph-sub">${esc(`${k.marketsTraded} traded in this window.${b.holdKnown ? ' Every market earns the same AURA per dollar, so pick the tightest spread' : ''}`)}</p></div></div>
        <div class="table-wrap">${marketsTable()}</div>
      </section>`;
    drawCharts();
  }

  function drawBulkCharts(host, labels) {
    PT.stackedColumns(host, {
      labels,
      series: [
        { name: 'Taker', color: 'var(--ex-bulk)', values: data.daily.map((d) => d.taker || 0) },
        { name: 'Maker', color: 'var(--n-lo)', values: data.daily.map((d) => d.maker || 0) },
      ],
      fmt: (v) => money(v, { dp: 0 }),
      title: (i) => `${PT.dayLabel(data.daily[i].day)} (UTC)`,
      height: 200,
      aria: 'Taker and maker volume per UTC day',
    });
    PT.lineChart($('#st-oi'), {
      labels,
      step: true,
      series: [
        { name: 'Average', color: 'var(--ink)', values: data.daily.map((d) => d.oiAvg), area: true },
        { name: 'Peak', color: 'var(--ink-3)', values: data.daily.map((d) => d.oiPeak), dash: true, width: 1.5 },
      ],
      fmt: (v) => money(v, { dp: 0 }),
      title: (i) => `${PT.dayLabel(data.daily[i].day)} (UTC)`,
      aria: 'Open interest per UTC day',
    });
    PT.lineChart($('#st-cum'), {
      labels: data.cumulative.map((d) => PT.dayLabel(d.day)),
      series: [
        { name: 'Net', color: 'var(--gold)', values: data.cumulative.map((d) => d.net), width: 2.5 },
        { name: 'Realised PnL', color: 'var(--ink-2)', values: data.cumulative.map((d) => d.pnl), width: 1.75 },
        { name: 'Funding', color: 'var(--ink-3)', values: data.cumulative.map((d) => d.funding), dash: true, width: 1.5 },
        { name: 'Fees', color: 'var(--down)', values: data.cumulative.map((d) => d.fees), dash: true, width: 1.5 },
      ],
      fmt: (v) => PT.signed(v),
      axisFmt: PT.short,
      title: (i) => `${PT.dayLabel(data.cumulative[i].day)} (UTC)`,
      aria: 'Cumulative realised PnL, funding, fees and net result',
    });
  }


  function marketsTable() {
    const rows = data.markets;
    if (!rows.length) return `<div class="empty">${PT.icon('list')}No trades in this window.</div>`;
    const showEx = shownIds().length > 1;
    const maxShare = Math.max(...rows.map((r) => r.share), 0.0001);
    return `<table><thead><tr><th>Market</th>${showEx ? '<th>Exchange</th>' : ''}<th>Type</th><th class="num">Volume</th><th>Share</th><th class="num">Fills</th><th class="num">PnL</th><th class="num">Fees</th><th class="num">Funding</th><th class="num">Net</th></tr></thead><tbody>${rows
      .map(
        (m) => `<tr><td class="mkt">${esc(m.mkt)}</td>${showEx ? `<td>${PT.exName(m.exchange)}</td>` : ''}<td><span class="chip">${m.cls === 'stocks' ? `${PT.icon('building')}Stock / RWA` : `${PT.icon('coins')}Crypto`}</span></td><td class="num">${esc(money(m.volume, { dp: 0 }))}</td><td><span class="minibar"><i style="width:${(m.share / maxShare) * 100}%"></i></span><span class="mono" style="font-size:11.5px">${esc(pct(m.share))}</span></td><td class="num">${esc(count(m.fills))}</td><td class="num ${PT.pnlClass(m.pnl)}">${esc(signed(m.pnl))}</td><td class="num">${esc(money(m.fees, { dp: 2 }))}</td><td class="num ${PT.pnlClass(m.funding)}">${esc(signed(m.funding))}</td><td class="num ${PT.pnlClass(m.net)}"><b>${esc(signed(m.net))}</b></td></tr>`
      )
      .join('')}</tbody></table>`;
  }

  function drawCharts() {
    const host = $('#st-vol');
    if (!host || !data) return;
    const labels = data.daily.map((d) => PT.dayLabel(d.day));
    if (isBulk()) return drawBulkCharts(host, labels);
    PT.stackedColumns(host, {
      labels,
      series: CLS.map((c) => ({ name: c.name, color: c.color, values: data.daily.map((d) => d[c.key]) })),
      fmt: (v) => money(v, { dp: 0 }),
      title: (i) => `${PT.dayLabel(data.daily[i].day)} (UTC)`,
      height: 220,
      aria: 'Volume per UTC day by asset type and trading hours',
    });
    PT.lineChart($('#st-oi'), {
      labels,
      step: true,
      series: [
        { name: 'Average', color: 'var(--ink)', values: data.daily.map((d) => d.oiAvg), area: true },
        { name: 'Peak', color: 'var(--ink-3)', values: data.daily.map((d) => d.oiPeak), dash: true, width: 1.5 },
      ],
      ref: { value: Number(data.targets.oiNow), label: `target ${PT.short(Number(data.targets.oiNow))}` },
      fmt: (v) => money(v, { dp: 0 }),
      title: (i) => `${PT.dayLabel(data.daily[i].day)} (UTC)`,
      aria: 'Open interest per UTC day',
    });
    PT.lineChart($('#st-cum'), {
      labels: data.cumulative.map((d) => PT.dayLabel(d.day)),
      series: [
        { name: 'Net', color: 'var(--gold)', values: data.cumulative.map((d) => d.net), width: 2.5 },
        { name: 'Realised PnL', color: 'var(--ink-2)', values: data.cumulative.map((d) => d.pnl), width: 1.75 },
        { name: 'Funding', color: 'var(--ink-3)', values: data.cumulative.map((d) => d.funding), dash: true, width: 1.5 },
        { name: 'Fees', color: 'var(--down)', values: data.cumulative.map((d) => d.fees), dash: true, width: 1.5 },
      ],
      fmt: (v) => PT.signed(v),
      axisFmt: PT.short,
      title: (i) => `${PT.dayLabel(data.cumulative[i].day)} (UTC)`,
      aria: 'Cumulative realised PnL, funding, fees and net result',
    });
  }

  // ---------- live hold timers (for "Hold positions 1–24 hours") ----------
  const HOUR = 36e5;
  const hm = (ms) => {
    const h = Math.floor(ms / HOUR);
    const m = Math.max(0, Math.floor((ms % HOUR) / 6e4));
    return h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  };
  function holdState(held) {
    if (held < HOUR) return { cls: 'early', note: `${hm(HOUR - held)} until it reaches 1 h` };
    if (held <= 24 * HOUR) return { cls: 'zone', note: `In the 1–24 h zone, ${hm(24 * HOUR - held)} left` };
    return { cls: 'late', note: `${hm(held - 24 * HOUR)} past 24 h` };
  }
  const heldText = (held) => {
    const h = Math.floor(held / HOUR);
    const m = Math.floor((held % HOUR) / 6e4);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  };
  function holdTimers() {
    if (isBulk()) return PT.holdKnown() ? bulkHoldTimers() : '';
    const ps = (data && data.openPositions) || [];
    if (!ps.length) return '<div class="holds"><div class="holds-h"><span>Open now</span></div><div class="hold-note">Nothing open right now.</div></div>';
    const rows = ps
      .map((p) => {
        if (!p.openTs) return `<div class="hold-row"><div class="hold-top">${PT.exm(p.exchange, 'sm')}<span class="mkt">${esc(p.mkt)}</span><span class="t">open time unknown</span></div></div>`;
        return `<div class="hold-row" data-open-ts="${p.openTs}"><div class="hold-top">${PT.exm(p.exchange, 'sm')}<span class="mkt">${esc(p.mkt)} ${p.side === 'L' ? 'long' : 'short'}</span><span class="t"><b class="held"></b> / 24h</span></div><div class="hold-bar" role="img"><i></i></div><div class="hold-note"></div></div>`;
      })
      .join('');
    return `<div class="holds"><div class="holds-h"><span><b>Open now</b>, every exchange</span><span>held / 24 h, tick at 1 h</span></div>${rows}</div>`;
  }
  // Bulk: each open position's hold multiplier so far (when the AURA model rates open positions).
  function bulkHoldTimers() {
    const ps = ((data && data.openPositions) || []).filter((p) => p.exchange === 'bulk');
    if (!ps.length) return '<div class="holds"><div class="holds-h"><span>Open on Bulk</span></div><div class="hold-note">Nothing open on Bulk right now. Open positions earn AURA every hour they stay open.</div></div>';
    const rows = ps
      .map((p) => (p.openTs ? `<div class="hold-row bulk" data-open-ts="${p.openTs}"><div class="hold-top">${PT.exm('bulk', 'sm')}<span class="mkt">${esc(p.mkt)} ${p.side === 'L' ? 'long' : 'short'}</span><span class="t"><b class="held"></b> · <b class="mult"></b></span></div><div class="hold-bar" role="img"><i></i></div><div class="hold-note"></div></div>` : ''))
      .join('');
    return `<div class="holds"><div class="holds-h"><span><b>Open on Bulk</b></span><span>multiplier so far, bar to 7 days</span></div>${rows}</div>`;
  }

  // Refresh the timers in place every 20 seconds while the Strategy page is open.
  function tickHolds() {
    const now = Date.now();
    if (isBulk()) {
      const m = (data.bulk && data.bulk.model) || null;
      PT.$$('.hold-row.bulk[data-open-ts]').forEach((row) => {
        const held = Math.max(0, now - Number(row.dataset.openTs));
        const h = held / HOUR;
        const mult = PT.bulkMult(h, m);
        row.querySelector('.held').textContent = heldText(held);
        row.querySelector('.mult').textContent = `${mult.toFixed(2)}×`;
        row.querySelector('.hold-bar i').style.width = `${Math.min(100, (h / 168) * 100).toFixed(1)}%`;
        row.querySelector('.hold-bar').setAttribute('aria-label', `Held ${heldText(held)}, multiplier ${mult.toFixed(2)}`);
        row.querySelector('.hold-note').textContent = `Another day takes it to ${PT.bulkMult(h + 24, m).toFixed(2)}×.`;
        row.classList.toggle('zone', h >= 24);
      });
      return;
    }
    PT.$$('.hold-row[data-open-ts]').forEach((row) => {
      const held = Math.max(0, now - Number(row.dataset.openTs));
      const st = holdState(held);
      row.classList.remove('early', 'zone', 'late');
      row.classList.add(st.cls);
      row.querySelector('.held').textContent = heldText(held);
      row.querySelector('.hold-bar i').style.width = `${Math.min(100, (held / (24 * HOUR)) * 100).toFixed(1)}%`;
      row.querySelector('.hold-bar').setAttribute('aria-label', `Held ${heldText(held)} of 24 hours`);
      row.querySelector('.hold-note').textContent = st.note;
    });
  }
  setInterval(tickHolds, 20000);

  // ---------- checklist rail ----------
  function fmtVal(item, v) {
    if (v == null || !Number.isFinite(v)) return '–';
    switch (item.unit) {
      case 'usd':
        return item.id === 'breakeven' || item.id === 'bBreakeven' ? signed(v) : PT.short(v);
      case 'mult':
        return `${v.toFixed(2)}×`;
      case 'usdWeek':
        return PT.short(v);
      case 'pct':
        return pct(v);
      case 'perDay':
        return `${v.toFixed(1)} a day`;
      case 'bps':
        return `${v.toFixed(2)} bps`;
      default:
        return String(v);
    }
  }
  function fmtTarget(item) {
    const t = item.target;
    if (item.cmp === 'between') return `${t[0]}–${t[1]} a day`;
    return `${item.cmp === 'lte' ? '≤' : '≥'} ${fmtVal(item, t)}`;
  }
  function progress(item) {
    const v = item.value;
    const t = item.target;
    if (v == null || !Number.isFinite(v)) return 0;
    if (item.cmp === 'between') {
      if (v >= t[0] && v <= t[1]) return 1;
      return v < t[0] ? (t[0] > 0 ? v / t[0] : 0) : t[1] / v;
    }
    if (item.cmp === 'lte') return v <= t ? 1 : t > 0 ? t / v : 0.05;
    if (t <= 0) return v >= t ? 1 : 0.1;
    return Math.max(0, Math.min(1, v / t));
  }

  // Editable targets, in the units people think in.
  function editInputs(item) {
    // The volume item shows its weekly target scaled to the window; edit the weekly number.
    const t = (item.id === 'volume' || item.id === 'bVolume') && data.targets ? data.targets[item.id] : item.target;
    const track = `<label><input type="checkbox" class="toggle" data-track="${item.id}" ${item.disabled ? '' : 'checked'}> Track</label>`;
    if (item.cmp === 'between') {
      return `<div class="ck-edit">${track}<label>from <input type="number" step="0.5" min="0" data-t="${item.id}" data-i="0" value="${t[0]}"></label><label>to <input type="number" step="0.5" min="0" data-t="${item.id}" data-i="1" value="${t[1]}"></label><span>a day</span></div>`;
    }
    let val = t;
    let unit = '';
    let step = 'any';
    if (item.unit === 'pct') {
      val = +(t * 100).toFixed(2);
      unit = '%';
      step = '1';
    } else if (item.unit === 'usd' || item.unit === 'usdWeek') {
      unit = item.unit === 'usdWeek' ? '$ a week' : '$';
      step = '100';
    } else if (item.unit === 'bps') {
      unit = 'bps';
      step = '0.1';
    } else if (item.unit === 'mult') {
      unit = '×';
      step = '0.05';
    }
    return `<div class="ck-edit">${track}<label>${item.cmp === 'lte' ? 'At most' : 'At least'} <input type="number" step="${step}" data-t="${item.id}" value="${val}"></label><span>${esc(unit)}</span></div>`;
  }

  function renderRail() {
    const rail = $('#st-rail');
    const ck = data.checklist;
    const open = PT.usSessionOpen ? PT.usSessionOpen(Date.now()) : (data.market || {}).open;
    const stateIcon = { pass: 'check', fail: 'x', na: 'na', off: 'off' };
    const viewKey = `${keyOf(shownIds())}|${windowKey}`;
    const sameView = shownRail.key === viewKey;
    const scoreChanged = !sameView || shownRail.passed !== ck.passed || shownRail.total !== ck.total;
    const entrance = (pendingEnter || !sameView) && !PT.reduceMotion(); // full entrance: rise, ticks, bars
    const fromScore = pendingEnter || !sameView || shownRail.passed == null ? 0 : shownRail.passed;
    const delta = sameView && !pendingEnter && shownRail.passed != null ? ck.passed - shownRail.passed : 0;
    const stateOf = (it) => (it.disabled ? 'off' : it.state);
    const items = ck.items
      .map((it, i) => {
        const state = stateOf(it);
        const p = progress(it);
        const srState = { pass: 'matched', fail: 'not yet', na: 'not measured yet', off: 'not tracked' }[state];
        const was = sameView && !pendingEnter ? shownRail.states[it.id] : null;
        const flash = was && was !== state && (state === 'pass' || state === 'fail') ? ` flash-${state}` : '';
        return `<li class="ck ${state}${flash}" style="--i:${i}">
          <span class="ck-tile">${PT.icon(RULE_ICON[it.id] || 'strategy')}<span class="ck-state">${PT.icon(stateIcon[state])}</span></span>
          <div>
            <div class="ck-title">${esc(it.label)}<span class="sr-only"> (${srState})</span></div>
            ${it.quote ? `<div class="ck-quote">“${esc(it.quote)}”</div>` : ''}
            <div class="ck-vals"><span>You <b>${esc(fmtVal(it, it.value))}</b></span><span>Target <b>${esc(fmtTarget(it))}</b></span></div>
            <div class="ck-bar"><i style="width:${(state === 'na' || state === 'off' ? 0 : p * 100).toFixed(0)}%"></i></div>
            ${isBulk() ? `<div class="ck-why">${esc(it.why)}</div>` : ''}
            <div class="ck-note">${isBulk() ? 'Measured' : 'Benchmark'}: ${esc(it.bench)}${it.note ? `. ${esc(it.note)}` : ''}</div>
            ${it.id === 'hold' || it.id === 'bHold' ? holdTimers() : ''}
            ${editing ? editInputs(it) : ''}
          </div>
        </li>`;
      })
      .join('');
    const ticks = ck.items.map((it, i) => `<i class="${it.disabled ? '' : it.state}" style="--i:${i}"></i>`).join('');
    // Keep where the checklist was scrolled to when new data redraws it.
    const keepRail = sameView ? rail.scrollTop : 0;
    const oldList = rail.querySelector('.ck-panel');
    const keepList = sameView && oldList ? oldList.scrollTop : 0;

    rail.innerHTML = `
      <section class="panel">
        <div class="score">
          <div><div class="score-num"><b class="n">${ck.passed}</b><span>/${ck.total}</span>${delta ? `<em class="score-delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : '−'}${Math.abs(delta)}</em>` : ''}</div><div class="score-cap">${isBulk() ? 'AURA habits' : 'habits'} matched, ${esc(data.window.label.charAt(0).toLowerCase() + data.window.label.slice(1))}</div></div>
          <button class="btn btn-sm" id="st-edit" aria-pressed="${editing}">${PT.icon(editing ? 'check' : 'sliders', 'sm')}${editing ? 'Done' : 'Edit targets'}</button>
        </div>
        <div class="ticks" aria-hidden="true">${ticks}</div>
        ${
          isBulk()
            ? `<div class="session">${PT.icon('clock')}<span>AURA week closes <b>${esc(localFmt.format(new Date(bulkCutoff())))}</b></span><span class="mono" data-countdown="${bulkCutoff()}" data-done="Closing">${esc(PT.countdown(bulkCutoff() - Date.now()))}</span></div>`
            : `<div class="session">${PT.icon('globe')}<span>US session <b>${open ? 'open' : 'closed'}</b>: stock trades count as ${open ? 'US hours' : '<b>off-hours</b>'}</span><span class="mono">NY ${esc(PT.nyClock())}</span></div>`
        }
        ${editing ? `<div class="edit-bar"><button class="btn btn-primary btn-sm" id="st-save">Save targets</button><button class="btn btn-sm" id="st-reset">${isBulk() ? 'Reset to measured' : 'Reset to benchmark'}</button><div class="pts-error" id="st-edit-err" style="margin:0;flex-basis:100%"></div></div>` : ''}
      </section>
      <section class="panel ck-panel" tabindex="0" aria-label="Habits"><ul class="checklist" aria-label="Strategy checklist">${items}</ul></section>
      ${
        isBulk()
          ? `<section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('sparkles')}How Bulk pays trading AURA</h2><p class="ph-sub">${esc(data.bulk.holdKnown ? 'From the AURA model in this build' : 'From your own revealed weeks')}</p></div></div>
        <div class="pb tips">${(data.bulk.tips || []).map((t) => `<div class="tip">${PT.icon(t.icon)}<div><b>${esc(t.title)}</b><p>${esc(t.body)}</p></div></div>`).join('')}</div>
      </section>`
          : `<section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('quote')}Where the rules come from</h2><p class="ph-sub">The benchmark trader's messages, translated from Turkish</p></div></div>
        <div class="pb notes">
          <div class="quote"><q>Min 7k 8k oi 24 saat tutuyorum</q><span>I keep at least $7–8K of open interest, 24 hours a day.</span></div>
          <div class="quote"><q>Günde 2 3 kere aç kapa yapıyorum</q><span>I open and close 2–3 times a day.</span></div>
        </div>
      </section>`
      }`;

    fitRail();
    rail.scrollTop = keepRail;
    const list = rail.querySelector('.ck-panel');
    if (list) list.scrollTop = keepList;
    rail.classList.toggle('anim', entrance);
    if (entrance || scoreChanged) PT.countUp($('.score-num .n', rail), ck.passed, { from: fromScore, dur: 650 + 60 * Math.abs(ck.passed - fromScore), fmt: (v) => String(Math.round(v)) });
    shownRail = { key: viewKey, passed: ck.passed, total: ck.total, states: Object.fromEntries(ck.items.map((it) => [it.id, stateOf(it)])) };
    pendingEnter = false;

    tickHolds();
    $('#st-edit').onclick = () => {
      editing = !editing;
      renderRail();
    };
    if (editing) {
      $('#st-save').onclick = saveTargets;
      $('#st-reset').onclick = async () => {
        const defaults = Object.fromEntries(((isBulk() ? PT.state.bulkRules : PT.state.rules) || []).map((r) => [r.id, r.default]));
        try {
          await PT.post('/api/targets', { targets: defaults, disabled: [], mode: isBulk() ? 'bulk' : undefined });
          editing = false;
          await load(true);
        } catch (e) {
          $('#st-edit-err').textContent = e.message;
        }
      };
    }
  }

  async function saveTargets() {
    const targets = {};
    const disabled = [];
    for (const it of data.checklist.items) {
      const inputs = PT.$$(`input[data-t="${it.id}"]`);
      if (it.cmp === 'between') {
        targets[it.id] = [Number(inputs[0].value), Number(inputs[1].value)];
      } else if (inputs[0]) {
        const v = Number(inputs[0].value);
        targets[it.id] = it.unit === 'pct' ? v / 100 : v;
      }
      const tr = PT.$(`input[data-track="${it.id}"]`);
      if (tr && !tr.checked) disabled.push(it.id);
    }
    try {
      await PT.post('/api/targets', { targets, disabled, mode: isBulk() ? 'bulk' : undefined });
      editing = false;
      await load(true);
    } catch (e) {
      $('#st-edit-err').textContent = e.message;
    }
  }

  // The checklist column scrolls on its own; keep its height to what's visible below its top edge.
  function fitRail() {
    const rail = $('#st-rail');
    if (!rail || !rail.offsetParent) return;
    const top = Math.max(68, Math.round(rail.getBoundingClientRect().top));
    if (rail.style.getPropertyValue('--rail-top') !== `${top}px`) rail.style.setProperty('--rail-top', `${top}px`);
  }
  let fitQueued = false;
  window.addEventListener(
    'scroll',
    () => {
      if (fitQueued) return;
      fitQueued = true;
      requestAnimationFrame(() => {
        fitQueued = false;
        fitRail();
      });
    },
    { passive: true }
  );
  window.addEventListener('resize', fitRail);

  PT.strategy = {
    load,
    redraw: () => data && (drawCharts(), fitRail()),
    // Shared with the Pulse widget: the exchanges picked here, and how habits are shown.
    selection: () => keyOf(selected),
    selectionName: () => (selected.length === EX.length ? 'All exchanges' : nameOf(selected)),
    fmtVal,
    fmtTarget,
    progress,
    icon: (id) => RULE_ICON[id] || 'strategy',
  };
})();
