'use strict';

// Local cache of each wallet's fills and positions, one JSON file per exchange+wallet in ./data.
// Keeping fills locally makes refreshes incremental and preserves history the APIs eventually drop.

const fs = require('fs');
const path = require('path');

const VERSION = 2; // bump when the cached shape changes (forces a clean re-sync)

function emptyCache(exchange, address) {
  return { v: VERSION, exchange, address, fills: [], closed: null, funding: [], transfers: [], positions: [], cursor: {}, meta: {}, syncedAt: null };
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.mem = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  key(exchange, address) {
    const a = String(address).trim();
    return `${exchange}_${/^0x/i.test(a) ? a.toLowerCase() : a}`;
  }

  file(exchange, address) {
    return path.join(this.dir, `${this.key(exchange, address)}.json`);
  }

  get(exchange, address) {
    const k = this.key(exchange, address);
    if (this.mem.has(k)) return this.mem.get(k);
    let cache = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(exchange, address), 'utf8'));
      if (parsed && parsed.v === VERSION && Array.isArray(parsed.fills)) cache = parsed;
    } catch {
      cache = null;
    }
    if (!cache) cache = emptyCache(exchange, address);
    cache.cursor = cache.cursor || {};
    cache.meta = cache.meta || {};
    cache.positions = Array.isArray(cache.positions) ? cache.positions : [];
    cache.funding = Array.isArray(cache.funding) ? cache.funding : [];
    cache.transfers = Array.isArray(cache.transfers) ? cache.transfers : [];
    this.mem.set(k, cache);
    return cache;
  }

  save(exchange, address) {
    const k = this.key(exchange, address);
    const cache = this.mem.get(k);
    if (!cache) return;
    try {
      writeJsonAtomic(this.file(exchange, address), cache);
    } catch (e) {
      console.error(`Couldn't save cache for ${exchange} ${address}: ${e.message}`);
    }
  }
}

module.exports = { Store, writeJsonAtomic };
