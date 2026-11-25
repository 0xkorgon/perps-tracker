'use strict';

// Invite codes. A new visitor needs one to open their own dashboard; the developer makes and
// revokes them on the admin page. Kept in data/invites.json.
//
//   { code, note, uses, used, createdAt, revoked, lastUsedAt }
//   uses  how many dashboards the code can open (0 = no limit)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./store');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const block = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const normalize = (code) => String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
const text = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

class Invites {
  constructor(dir) {
    this.file = path.join(dir, 'invites.json');
    this.list = [];
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s && Array.isArray(s.invites)) this.list = s.invites;
    } catch {
      // none yet
    }
  }

  save() {
    writeJsonAtomic(this.file, { v: 1, invites: this.list });
  }

  find(code) {
    const n = normalize(code);
    return n ? this.list.find((i) => normalize(i.code) === n) || null : null;
  }

  create({ note, uses, code } = {}) {
    let c = text(code, 24).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (c && c.replace(/-/g, '').length < 4) return { error: 'A custom code needs at least 4 letters or numbers.' };
    if (c && this.find(c)) return { error: 'That code already exists.' };
    if (!c) do c = `PT-${block(4)}-${block(4)}`; while (this.find(c));
    const n = Math.round(Number(uses));
    const invite = { code: c, note: text(note, 80), uses: Number.isFinite(n) && n >= 0 ? Math.min(n, 100000) : 1, used: 0, createdAt: Date.now(), revoked: false, lastUsedAt: null };
    this.list.push(invite);
    this.save();
    return { invite };
  }

  // Is this code good for one more dashboard? Doesn't use it up (see redeem).
  check(code) {
    const i = this.find(code);
    if (!i || i.revoked) return { error: 'That invite code isn’t valid.' };
    if (i.uses > 0 && i.used >= i.uses) return { error: 'That invite code has been used up.' };
    return { invite: i };
  }

  redeem(code) {
    const r = this.check(code);
    if (r.error) return r;
    r.invite.used += 1;
    r.invite.lastUsedAt = Date.now();
    this.save();
    return r;
  }

  revoke(code, revoked = true) {
    const i = this.find(code);
    if (!i) return { error: 'No such code.' };
    i.revoked = Boolean(revoked);
    this.save();
    return { invite: i };
  }
}

module.exports = { Invites, normalize };
