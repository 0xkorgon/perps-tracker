/* Settings → System: start with Windows (only after the security check passes) and the security
   check itself: what it found last time, and a button to run it now (with a Windows Defender scan). */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc } = PT;
  const ICON = { ok: 'passed', warn: 'na', fail: 'failed' };

  function checksHtml(last) {
    if (!last) return '<p class="wsec-hint">Not run yet. It runs every time the tracker starts.</p>';
    const when = { start: 'when the tracker started', autostart: 'when it started with Windows', manual: 'on request' }[last.mode] || '';
    return `<div class="sys-sum ${last.ok ? 'ok' : 'fail'}">${PT.icon(last.ok ? 'passed' : 'failed')}<b>${last.ok ? 'Passed' : 'Failed'}</b><span>${esc(`${PT.ago(last.at)}, ${when}`)}</span></div>
      <ul class="sys-checks">${last.checks
        .map((c) => `<li class="${c.state}" data-check="${esc(c.id)}">${PT.icon(ICON[c.state] || 'na', 'sm')}<span><b>${esc(c.label)}</b><span>${esc(c.detail)}</span></span></li>`)
        .join('')}</ul>`;
  }

  // Official, signed build or a modified copy (src/official.js), and the setup and tour.
  function officialHtml() {
    const o = (PT.state && PT.state.official) || {};
    const ok = o.state === 'verified';
    const what = ok
      ? `Version ${o.version || ''}, signed by the developer.${o.edition === 'owner' ? ' Owner edition: the private AURA model is loaded.' : ''}`
      : o.state === 'modified'
        ? `Modified, unofficial build: ${(o.changed || []).join(', ')}${o.changes > (o.changed || []).length ? ` and ${o.changes - o.changed.length} more` : ''} differ from the signed release.`
        : o.state === 'bad-signature'
          ? 'The signature doesn’t match the developer’s key: not an official release.'
          : 'Unsigned copy: not an official release.';
    return `<div class="wsec">
        <div class="wsec-head">${PT.icon('shield')}<h3>Official build</h3></div>
        <div class="sys-sum ${ok ? 'ok' : 'fail'}">${PT.icon(ok ? 'passed' : 'failed')}<b>${ok ? 'Verified' : 'Not verified'}</b><span>${esc(what)}</span></div>
        ${o.repo ? `<p class="wsec-hint">Official releases: <a href="${esc(o.repo)}" target="_blank" rel="noopener noreferrer">${esc(o.repo.replace(/^https?:\/\//, ''))}</a>. Each one is signed; a copy with any file changed shows as unofficial.</p>` : ''}
        ${o.ignored ? `<p class="wsec-hint">${esc(o.ignored)}</p>` : ''}
      </div>
      <div class="wsec">
        <div class="wsec-head">${PT.icon('sparkles')}<h3>Setup and tour</h3></div>
        <p class="wsec-hint">Run the first-run setup again to change your name, exchanges and the pages you see, or take the tour of the dashboard.</p>
        <div class="ds-actions"><button type="button" class="btn btn-sm" id="sys-setup">${PT.icon('settings', 'sm')}Run setup again</button><button type="button" class="btn btn-sm" id="sys-tour">${PT.icon('book', 'sm')}Take the tour</button></div>
      </div>`;
  }

  function render(host, d) {
    const a = d.autostart || { supported: false, on: false };
    host.innerHTML = `${officialHtml()}
      <div class="wsec">
        <div class="wsec-head">${PT.icon('zap')}<h3>Start with Windows</h3></div>
        <label class="al-opt"><input type="checkbox" class="toggle" id="sys-auto"${a.on ? ' checked' : ''}${a.supported ? '' : ' disabled'}><span><b>Start when I log in</b><span>${esc(
          a.supported ? 'Starts minimised in the background, only if the full security check below passes. If it fails, the tracker stays closed and Windows tells you why.' : 'Only available on Windows.'
        )}</span></span></label>
        <div class="ds-msg" id="sys-auto-msg" role="status"></div>
      </div>
      <div class="wsec">
        <div class="wsec-head">${PT.icon('shield')}<h3>Security check</h3></div>
        <div id="sys-checks">${checksHtml(d.last)}</div>
        <div class="ds-actions"><button type="button" class="btn btn-sm" id="sys-scan">${PT.icon('refresh', 'sm')}Run check now</button><span class="ds-msg" id="sys-msg" role="status"></span></div>
      </div>`;
    const close = () => {
      const dlg = host.closest('dialog');
      if (dlg) dlg.close();
    };
    $('#sys-setup', host).addEventListener('click', () => {
      close();
      PT.onboarding.restart();
    });
    $('#sys-tour', host).addEventListener('click', () => {
      close();
      PT.tour.start();
    });
    $('#sys-auto', host).addEventListener('change', async (ev) => {
      const on = ev.target.checked;
      const msg = $('#sys-auto-msg', host);
      ev.target.disabled = true;
      try {
        const r = await PT.post('/api/autostart', { on });
        ev.target.checked = Boolean(r.autostart && r.autostart.on);
        msg.textContent = ev.target.checked ? 'On. It will start when you next log in.' : 'Off.';
      } catch (e) {
        ev.target.checked = !on;
        msg.textContent = e.message;
      } finally {
        ev.target.disabled = false;
      }
    });
    $('#sys-scan', host).addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      const msg = $('#sys-msg', host);
      b.disabled = true;
      msg.textContent = 'Checking, with a Windows Defender scan…';
      try {
        const r = await PT.post('/api/security/scan', {});
        $('#sys-checks', host).innerHTML = checksHtml(r.last);
        msg.textContent = '';
      } catch (e) {
        msg.textContent = e.message;
      } finally {
        b.disabled = false;
      }
    });
  }

  async function load(host) {
    host.innerHTML = '<div class="wsec"><p class="wsec-hint">Loading…</p></div>';
    try {
      render(host, await PT.getJSON('/api/security'));
    } catch (e) {
      host.innerHTML = `<div class="wsec"><p class="wsec-hint">${esc(`Couldn't load the security check: ${e.message}`)}</p></div>`;
    }
  }

  PT.system = { load };
})();
