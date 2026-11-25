'use strict';

// The AURA model behind Bulk estimates, the Live page's hold multiplier and Strategy's Bulk habits.
//
//   private/aura-model.js  the developer's own model (its code stays on the server; its numbers,
//                          rates and workings are shown in full on the dashboard)
//   src/model-public.js    the fallback: estimates from a wallet's own revealed weeks

const path = require('path');
const fs = require('fs');
const publicModel = require('./model-public');

const PRIVATE = path.join(__dirname, '..', 'private', 'aura-model.js');

function load() {
  if (!fs.existsSync(PRIVATE)) return { ...publicModel, status: { edition: 'public' } };
  try {
    const own = require(PRIVATE);
    return { ...publicModel, ...own, status: { edition: 'owner' } };
  } catch (e) {
    console.error(`  [!] private/aura-model.js couldn't be loaded (${e.message}); using the fallback model.`);
    return { ...publicModel, status: { edition: 'public', ignored: e.message } };
  }
}

module.exports = load();
