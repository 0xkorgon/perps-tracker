'use strict';

// Bulk's markets and fees (docs.bulk.trade, Fees, "Growth Mode").
//
//   Crypto markets  taker fee by 14-day volume, 3.5 bps down to 2.2 bps; makers pay 0 bps (a few
//                   large makers earn rebates)
//   TradFi markets  stocks, ETFs, indices and commodities: one flat tier, 1.5 bps taker, 0 bps
//                   maker ("55% lower fees")
//
// Bulk's public fee state (/feeState) says it market by market: a market with its own policy (one flat
// 1.5 bps tier) is TradFi, the rest pay the global crypto tiers. It's read with the market volume and
// used first; the name list below covers markets it hasn't listed yet.

const TRADFI = new Set(
  [
    // Indices
    'US500', 'US100', 'US30', 'US2000', 'SPX', 'SPX500', 'NDX', 'NAS100', 'DJI', 'DJ30', 'RUT', 'VIX', 'GER40', 'DAX', 'UK100', 'JP225', 'NIKKEI', 'HK50',
    // ETFs
    'SPY', 'QQQ', 'IWM', 'DIA', 'SOXL', 'SOXS', 'SOXX', 'SMH', 'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'UPRO', 'UVXY', 'VXX', 'GLD', 'SLV', 'USO', 'UNG', 'TLT', 'IBIT', 'ETHA', 'ARKK', 'XLE', 'XLF', 'XLK', 'KWEB', 'FXI', 'EEM', 'EWJ', 'EWY', 'TSLL', 'NVDL', 'MSTU', 'CONL',
    // Stocks
    'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'NFLX', 'AMD', 'INTC', 'AVGO', 'TSM', 'ARM', 'MU', 'SMCI', 'ORCL', 'CRM', 'ADBE', 'PLTR', 'COIN', 'MSTR', 'HOOD', 'CRCL', 'SNDK', 'WDC', 'STX', 'BABA', 'NIO', 'GME', 'AMC', 'UBER', 'ABNB', 'SHOP', 'PYPL', 'SQ', 'XYZ', 'DIS', 'NKE', 'KO', 'PEP', 'WMT', 'COST', 'JPM', 'GS', 'BAC', 'MA', 'XOM', 'CVX', 'BA', 'LLY', 'UNH', 'PFE', 'MRNA', 'IBM', 'QCOM', 'TXN', 'ASML', 'SPOT', 'RBLX', 'SNOW', 'CRWD', 'CRWV', 'PANW', 'RDDT', 'IONQ', 'RGTI', 'QBTS', 'OKLO', 'SMR', 'CEG', 'VST', 'APP', 'CVNA', 'SOFI', 'RIVN', 'LCID', 'F', 'GM', 'DELL', 'HPE', 'ANET', 'MRVL', 'LRCX', 'AMAT', 'KLAC', 'ON', 'NBIS', 'CIFR', 'IREN', 'MARA', 'RIOT', 'CLSK', 'HUT', 'BMNR', 'SBET', 'GLXY', 'SKHYNIX', 'SAMSUNG', 'TSMC', 'SONY', 'TOYOTA',
    // Pre-IPO companies
    'SPACEX', 'OPENAI', 'ANTHROPIC', 'ANT', 'STRIPE', 'DATABRICKS', 'XAI', 'KRAKEN',
    // Commodities and FX
    'XAU', 'XAG', 'XPT', 'XPD', 'GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM', 'OIL', 'WTI', 'BRENT', 'NATGAS', 'COPPER', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'EURUSD', 'GBPUSD', 'USDJPY',
  ]
);

// "TSLA-USD", "US500-PERP", "xyz:NVDA" -> "TSLA", "US500", "NVDA".
function baseOf(sym) {
  return String(sym || '')
    .toUpperCase()
    .replace(/^[A-Z0-9]+:/, '')
    .replace(/[-_/](USDC|USDT|USD|PERP)$/, '')
    .replace(/[-_/]PERP$/, '');
}

// Bulk's live fee state: { tiers: [[14-day volume from, taker bps]], overrides: { 'TSLA-USD': bps },
// instruments: [...], at }, or null until it's been read.
let live = null;
function setFeeState(fs) {
  if (fs && Array.isArray(fs.tiers) && fs.tiers.length && fs.overrides && Array.isArray(fs.instruments)) live = fs;
}
// Bulk's /feeState answer, boiled down to what the tracker uses.
function parseFeeState(raw) {
  const scopes = raw && Array.isArray(raw.scopes) ? raw.scopes : [];
  const g = scopes.find((x) => x && x.instrument === 'global');
  const tiers = g && g.active_policy && Array.isArray(g.active_policy.tiers) ? g.active_policy.tiers.map((t) => [Number(t.threshold_volume) || 0, Number(t.taker_bps)]).filter((t) => Number.isFinite(t[1])).sort((a, b) => a[0] - b[0]) : [];
  const overrides = {};
  const instruments = [];
  for (const x of scopes) {
    if (!x || !x.instrument || x.instrument === 'global') continue;
    instruments.push(x.instrument);
    const t = x.active_policy && Array.isArray(x.active_policy.tiers) && x.active_policy.tiers[0];
    if (t && Number.isFinite(Number(t.taker_bps))) overrides[x.instrument] = Number(t.taker_bps);
  }
  return tiers.length ? { tiers, overrides, instruments, at: Date.now() } : null;
}
const known = (sym) => live && live.instruments.includes(sym);

// 'tradfi' for stocks, ETFs, indices and commodities; 'crypto' for everything else.
function bulkClass(sym) {
  if (known(sym)) return sym in live.overrides ? 'tradfi' : 'crypto';
  return TRADFI.has(baseOf(sym)) ? 'tradfi' : 'crypto';
}

// Crypto taker fee tiers: [14-day volume from, taker bps].
const CRYPTO_TIERS = [
  [0, 3.5],
  [1e6, 3.3],
  [1e7, 3.0],
  [5e7, 2.8],
  [1.5e8, 2.6],
  [5e8, 2.4],
  [1.5e9, 2.3],
  [4e9, 2.2],
];
const TRADFI_TAKER_BPS = 1.5;
const MAKER_BPS = 0;

// Your crypto tier from your 14-day volume (main account and sub-accounts together).
function cryptoTier(vol14) {
  const T = live ? live.tiers : CRYPTO_TIERS;
  const v = Number(vol14) || 0;
  let i = 0;
  while (i + 1 < T.length && v >= T[i + 1][0]) i += 1;
  const next = T[i + 1];
  return { tier: i + 1, takerBps: T[i][1], volume14: v, next: next ? { tier: i + 2, at: next[0], takerBps: next[1] } : null };
}

// The taker fee for a market class (and, when known, the market's own rate from Bulk's fee state).
function takerBps(cls, vol14, sym) {
  if (sym && known(sym) && sym in live.overrides) return live.overrides[sym];
  return cls === 'tradfi' ? TRADFI_TAKER_BPS : cryptoTier(vol14).takerBps;
}

// Bulk's net fee revenue per dollar traded (for the leagues' prize pool, 12.5% of net revenue): every
// trade has one taker paying the tier fee (most volume comes from busy traders on lower tiers) and
// one maker paying nothing, with a few large makers earning rebates.
const NET_BPS = { crypto: 3.0, tradfi: 1.4 };

module.exports = { bulkClass, baseOf, cryptoTier, takerBps, setFeeState, parseFeeState, feeState: () => live, CRYPTO_TIERS, TRADFI_TAKER_BPS, MAKER_BPS, NET_BPS };
