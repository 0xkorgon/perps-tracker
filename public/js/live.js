/* Live: every open trade right now, grouped by asset so a Bulk position sits with its hedge on
   Entropy or Arcus. Hold times tick every second. With an AURA model that rates open positions
   (official owner builds), Bulk legs also show their hold multiplier and what they earn this AURA
   week if closed now. Colour: each leg carries its exchange's colour. */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, $$, esc, NAMES } = PT;
  const HOUR = 3600e3;

  let data = null;
  let legs = []; // every leg on the page, in table order (data-k is its index)
  let sig = '';
  let loading = false;

  const visible = () => location.hash.replace('#', '') === 'live';
  const WEEK_H = 168;
  const model = () => (data && data.model) || { perHour: PT.bulkPerHour() };
  const mult = (h) => PT.bulkMult(h, model());
  // Position on the colour ramp: 0 at 1.00×, 1 at a week held.
  const rampOf = (x) => Math.max(0, Math.min(1, (x - 1) / (mult(WEEK_H) - 1 || 1)));

  // One range per day of holding, then a week and more (it keeps growing).
  function ranges() {
    const out = [];
    for (let d = 0; d < 7; d++) out.push({ label: `Day ${d + 1}`, from: d * 24, to: (d + 1) * 24, lo: mult(d * 24), hi: mult((d + 1) * 24) });
    out.push({ label: '7 days +', from: WEEK_H, to: Infinity, lo: mult(WEEK_H), hi: null });
    return out;
  }
  // What a Bulk leg earns this AURA week if closed now: its taker volume this week and the close,
  // plus its hours open this week.
  const hoursThisWeek = (l, now) => Math.max(0, now - Math.max(l.openTs, data.weekStart)) / HOUR;
  const closeNow = (l, now) => ((l.weekVol || 0) + (l.notional || 0)) * data.rate.base + (data.rate.oiHour || 0) * (l.notional || 0) * hoursThisWeek(l, now);
  const rangeIndex = (h) => {
    const rs = ranges();
    const i = rs.findIndex((r) => h < r.to);
    return i === -1 ? rs.length - 1 : i;
  };
  const multText = (r) => (r.hi == null ? `from ${r.lo.toFixed(2)}×` : `${r.lo.toFixed(2)}–${r.hi.toFixed(2)}×`);

  // 1d 04:13:05 (or 04:13:05 under a day).
  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const p2 = (n) => String(n).padStart(2, '0');
    const hms = `${p2(Math.floor((s % 86400) / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
    return d ? `${d}d ${hms}` : hms;
  }
  const aura = (x) => `≈ ${x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1)}`;
  const usd = (n) => PT.money(n, { dp: Math.abs(n) >= 1000 ? 0 : 2 });

  async function load(force = false) {
    if (loading) return;
    loading = true;
    try {
      const d = await PT.getJSON('/api/live');
      const s = JSON.stringify([d.groups, d.rate, d.weekStart, d.hasBulk]);
      data = d;
      if (force || s !== sig || !$('#live-main').childElementCount) {
        sig = s;
        render();
      }
      tick();
    } catch (e) {
      if (!data) $('#live-main').innerHTML = `<div class="panel"><div class="empty">${PT.icon('alert')}Couldn't read your open trades (${esc(e.message)}). Is the tracker's window still open?</div></div>`;
    } finally {
      loading = false;
    }
  }

  // ---------- page ----------
  function render() {
    const d = data;
    const parts = [];
    const auraMode = d.hasBulk;
    if (auraMode) {
      parts.push(board(d));
      const rs = ranges();
      parts.push(`<section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('gauge')}Multiplier ranges</h2><p class="ph-sub">${esc(`+${(model().perHour * 100).toFixed(2)}% an hour while open, no cap (${(((d.rate.oiHour || 0) * 24 * 1000) || 0).toFixed(2)} AURA a day per $1K open). Lit up: where your open Bulk trades are now.`)}</p></div></div>
        <div class="pb"><div class="lv-ranges">${rs
          .map((r, i) => `<div class="lv-rg" data-rg="${i}" style="--p:${(i / (rs.length - 1)).toFixed(3)}"><span class="lv-rg-l">${esc(r.label)}</span><span class="lv-rg-m">${esc(multText(r))}</span><span class="lv-rg-n">–</span></div>`)
          .join('')}</div></div>
      </section>`);
    }
    parts.push(trades(d, auraMode));
    $('#live-main').innerHTML = parts.join('');
  }

  function board(d) {
    const n = d.bulk.length;
    const notional = d.bulk.reduce((a, p) => a + (p.notional || 0), 0);
    const bulkGroups = d.groups.filter((g) => g.legs.some((l) => l.exchange === 'bulk'));
    const unhedged = bulkGroups.filter((g) => g.status !== 'hedged').length;
    const hedgeText = !n ? '' : unhedged === 0 ? ' · hedged' : ` · ${unhedged} not hedged`;
    return `<div class="board"><div class="board-row even">
      ${PT.cell({ icon: 'layers', label: 'Open on Bulk', value: PT.count(n), sub: n ? `${usd(notional)} notional${hedgeText}` : 'Nothing open right now' })}
      <div class="cell"><span class="cell-l">${PT.icon('hourglass')}Multiplier now</span><span class="cell-v lv-ramp" id="lv-avg">–</span><span class="cell-s" id="lv-avg-s">Weighted by notional</span></div>
      <div class="cell"><span class="cell-l">${PT.icon('sparkles')}AURA if closed now</span><span class="cell-v lv-gold" id="lv-aura">–</span><span class="cell-s">${esc(`${(d.rate.base * 1000).toFixed(2)} per $1K taker + hours open`)}</span></div>
      <div class="cell"><span class="cell-l">${PT.icon('clock')}AURA week ends in</span><span class="cell-v" id="lv-cut">–</span><span class="cell-s">${esc(PT.localWhen(d.cutoff))}</span></div>
    </div></div>`;
  }

  function trades(d, auraMode) {
    legs = [];
    if (!d.groups.length) {
      return `<section class="panel"><div class="ph ruled"><div><h2 class="ph-title">${PT.icon('layers')}Open trades</h2></div></div><div class="empty">${PT.icon('hourglass')}Nothing open right now. Open a position and its hold time${auraMode ? ' and multiplier' : ''} show up here.</div></section>`;
    }
    const cols = auraMode ? 9 : 5;
    const exs = PT.ORDER.filter((id) => d.groups.some((g) => g.legs.some((l) => l.exchange === id)));
    const legend = `<div class="legend">${exs.map((id) => `<span><i class="key" style="background:${PT.COLOR[id]}"></i>${esc(NAMES[id])}</span>`).join('')}</div>`;
    const head = `<thead><tr><th>Position</th><th>Side</th><th class="num">Notional</th><th class="num">Unrealised PnL</th><th class="num">Held</th>${
      auraMode ? `<th class="num">Multiplier</th><th>Range</th><th class="num">Next</th><th class="num" title="What this position earns this AURA week if you close it now as taker: its taker volume this week and the close, plus its hours open this week">AURA if closed now</th>` : ''
    }</tr></thead>`;
    const bodies = d.groups.map((g) => `<tbody class="lv-group">${g.legs.length > 1 ? groupHead(g, cols) : ''}${g.legs.map((l) => legRow(l, auraMode, g.legs.length > 1)).join('')}</tbody>`).join('');
    const rateText = d.rate.source === 'yours' ? `your week ${d.rate.week} rate, adjusted for how busy Bulk is` : 'the typical rate until a revealed week of yours loads';
    const sub = auraMode
      ? `Grouped by asset, so each Bulk position sits with its hedge. AURA assumes you close as taker within this AURA week (${rateText}).`
      : (PT.holdKnown() || !PT.hasWallets('bulk') ? 'Grouped by asset. Add a Bulk wallet in Settings to see AURA multipliers here.' : 'Grouped by asset.');
    return `<section class="panel">
      <div class="ph ruled"><div><h2 class="ph-title">${PT.icon('layers')}Open trades</h2><p class="ph-sub">${esc(sub)}</p></div>${legend}</div>
      <div class="table-wrap"><table class="lv-table">${head}${bodies}</table></div>
      ${auraMode && d.bulk.some((l) => l.openTs) ? `<p class="lv-note">${PT.icon('info', 'sm')}<span id="lv-cut-note"></span></p>` : ''}
    </section>`;
  }

  // The hedge as a whole: is it balanced, what's left over, and what it's doing right now.
  function groupHead(g, cols) {
    const status = { hedged: ['up', 'Hedged'], uneven: ['gold', 'Uneven'], open: ['', 'One-sided'] }[g.status];
    const sides = g.legs.map((l) => `<span class="lv-gh-leg"><i class="key" style="background:${PT.COLOR[l.exchange]}"></i>${l.side === 'L' ? 'Long' : 'Short'} ${esc(usd(l.notional))} on ${esc(NAMES[l.exchange])}</span>`).join('');
    const stat = (label, v, cls = '') => `<span class="lv-gh-stat">${esc(label)} <b class="${cls}">${esc(v)}</b></span>`;
    let liq = '';
    if (g.nearest && g.nearest.dist < 0.15) {
      const n = g.nearest;
      const danger = n.dist < 0.05;
      const add = n.add10 > 0 ? ` · add ${usd(n.add10)} → 10%` : '';
      const tip = `${NAMES[n.exchange]} ${n.mkt}${n.est ? ' (liquidation price estimated)' : ''}.${n.add10 > 0 ? ` Adding about ${usd(n.add10)} margin moves it to 10% away${n.add15 > n.add10 ? `, ${usd(n.add15)} to 15%` : ''}, assuming the margin goes to this position.` : ''}`;
      liq = `<span class="chip ${danger ? 'down' : 'gold'}" title="${esc(tip)}">${PT.icon('alert')}${esc(NAMES[n.exchange])} liquidation ${(n.dist * 100).toFixed(1)}% away${esc(add)}</span>`;
    }
    return `<tr class="lv-gh"><td colspan="${cols}"><div class="lv-gh-in">
      <span class="lv-asset">${esc(g.asset)}</span><span class="chip ${status[0]}">${status[1]}</span>
      <span class="lv-gh-legs">${sides}</span>
      <span class="lv-gh-stats">${stat('Net', PT.signed(g.netUsd, { dp: 2 }), Math.abs(g.netUsd) < 0.05 * Math.max(g.longUsd, g.shortUsd) ? '' : 'lv-goldtx')}${stat('PnL', PT.signed(g.upnl), PT.pnlClass(g.upnl))}${g.fundDay != null ? stat('Funding', `${PT.signed(g.fundDay)}/day`, PT.pnlClass(g.fundDay)) : ''}${holdStat(g)}${liq}</span>
    </div></td></tr>`;
  }

  // What holding this hedge another day is worth: the AURA its Bulk legs earn per day open against
  // the funding the hedge pays per day.
  function holdStat(g) {
    const d = data;
    if (!d.hasBulk) return '';
    const legsB = g.legs.filter((l) => l.exchange === 'bulk' && l.openTs);
    if (!legsB.length) return '';
    const perDay = legsB.reduce((a, l) => a + (l.notional || 0) * (d.rate.oiHour || 0) * 24, 0);
    const tradeCost = d.takerBps / 1e4 / d.rate.base; // fees per AURA when you earn it by trading instead
    if (!(perDay > 0)) return '';
    let value = `+${perDay.toFixed(1)} AURA/day`;
    let cls = '';
    let tip = `Each day it stays open earns about ${perDay.toFixed(1)} AURA, cutoff or not.`;
    if (g.fundDay != null && g.fundDay < 0) {
      const each = -g.fundDay / perDay;
      value += ` · $${each.toFixed(2)} each`;
      cls = each <= tradeCost ? 'pos' : 'lv-goldtx';
      tip += ` Funding costs ${PT.money(-g.fundDay, { dp: 2 })} a day, about $${each.toFixed(2)} per AURA. Earning AURA by trading costs about $${tradeCost.toFixed(2)} each in fees, so holding is ${each <= tradeCost ? 'the cheaper way' : 'the dearer way'} right now.`;
    } else if (g.fundDay != null) {
      value += ' · funding pays you';
      cls = 'pos';
      tip += ' Funding is paying you, so holding costs nothing.';
    }
    return `<span class="lv-gh-stat" title="${esc(tip)}">Hold <b class="${cls}">${esc(value)}</b></span>`;
  }

  function legRow(l, auraMode, inGroup) {
    const k = legs.push(l) - 1;
    const mw = PT.multiWallet();
    const lev = l.lev ? ` <span class="chip mono">${esc(PT.plain(l.lev, 0))}×</span>` : '';
    const held = l.openTs
      ? `<span class="lv-held">–</span><span class="td-sub">${esc(`since ${PT.localWhen(l.openTs)}`)}</span>`
      : '<span class="muted" title="Opened before the history the exchange shares">unknown</span>';
    let tail = '';
    if (auraMode) {
      if (l.exchange !== 'bulk') tail = `<td class="lv-c-noaura" colspan="4">No AURA multiplier on ${esc(NAMES[l.exchange])}${inGroup ? ', this leg is the hedge' : ''}</td>`;
      else if (!l.openTs) tail = `<td class="lv-c-noaura" colspan="4">Opened before the history Bulk shares, so its multiplier is unknown</td>`;
      else
        tail = `<td class="num lv-c-mult" data-l="Multiplier"><span class="lv-mult"><b class="lv-m">–</b><span class="lv-bar" aria-hidden="true"><i></i></span></span></td>
          <td class="lv-c-rng" data-l="Range"><span class="chip lv-range">–</span></td>
          <td class="num lv-c-next" data-l="Next"><span class="lv-next">–</span><span class="td-sub lv-next-s"></span></td>
          <td class="num lv-c-aura" data-l="AURA if closed now"><b class="lv-a lv-gold">–</b><span class="td-sub lv-a-s"></span></td>`;
    }
    return `<tr class="lv-leg ex-${esc(l.exchange)}" data-k="${k}">
      <td class="lv-c-pos"><span class="lv-pos">${PT.exm(l.exchange, 'sm')}<span class="mkt">${esc(l.mkt)}</span>${lev}</span>${mw && l.wallet ? `<span class="td-sub">${esc(l.wallet)}</span>` : ''}</td>
      <td class="lv-c-side">${PT.sideBadge(l.side)}</td>
      <td class="num lv-c-not" data-l="Notional"><b>${esc(PT.money(l.notional, { dp: 2 }))}</b></td>
      <td class="num lv-c-pnl ${PT.pnlClass(l.upnl)}" data-l="Unrealised PnL">${esc(PT.signed(l.upnl))}</td>
      <td class="num lv-c-held" data-l="Held">${held}</td>${tail}
    </tr>`;
  }

  // ---------- once a second ----------
  function tick() {
    if (!data || !visible()) return;
    const now = Date.now();
    const d = data;
    const stamp = $('#live-stamp');
    if (stamp) stamp.textContent = d.pricesAt ? `Prices ${PT.ago(d.pricesAt)}` : 'Waiting for the first sync';
    const rs = ranges();
    const inRange = rs.map(() => ({ n: 0, usd: 0 }));
    let wN = 0;
    let wM = 0;
    let total = 0;
    let atCut = 0;
    let perDayAll = 0;
    legs.forEach((l, k) => {
      if (!l.openTs) return;
      const tr = $(`#live-main tr[data-k="${k}"]`);
      const heldEl = tr && tr.querySelector('.lv-held');
      if (heldEl) heldEl.textContent = clock(now - l.openTs);
      if (l.exchange !== 'bulk' || !d.hasBulk) return;
      const h = (now - l.openTs) / HOUR;
      const x = mult(h);
      const ri = rangeIndex(h);
      const r = rs[ri];
      inRange[ri].n += 1;
      inRange[ri].usd += l.notional || 0;
      wN += l.notional || 0;
      wM += (l.notional || 0) * x;
      const earn = closeNow(l, now);
      total += earn;
      // Left open to the cutoff: this week's taker volume and every hour until then.
      atCut += (l.weekVol || 0) * d.rate.base + (d.rate.oiHour || 0) * (l.notional || 0) * (Math.max(0, d.cutoff - Math.max(l.openTs, d.weekStart)) / HOUR);
      perDayAll += (l.notional || 0) * (d.rate.oiHour || 0) * 24;
      if (!tr) return;
      tr.style.setProperty('--p', rampOf(x).toFixed(3));
      tr.querySelector('.lv-m').textContent = `${x.toFixed(3)}×`;
      tr.querySelector('.lv-bar i').style.width = `${Math.min(100, (h / WEEK_H) * 100).toFixed(2)}%`;
      tr.querySelector('.lv-range').textContent = `${r.label} · ${multText(r)}`;
      const next = tr.querySelector('.lv-next');
      const nextS = tr.querySelector('.lv-next-s');
      const nextDay = (Math.floor(h / 24) + 1) * 24;
      next.textContent = `${mult(nextDay).toFixed(2)}× in ${PT.countdown(nextDay * HOUR - (now - l.openTs))}`;
      nextS.textContent = h < WEEK_H ? `${mult(WEEK_H).toFixed(2)}× at a week, ${PT.localWhen(l.openTs + WEEK_H * HOUR)}` : `+${(model().perHour * 2400).toFixed(0)}% a day, no cap`;
      tr.querySelector('.lv-a').textContent = aura(earn);
      tr.querySelector('.lv-a-s').textContent = `${PT.compact((l.weekVol || 0) + (l.notional || 0))} taker · ${Math.round(hoursThisWeek(l, now))} h open`;
    });
    if (!d.hasBulk) return;

    const avg = $('#lv-avg');
    if (avg) {
      const a = wN > 0 ? wM / wN : null;
      avg.textContent = a ? `${a.toFixed(2)}×` : '–';
      avg.style.setProperty('--p', a ? rampOf(a).toFixed(3) : '0');
      avg.classList.toggle('lv-ramp', Boolean(a));
      $('#lv-avg-s').textContent = a ? 'Weighted by notional' : 'Opens at 1.00×';
    }
    const tot = $('#lv-aura');
    if (tot) tot.textContent = wN > 0 ? aura(total) : '–';
    const cut = $('#lv-cut');
    if (cut) {
      cut.textContent = d.cutoff > now ? PT.countdown(d.cutoff - now) : 'Any moment now';
      cut.classList.toggle('lv-goldtx', d.cutoff - now < 24 * HOUR);
    }
    const note = $('#lv-cut-note');
    if (note)
      note.textContent = `Left open to the cutoff (${PT.localWhen(d.cutoff)}), your Bulk positions earn about ${atCut >= 100 ? Math.round(atCut).toLocaleString('en-US') : atCut.toFixed(1)} AURA this week (≈ ${perDayAll >= 100 ? Math.round(perDayAll).toLocaleString('en-US') : perDayAll.toFixed(1)} a day while open), and keep earning after it, for next week. Closing adds their size as taker volume in the week you close.`;
    $$('#live-main .lv-rg').forEach((el) => {
      const c = inRange[Number(el.dataset.rg)];
      el.classList.toggle('on', c.n > 0);
      el.querySelector('.lv-rg-n').textContent = c.n ? `${c.n} open · ${PT.compact(c.usd)}` : '–';
    });
  }
  setInterval(tick, 1000);

  PT.live = { load };
})();
