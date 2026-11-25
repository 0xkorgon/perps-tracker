/* Access: the invite screen, private links and the admin page.
     No key in this browser  the invite screen: an invite code opens a new dashboard, or a private
                             link opens an existing one.
     #k=<key>                a private link: this browser opens that dashboard (the part after # is
                             never sent to any server, so the link only travels where you paste it).
     #admin                  the admin page: invite codes and who's using the tracker. Needs the
                             admin key from the server's setup. */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc } = PT;
  const KEY_RE = /^pt_[A-Za-z0-9_-]{32,64}$/;

  const siteUrl = () => `${location.origin}${location.pathname}`;
  const privateLink = () => (PT.key() ? `${siteUrl()}#k=${PT.key()}` : '');
  // A key from a private link pasted in the invite screen (or the bare key).
  const keyFrom = (text) => {
    const t = String(text || '').trim();
    const m = /#k=([A-Za-z0-9_-]+)/.exec(t);
    const k = m ? m[1] : t;
    return KEY_RE.test(k) ? k : null;
  };

  // ---------- private links ----------
  // Called before anything else loads.
  function boot() {
    const m = /^#k=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (m) {
      const k = m[1];
      history.replaceState(null, '', `${location.pathname}#overview`);
      if (KEY_RE.test(k) && k !== PT.key()) {
        // Opening someone else's link on a browser that already has a dashboard: ask first.
        if (!PT.key() || window.confirm('Open the dashboard in this link? This browser will switch to it. Your current dashboard stays on the server: open its own private link to come back.')) PT.setKey(k);
      }
    }
    document.body.classList.toggle('no-key', !PT.key());
  }

  function forget() {
    PT.setKey(null);
    PT.prefs.set('tour.offered', '');
    location.replace(`${location.pathname}#overview`);
    location.reload();
  }

  // ---------- invite screen ----------
  let joinMsg = '';
  function showJoin(msg) {
    if (msg) joinMsg = msg;
    const host = $('#join');
    if (!host) return;
    document.body.classList.add('no-key');
    if (host.dataset.ready === '1' && !msg) {
      host.hidden = false;
      return;
    }
    host.dataset.ready = '1';
    const dev = { handle: '@Korgonxx', x: 'https://x.com/Korgonxx' };
    host.innerHTML = `
      <div class="join-card">
        <div class="join-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="13" width="5.5" height="9" rx="1.4"/><rect x="9.25" y="7.5" width="5.5" height="14.5" rx="1.4"/><rect x="16.5" y="2" width="5.5" height="20" rx="1.4"/></svg></div>
        <h1>Perps Tracker</h1>
        <p class="join-lede">Your perps dashboard for Bulk, Arcus and Entropy: volume, open interest, hedges, fees, liquidation alerts and what your next points drops should pay. Read-only: it only needs your public wallet addresses, never a key.</p>
        <div class="chip join-chip">${PT.icon('key', 'sm')}Invite only</div>
        <form class="join-form" id="join-form" autocomplete="off">
          <label for="join-code">Invite code</label>
          <div class="join-row">
            <input type="text" id="join-code" class="mono" maxlength="40" placeholder="PT-XXXX-XXXX" spellcheck="false" autocapitalize="characters" required>
            <button type="submit" class="btn btn-primary">${PT.icon('check', 'sm')}Open my dashboard</button>
          </div>
          <div class="join-err" id="join-err" role="alert">${esc(joinMsg)}</div>
        </form>
        <details class="join-more">
          <summary>${PT.icon('shield', 'sm')}Already have a dashboard? Use your private link${PT.icon('chevron', 'sm chev')}</summary>
          <form class="join-form" id="join-link" autocomplete="off">
            <div class="join-row">
              <input type="password" id="join-key" class="mono" placeholder="Paste your private link" spellcheck="false">
              <button type="submit" class="btn">Open</button>
            </div>
            <p class="join-hint">Your private link is in Settings → System on any device where your dashboard is open.</p>
            <div class="join-err" id="join-key-err" role="alert"></div>
          </form>
        </details>
        <p class="join-foot">No invite yet? Ask on X: <a href="${esc(dev.x)}" target="_blank" rel="noopener noreferrer">${esc(dev.handle)}</a>, or run the free <a href="https://github.com/0xkorgon/perps-tracker" target="_blank" rel="noopener noreferrer">open-source version</a> on your own computer.</p>
      </div>`;
    host.hidden = false;
    // Running on your own computer (--local): no invite needed.
    PT.getJSON('/api/health')
      .then((h) => {
        if (!h || !h.open) return;
        $('.join-chip', host).innerHTML = `${PT.icon('shield', 'sm')}Running on your computer`;
        $('label[for="join-code"]', host).textContent = 'No invite needed here';
        const input = $('#join-code', host);
        input.required = false;
        input.hidden = true;
        $('#join-form button', host).innerHTML = `${PT.icon('check', 'sm')}Open my dashboard`;
        $('.join-foot', host).innerHTML = `Made by <a href="${esc(dev.x)}" target="_blank" rel="noopener noreferrer">${esc(dev.handle)}</a>. Follow on X for updates.`;
      })
      .catch(() => {});
    $('#join-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = $('#join-code');
      const code = input.value.trim();
      const err = $('#join-err');
      const btn = ev.submitter || $('#join-form button');
      if (!code && !input.hidden) return;
      btn.disabled = true;
      err.textContent = '';
      try {
        const r = await PT.post('/api/join', { invite: code });
        if (!r.key) throw new Error('The server didn’t send a dashboard key.');
        PT.setKey(r.key);
        PT.prefs.set('link.saved', '');
        location.replace(`${location.pathname}#overview`);
        location.reload();
      } catch (e) {
        err.textContent = e.status === 0 || /fetch/i.test(e.message) ? 'Can’t reach the tracker’s server right now. Try again in a minute.' : e.message;
        btn.disabled = false;
      }
    });
    $('#join-link').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const k = keyFrom($('#join-key').value);
      if (!k) {
        $('#join-key-err').textContent = 'That doesn’t look like a private link. Copy it again from Settings → System.';
        return;
      }
      PT.setKey(k);
      location.replace(`${location.pathname}#overview`);
      location.reload();
    });
    setTimeout(() => $('#join-code') && $('#join-code').focus(), 50);
  }

  // The server doesn't know this browser's key (it was mistyped, or the dashboard was removed).
  PT.onAuthLost = () => {
    if (!PT.key()) return;
    PT.setKey(null);
    showJoin('This browser’s dashboard link isn’t valid on the server. Use your private link, or an invite code for a new dashboard.');
    document.body.classList.add('no-key');
    if (PT.rerender) PT.rerender();
  };

  // A one-time nudge to save the private link, a little after a new dashboard is set up.
  function maybeNudgeLink() {
    if (!PT.key() || PT.prefs.get('link.saved') || !PT.state || !PT.state.config.onboardedAt || document.querySelector('.tour-offer, .import-offer, .link-offer, .whatsnew, dialog[open]') || (PT.tour && PT.tour.active())) return;
    if (Date.now() - PT.state.config.onboardedAt < 60 * 1000) return;
    PT.prefs.set('link.saved', '1');
    const el = document.createElement('div');
    el.className = 'tour-offer link-offer';
    el.innerHTML = `${PT.icon('shield')}<span><b>Save your private link.</b> It opens this dashboard on your phone or another computer, and it's the only way back if this browser's data is cleared.</span><button type="button" class="btn btn-primary btn-sm" data-link="copy">${PT.icon('copy', 'sm')}Copy link</button><button type="button" class="icon-btn" data-link="no" aria-label="Later">${PT.icon('x')}</button>`;
    document.body.appendChild(el);
    el.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-link]');
      if (!b) return;
      if (b.dataset.link === 'copy') {
        try {
          await navigator.clipboard.writeText(privateLink());
          el.innerHTML = `${PT.icon('check')}<span><b>Copied.</b> Keep it somewhere private, like a password manager. Settings → System has it too.</span><button type="button" class="icon-btn" data-link="no" aria-label="Close">${PT.icon('x')}</button>`;
          setTimeout(() => el.remove(), 6000);
          return;
        } catch {
          el.remove();
          return document.getElementById('btn-wallets').click();
        }
      }
      el.remove();
    });
  }

  // ---------- admin ----------
  let admin = null;
  let adminMsg = '';
  const adminKey = () => PT.prefs.get('adminKey') || '';
  const adminCall = async (path, body) => {
    const headers = { Authorization: `Bearer ${adminKey()}` };
    const r = body ? await fetch(PT.API + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) : await fetch(PT.API + path, { headers, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.error || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return j;
  };
  const inviteMessage = (code) => `You're invited to Perps Tracker, a dashboard for Bulk, Arcus and Entropy.\n${siteUrl()}\nInvite code: ${code}`;

  async function loadAdmin() {
    if (!adminKey()) return renderAdmin();
    try {
      admin = await adminCall('/api/admin/overview');
    } catch (e) {
      if (e.status === 401) {
        PT.prefs.set('adminKey', '');
        adminMsg = 'That admin key isn’t right.';
      } else adminMsg = e.message;
      admin = null;
    }
    renderAdmin();
  }

  // This week's gauntlet (Bulk announces it on Saturday in its Challenger tab) and, if no AURA import
  // has brought them, the league cutoffs at the last reveal. Every dashboard uses both.
  function seasonPanel(se) {
    if (!se) return '';
    const g = se.gauntlet;
    const c = (se.cutoffs && se.cutoffs.cutoffs) || {};
    const goals = Object.entries(se.goals || {}).map(([k, label]) => `<option value="${esc(k)}"${(g ? g.goal : 'taker') === k ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const cutoffNote = se.cutoffs ? `Now: from ${se.cutoffs.source === 'admin' ? 'you' : 'an AURA import'}, ${PT.localWhen(se.cutoffs.at)}.` : 'None shared yet: dashboards use the October snapshot until someone imports their AURA.';
    return `<section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('trophy')}This week’s gauntlet</h2><p class="ph-sub">${esc(`AURA week ${PT.localWhen(se.weekStart)} to ${PT.localWhen(se.weekEnd)}. Copy it from the Challenger tab on app.bulk.trade; every dashboard estimates its share from it.`)}</p></div></div>
        <div class="pb"><form class="admin-form" id="adm-gauntlet" autocomplete="off">
          <label>Name<input type="text" id="adm-g-title" maxlength="60" placeholder="As Bulk shows it, e.g. Baskets" value="${esc(g ? g.title : '')}"></label>
          <label>What counts<select id="adm-g-goal" class="select">${goals}</select></label>
          <label>Markets<input type="text" id="adm-g-markets" maxlength="200" placeholder="SOXL, QQQ (for some markets)" value="${esc(g ? g.markets.map((m) => m.replace(/-USD$/, '')).join(', ') : '')}" list="adm-g-list"></label>
          <label>Reward<input type="number" id="adm-g-reward" min="1" max="1000000" value="${esc(String(g ? g.reward : se.reward))}"></label>
          <label class="wide-field">Note<input type="text" id="adm-g-note" maxlength="240" placeholder="Optional: Bulk’s description" value="${esc(g ? g.note : '')}"></label>
          <button type="submit" class="btn btn-primary">${PT.icon('check', 'sm')}${g ? 'Update' : 'Save'}</button>${g ? `<button type="button" class="btn btn-ghost" id="adm-g-clear">Clear</button>` : ''}
          <datalist id="adm-g-list">${(se.markets || []).map((m) => `<option value="${esc(m.replace(/-USD$/, ''))}">`).join('')}</datalist>
        </form><div class="join-err" id="adm-g-err" role="alert"></div>${g ? `<div class="pts-ok">${PT.icon('check', 'sm')}${esc(`Set: ${g.title} · ${se.goals[g.goal]}${g.markets.length ? ` (${g.markets.join(', ')})` : ''} · ${g.reward.toLocaleString('en-US')} AURA`)}</div>` : ''}</div>
        <div class="ph ruled"><div><h2 class="ph-title">${PT.icon('list')}League cutoffs</h2><p class="ph-sub">${esc(`Only needed when no one’s AURA import brings them. Trading AURA of the last wallet in each league on Bulk’s leaderboard (ranks 25, 100, top 10%, top 25%). ${cutoffNote}`)}</p></div></div>
        <div class="pb"><form class="admin-form" id="adm-cutoffs" autocomplete="off">
          ${['challenger', 'diamond', 'platinum', 'gold'].map((k) => `<label>${k.charAt(0).toUpperCase() + k.slice(1)}<input type="number" min="1" data-cut="${k}" value="${c[k] != null ? c[k] : ''}"></label>`).join('')}
          <label>Ranked traders<input type="number" min="1" id="adm-c-pop" value="${se.cutoffs && se.cutoffs.population ? se.cutoffs.population : ''}"></label>
          <button type="submit" class="btn">${PT.icon('check', 'sm')}Save cutoffs</button>
        </form><div class="join-err" id="adm-c-err" role="alert"></div></div>
      </section>`;
  }

  function renderAdmin() {
    const host = $('#admin-main');
    if (!host) return;
    if (!adminKey() || !admin) {
      host.innerHTML = `<section class="panel"><div class="pb">
        <form class="join-form" id="admin-login" autocomplete="off">
          <label for="admin-key">Admin key</label>
          <div class="join-row"><input type="password" id="admin-key" class="mono" placeholder="adm_…" spellcheck="false"><button type="submit" class="btn btn-primary">Open admin</button></div>
          <p class="join-hint">The admin key was printed when the server was set up (also in <code>/opt/perps-tracker/data/admin.key</code> on the server). It stays in this browser only.</p>
          <div class="join-err" role="alert">${esc(adminMsg)}</div>
        </form></div></section>`;
      $('#admin-login').addEventListener('submit', (ev) => {
        ev.preventDefault();
        PT.prefs.set('adminKey', $('#admin-key').value.trim());
        adminMsg = '';
        loadAdmin();
      });
      return;
    }
    const a = admin;
    const ago = (t) => (t ? PT.ago(t) : '–');
    const active = a.users.filter((u) => u.active).length;
    const inv = a.invites
      .map((i) => {
        const left = i.uses > 0 ? `${i.used} of ${i.uses}` : `${i.used} (no limit)`;
        const state = i.revoked ? '<span class="chip down">Revoked</span>' : i.uses > 0 && i.used >= i.uses ? '<span class="chip">Used up</span>' : '<span class="chip up">Active</span>';
        return `<tr><td class="mono"><b>${esc(i.code)}</b></td><td>${esc(i.note || '')}</td><td class="num">${esc(left)}</td><td>${state}</td><td class="mono">${esc(PT.dateShort(i.createdAt))}</td><td class="num rf-row-actions"><button type="button" class="btn btn-sm" data-copy="${esc(inviteMessage(i.code))}">${PT.icon('copy', 'sm')}Copy invite</button><button type="button" class="btn btn-ghost btn-sm" data-revoke="${esc(i.code)}" data-on="${i.revoked ? '0' : '1'}">${i.revoked ? 'Restore' : 'Revoke'}</button></td></tr>`;
      })
      .join('');
    const users = a.users
      .map((u) => `<tr><td class="mono">${esc(u.id)}</td><td>${esc(u.name || '–')}</td><td class="mono">${esc(u.invite || '–')}</td><td class="mono">${esc(PT.dateShort(u.createdAt))}</td><td>${u.active ? '<span class="chip up">Open now</span>' : esc(ago(u.lastSeen))}</td><td class="num">${esc(['bulk', 'arcus', 'entropy'].map((x) => u.wallets[x] || 0).join(' · '))}</td></tr>`)
      .join('');
    host.innerHTML = `
      <div class="board"><div class="board-row even">
        ${PT.cell({ icon: 'layers', label: 'Dashboards', value: PT.count(a.users.length), sub: `${active} open now` })}
        ${PT.cell({ icon: 'key', label: 'Invite codes', value: PT.count(a.invites.filter((i) => !i.revoked).length), sub: `${a.invites.reduce((s, i) => s + i.used, 0)} used in all` })}
        ${PT.cell({ icon: 'activity', label: 'Server', value: `v${a.version}`, sub: `Up ${PT.dur(a.uptime * 1000)} · ${a.model === 'owner' ? 'your model' : 'fallback model'}` })}
      </div></div>
      ${seasonPanel(a.season)}
      <section class="panel">
        <div class="ph"><div><h2 class="ph-title">${PT.icon('plus')}New invite code</h2><p class="ph-sub">Each person opens their own private dashboard with it.</p></div></div>
        <div class="pb"><form class="admin-form" id="admin-new" autocomplete="off">
          <label>Note<input type="text" id="adm-note" maxlength="80" placeholder="Who it's for (only you see this)"></label>
          <label>Uses<input type="number" id="adm-uses" min="0" max="100000" value="1" title="0 = no limit"></label>
          <label>Code<input type="text" id="adm-code" maxlength="24" placeholder="Leave empty for a random one" class="mono"></label>
          <button type="submit" class="btn btn-primary">${PT.icon('plus', 'sm')}Create</button>
        </form><div class="join-err" id="adm-err" role="alert"></div>${a.created ? `<div class="pts-ok">${PT.icon('check', 'sm')}Created <b class="mono">${esc(a.created)}</b>. <button type="button" class="btn btn-sm" data-copy="${esc(inviteMessage(a.created))}">${PT.icon('copy', 'sm')}Copy invite message</button></div>` : ''}</div>
      </section>
      <section class="panel">
        <div class="ph ruled"><div><h2 class="ph-title">${PT.icon('key')}Invite codes</h2></div></div>
        <div class="table-wrap">${inv ? `<table><thead><tr><th>Code</th><th>Note</th><th class="num">Used</th><th>Status</th><th>Made</th><th></th></tr></thead><tbody>${inv}</tbody></table>` : `<div class="empty">${PT.icon('key')}No invite codes yet. Make one above.</div>`}</div>
      </section>
      <section class="panel">
        <div class="ph ruled"><div><h2 class="ph-title">${PT.icon('layers')}Dashboards</h2><p class="ph-sub">No wallet addresses here: just who's using the tracker and how much.</p></div></div>
        <div class="table-wrap">${users ? `<table><thead><tr><th>ID</th><th>Name</th><th>Invite</th><th>Opened</th><th>Last seen</th><th class="num">Wallets (Bulk · Arcus · Entropy)</th></tr></thead><tbody>${users}</tbody></table>` : `<div class="empty">${PT.icon('layers')}Nobody yet.</div>`}</div>
      </section>
      <p class="wsec-hint"><button type="button" class="btn btn-ghost btn-sm" id="adm-out">Sign out of admin on this browser</button></p>`;
    PT.hydrateIcons && PT.hydrateIcons(host);
    host.onclick = async (ev) => {
      const cp = ev.target.closest('[data-copy]');
      if (cp) {
        try {
          await navigator.clipboard.writeText(cp.dataset.copy);
          const was = cp.innerHTML;
          cp.innerHTML = `${PT.icon('check', 'sm')}Copied`;
          setTimeout(() => (cp.innerHTML = was), 1400);
        } catch {}
        return;
      }
      const rv = ev.target.closest('[data-revoke]');
      if (rv) {
        try {
          admin = await adminCall('/api/admin/invites/revoke', { code: rv.dataset.revoke, revoked: rv.dataset.on === '1' });
          renderAdmin();
        } catch (e) {
          $('#adm-err').textContent = e.message;
        }
        return;
      }
      if (ev.target.closest('#adm-out')) {
        PT.prefs.set('adminKey', '');
        admin = null;
        renderAdmin();
      }
    };
    const gForm = $('#adm-gauntlet');
    if (gForm) {
      gForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        try {
          admin = await adminCall('/api/admin/season', { gauntlet: { title: $('#adm-g-title').value, goal: $('#adm-g-goal').value, markets: $('#adm-g-markets').value, reward: Number($('#adm-g-reward').value), note: $('#adm-g-note').value } });
          renderAdmin();
        } catch (e) {
          $('#adm-g-err').textContent = e.message;
        }
      });
      const clr = $('#adm-g-clear');
      if (clr)
        clr.addEventListener('click', async () => {
          admin = await adminCall('/api/admin/season', { gauntlet: { clear: true } });
          renderAdmin();
        });
    }
    const cForm = $('#adm-cutoffs');
    if (cForm)
      cForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const cut = Object.fromEntries(PT.$$('[data-cut]', cForm).map((i) => [i.dataset.cut, Number(i.value)]));
        try {
          admin = await adminCall('/api/admin/season', { cutoffs: { ...cut, population: Number($('#adm-c-pop').value) || null } });
          renderAdmin();
        } catch (e) {
          $('#adm-c-err').textContent = e.message;
        }
      });
    $('#admin-new').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const r = await adminCall('/api/admin/invites', { note: $('#adm-note').value, uses: Number($('#adm-uses').value), code: $('#adm-code').value });
        admin = { ...r, created: r.invite.code };
        renderAdmin();
      } catch (e) {
        $('#adm-err').textContent = e.message;
      }
    });
  }

  PT.access = { boot, showJoin, privateLink, forget, maybeNudgeLink, loadAdmin };
})();
