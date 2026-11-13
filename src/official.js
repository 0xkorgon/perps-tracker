'use strict';

// What makes a copy of the tracker the official one.
//
// Every official release is signed with the developer's private key (kept off the internet and out
// of the repository). The matching public key below checks two things:
//   security/manifest.json  the SHA-256 of every file in the release, signed in manifest.sig
//   private/aura-model.js   the developer's own AURA model, signed in aura-model.sig (owner builds)
// A copy whose files don't match the signed list still runs, but shows that it's a modified,
// unofficial build: its referral links and numbers aren't the developer's.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALQNyT4n/OzG2ylfK6cb+V96STeus9HhrH5kvzcvp9o4=
-----END PUBLIC KEY-----
`;
const REPO = 'https://github.com/0xkorgon/perps-tracker';
const NAME = 'Perps Tracker';
// The developer, for the follow button and the About links.
const DEVELOPER = { name: 'Korgon', handle: '@Korgonxx', x: 'https://x.com/Korgonxx' };

const ROOT = path.join(__dirname, '..');
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.bat', '.cmd', '.svg', '.md', '.txt']);

// File contents as hashed and signed: text files with Windows line endings (CRLF) count the same as
// with Unix ones, so a copy checked out with Git on Windows still matches.
function normalized(file, buf) {
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) return buf;
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fileHash = (abs, rel = abs) => sha(normalized(rel, fs.readFileSync(abs)));

function verifyBytes(buf, sigText, publicKey = PUBLIC_KEY) {
  try {
    const sig = Buffer.from(String(sigText || '').trim(), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, buf, crypto.createPublicKey(publicKey), sig);
  } catch {
    return false;
  }
}
// A file and its signature (file + ".sig" by default, or `sigFile`).
function verifyFile(file, sigFile = `${file}.sig`, publicKey = PUBLIC_KEY) {
  try {
    return verifyBytes(normalized(file, fs.readFileSync(file)), fs.readFileSync(sigFile, 'utf8'), publicKey);
  } catch {
    return false;
  }
}
function signBytes(buf, privateKeyPem) {
  return crypto.sign(null, buf, crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

let pkg = {};
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch {
  pkg = {};
}

module.exports = { PUBLIC_KEY, REPO, NAME, DEVELOPER, VERSION: pkg.version || '0.0.0', ROOT, TEXT_EXT, normalized, sha, fileHash, verifyBytes, verifyFile, signBytes };
