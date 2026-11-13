/* Small hand-rolled SVG/HTML charts: stacked columns, lines/areas, donuts, bars, heatmap.
   Colours come in as CSS variables, so charts follow the light/dark theme. */
(() => {
  'use strict';

  const PT = window.PT;
  const { esc } = PT;

  function niceTicks(max, n = 4) {
    if (!(max > 0)) return [0, 1];
    const raw = max / n;
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
    const ticks = [];
    for (let v = 0; v <= Math.ceil(max / step) * step + step / 2; v += step) ticks.push(v);
    return ticks;
  }
  function niceRange(min, max, n = 4) {
    if (min >= 0) return niceTicks(max, n);
    const span = max - min || 1;
    const raw = span / n;
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return ticks;
  }
  const roundedTop = (x, y, w, h, r) => `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  const tickEvery = (band) => (band < 14 ? 7 : band < 22 ? 5 : band < 34 ? 3 : band < 60 ? 2 : 1);

  // ---------- stacked columns ----------
  // opts: { labels[], series:[{name,color,values[]}], fmt(v), axisFmt(v), title(i) }
  PT.stackedColumns = (host, opts) => {
    const { labels, series } = opts;
    const fmt = opts.fmt || PT.compact;
    const axisFmt = opts.axisFmt || PT.short;
    const W = Math.max(300, Math.floor(host.clientWidth || 800));
    const H = opts.height || 240;
    const m = { l: 54, r: 6, t: 12, b: 26 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const totals = labels.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0));
    const maxV = Math.max(0, ...totals);
    if (!(maxV > 0)) {
      host.innerHTML = `<div class="chart-empty">${esc(opts.empty || 'No volume in this window yet.')}</div>`;
      return;
    }
    const ticks = niceTicks(maxV, 4);
    const top = ticks[ticks.length - 1];
    const y = (v) => m.t + ih - (v / top) * ih;
    const band = iw / labels.length;
    const bw = Math.max(3, Math.min(24, band * 0.62));
    const out = [`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(opts.aria || 'Stacked column chart')}">`];
    for (const t of ticks) {
      out.push(`<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`);
      out.push(`<text class="tick" x="${m.l - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(axisFmt(t))}</text>`);
    }
    labels.forEach((_, i) => {
      const x = m.l + band * i + (band - bw) / 2;
      const segs = series.map((s) => ({ s, v: Math.max(0, s.values[i] || 0) })).filter((x2) => x2.v > 0);
      let acc = 0;
      let g = `<g class="col" data-i="${i}">`;
      segs.forEach((sg, j) => {
        const yTop = y(acc + sg.v);
        let yBottom = y(acc);
        acc += sg.v;
        if (j > 0) yBottom -= 2; // surface gap between stacked segments
        const h = yBottom - yTop;
        if (h < 0.75) return;
        const fill = `style="fill:${sg.s.color}"`;
        g += j === segs.length - 1 ? `<path d="${roundedTop(x, yTop, bw, h, Math.min(4, h, bw / 2))}" ${fill}/>` : `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" ${fill}/>`;
      });
      out.push(`${g}</g>`);
    });
    out.push(`<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>`);
    const every = tickEvery(band);
    labels.forEach((lab, i) => {
      if ((labels.length - 1 - i) % every !== 0) return;
      out.push(`<text class="tick" x="${(m.l + band * i + band / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(lab)}</text>`);
    });
    labels.forEach((lab, i) => {
      out.push(`<rect class="hit" data-i="${i}" x="${(m.l + band * i).toFixed(1)}" y="${m.t}" width="${band.toFixed(1)}" height="${ih}" tabindex="0" aria-label="${esc(`${lab}: ${fmt(totals[i])}`)}"/>`);
    });
    out.push('</svg>');
    host.innerHTML = out.join('');

    const cols = PT.$$('.col', host);
    const show = (i, cx, cy) => {
      const rows = series.map((s) => ({ name: s.name, color: s.color, value: fmt(s.values[i] || 0), box: true }));
      PT.showTip(PT.tipRows(opts.title ? opts.title(i) : labels[i], rows, series.length > 1 ? { name: 'Total', value: fmt(totals[i]) } : null), cx, cy);
      host.classList.add('hovering');
      cols.forEach((c) => c.classList.toggle('active', Number(c.dataset.i) === i));
    };
    const hide = () => {
      PT.hideTip();
      host.classList.remove('hovering');
      cols.forEach((c) => c.classList.remove('active'));
    };
    PT.$$('.hit', host).forEach((el) => {
      const i = Number(el.dataset.i);
      el.addEventListener('pointermove', (ev) => show(i, ev.clientX, ev.clientY));
      el.addEventListener('pointerleave', hide);
      el.addEventListener('focus', () => {
        const b = el.getBoundingClientRect();
        show(i, b.left + b.width / 2, b.top + b.height / 2);
      });
      el.addEventListener('blur', hide);
    });
  };

  // ---------- lines / areas ----------
  // opts: { labels[], series:[{name,color,values[],area?,dash?,width?}], fmt, axisFmt, ref:{value,label}, step?, title(i) }
  PT.lineChart = (host, opts) => {
    const { labels, series } = opts;
    const fmt = opts.fmt || ((v) => PT.money(v, { dp: 2 }));
    const axisFmt = opts.axisFmt || PT.short;
    const W = Math.max(300, Math.floor(host.clientWidth || 800));
    const H = opts.height || 230;
    const m = { l: 56, r: 10, t: 14, b: 26 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const all = series.flatMap((s) => s.values.filter(Number.isFinite));
    if (opts.ref && Number.isFinite(opts.ref.value)) all.push(opts.ref.value);
    if (!labels.length || !all.length) {
      host.innerHTML = `<div class="chart-empty">${esc(opts.empty || 'Nothing to show for this window yet.')}</div>`;
      return;
    }
    const lo = Math.min(0, ...all);
    const hi = Math.max(...all, lo + 1e-9);
    const ticks = niceRange(lo, hi, 4);
    const t0 = ticks[0];
    const t1 = ticks[ticks.length - 1];
    const y = (v) => m.t + ih - ((v - t0) / (t1 - t0 || 1)) * ih;
    const n = labels.length;
    const x = (i) => (opts.step ? m.l + (iw * i) / n : m.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1)));
    const out = [`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(opts.aria || 'Line chart')}">`];
    for (const t of ticks) {
      out.push(`<line class="${t === 0 ? 'baseline' : 'gridline'}" x1="${m.l}" x2="${W - m.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`);
      out.push(`<text class="tick" x="${m.l - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(axisFmt(t))}</text>`);
    }
    for (const s of series.slice().reverse()) { // first series is drawn last, so it sits on top
      const pts = [];
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        if (opts.step) {
          pts.push([x(i), y(v)]);
          pts.push([x(i + 1), y(v)]);
        } else pts.push([x(i), y(v)]);
      });
      if (!pts.length) continue;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      if (s.area) {
        const base = y(Math.max(0, t0));
        out.push(`<path d="${d}L${pts[pts.length - 1][0].toFixed(1)},${base.toFixed(1)}L${pts[0][0].toFixed(1)},${base.toFixed(1)}Z" style="fill:${s.color};opacity:0.12"/>`);
      }
      out.push(`<path d="${d}" fill="none" style="stroke:${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="5 4"' : ''}/>`);
    }
    if (opts.ref && Number.isFinite(opts.ref.value)) {
      const ry = y(opts.ref.value).toFixed(1);
      out.push(`<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${ry}" y2="${ry}"/><text class="ref-label" x="${W - m.r - 2}" y="${(Number(ry) - 5).toFixed(1)}" text-anchor="end">${esc(opts.ref.label)}</text>`);
    }
    const every = tickEvery(iw / n);
    labels.forEach((lab, i) => {
      if ((n - 1 - i) % every !== 0) return;
      const cx = opts.step ? x(i) + iw / n / 2 : x(i);
      out.push(`<text class="tick" x="${cx.toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(lab)}</text>`);
    });
    out.push(`<line class="crosshair" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>`);
    out.push(`<rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" tabindex="0" aria-label="${esc(opts.aria || 'chart')}"/>`);
    out.push('</svg>');
    host.innerHTML = out.join('');
    const svg = PT.$('svg', host);
    const cross = PT.$('.crosshair', host);
    const hit = PT.$('.hit', host);
    const idxAt = (clientX) => {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      const i = opts.step ? Math.floor(((px - m.l) / iw) * n) : Math.round(((px - m.l) / iw) * (n - 1));
      return Math.max(0, Math.min(n - 1, i));
    };
    const show = (i, cx, cy) => {
      const xx = opts.step ? x(i) + iw / n / 2 : x(i);
      cross.setAttribute('x1', xx);
      cross.setAttribute('x2', xx);
      cross.setAttribute('visibility', 'visible');
      const rows = series.map((s) => ({ name: s.name, color: s.color, value: fmt(s.values[i]) }));
      PT.showTip(PT.tipRows(opts.title ? opts.title(i) : labels[i], rows), cx, cy);
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      PT.hideTip();
    };
    hit.addEventListener('pointermove', (ev) => show(idxAt(ev.clientX), ev.clientX, ev.clientY));
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => {
      const b = hit.getBoundingClientRect();
      show(n - 1, b.right - 20, b.top + b.height / 2);
    });
    hit.addEventListener('blur', hide);
  };

  // ---------- donut ----------
  // items:[{name,color,value}] -> returns HTML (svg + legend)
  PT.donut = (items, opts = {}) => {
    const fmt = opts.fmt || PT.compact;
    const total = items.reduce((a, x) => a + Math.max(0, x.value || 0), 0);
    const size = opts.size || 150;
    const r = size / 2 - 8;
    const sw = opts.thickness || 18;
    const c = 2 * Math.PI * r;
    let svg = `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(`${opts.title || 'Share'}: ${items.map((x) => `${x.name} ${fmt(x.value)}`).join(', ')}`)}">`;
    svg += `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:var(--panel-3)" stroke-width="${sw}"/>`;
    if (total > 0) {
      let offset = 0;
      const gap = items.filter((x) => x.value > 0).length > 1 ? 2 : 0; // surface gap between segments
      for (const x of items) {
        if (!(x.value > 0)) continue;
        const len = (x.value / total) * c;
        const dash = Math.max(0.5, len - gap);
        svg += `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:${x.color}" stroke-width="${sw}" stroke-dasharray="${dash.toFixed(2)} ${(c - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
        offset += len;
      }
    }
    svg += `<text class="center-v" x="${size / 2}" y="${size / 2 + 2}" text-anchor="middle">${esc(opts.centerValue != null ? opts.centerValue : fmt(total))}</text>`;
    svg += `<text class="center-l" x="${size / 2}" y="${size / 2 + 18}" text-anchor="middle">${esc(opts.centerLabel || 'total')}</text></svg>`;
    const legend = items
      .map((x) => `<div class="row"><i class="key" style="background:${x.color}"></i><span>${esc(x.name)}</span><b>${esc(fmt(x.value))}</b><span class="p">${total > 0 ? PT.pct(x.value / total) : '–'}</span></div>`)
      .join('');
    return `<div class="donut-wrap">${svg}<div class="donut-legend">${legend}</div></div>`;
  };

  // ---------- horizontal bars (HTML) ----------
  PT.hbars = (items, opts = {}) => {
    const max = Math.max(1, ...items.map((x) => x.value || 0));
    return `<div class="hbars" role="img" aria-label="${esc(opts.aria || items.map((x) => `${x.label} ${x.value}`).join(', '))}">${items
      .map(
        (x) =>
          `<span class="lbl">${esc(x.label)}</span><div class="track"><div class="fill" style="width:${((x.value || 0) / max) * 100}%;background:${x.color || 'var(--n-lo)'}"></div></div><span class="val">${esc(opts.fmt ? opts.fmt(x.value) : PT.count(x.value))}</span>`
      )
      .join('')}</div>`;
  };

  // ---------- share bar (HTML) ----------
  PT.shareBar = (items, fmt = PT.compact) => {
    if (!items.length) return '';
    const total = items.reduce((a, x) => a + Math.max(0, x.v || 0), 0);
    const segs = total > 0 ? items.filter((x) => x.v > 0).map((x) => `<span style="flex:${x.v / total};background:${x.color}"></span>`).join('') : '';
    const legend = items.map((x) => `<span><i class="key" style="background:${x.color}"></i>${esc(x.name)} <b>${esc(fmt(x.v))}</b></span>`).join('');
    return `<div class="share" role="img" aria-label="${esc(items.map((x) => `${x.name} ${fmt(x.v)}`).join(', '))}">${segs}</div><div class="legend">${legend}</div>`;
  };

  // ---------- activity heatmap (HTML) ----------
  PT.heatmap = (days, fmt = PT.compact) => {
    const max = Math.max(0, ...days.map((d) => d.vol));
    const level = (v) => (v <= 0 || max <= 0 ? 0 : v / max > 0.75 ? 4 : v / max > 0.5 ? 3 : v / max > 0.2 ? 2 : 1);
    const pad = days.length ? days[0].dow : 0; // start columns on Sunday
    const cells = [];
    for (let i = 0; i < pad; i++) cells.push('<i style="visibility:hidden"></i>');
    for (const d of days) {
      cells.push(`<i style="background:var(--heat-${level(d.vol)})" title="${esc(`${PT.dayLabel(d.day)} (UTC): ${d.vol > 0 ? fmt(d.vol) : 'no trades'}`)}"></i>`);
    }
    const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x, i) => `<span>${i % 2 ? x : ''}</span>`).join('');
    const scale = [0, 1, 2, 3, 4].map((l) => `<i style="background:var(--heat-${l})"></i>`).join('');
    return `<div class="heat-wrap"><div class="heat-days">${dayNames}</div><div class="heat" role="img" aria-label="Daily volume, last 16 weeks">${cells.join('')}</div></div><div class="heat-scale">Less ${scale} More</div>`;
  };
})();
