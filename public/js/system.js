/* Settings → System: your private link (to open this dashboard on another device), forgetting it on
   this browser, and the setup and tour. */
(() => {
  'use strict';

  const PT = window.PT;
  const { $, esc } = PT;

  function render(host) {
    const link = PT.access ? PT.access.privateLink() : '';
    host.innerHTML = `
      <div class="wsec">
        <div class="wsec-head">${PT.icon('shield')}<h3>Your private link</h3></div>
        <p class="wsec-hint">Open this link on your phone or another computer to see this same dashboard there. It works like a password: anyone with it can see your dashboard, so don't share it or post it anywhere. There's no account, so keep a copy somewhere safe (a password manager is ideal): if you clear this browser's data without it, the dashboard can't be recovered.</p>
        <div class="sys-link">
          <input type="password" class="wide mono" id="sys-link" value="${esc(link)}" readonly aria-label="Your private link">
          <button type="button" class="btn btn-sm" id="sys-link-show">${PT.icon('eye', 'sm')}Show</button>
          <button type="button" class="btn btn-sm btn-primary" id="sys-link-copy">${PT.icon('copy', 'sm')}Copy</button>
        </div>
        <div class="ds-msg" id="sys-link-msg" role="status"></div>
      </div>
      <div class="wsec">
        <div class="wsec-head">${PT.icon('sparkles')}<h3>Setup and tour</h3></div>
        <p class="wsec-hint">Run the first-run setup again to change your name, exchanges and the pages you see, or take the tour of the dashboard.</p>
        <div class="ds-actions"><button type="button" class="btn btn-sm" id="sys-setup">${PT.icon('settings', 'sm')}Run setup again</button><button type="button" class="btn btn-sm" id="sys-tour">${PT.icon('book', 'sm')}Take the tour</button></div>
      </div>
      <div class="wsec">
        <div class="wsec-head">${PT.icon('x')}<h3>Leave this browser</h3></div>
        <p class="wsec-hint">Removes the dashboard from this browser only (for a shared computer). It stays on the server: open your private link to come back.</p>
        <div class="ds-actions"><button type="button" class="btn btn-sm" id="sys-forget">${PT.icon('x', 'sm')}Forget on this browser</button><span class="ds-msg" id="sys-forget-msg" role="status"></span></div>
      </div>
      ${PT.state && PT.state.version ? `<p class="wsec-hint">Perps Tracker ${esc(PT.state.version)}</p>` : ''}`;
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
    $('#sys-link-show', host).addEventListener('click', (ev) => {
      const input = $('#sys-link', host);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      ev.currentTarget.lastChild.textContent = show ? 'Hide' : 'Show';
    });
    $('#sys-link-copy', host).addEventListener('click', async () => {
      const msg = $('#sys-link-msg', host);
      try {
        await navigator.clipboard.writeText(link);
        msg.textContent = 'Copied. Keep it somewhere private.';
      } catch {
        const input = $('#sys-link', host);
        input.type = 'text';
        input.select();
        msg.textContent = 'Press Ctrl+C (or Cmd+C) to copy.';
      }
    });
    let armed = false;
    $('#sys-forget', host).addEventListener('click', () => {
      const msg = $('#sys-forget-msg', host);
      if (!armed) {
        armed = true;
        msg.textContent = 'Saved your private link? Click again to forget this dashboard here.';
        return;
      }
      PT.access.forget();
    });
  }

  function load(host) {
    render(host);
  }

  PT.system = { load };
})();
