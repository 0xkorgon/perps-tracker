'use strict';

// Desktop notifications from the tracker itself, so alerts reach you with the browser closed.
//
// Windows  a toast through Windows PowerShell (built in, nothing to install), with Windows' alarm
//          sound for danger and its reminder sound for warnings. Danger toasts stay on screen until
//          dismissed. "Open dashboard" opens the tracker in your browser.
// macOS    osascript "display notification" with a system sound.
// Linux    notify-send, if it's installed.
// Every alert is also printed in the tracker's window with a terminal beep.

const { spawn } = require('child_process');

const xml = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// The Windows toast as XML. silent: no sound (the open dashboard plays its own instead).
function toastXml({ title, body, level, url, silent }) {
  const danger = level === 'danger';
  const audio = silent ? '<audio silent="true"/>' : danger ? '<audio src="ms-winsoundevent:Notification.Looping.Alarm2" loop="false"/>' : '<audio src="ms-winsoundevent:Notification.Reminder"/>';
  const link = url ? `<actions><action content="Open dashboard" activationType="protocol" arguments="${xml(url)}"/></actions>` : '';
  return `<toast${danger ? ' scenario="reminder"' : ''}${url ? ` activationType="protocol" launch="${xml(url)}"` : ''}><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text><text placement="attribution">Perps Tracker</text></binding></visual>${audio}${link}</toast>`;
}

// PowerShell that shows the toast. PowerShell's own app id is registered on every Windows 10/11 PC,
// so no installation or shortcut is needed.
function windowsScript(toast) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('${toast.replace(/'/g, "''")}')`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
  ].join('\n');
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return resolve(e.message);
    }
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve(e.message));
    child.on('close', (code) => resolve(code === 0 ? null : err.trim().split('\n').slice(-1)[0] || `exit ${code}`));
  });
}

// Resolves to null when shown, or a reason it couldn't be.
async function desktop(alert, { url, silent = false, platform = process.platform } = {}) {
  const title = alert.title;
  const body = alert.body || '';
  if (platform === 'win32') {
    const script = windowsScript(toastXml({ title, body, level: alert.level, url, silent }));
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  }
  if (platform === 'darwin') {
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const sound = silent ? '' : ` sound name "${alert.level === 'danger' ? 'Sosumi' : 'Glass'}"`;
    return run('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"${sound}`]);
  }
  return run('notify-send', ['-u', alert.level === 'danger' ? 'critical' : 'normal', '-a', 'Perps Tracker', title, body]);
}

// A line in the tracker's window, with a beep for danger.
function terminal(alert, { sound = true } = {}) {
  const t = new Date(alert.at || Date.now()).toLocaleTimeString();
  const mark = alert.level === 'danger' ? '[!!]' : alert.level === 'warn' ? '[! ]' : '[i ]';
  console.log(`${sound && alert.level === 'danger' ? '\x07' : ''}  ${mark} ${t}  ${alert.title}${alert.body ? `\n         ${alert.body}` : ''}`);
}

module.exports = { desktop, terminal, toastXml, windowsScript };
