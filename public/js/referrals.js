/* Referrals & codes: the developer's sign-up codes for each exchange (part of the signed release,
   so the page says whether this copy's links are the official ones), and your own codes to keep
   handy and share. Data: /api/referrals */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, $$, esc, NAMES } = PT;

  let data = null;
  let loading = false;
  let editing = null; // id of the code being edited, or 'new'
  let flash = null;

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

  function officialNote() {
    const o = (data && data.official) || (PT.state && PT.state.official) || {};
    if (o.state === 'verified') return `<span class="chip rf-ok">${PT.icon('shield', 'sm')}Verified official build${o.version ? ` v${esc(o.version)}` : ''}</span>`;
    return `<span class="chip rf-bad">${PT.icon('alert', 'sm')}Unofficial copy: these links may not be the developer's</span>`;
  }

  // Made by: the developer's X, from the signed release.
  function followStrip() {
    const dev = PT.state && PT.state.developer;
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
        <div class="ph"><div><h2 class="ph-title">${PT.icon('gift')}Support the tracker</h2><p class="ph-sub">Signing up with these codes supports the developer and keeps the tracker free. They're part of the signed release.</p></div>${officialNote()}</div>
        ${followStrip()}
        <div class="pb rf-grid">${data.ours.map(oursCard).join('')}</div>
      </section>
      ${more}
      <section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('list')}Your codes</h2><p class="ph-sub">Your own referral codes and links, kept on this computer. Copy a ready-to-send message with one click.</p></div>
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
      if (ev.target.matches('[data-f="program"]')) {
        const other = ev.target.parentElement.querySelector('[data-f="other"]');
        other.hidden = ev.target.value !== 'Other';
        if (!other.hidden) other.focus();
      }
    };
  }

  PT.referrals = { load, render };
})();
