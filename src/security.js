'use strict';

// Security check. Runs every time the tracker starts (quick checks) and in full before it starts with
// Windows. If anything fails when it starts with Windows, the tracker stays closed and tells you why.
//
//   Tracker files      every code file matches the official list shipped with this version
//                      (security/manifest.json, SHA-256 of each file)
//   Same as last time  when it starts with Windows: the files are the ones you last opened yourself
//                      (a copy of the list is kept outside the folder, in your user profile)
//   No program files   no unexpected programs or scripts (.exe, .vbs, .ps1, extra .js ...) in the
//                      folder, and no downloaded packages (node_modules)
//   No keys saved      config.json holds nothing that looks like a private key or seed phrase (the
//                      tracker only ever needs your public addresses)
//   Network            the code only points at Bulk, Arcus and Hyperliquid, and the dashboard only
//                      answers this computer (127.0.0.1)
//   No packages        package.json has no third-party dependencies or install scripts
//   Antivirus          Windows Defender scans the folder (when it starts with Windows, or on demand)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MANIFEST = 'security/manifest.json';
const MANIFEST_SIG = 'security/manifest.sig';
// data: your history; private: the developer's own files (never published); release: build output.
const SKIP_DIRS = new Set(['data', 'node_modules', '.git', 'security', 'private', 'release', '__MACOSX']);
const SKIP_FILES = new Set(['config.json']);
// What the official list covers: the tracker's own code and assets.
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.bat', '.cmd', '.svg', '.png', '.woff2', '.ico']);
// Files that can run something. None should be in the folder unless they're on the official list.
const RISKY_EXT = new Set(['.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.mjs', '.cjs', '.jse', '.wsf', '.wsh', '.hta', '.lnk', '.jar', '.py', '.sh', '.node', '.reg']);
// Every server the code may point at: the exchanges' public APIs, links shown on the page, and this PC.
const HOSTS = new Set(['localhost', '127.0.0.1', 'app.bulk.trade', 'mainnet-api1.bulk.trade', 'app.arcus.xyz', 'api.arcus.xyz', 'points-api.arcus.xyz', 'api.hyperliquid.xyz', 'app.hyperliquid.xyz', 'entropy.io', 'pro.entropy.io', 'nodejs.org', 'www.w3.org', 'github.com', 'x.com']);
const ENV_OVERRIDES = ['PERPS_BULK_API', 'PERPS_ARCUS_API', 'PERPS_HL_API', 'PERPS_BULK_AURA_API', 'PERPS_ARCUS_POINTS_API'];

const official = require('./official');
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

// Every file under root, as paths relative to it ("src/http.js"). skipDirs are left out.
function walk(root, skipDirs = SKIP_DIRS) {
  const out = [];
  const go = (dir) => {
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (dir === root && skipDirs.has(it.name)) continue;
        go(full);
      } else if (it.isFile() || it.isSymbolicLink()) out.push(rel(root, full));
    }
  };
  go(root);
  return out.sort();
}

function buildManifest(root) {
  const files = {};
  for (const f of walk(root)) {
    if (SKIP_FILES.has(f) || !CODE_EXT.has(path.extname(f).toLowerCase())) continue;
    files[f] = official.fileHash(path.join(root, f), f); // line endings don't count (see official.js)
  }
  return { v: 1, files };
}
const digest = (files) => official.sha(Buffer.from(JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]]))));

// ---------- trusted copy, kept outside the folder ----------
function trustedPath(env = process.env) {
  if (env.PERPS_TRUST_DIR) return path.join(env.PERPS_TRUST_DIR, 'trusted.json');
  const base = process.platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'PerpsTracker') : path.join(os.homedir(), '.perps-tracker');
  return path.join(base, 'trusted.json');
}
function readTrust(file = trustedPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
// You opened the tracker yourself: this version becomes the trusted one.
function saveTrust(root, file = trustedPath()) {
  const m = buildManifest(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, digest: digest(m.files), files: Object.keys(m.files).length, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

// ---------- keys and seed phrases ----------
function findSecrets(text) {
  const hits = [];
  if (/\b(?:0x)?[0-9a-fA-F]{64}\b/.test(text)) hits.push('a private key (64 hex characters)');
  if (/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/.test(text)) hits.push('a Solana secret key');
  if (/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/.test(text)) hits.push('a key file (64 numbers)');
  if (/"(?:[a-z]{3,8} ){11,23}[a-z]{3,8}"/.test(text)) hits.push('a seed phrase');
  if (/"[^"]*(?:private.?key|secret.?key|mnemonic|seed.?phrase|passphrase)[^"]*"\s*:/i.test(text)) hits.push('a field named like a key or seed');
  return hits;
}

// ---------- Windows Defender ----------
function defenderPath(env = process.env) {
  if (process.platform !== 'win32') return env.PERPS_DEFENDER || null; // tests only; never used on Windows
  const cands = [];
  const platform = path.join(env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform');
  try {
    for (const d of fs.readdirSync(platform).sort().reverse()) cands.push(path.join(platform, d, 'MpCmdRun.exe'));
  } catch {
    // no platform updates folder
  }
  cands.push(path.join(env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe'));
  return cands.find((c) => fs.existsSync(c)) || null;
}
function defenderScan(root, env = process.env) {
  return new Promise((resolve) => {
    const exe = defenderPath(env);
    if (!exe) return resolve({ state: 'warn', detail: process.platform === 'win32' ? "Windows Defender isn't available on this PC. Your own antivirus still protects the folder." : 'Windows Defender is only on Windows.' });
    execFile(exe, ['-Scan', '-ScanType', '3', '-File', root, '-DisableRemediation'], { timeout: 180 * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const out = String(stdout || '');
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      if (code === 0) return resolve({ state: 'ok', detail: 'Windows Defender scanned the folder: no threats.' });
      if (code === 2) {
        const n = (out.match(/found (\d+) threats?/i) || [])[1];
        return resolve({ state: 'fail', detail: `Windows Defender found ${n ? `${n} threat${n === '1' ? '' : 's'}` : 'a threat'} in the tracker folder. Open Windows Security to see it.` });
      }
      const why = err && err.killed ? 'it took too long' : "it's turned off or another antivirus is in charge";
      resolve({ state: 'warn', detail: `Couldn't run Windows Defender (${why}). Your own antivirus still protects the folder.` });
    });
  });
}

// ---------- official build ----------
// Signed by the developer (security/manifest.sig over security/manifest.json, checked with the
// public key in official.js) and every listed file unchanged: an official release. Anything else
// still runs, but the dashboard says it's a modified, unofficial build.
function verifyOfficial(root, cur = buildManifest(root)) {
  const out = { state: 'unsigned', version: official.VERSION, repo: official.REPO, changed: [], missing: [], edition: 'public' };
  let text = null;
  try {
    text = fs.readFileSync(path.join(root, MANIFEST), 'utf8');
  } catch {
    out.state = 'unsigned';
    out.detail = 'The list of official files is missing.';
    return out;
  }
  let shipped = null;
  try {
    shipped = JSON.parse(text);
  } catch {
    shipped = null;
  }
  let sig = null;
  try {
    sig = fs.readFileSync(path.join(root, MANIFEST_SIG), 'utf8');
  } catch {
    sig = null;
  }
  const signed = sig != null && official.verifyBytes(official.normalized(MANIFEST, Buffer.from(text, 'utf8')), sig);
  if (shipped && shipped.files) {
    for (const [f, h] of Object.entries(shipped.files)) {
      if (!(f in cur.files)) out.missing.push(f);
      else if (cur.files[f] !== h) out.changed.push(f);
    }
    // Code files that aren't on the signed list count as changes too.
    out.added = Object.keys(cur.files).filter((f) => !(f in shipped.files) && /\.(m?js|cjs|html|css)$/i.test(f));
    out.version = shipped.version || out.version;
    out.signedAt = shipped.signedAt || null;
  }
  const changes = out.changed.length + out.missing.length + (out.added || []).length;
  if (sig == null) out.state = 'unsigned';
  else if (!signed) out.state = 'bad-signature';
  else out.state = changes ? 'modified' : 'verified';
  // The developer's own private model, if this copy has one (see model.js).
  const priv = path.join(root, 'private', 'aura-model.js');
  if (fs.existsSync(priv)) out.edition = official.verifyFile(priv) ? 'owner' : 'public';
  return out;
}

// ---------- the check ----------
// mode: 'start' (you opened it), 'autostart' (it's starting with Windows) or 'manual' (Run check now).
async function scan(root, { mode = 'start', defender = false, env = process.env, trustFile = trustedPath(env) } = {}) {
  const checks = [];
  const add = (id, label, state, detail) => checks.push({ id, label, state, detail });
  const cur = buildManifest(root);
  const n = Object.keys(cur.files).length;

  // 1. Every code file matches the official list.
  let shipped = null;
  try {
    shipped = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
  } catch {
    shipped = null;
  }
  if (!shipped || !shipped.files) add('files', 'Tracker files', 'fail', "The list of official files (security/manifest.json) is missing, so the files can't be checked.");
  else {
    const changed = [];
    const missing = [];
    for (const [f, h] of Object.entries(shipped.files)) {
      if (!(f in cur.files)) missing.push(f);
      else if (cur.files[f] !== h) changed.push(f);
    }
    const list = (xs) => `${xs.slice(0, 4).join(', ')}${xs.length > 4 ? ` and ${xs.length - 4} more` : ''}`;
    if (changed.length || missing.length) add('files', 'Tracker files', 'fail', `${changed.length ? `Changed: ${list(changed)}. ` : ''}${missing.length ? `Missing: ${list(missing)}.` : ''}`.trim());
    else add('files', 'Tracker files', 'ok', `All ${Object.keys(shipped.files).length} files match the official versions.`);
  }

  // 1b. An official, signed release (a modified copy still runs; it just isn't official).
  const off = verifyOfficial(root, cur);
  const list2 = (xs) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ` and ${xs.length - 3} more` : ''}`;
  if (off.state === 'verified') add('official', 'Official build', 'ok', `Version ${off.version}, signed by the developer.${off.edition === 'owner' ? ' Owner edition: the private model is loaded.' : ''}`);
  else if (off.state === 'modified') add('official', 'Official build', 'warn', `Modified, unofficial build: ${list2([...off.changed, ...off.missing, ...(off.added || [])])} differ from the signed release. Get the official version at ${off.repo}.`);
  else if (off.state === 'bad-signature') add('official', 'Official build', 'warn', `The signature doesn't match the developer's key, so this isn't an official release. Get the official version at ${off.repo}.`);
  else add('official', 'Official build', 'warn', `Unsigned copy, not an official release. Get the official version at ${off.repo}.`);

  // 2. The same files as the last time you opened it yourself.
  const trust = readTrust(trustFile);
  const dig = digest(cur.files);
  if (!trust) add('trusted', 'Same as last time', mode === 'autostart' ? 'fail' : 'ok', mode === 'autostart' ? 'Open the tracker yourself once (start.bat) before it starts with Windows.' : 'First check on this PC. This version is now the trusted one.');
  else if (trust.digest !== dig) add('trusted', 'Same as last time', mode === 'autostart' ? 'fail' : 'warn', mode === 'autostart' ? 'The files changed since you last opened the tracker yourself. Open it with start.bat to check the change.' : 'The files changed since you last opened the tracker (an update). This version is now the trusted one.');
  else add('trusted', 'Same as last time', 'ok', 'Same files as the last time you opened it yourself.');

  // 3. No unexpected programs or scripts anywhere in the folder.
  const listed = new Set(Object.keys((shipped && shipped.files) || {}));
  const all = walk(root, new Set(['.git', 'release', '__MACOSX']));
  // private/: only the developer's signed model may hold code.
  const signedPrivate = (f) => f === 'private/aura-model.js' && official.verifyFile(path.join(root, f));
  const odd = all.filter((f) => RISKY_EXT.has(path.extname(f).toLowerCase()) && !listed.has(f) && !f.startsWith('node_modules/') && !signedPrivate(f));
  if (all.some((f) => f.startsWith('node_modules/'))) odd.unshift('node_modules (downloaded packages)');
  if (odd.length) add('programs', 'No unexpected programs', 'fail', `Found: ${odd.slice(0, 4).join(', ')}${odd.length > 4 ? ` and ${odd.length - 4} more` : ''}. The tracker doesn't use them; delete them if you didn't put them there.`);
  else add('programs', 'No unexpected programs', 'ok', 'No extra programs or scripts in the folder.');

  // 4. No keys or seed phrases saved.
  let cfg = '';
  try {
    cfg = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
  } catch {
    cfg = '';
  }
  const secrets = findSecrets(cfg);
  if (secrets.length) add('keys', 'No keys saved', 'fail', `config.json seems to hold ${secrets.join(' and ')}. The tracker never needs one: remove it and move your funds if it's real.`);
  else add('keys', 'No keys saved', 'ok', 'No private keys or seed phrases. The tracker only uses your public addresses and never signs anything.');

  // 5. Network: only the exchanges, and the dashboard only answers this computer.
  const unknown = new Set();
  for (const f of Object.keys(cur.files)) {
    if (!/\.(m?js|cjs|html)$/i.test(f)) continue;
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) if (!HOSTS.has(m[1].toLowerCase())) unknown.add(m[1]);
  }
  let serverText = '';
  try {
    serverText = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  } catch {
    serverText = '';
  }
  const localOnly = /\.listen\(\s*port\s*,\s*'127\.0\.0\.1'/.test(serverText);
  const overridden = ENV_OVERRIDES.filter((k) => env[k]);
  if (unknown.size || !localOnly) add('network', 'Network', 'fail', `${unknown.size ? `The code points at a server it shouldn't: ${[...unknown].slice(0, 3).join(', ')}. ` : ''}${localOnly ? '' : 'The dashboard may answer other computers.'}`.trim());
  else if (overridden.length) add('network', 'Network', 'warn', `Exchange addresses are replaced by environment settings (${overridden.join(', ')}).`);
  else add('network', 'Network', 'ok', 'Talks only to Bulk, Arcus and Hyperliquid. The dashboard only answers this computer.');

  // 6. No third-party packages or install scripts.
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    pkg = null;
  }
  const deps = pkg ? ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((k) => Object.keys(pkg[k] || {})) : [];
  const hooks = pkg ? ['preinstall', 'install', 'postinstall', 'prepare'].filter((k) => pkg.scripts && pkg.scripts[k]) : [];
  if (!pkg || deps.length || hooks.length) add('packages', 'No packages', 'fail', !pkg ? 'package.json is missing or unreadable.' : `${deps.length ? `Lists packages: ${deps.slice(0, 4).join(', ')}. ` : ''}${hooks.length ? `Has install scripts: ${hooks.join(', ')}.` : ''}`.trim());
  else add('packages', 'No packages', 'ok', "No third-party code: nothing is downloaded or run besides the tracker's own files.");

  // 7. Antivirus.
  if (defender) {
    const d = await defenderScan(root, env);
    add('antivirus', 'Antivirus', d.state, d.detail);
  }

  return { v: 1, at: Date.now(), mode, files: n, ok: !checks.some((c) => c.state === 'fail'), checks };
}

function saveResult(dataDir, result) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'security.json'), JSON.stringify(result, null, 1));
  } catch {
    // not critical
  }
}
function readResult(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'security.json'), 'utf8'));
  } catch {
    return null;
  }
}

// ---------- start with Windows ----------
// A small file in your Startup folder that starts the tracker minimised when you log in. Turning it
// off deletes the file.
const STARTUP_NAME = 'Perps Tracker.cmd';
function startupDir(env = process.env) {
  if (env.PERPS_STARTUP_DIR) return env.PERPS_STARTUP_DIR; // tests
  if (process.platform !== 'win32') return null;
  return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function autostartStatus(env = process.env) {
  const dir = startupDir(env);
  if (!dir) return { supported: false, on: false };
  return { supported: true, on: fs.existsSync(path.join(dir, STARTUP_NAME)) };
}
function startupScript(root) {
  return [
    '@echo off',
    'rem Perps Tracker: starts when you log in, only after its security check passes.',
    'rem Turn it off in the tracker (Settings, System) or delete this file.',
    `cd /d "${root}"`,
    'start "Perps Tracker" /min cmd /c node server.js --autostart',
    '',
  ].join('\r\n');
}
function setAutostart(on, root, env = process.env) {
  const dir = startupDir(env);
  if (!dir) return { supported: false, on: false, error: 'Starting with the computer is only set up on Windows.' };
  const file = path.join(dir, STARTUP_NAME);
  try {
    if (on) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, startupScript(root));
    } else if (fs.existsSync(file)) fs.unlinkSync(file);
    return autostartStatus(env);
  } catch (e) {
    return { ...autostartStatus(env), error: e.message };
  }
}

module.exports = { scan, verifyOfficial, buildManifest, digest, saveTrust, readTrust, trustedPath, findSecrets, defenderScan, saveResult, readResult, autostartStatus, setAutostart, startupScript, HOSTS, MANIFEST, MANIFEST_SIG, SKIP_DIRS };
