/* AURA Planner (experimental): price a Bulk trade before you open it. Pick the market, the size, how
   you open and close (market orders are taker fills and earn trading AURA; limit orders are maker
   fills, which pay no fee and earn none) and how long you hold. The planner works out:
     AURA  = taker rate x taker volume + hold rate x dollars open x hours open
     fees  = size x Bulk's taker fee for that market (crypto by your 14-day volume tier; stocks,
             ETFs and indices flat 1.5 bps) for each taker side
   with the rates from the AURA model (your own this week, else typical ones). Data: /api/planner */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc, money, compact, count } = PT;
  const HOUR = 3600 * 1000;
  const HOLDS = [
    { v: '1h', label: '1 hour', h: 1 },
    { v: '6h', label: '6 hours', h: 6 },
    { v: '1d', label: '1 day', h: 24 },
    { v: '2d', label: '2 days', h: 48 },
    { v: '3d', label: '3 days', h: 72 },
    { v: '1w', label: '1 week', h: 168 },
    { v: 'cutoff', label: 'Until the cutoff' },
    { v: 'custom', label: 'Custom' },
  ];
  const SIZES = [1000, 5000, 10000, 25000, 100000];
  const MOVES = [-10, -5, 0, 5, 10]; // price at close vs open, %
  const COMPARE = [1, 24, 48, 72, 168];
  let data = null;
  let loading = false;
  const st = {
    symbol: PT.prefs.get('planner.symbol') || 'BTC-USD',
    size: Number(PT.prefs.get('planner.size')) || 10000,
    open: PT.prefs.get('planner.open') || 'taker',
    close: PT.prefs.get('planner.close') || 'taker',
    hold: PT.prefs.get('planner.hold') || '1d',
    custom: Number(PT.prefs.get('planner.custom')) || 12,
    unit: PT.prefs.get('planner.unit') || 'h',
    move: Number(PT.prefs.get('planner.move')) || 0,
  };
  const moveOf = () => Math.max(-90, Math.min(500, Number(st.move) || 0)) / 100;
  const pct = (m) => `${m > 0 ? '+' : m < 0 ? '−' : ''}${Math.abs(m)}%`;
  const save = () => {
    for (const k of Object.keys(st)) PT.prefs.set(`planner.${k}`, String(st[k]));
  };

  const usd = (n, dp) => (n == null || !Number.isFinite(n) ? '–' : money(n, { dp: dp != null ? dp : Math.abs(n) >= 100 ? 0 : 2 }));
  const aura = (n) => (n == null || !Number.isFinite(n) ? '–' : n >= 100 ? count(Math.round(n)) : n.toFixed(n >= 10 ? 1 : 2));
  const hoursText = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${+h.toFixed(h < 10 ? 1 : 0)} h` : `${+(h / 24).toFixed(1)} days`);

  async function load(force = false) {
    if (loading) return;
    if (data && !force) return render();
    loading = true;
    try {
      data = await PT.getJSON('/api/planner');
      if (!data.markets.some((m) => m.symbol === st.symbol)) st.symbol = (data.markets.find((m) => m.symbol === 'BTC-USD') || data.markets[0] || {}).symbol || 'BTC-USD';
      render();
    } catch (e) {
      if (!data) $('#pl-main').innerHTML = `<div class="panel"><div class="empty">${PT.icon('alert')}${esc(`Couldn't load the planner: ${e.message}`)}</div></div>`;
    } finally {
      loading = false;
    }
  }

  // The AURA week's cutoff at or after `t` (Saturday 12:30 UTC).
  function cutoffAfter(t) {
    let c = data.cutoff;
    while (c <= t) c += 7 * 24 * HOUR;
    return c;
  }

  function holdHours(now) {
    if (st.hold === 'cutoff') return Math.max(0, (cutoffAfter(now) - now) / HOUR - 5 / 60); // close 5 minutes before it
    if (st.hold === 'custom') return Math.max(0, Math.min(24 * 30, st.custom * (st.unit === 'd' ? 24 : 1)));
    return (HOLDS.find((x) => x.v === st.hold) || HOLDS[2]).h;
  }

  // Everything about one trade: AURA by part and by AURA week, fees, cost per 1,000 AURA.
  function plan(hours, now = Date.now()) {
    const m = data.markets.find((x) => x.symbol === st.symbol) || { cls: 'crypto', takerBps: data.tier.takerBps };
    const N = Math.max(0, st.size || 0);
    // The position's value at close follows the price (long or short alike: size x exit price), so
    // the closing order, its fee and its AURA do too; the hold earns on the value in between.
    const Nc = N * (1 + moveOf());
    const Nh = (N + Nc) / 2;
    const base = data.rates.base || 0;
    const oi = data.rates.oiHour || 0;
    const cut = cutoffAfter(now);
    const closeAt = now + hours * HOUR;
    const inWeek = Math.max(0, Math.min(hours, (cut - now) / HOUR)); // hours open before the cutoff
    const openA = st.open === 'taker' ? base * N : 0;
    const holdA = oi * Nh * hours;
    const holdThis = oi * Nh * inWeek;
    const closeA = st.close === 'taker' ? base * Nc : 0;
    const closesThisWeek = closeAt < cut;
    // This week's gauntlet: the trade's taker volume this week adds to your share of its reward
    // (what your share becomes with it, minus what it is without it).
    const g = data.gauntlet;
    const gCounts = Boolean(g && g.measurable && (g.goal === 'taker' || (g.markets || []).includes(st.symbol)));
    const tv = (st.open === 'taker' ? N : 0) + (st.close === 'taker' && closesThisWeek ? Nc : 0);
    let gauntA = 0;
    if (gCounts && g.total && g.total.projected > 0 && tv > 0) {
      const Y = g.yours ? g.yours.projected || 0 : 0;
      const T = g.total.projected;
      // Scaled like the gauntlet estimate itself, by what Bulk paid against past estimates.
      const f = g.calibration && g.calibration.factor > 0 ? g.calibration.factor : 1;
      gauntA = Math.max(0, f * g.reward * ((Y + tv) / (Math.max(T, Y) + tv) - Y / Math.max(T, Y || 1)));
    }
    const thisWeek = openA + holdThis + (closesThisWeek ? closeA : 0) + gauntA;
    const total = openA + holdA + closeA + gauntA;
    const bps = m.takerBps;
    const openFee = st.open === 'taker' ? (N * bps) / 1e4 : (N * data.makerBps) / 1e4;
    const closeFee = st.close === 'taker' ? (Nc * bps) / 1e4 : (Nc * data.makerBps) / 1e4;
    const fees = openFee + closeFee;
    return { m, N, Nc, hours, cut, closeAt, closesThisWeek, inWeek, openA, holdA, holdThis, closeA, gauntA, gCounts, thisWeek, later: total - thisWeek, total, bps, openFee, closeFee, fees, per1k: total > 0 ? (fees / total) * 1000 : null };
  }

  function leagueAfter(addThisWeek) {
    const L = data.league;
    if (!L || L.endAura == null || !L.cutoffs) return null;
    const end = L.endAura + addThisWeek;
    const ids = ['challenger', 'diamond', 'platinum', 'gold'];
    const id = L.qualified === false ? null : ids.find((k) => L.cutoffs[k] != null && end >= L.cutoffs[k]) || null;
    const up = id ? ids[ids.indexOf(id) - 1] : 'gold';
    return { end, before: L.endAura, id, name: id ? L.names[id] : null, was: L.current, next: up && L.cutoffs[up] != null ? { name: L.names[up], cutoff: L.cutoffs[up], gap: Math.max(0, L.cutoffs[up] - end) } : null };
  }

  function seg(name, opts, value) {
    return `<div class="seg pl-seg" role="group" data-pl="${name}">${opts.map(([v, label]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${String(v === value)}">${label}</button>`).join('')}</div>`;
  }

  function render() {
    const main = $('#pl-main');
    if (!data) {
      main.innerHTML = `<div class="panel empty"><span class="spinner"></span>Loading…</div>`;
      return;
    }
    const dev = (PT.state && PT.state.developer) || { handle: '@Korgonxx', x: 'https://x.com/Korgonxx' };
    const crypto = data.markets.filter((m) => m.cls === 'crypto');
    const tradfi = data.markets.filter((m) => m.cls === 'tradfi');
    const opt = (m) => `<option value="${esc(m.symbol)}"${m.symbol === st.symbol ? ' selected' : ''}>${esc(m.symbol.replace(/-USD$/, ''))} · ${esc(PT.plain ? PT.plain(m.takerBps) : m.takerBps)} bps</option>`;
    main.innerHTML = `
      <div class="exp-banner">${PT.icon('sparkles', 'sm')}<span><b>Experimental.</b> The planner uses the AURA model’s rates and Bulk’s published fees, and Bulk’s rates move every week. More updates will be shared on X.</span><a class="btn btn-sm" href="${esc(dev.x)}" target="_blank" rel="noopener noreferrer"><span class="x-mark" aria-hidden="true">𝕏</span>Follow ${esc(dev.handle)}</a></div>
      <div class="pl-layout">
        <section class="panel pl-form">
          <div class="ph"><div><h2 class="ph-title">${PT.icon('sliders')}Your trade</h2><p class="ph-sub">Opens now, on Bulk</p></div></div>
          <div class="pb">
            <label class="pl-field"><span>Market</span>
              <span class="select-wrap"><select class="select" id="pl-symbol" aria-label="Market">${crypto.length ? `<optgroup label="Crypto">${crypto.map(opt).join('')}</optgroup>` : ''}${tradfi.length ? `<optgroup label="Stocks, ETFs and indices (lower fees)">${tradfi.map(opt).join('')}</optgroup>` : ''}</select><i data-icon="chevron" data-cls="chev"></i></span>
            </label>
            <label class="pl-field"><span>Size (notional)</span>
              <span class="pl-money"><b>$</b><input type="number" id="pl-size" min="0" step="100" inputmode="decimal" value="${st.size}"></span>
            </label>
            <div class="pl-chips">${SIZES.map((s) => `<button type="button" class="chip pl-chip${s === st.size ? ' on' : ''}" data-size="${s}">${esc(PT.short(s))}</button>`).join('')}</div>
            <div class="pl-field"><span>Open with</span>${seg('open', [['taker', 'Market <em>taker</em>'], ['maker', 'Limit <em>maker</em>']], st.open)}</div>
            <div class="pl-field"><span>Close with</span>${seg('close', [['taker', 'Market <em>taker</em>'], ['maker', 'Limit <em>maker</em>']], st.close)}</div>
            <div class="pl-field"><span>Price at close</span>
              <div class="pl-holds" role="group" data-pl="move">${MOVES.map((m) => `<button type="button" class="chip pl-chip${m === Number(st.move) ? ' on' : ''}" data-v="${m}">${m === 0 ? 'Same' : pct(m)}</button>`).join('')}<span class="pl-money pl-move"><input type="number" id="pl-move" min="-90" max="500" step="1" value="${Number(st.move) || 0}" aria-label="Price at close, percent vs open"><b>%</b></span></div>
            </div>
            <div class="pl-field"><span>Hold for</span>
              <div class="pl-holds" role="group" data-pl="hold">${HOLDS.map((h) => `<button type="button" class="chip pl-chip${h.v === st.hold ? ' on' : ''}" data-v="${h.v}">${esc(h.label)}</button>`).join('')}</div>
              <div class="pl-custom" ${st.hold === 'custom' ? '' : 'hidden'}><input type="number" id="pl-custom" min="0" step="1" value="${st.custom}" aria-label="Custom hold">${seg('unit', [['h', 'hours'], ['d', 'days']], st.unit)}</div>
            </div>
            <p class="pl-note">${PT.icon('info', 'sm')}<span>Only taker fills (market orders) earn trading AURA. Limit orders that rest on the book are maker fills: no fee, and no trading AURA.</span></p>
          </div>
        </section>
        <div class="pl-out" id="pl-out"></div>
      </div>`;
    PT.hydrateIcons && PT.hydrateIcons(main);
    wire();
    renderOut();
  }

  function renderOut() {
    const out = $('#pl-out');
    if (!out) return;
    const now = Date.now();
    if (!(data.rates.base > 0)) {
      out.innerHTML = `<section class="panel"><div class="empty">${PT.icon('sparkles')}<div><b>No AURA rate yet.</b><br>Import your Bulk AURA on the Points page (or wait for Bulk’s market data) and the planner can price trades.</div></div></section>`;
      return;
    }
    const h = holdHours(now);
    const p = plan(h, now);
    const lo = p.total * (1 - data.err);
    const hi = p.total * (1 + data.err);
    const lg = leagueAfter(p.thisWeek);
    const src = data.rates.source === 'yours' ? `your rates${data.rates.week ? ` (from week ${data.rates.week})` : ''}` : 'typical rates';
    const feeTxt = p.m.cls === 'tradfi' ? `${p.bps} bps taker: stocks, ETFs and indices have one flat fee` : `${p.bps} bps taker: crypto tier ${data.tier.tier} from your 14-day volume (${compact(data.tier.volume14)})${data.tier.next ? `; tier ${data.tier.next.tier} (${data.tier.next.takerBps} bps) from ${compact(data.tier.next.at)}` : ''}`;
    const row = (label, sub, value, cls = '') => `<div class="pl-row ${cls}"><span><b>${label}</b>${sub ? `<em>${sub}</em>` : ''}</span><span class="mono">${value}</span></div>`;
    const cmp = COMPARE.map((hh) => ({ hh, q: plan(hh, now) }));
    out.innerHTML = `
      <section class="panel pl-result">
        <div class="pl-hero">
          <div><span class="cell-l">${PT.icon('sparkles')}Trading AURA from this trade</span><div class="pl-big">≈ ${esc(aura(p.total))}</div><span class="cell-s">${esc(`Likely ${aura(lo)}–${aura(hi)} · ${src}`)}</span></div>
          <div><span class="cell-l">${PT.icon('receipt')}Fees</span><div class="pl-big pl-fee">${esc(usd(p.fees))}</div><span class="cell-s">${esc(p.per1k != null ? `${usd(p.per1k, 2)} per 1,000 AURA${data.yourFeesPer1k ? ` · your last week ${usd(data.yourFeesPer1k, 2)}` : ''}` : 'No taker fills, no trading AURA')}</span></div>
        </div>
        <div class="pb">
          ${row('Open', st.open === 'taker' ? `Market order, ${esc(usd(p.N, 0))} taker` : 'Limit order: maker fill', `${esc(aura(p.openA))} AURA · ${esc(usd(p.openFee))}`)}
          ${row(`Hold ${esc(hoursText(p.hours))}`, `${esc(p.Nc !== p.N ? `${usd(p.N, 0)} → ${usd(p.Nc, 0)}` : usd(p.N, 0))} open × ${esc(hoursText(p.hours))}${p.hours > p.inWeek + 1e-9 ? `, ${esc(hoursText(p.inWeek))} of it before the cutoff` : ''}`, `${esc(aura(p.holdA))} AURA`)}
          ${row('Close', `${st.close === 'taker' ? `Market order, ${esc(usd(p.Nc, 0))} taker` : 'Limit order: maker fill'}${p.Nc !== p.N ? ` (price ${esc(pct(Math.round(moveOf() * 1000) / 10))})` : ''} · ${esc(PT.localWhen(p.closeAt))}`, `${esc(aura(p.closeA))} AURA · ${esc(usd(p.closeFee))}`)}
          ${gauntletRow(p, row)}
          ${row('This AURA week', `Counts toward this week’s league · cutoff ${esc(PT.localWhen(p.cut))}`, `≈ ${esc(aura(p.thisWeek))} AURA`, 'pl-sum')}
          ${p.later > 0.05 ? row('Next week and after', p.closesThisWeek ? 'Hours open after the cutoff' : 'Closes after the cutoff: its hours and closing volume count next week', `≈ ${esc(aura(p.later))} AURA`, 'pl-sum') : ''}
          <p class="pl-note">${PT.icon('coins', 'sm')}<span>${esc(feeTxt)}. Makers pay 0 bps.</span></p>
        </div>
      </section>
      ${
        lg
          ? `<section class="panel"><div class="ph"><div><h2 class="ph-title">${PT.icon('trophy')}Your league this week</h2><p class="ph-sub">${esc(`At your pace you’d end the week near ${count(Math.round(lg.before))} trading AURA; this trade makes it ≈ ${count(Math.round(lg.end))}.`)}</p></div></div>
          <div class="pb pl-league"><span class="chip ${lg.id ? 'gold' : ''}">${esc(lg.name || 'Below Gold')}</span>${lg.was && lg.name && lg.was !== lg.name ? `<span>${esc(`up from ${lg.was}`)}</span>` : ''}${lg.next ? `<span>${esc(lg.next.gap > 0 ? `${count(Math.round(lg.next.gap))} AURA short of ${lg.next.name} (${count(lg.next.cutoff)})` : `Reaches ${lg.next.name}`)}</span>` : ''}<a href="#leagues" class="pl-link">Leagues ${PT.icon('chevron', 'sm pl-go')}</a></div></section>`
          : ''
      }
      <section class="panel">
        <div class="ph ruled"><div><h2 class="ph-title">${PT.icon('hourglass')}Hold longer?</h2><p class="ph-sub">The same trade with other hold times: an open position earns AURA every hour, so the fees buy more AURA the longer you hold.</p></div></div>
        <div class="table-wrap"><table><thead><tr><th>Hold</th><th class="num">AURA</th><th class="num">This week</th><th class="num">Fees</th><th class="num">Per 1,000 AURA</th></tr></thead><tbody>${cmp
          .map(({ hh, q }) => `<tr class="${Math.abs(hh - p.hours) < 0.01 ? 'lg-mine' : ''}"><td>${esc(hoursText(hh))}</td><td class="num"><b>${esc(aura(q.total))}</b></td><td class="num">${esc(aura(q.thisWeek))}</td><td class="num">${esc(usd(q.fees))}</td><td class="num">${esc(q.per1k != null ? usd(q.per1k, 2) : '–')}</td></tr>`)
          .join('')}</tbody></table></div>
      </section>
      <p class="lg-foot">${PT.icon('info', 'sm')}<span>${esc('Not included: funding (paid hourly between longs and shorts, either way), price moves, the spread and slippage, gauntlet bonuses, and how Bulk’s weekly rates move with its total volume. Gauntlet AURA counts toward your league, so a week whose gauntlet matches this trade pays extra.')}</span></p>`;
    PT.hydrateIcons && PT.hydrateIcons(out);
  }

  // This week's gauntlet, for the trade on screen.
  function gauntletRow(p, row) {
    const g = data.gauntlet;
    if (!g) return '';
    const where = g.goal === 'markets' ? (g.markets || []).map((m) => m.replace(/-USD$/, '')).join(', ') : 'every market';
    if (!g.measurable) return row(`Gauntlet: ${esc(g.title)}`, 'Its goal isn’t something the planner can price', '–');
    if (!p.gCounts) return row(`Gauntlet: ${esc(g.title)}`, `Counts taker volume on ${esc(where)}, not ${esc(p.m.symbol.replace(/-USD$/, ''))}`, '0 AURA');
    if (!(g.total && g.total.projected > 0)) return row(`Gauntlet: ${esc(g.title)}`, 'Waiting for Bulk’s volume to price it', '–');
    return row(`Gauntlet: ${esc(g.title)}`, `${esc(`Taker volume on ${where} · your extra share of ${g.reward.toLocaleString('en-US')} AURA`)}`, `+≈ ${esc(aura(p.gauntA))} AURA`, 'pl-gaunt');
  }

  function wire() {
    const main = $('#pl-main');
    $('#pl-symbol', main).onchange = (e) => {
      st.symbol = e.target.value;
      save();
      renderOut();
    };
    $('#pl-size', main).oninput = (e) => {
      st.size = Math.max(0, Number(e.target.value) || 0);
      main.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', Number(b.dataset.size) === st.size));
      save();
      renderOut();
    };
    main.querySelectorAll('[data-size]').forEach((b) =>
      b.addEventListener('click', () => {
        st.size = Number(b.dataset.size);
        $('#pl-size', main).value = st.size;
        main.querySelectorAll('[data-size]').forEach((x) => x.classList.toggle('on', x === b));
        save();
        renderOut();
      })
    );
    main.querySelectorAll('.pl-seg').forEach((g) =>
      g.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          st[g.dataset.pl] = b.dataset.v;
          g.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          save();
          renderOut();
        })
      )
    );
    main.querySelectorAll('[data-pl="hold"] button').forEach((b) =>
      b.addEventListener('click', () => {
        st.hold = b.dataset.v;
        main.querySelectorAll('[data-pl="hold"] button').forEach((x) => x.classList.toggle('on', x === b));
        $('.pl-custom', main).hidden = st.hold !== 'custom';
        save();
        renderOut();
      })
    );
    main.querySelectorAll('[data-pl="move"] button').forEach((b) =>
      b.addEventListener('click', () => {
        st.move = Number(b.dataset.v);
        $('#pl-move', main).value = st.move;
        main.querySelectorAll('[data-pl="move"] button').forEach((x) => x.classList.toggle('on', x === b));
        save();
        renderOut();
      })
    );
    $('#pl-move', main).oninput = (e) => {
      st.move = Math.max(-90, Math.min(500, Number(e.target.value) || 0));
      main.querySelectorAll('[data-pl="move"] button').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) === st.move));
      save();
      renderOut();
    };
    $('#pl-custom', main).oninput = (e) => {
      st.custom = Math.max(0, Number(e.target.value) || 0);
      save();
      renderOut();
    };
  }

  // Keep "until the cutoff" and the close time current while the page is open.
  setInterval(() => {
    if (location.hash.replace('#', '') === 'planner' && data && !document.activeElement?.closest?.('#pl-main input')) renderOut();
  }, 60 * 1000);

  PT.planner = { load };
})();
