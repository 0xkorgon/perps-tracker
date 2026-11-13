'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Turn any epoch timestamp (seconds, ms, µs or ns; number or string) into milliseconds.
// The three exchanges use three different units, so everything goes through here.
function toMs(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e17) return n / 1e6; // nanoseconds (Bulk)
  if (n > 1e14) return n / 1e3; // microseconds (Arcus)
  if (n > 1e11) return n;       // milliseconds (Hyperliquid)
  return n * 1000;              // seconds
}

// Parse a numeric API field; anything unparseable becomes 0.
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const isEvmAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim());
const isSolanaAddress = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || '').trim());

module.exports = { sleep, toMs, num, isEvmAddress, isSolanaAddress };
