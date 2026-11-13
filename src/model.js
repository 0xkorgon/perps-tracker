'use strict';

// The AURA model behind Bulk estimates, the Live page's hold multiplier and Strategy's Bulk habits.
//
//   public  src/model-public.js: estimates from your own revealed weeks (every copy has it)
//   owner   private/aura-model.js: the developer's own model. Not in the repository or in releases.
//           Loaded only when private/aura-model.sig is a valid signature by the official release
//           key (src/official.js), so no other code can be slipped in under that name.

const path = require('path');
const fs = require('fs');
const official = require('./official');
const publicModel = require('./model-public');

const PRIVATE = path.join(official.ROOT, 'private', 'aura-model.js');

function load() {
  if (!fs.existsSync(PRIVATE)) return { ...publicModel, status: { edition: 'public' } };
  if (!official.verifyFile(PRIVATE)) return { ...publicModel, status: { edition: 'public', ignored: 'private/aura-model.js isn’t signed with the official key, so it wasn’t loaded.' } };
  try {
    const own = require(PRIVATE);
    return { ...publicModel, ...own, status: { edition: 'owner' } };
  } catch (e) {
    return { ...publicModel, status: { edition: 'public', ignored: `private/aura-model.js couldn’t be loaded (${e.message}).` } };
  }
}

module.exports = load();
