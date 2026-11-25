'use strict';

// Referral codes and sign-up links.
//
//   ours   the developer's codes for each exchange, shown on the Referrals page, in the first-run
//          setup and in Settings. They live on the server, so nobody using the site can change them.
//   yours  codes you add yourself on the Referrals page, kept with your dashboard.
//
// A program with no code or link yet is shown as "coming soon".

// The developer, for the follow button and the About links.
const DEVELOPER = { name: 'Korgon', handle: '@Korgonxx', x: 'https://x.com/Korgonxx' };

const OURS = [
  {
    id: 'bulk',
    name: 'Bulk',
    kind: 'exchange',
    code: 'KORGONXX',
    accessCode: null, // Bulk asks for an access code at sign-up
    link: 'https://app.bulk.trade/ref/KORGONXX',
    perk: '',
    about: 'Solana perp DEX. Trading earns AURA every week.',
  },
  {
    id: 'arcus',
    name: 'Arcus',
    kind: 'exchange',
    code: 'KORGONXX',
    accessCode: null, // Arcus asks for an access code at sign-up
    link: 'https://app.arcus.xyz/ref/KORGONXX',
    perk: '',
    about: 'Perps on stocks, ETFs and crypto. Weekly points drops.',
  },
  {
    id: 'entropy',
    name: 'Entropy',
    kind: 'exchange',
    code: 'korgonxx',
    accessCode: null,
    link: 'https://pro.entropy.io/?r=korgonxx',
    perk: '',
    about: 'Trading front end on Hyperliquid with its own markets.',
  },
];

// More programs the developer recommends (other exchanges, tools). Same shape as above; `id` is a
// short name, `logo` optional.
const MORE = [];

const ALL = [...OURS, ...MORE];
const byId = (id) => ALL.find((p) => p.id === id) || null;
const ready = (p) => Boolean(p && (p.code || p.link));

// Your own codes, from the Referrals page: { id, program, code, link, note }. Kept with your
// dashboard on the server.
const httpUrl = (u) => {
  const s = String(u == null ? '' : u).trim();
  return /^https?:\/\/[^\s"'<>]{3,300}$/i.test(s) ? s : '';
};
const text = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function cleanMine(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => ({ id: text(x && x.id, 40) || `c${Math.random().toString(36).slice(2, 10)}`, program: text(x && x.program, 40), code: text(x && x.code, 60), link: httpUrl(x && x.link), note: text(x && x.note, 120) }))
    .filter((x) => x.program && (x.code || x.link))
    .slice(0, 50);
}

function view(config = {}, extra = {}) {
  return {
    ours: OURS.map((p) => ({ ...p, ready: ready(p) })),
    more: MORE.map((p) => ({ ...p, ready: ready(p) })),
    developer: DEVELOPER,
    mine: cleanMine(config.myCodes),
    ...extra,
  };
}

module.exports = { OURS, MORE, DEVELOPER, byId, ready, cleanMine, view };
