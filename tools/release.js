#!/usr/bin/env node
'use strict';

// Release tool: signs this copy and builds a clean one to share.
//
//   node tools/release.js keygen            make the signing key (private/signing-key.pem) and put
//                                           its public half in src/official.js. Once, ever.
//   node tools/release.js set-repo <url>    where the official version lives (shown to modified copies)
//   node tools/release.js sign              re-list every file, sign the list (security/manifest.sig)
//                                           and the private model (private/aura-model.sig)
//   node tools/release.js build             sign, then copy the public files to release/perps-tracker-<version>/
//                                           (no wallets, history, private folder or notes), check the
//                                           copy verifies, and zip it
//
// The signing key never leaves private/: it isn't in the manifest, the release or the repository
// (.gitignore). Keep a backup of the private folder somewhere safe: without the key you can't sign
// updates that existing copies recognise as official.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const official = require('../src/official');
const security = require('../src/security');

const KEY = process.env.PERPS_SIGNING_KEY || path.join(ROOT, 'private', 'signing-key.pem');
const OFFICIAL_JS = path.join(ROOT, 'src', 'official.js');
const DOCS = ['README.md', 'LICENSE', '.gitignore', '.gitattributes'];

const say = (m) => console.log(`  ${m}`);
const die = (m) => {
  console.error(`  ${m}`);
  process.exit(1);
};

function keygen() {
  if (fs.existsSync(KEY)) die(`There's already a signing key at ${path.relative(ROOT, KEY)}. Keep using it (a new key would make earlier releases look unofficial).`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(KEY), { recursive: true });
  fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const src = fs.readFileSync(OFFICIAL_JS, 'utf8').replace(/const PUBLIC_KEY = `[^`]*`;/, `const PUBLIC_KEY = \`${pub}\`;`);
  fs.writeFileSync(OFFICIAL_JS, src);
  say(`Signing key saved to ${path.relative(ROOT, KEY)} (never share it; back up the private folder).`);
  say('Its public half is now in src/official.js.');
}

function setRepo(url) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url || '')) die('Give the repository as https://github.com/<you>/<repo>.');
  const src = fs.readFileSync(OFFICIAL_JS, 'utf8').replace(/const REPO = '[^']*';/, `const REPO = '${url}';`);
  fs.writeFileSync(OFFICIAL_JS, src);
  say(`Official repository: ${url}`);
}

function privateKey() {
  if (!fs.existsSync(KEY)) die('No signing key yet: run  node tools/release.js keygen  first.');
  return fs.readFileSync(KEY, 'utf8');
}

// List every official file with its fingerprint, and sign the list.
function sign(root = ROOT) {
  const pem = privateKey();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const m = security.buildManifest(root);
  const manifest = { v: 1, name: official.NAME, version: pkg.version, signedAt: new Date().toISOString(), repo: official.REPO, files: m.files };
  const text = `${JSON.stringify(manifest, null, 1)}\n`;
  fs.mkdirSync(path.join(root, 'security'), { recursive: true });
  fs.writeFileSync(path.join(root, security.MANIFEST), text);
  fs.writeFileSync(path.join(root, security.MANIFEST_SIG), `${official.signBytes(official.normalized(security.MANIFEST, Buffer.from(text)), pem)}\n`);
  say(`Signed ${Object.keys(m.files).length} files, version ${pkg.version}.`);
  const priv = path.join(root, 'private', 'aura-model.js');
  if (fs.existsSync(priv)) {
    fs.writeFileSync(`${priv}.sig`, `${official.signBytes(official.normalized(priv, fs.readFileSync(priv)), pem)}\n`);
    say('Signed private/aura-model.js (owner edition).');
  }
  const check = security.verifyOfficial(root);
  if (check.state !== 'verified') die(`The signature doesn't check out (${check.state}). Is the public key in src/official.js the one for ${path.relative(ROOT, KEY)}?`);
  return manifest;
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function build() {
  const manifest = sign(ROOT);
  const name = `perps-tracker-${manifest.version}`;
  const out = path.join(ROOT, 'release', name);
  fs.rmSync(out, { recursive: true, force: true });
  for (const f of Object.keys(manifest.files)) copyFile(path.join(ROOT, f), path.join(out, f));
  for (const f of [security.MANIFEST, security.MANIFEST_SIG, ...DOCS]) if (fs.existsSync(path.join(ROOT, f))) copyFile(path.join(ROOT, f), path.join(out, f));
  // Nothing personal or private may end up in the copy.
  const leaked = ['config.json', 'data', 'private'].filter((f) => fs.existsSync(path.join(out, f)));
  if (leaked.length) die(`Refusing to release: ${leaked.join(', ')} ended up in the copy.`);
  const check = security.verifyOfficial(out);
  if (check.state !== 'verified' || check.edition !== 'public') die(`The release copy doesn't verify (${check.state}, ${check.edition}).`);
  say(`Release folder: ${path.relative(ROOT, out)} (verified, public edition)`);
  const zip = path.join(ROOT, 'release', `${name}.zip`);
  fs.rmSync(zip, { force: true });
  try {
    if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}' -DestinationPath '${zip}' -Force`], { stdio: 'ignore' });
    else execFileSync('zip', ['-qr', zip, name], { cwd: path.join(ROOT, 'release'), stdio: 'ignore' });
    say(`Zip: ${path.relative(ROOT, zip)}`);
  } catch {
    say('Couldn’t make a zip here; zip the release folder yourself.');
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'keygen') keygen();
else if (cmd === 'set-repo') setRepo(arg);
else if (cmd === 'sign') sign();
else if (cmd === 'build') build();
else {
  console.log('Usage: node tools/release.js keygen | set-repo <url> | sign | build');
  process.exit(cmd ? 1 : 0);
}
