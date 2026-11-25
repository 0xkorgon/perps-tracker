/* Referrals & codes: the developer's sign-up codes for each exchange (from the tracker's server, so
   they're the same for everyone), and your own codes to keep handy and share. Data: /api/referrals */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, $$, esc, NAMES } = PT;

  let data = null;
  let loading = false;
  let editing = null; // id of the code being edited, or 'new'
  let flash = null;
  let refFlash = null;
  let refBusy = false;

  const OPTIONS = ['Bulk', 'Arcus', 'Entropy', 'Hyperliquid', 'Other'];
  const logoFor = (name) => {
    const id = String(name || '').toLowerCase();
    return PT.LOGO[id] ? PT.exm(id) : `<span class="rf-mono">${esc(String(name || '?').slice(0, 1).toUpperCase())}</span>`;
  };
  const copyBtn = (value, label = 'Copy') => `<button type="button" class="btn btn-sm" data-copy="${esc(value)}">${PT.icon('copy', 'sm')}${esc(label)}</button>`;

  async function load(force) {
    if (loading) return;
    if (data && !force) return render();
    loading = true;
    try {
      data = await PT.getJSON('/api/referrals');
    } catch {
      // keep what's shown
    } finally {
      loading = false;
    }
    render();
  }

  // Made by: the developer's X.
  function followStrip() {
    const dev = (data && data.developer) || (PT.state && PT.state.developer);
    if (!dev || !dev.x) return '';
    return `<div class="rf-follow"><span class="x-mark" aria-hidden="true">𝕏</span><span>Made by <b>${esc(dev.name || dev.handle)}</b>. Follow <b>${esc(dev.handle)}</b> on X for updates, new features and what's coming next.</span><a class="btn btn-primary btn-sm" href="${esc(dev.x)}" target="_blank" rel="noopener noreferrer">Follow on X</a></div>`;
  }

  function oursCard(p) {
    const sign = p.link ? `<a class="btn btn-primary btn-sm" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">${PT.icon('external', 'sm')}Sign up on ${esc(p.name)}</a>` : '';
    const code = `${p.code ? `<div class="rf-code"><span>Referral code</span><b>${esc(p.code)}</b>${copyBtn(p.code)}</div>` : ''}${p.accessCode ? `<div class="rf-code"><span>Access code</span><b>${esc(p.accessCode)}</b>${copyBtn(p.accessCode)}</div>` : ''}`;
    return `<article class="rf-card${p.ready ? '' : ' soon'}">
      <div class="rf-head">${logoFor(p.id)}<div><b>${esc(p.name)}</b><span>${esc(p.about || '')}</span></div></div>
      ${p.perk ? `<p class="rf-perk">${PT.icon('gift', 'sm')}${esc(p.perk)}</p>` : ''}
      ${p.ready ? `${code}<div class="rf-actions">${sign}${p.link ? copyBtn(p.link, 'Copy link') : ''}</div>` : `<p class="rf-soon">${PT.icon('clock', 'sm')}Code coming soon</p>`}
    </article>`;
  }

  function shareText(c) {
    return `${c.program}: ${c.code ? `use my code ${c.code}` : 'join with my link'}${c.link ? ` ${c.link}` : ''}`;
  }

  function mineRow(c) {
    if (editing === c.id) return formRow(c);
    return `<tr>
      <td><span class="rf-prog">${logoFor(c.program)}${esc(c.program)}</span></td>
      <td class="mono">${c.code ? `<b>${esc(c.code)}</b>` : '<span class="muted">–</span>'}</td>
      <td class="rf-link">${c.link ? `<a href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">${esc(c.link.replace(/^https?:\/\//, ''))}</a>` : '<span class="muted">–</span>'}</td>
      <td class="muted">${esc(c.note || '')}</td>
      <td class="num rf-row-actions">
        <button type="button" class="icon-btn" data-copy="${esc(shareText(c))}" title="Copy a message to share" aria-label="Copy a message to share">${PT.icon('copy', 'sm')}</button>
        <button type="button" class="icon-btn" data-edit="${esc(c.id)}" title="Edit" aria-label="Edit">${PT.icon('settings', 'sm')}</button>
        <button type="button" class="icon-btn" data-del="${esc(c.id)}" title="Delete" aria-label="Delete">${PT.icon('trash', 'sm')}</button>
      </td>
    </tr>`;
  }

  function formRow(c = {}) {
    const known = OPTIONS.includes(c.program) ? c.program : c.program ? 'Other' : 'Bulk';
    return `<tr class="rf-form" data-form="${esc(c.id || 'new')}">
      <td><select class="select sm" data-f="program">${OPTIONS.map((o) => `<option${o === known ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
        <input type="text" class="sm" data-f="other" maxlength="40" placeholder="Name" value="${esc(known === 'Other' ? c.program || '' : '')}"${known === 'Other' ? '' : ' hidden'}></td>
      <td><input type="text" class="sm" data-f="code" maxlength="60" placeholder="Code" value="${esc(c.code || '')}" spellcheck="false"></td>
      <td><input type="url" class="sm" data-f="link" maxlength="300" placeholder="https://… (optional)" value="${esc(c.link || '')}" spellcheck="false"></td>
      <td><input type="text" class="sm" data-f="note" maxlength="120" placeholder="Note (optional)" value="${esc(c.note || '')}"></td>
      <td class="num rf-row-actions"><button type="button" class="btn btn-primary btn-sm" data-save>${PT.icon('check', 'sm')}Save</button><button type="button" class="btn btn-ghost btn-sm" data-cancel>Cancel</button></td>
    </tr>`;
  }

  // ---------- referral AURA (Bulk) ----------
  const aura = (n) => (Number.isFinite(n) ? PT.plain(n, Math.abs(n) >= 100 ? 0 : 1) : '–');
  const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

  function refPanel() {
    const r = data.bulkRef;
    if (!r) return '';
    const stat = (label, value, sub) => `<div class="lg-stat"><span>${esc(label)}</span><b>${value}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
    const has = r.wallets.length > 0;
    const lw = r.lastWeek;
    const since = `since ${PT.localWhen(r.start)}`;
    const stats = `<div class="lg-stats">
      ${stat('Referral volume this week', has ? esc(PT.compact(r.live.volume)) : '–', has ? `Live from ${r.wallets.length} wallet${r.wallets.length === 1 ? '' : 's'}, ${since}` : 'Click your bookmark on Bulk’s Referrals page')}
      ${stat('Referral AURA so far', r.aura ? `<span class="lv-gold">≈ ${esc(aura(r.aura.soFar))}</span>` : '–', r.aura ? `¼ of ≈ ${aura(r.live.trading)} Trading AURA they earned` : 'Estimated from their live volume')}
      ${stat('Last revealed week', lw ? `${esc(aura(lw.bulkAura))} AURA` : '–', lw ? `Week ${lw.week}: ${PT.compact(lw.bulkVolume || 0)} referral volume (Bulk)` : 'Shows after your AURA import')}
      <label class="lg-stat rf-incl"><span>In your estimates</span><span class="rf-incl-row"><input type="checkbox" class="toggle" data-ref-incl${r.included ? ' checked' : ''}><b>${r.included ? 'On' : 'Off'}</b></span><em>${esc(r.included ? 'Added to your Bulk estimate on Points and the drop card' : 'Turn on to add referral AURA and volume to your Bulk estimate')}</em></label>
    </div>`;

    const rows = r.wallets
      .map((w) => {
        const state = w.state === 'error' ? `<span class="rf-stale" title="${esc(w.error || '')}">${PT.icon('alert', 'sm')}Couldn’t read</span>` : w.syncedAt ? esc(PT.ago(w.syncedAt)) : '<span class="muted">Syncing…</span>';
        return `<tr>
          <td>${w.label ? `<b>${esc(w.label)}</b>` : '<span class="muted">–</span>'}${w.source === 'bulk' ? ' <span class="chip">From Bulk</span>' : w.source === 'own' ? ' <span class="chip">Your wallet</span>' : ''}</td>
          <td class="mono"><span class="copyable">${esc(shortAddr(w.address))}<button type="button" class="rm" data-copy="${esc(w.address)}" title="Copy" aria-label="Copy wallet">${PT.icon('copy', 'sm')}</button></span></td>
          <td class="num">${esc(PT.compact(w.volume))}</td>
          <td class="num">≈ ${esc(aura(w.trading))}</td>
          <td class="num lv-gold">≈ ${esc(aura(w.trading * r.ratio * (r.aura ? r.aura.factor : 1)))}</td>
          <td class="muted">${state}</td>
          <td class="num rf-row-actions">${w.source === 'own' ? '' : `<button type="button" class="icon-btn" data-ref-del="${esc(w.address)}" title="Stop watching" aria-label="Stop watching this wallet">${PT.icon('trash', 'sm')}</button>`}</td>
        </tr>`;
      })
      .join('');
    const form = r.wallets.filter((w) => w.source !== 'own').length < r.max
      ? `<div class="rf-ref-add"><input type="text" data-ref="address" maxlength="64" placeholder="Referral’s Bulk wallet address" spellcheck="false" autocomplete="off"><input type="text" data-ref="label" maxlength="40" placeholder="Name (optional)"><button type="button" class="btn btn-primary btn-sm" data-ref-add${refBusy ? ' disabled' : ''}>${PT.icon('plus', 'sm')}Watch wallet</button></div>`
      : `<p class="pl-note">${PT.icon('info', 'sm')}<span>Up to ${r.max} referral wallets.</span></p>`;
    const table = has
      ? `<div class="table-wrap"><table class="rf-table"><thead><tr><th>Name</th><th>Wallet</th><th class="num">Volume this week</th><th class="num">Their Trading AURA</th><th class="num">Your referral AURA</th><th>Synced</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '';

    // Revealed weeks: Bulk's numbers next to what your listed wallets traded.
    const wk = r.weeks.length
      ? `<div class="table-wrap"><table class="rf-table"><thead><tr><th>Week</th><th class="num">Referral volume (Bulk)</th><th class="num">Your listed wallets</th><th class="num">Referral AURA (Bulk)</th><th class="num">1:4 rule</th></tr></thead><tbody>${r.weeks
          .slice()
          .reverse()
          .map((w) => `<tr><td>Week ${esc(w.week)}</td><td class="num">${w.bulkVolume != null ? esc(PT.compact(w.bulkVolume)) : '<span class="muted">–</span>'}</td><td class="num">${w.measured != null ? esc(PT.compact(w.measured)) : '<span class="muted">–</span>'}</td><td class="num">${esc(aura(w.bulkAura))}</td><td class="num">${w.predicted != null && w.measured > 0 ? `≈ ${esc(aura(w.predicted))}` : '<span class="muted">–</span>'}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '';
    const notes = [];
    if (r.aura && r.aura.checks) notes.push(Math.abs(r.aura.factor - 1) >= 0.02 ? `Checked against ${r.aura.checks} revealed week${r.aura.checks === 1 ? '' : 's'}: per dollar of referral volume, Bulk paid ×${r.aura.factor.toFixed(2)} what the 1:4 rule gives at your rates, so the estimate is scaled by that.` : `Checked against ${r.aura.checks} revealed week${r.aura.checks === 1 ? '' : 's'}: the 1:4 rule matches what Bulk paid.`);
    const cov = r.weeks.filter((w) => w.bulkVolume > 1000 && w.measured != null).pop();
    if (cov && cov.measured < cov.bulkVolume * 0.9) notes.push(`In week ${cov.week} your listed wallets traded ${PT.compact(cov.measured)} of the ${PT.compact(cov.bulkVolume)} Bulk counted as your referral volume, so some referrals may be missing here.`);
    if (r.rates && r.rates.source === 'typical') notes.push('Rates are the model’s typical ones until Bulk has revealed a week of your own trading.');
    return `<section class="panel" id="rf-aura">
      <div class="ph"><div><h2 class="ph-title">${PT.exm('bulk')}Referral AURA</h2><p class="ph-sub">Bulk pays 1 AURA for every 4 Trading AURA your referrals earn. Their volume is read live from their wallets, nothing projected; only the AURA is estimated.</p></div></div>
      <div class="pb">
        ${stats}
        ${table}
        ${form}
        <p class="pl-note">${PT.icon('sparkles', 'sm')}<span><b>No typing needed:</b> ${esc('click your “Send AURA to tracker” bookmark on Bulk’s Referrals page while logged in, and the wallets you referred are added here (re-drag the bookmark from Points once if you added it before 3.6). Your own tracked wallets that one of your codes referred are counted automatically.')}</span></p>
        <p class="pl-note">${PT.icon('info', 'sm')}<span>${esc('Bulk only shows your referred wallets to you, on its Referrals page, so the tracker watches their public trades instead. They never count in your own stats or in Leagues (Bulk doesn’t count referral AURA toward leagues).')}</span></p>
        ${wk ? `<h3 class="rf-h3">Revealed weeks</h3>${wk}` : ''}
        ${notes.map((n) => `<p class="pl-note">${PT.icon('check', 'sm')}<span>${esc(n)}</span></p>`).join('')}
        <div class="pts-error" id="rf-ref-err" role="alert"></div>${refFlash && Date.now() - refFlash.at < 4000 ? `<div class="pts-ok">${PT.icon('check', 'sm')}${esc(refFlash.text)}</div>` : ''}
      </div>
    </section>`;
  }

  async function saveRef(body, msg) {
    refBusy = true;
    try {
      data = await PT.post('/api/referrals/bulk', body);
      refFlash = msg ? { text: msg, at: Date.now() } : null;
      if (body.inEstimates != null && PT.state && PT.state.config) PT.state.config.refInEstimates = body.inEstimates;
      render();
    } catch (e) {
      const err = $('#rf-ref-err');
      if (err) err.textContent = e.message;
    } finally {
      refBusy = false;
    }
  }

  function render() {
    const host = $('#rf-main');
    if (!host) return;
    if (!data) {
      host.innerHTML = '<div class="panel empty"><span class="spinner"></span>Loading…</div>';
      return;
    }
    const b = data.bulk;
    const detected = b && b.code && !data.mine.some((c) => c.program.toLowerCase() === 'bulk' && c.code === b.code)
      ? `<div class="rf-detected">${PT.exm('bulk')}<span>Your Bulk referral code is <b>${esc(b.code)}</b>${b.sent ? `: ${PT.count(b.sent)} people used it${b.qualified ? `, ${PT.count(b.qualified)} qualified` : ''}` : ''}.</span>${copyBtn(b.code)}<button type="button" class="btn btn-sm" data-add-detected="${esc(b.code)}">${PT.icon('plus', 'sm')}Save it here</button></div>`
      : '';
    const rows = data.mine.map(mineRow).join('');
    const adding = editing === 'new' ? formRow({}) : '';
    const more = data.more && data.more.length ? `<section class="panel"><div class="ph"><div><h2 class="ph-title">${PT.icon('sparkles')}More from the developer</h2><p class="ph-sub">Other exchanges and tools worth a look</p></div></div><div class="pb rf-grid">${data.more.map(oursCard).join('')}</div></section>` : '';
    host.innerHTML = `
      <section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('gift')}Support the tracker</h2><p class="ph-sub">Signing up with these codes supports the developer and keeps the tracker free.</p></div></div>
        ${followStrip()}
        <div class="pb rf-grid">${data.ours.map(oursCard).join('')}</div>
      </section>
      ${more}
      ${refPanel()}
      <section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('list')}Your codes</h2><p class="ph-sub">Your own referral codes and links, kept with your dashboard. Copy a ready-to-send message with one click.</p></div>
          <button type="button" class="btn btn-sm" data-new${editing === 'new' ? ' disabled' : ''}>${PT.icon('plus', 'sm')}Add a code</button></div>
        ${detected}
        ${rows || adding ? `<div class="table-wrap"><table class="rf-table"><thead><tr><th>Program</th><th>Code</th><th>Link</th><th>Note</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${adding}${rows}</tbody></table></div>` : `<div class="empty">${PT.icon('gift')}No codes saved yet. Add your referral codes for each exchange to keep them in one place.</div>`}
        <div class="pts-error" id="rf-err" role="alert"></div>${flash && Date.now() - flash.at < 4000 ? `<div class="pts-ok">${PT.icon('check', 'sm')}${esc(flash.text)}</div>` : ''}
      </section>`;
    PT.hydrateLogos(host);
    wire(host);
  }

  async function save(list, msg) {
    try {
      data = await PT.post('/api/referrals/mine', { myCodes: list });
      editing = null;
      flash = msg ? { text: msg, at: Date.now() } : null;
      render();
    } catch (e) {
      const err = $('#rf-err');
      if (err) err.textContent = e.message;
    }
  }

  function wire(host) {
    host.onclick = async (ev) => {
      const t = ev.target;
      const cp = t.closest('[data-copy]');
      if (cp) {
        try {
          await navigator.clipboard.writeText(cp.dataset.copy);
          const was = cp.innerHTML;
          cp.innerHTML = `${PT.icon('check', 'sm')}${cp.classList.contains('icon-btn') ? '' : 'Copied'}`;
          setTimeout(() => (cp.innerHTML = was), 1400);
        } catch {
          // clipboard blocked: nothing to do
        }
        return;
      }
      const rdel = t.closest('[data-ref-del]');
      const listed = () => data.bulkRef.wallets.filter((w) => w.source !== 'own').map(({ address, label, source }) => ({ address, label, source }));
      if (rdel) return saveRef({ referees: listed().filter((w) => w.address !== rdel.dataset.refDel) }, 'Stopped watching that wallet.');
      if (t.closest('[data-ref-add]')) {
        const address = $('[data-ref="address"]', host).value.trim();
        const label = $('[data-ref="label"]', host).value.trim();
        const err = $('#rf-ref-err');
        if (!address) return (err.textContent = 'Paste a Bulk wallet address.');
        if (data.bulkRef.wallets.some((w) => w.address === address)) return (err.textContent = 'That wallet is already watched.');
        return saveRef({ referees: [...listed(), { address, label }] }, 'Watching it: its trades load in a minute.');
      }
      if (t.closest('[data-new]')) {
        editing = 'new';
        return render();
      }
      const ed = t.closest('[data-edit]');
      if (ed) {
        editing = ed.dataset.edit;
        return render();
      }
      if (t.closest('[data-cancel]')) {
        editing = null;
        return render();
      }
      const del = t.closest('[data-del]');
      if (del) return save(data.mine.filter((c) => c.id !== del.dataset.del), 'Deleted.');
      const det = t.closest('[data-add-detected]');
      if (det) return save([{ program: 'Bulk', code: det.dataset.addDetected, link: '', note: 'From your AURA page' }, ...data.mine], 'Saved.');
      if (t.closest('[data-save]')) {
        const row = t.closest('.rf-form');
        const f = (k) => $(`[data-f="${k}"]`, row);
        const program = f('program').value === 'Other' ? f('other').value.trim() : f('program').value;
        const item = { id: row.dataset.form === 'new' ? undefined : row.dataset.form, program, code: f('code').value.trim(), link: f('link').value.trim(), note: f('note').value.trim() };
        const err = $('#rf-err');
        if (!item.program) return (err.textContent = 'Name the program.');
        if (!item.code && !item.link) return (err.textContent = 'Add a code or a link.');
        if (item.link && !/^https?:\/\//i.test(item.link)) return (err.textContent = 'Links start with https://');
        const list = row.dataset.form === 'new' ? [item, ...data.mine] : data.mine.map((c) => (c.id === item.id ? item : c));
        return save(list, 'Saved.');
      }
    };
    host.onchange = (ev) => {
      if (ev.target.matches('[data-ref-incl]')) return saveRef({ inEstimates: ev.target.checked }, ev.target.checked ? 'Referral AURA now counts in your estimates.' : 'Referral AURA no longer counts in your estimates.');
      if (ev.target.matches('[data-f="program"]')) {
        const other = ev.target.parentElement.querySelector('[data-f="other"]');
        other.hidden = ev.target.value !== 'Other';
        if (!other.hidden) other.focus();
      }
    };
  }

  PT.referrals = { load, render };
})();
