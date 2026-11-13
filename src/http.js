'use strict';

// Tiny JSON-over-HTTPS client built on Node's standard library (no npm install needed).
// Retries network errors, 5xx and 429 (honouring Retry-After) with backoff.

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const { sleep } = require('./util');

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 4 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 4 }),
};

function rawRequest(method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'perps-tracker/1.0',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers,
        agent: agents[u.protocol],
      },
      (res) => {
        let stream = res;
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
        else if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
        stream.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function errorText(res) {
  const j = res.json;
  if (j && typeof j.error === 'string') return j.error;
  if (j && j.error && typeof j.error.message === 'string') return j.error.message;
  if (j && typeof j.message === 'string') return j.message;
  // Cloudflare and other gateways answer with a problem document:
  // {"type": "<a Cloudflare docs link>", "title": "Error 504: Gateway time-out", "status": 504, "detail": "..."}
  if (j && typeof j.title === 'string') return j.title;
  const t = (res.text || '').trim();
  const title = /<title[^>]*>([^<]{1,160})<\/title>/i.exec(t);
  if (title) return title[1].replace(/\s+/g, ' ').trim();
  if (/^</.test(t)) return `HTTP ${res.status}`; // an HTML page without a title: don't print its markup
  return t ? t.slice(0, 200) : `HTTP ${res.status}`;
}

// The server (or the gateway in front of it) is having trouble, not your request: 5xx, Cloudflare's
// 52x, or no answer in time. Worth trying again later; nothing about your address is wrong.
const GATEWAY = { 500: 'server error', 502: 'bad gateway', 503: 'unavailable', 504: 'gateway time-out', 520: 'unknown error', 521: 'server down', 522: 'connection timed out', 523: 'origin unreachable', 524: 'timed out' };
function isServerTrouble(err) {
  if (!err) return false;
  if (err.status >= 500) return true;
  return err.status === 0 && /timed out|ECONNRESET|socket hang up|ETIMEDOUT/i.test(String(err.message || ''));
}
// "Bulk's API isn't answering right now (Cloudflare 504, gateway time-out). ..."
function serverTroubleText(err, name) {
  const s = err && err.status;
  const h = (err && err.headers) || {};
  const cf = Boolean(h['cf-ray'] || /cloudflare/i.test(String(h.server || ''))) || /cloudflare/i.test(String((err && err.body && err.body.type) || ''));
  const what = s >= 500 ? `${cf ? 'Cloudflare ' : 'HTTP '}${s}${GATEWAY[s] ? `, ${GATEWAY[s]}` : ''}` : 'no answer in time';
  return `${name}'s API isn't answering right now (${what}). Showing your last synced data; the tracker tries again at the next sync.`;
}

async function request(method, url, body, opts = {}) {
  const retries = opts.retries == null ? 5 : opts.retries;
  const timeoutMs = opts.timeoutMs || 30000;
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    let res;
    let netErr;
    try {
      res = await rawRequest(method, url, body, timeoutMs);
    } catch (e) {
      netErr = e;
    }
    if (res && res.status >= 200 && res.status < 300) {
      if (res.json === undefined) throw new ApiError(`${host} sent a response that isn't JSON`, res.status, res.text);
      return res.json;
    }
    // retry429: false for sites whose 429 is a firewall block rather than a short rate limit.
    const retryable = Boolean(netErr) || (res.status === 429 && opts.retry429 !== false) || res.status >= 500;
    // A gateway error rarely clears within seconds: try a few times, then let the next sync retry
    // (five tries with backoff kept a whole sync waiting for half a minute per request).
    const stuck = (res && res.status >= 500) || (netErr && /timed out/i.test(netErr.message));
    const limit = stuck ? Math.min(retries, 2) : retries;
    if (!retryable || attempt >= limit) {
      if (netErr) throw new ApiError(`Can't reach ${host}: ${netErr.message}`, 0);
      const err = new ApiError(errorText(res), res.status, res.json);
      err.headers = res.headers;
      err.isHtml = /text\/html/i.test(String(res.headers['content-type'] || ''));
      throw err;
    }
    let waitMs = Math.min(30000, 1000 * 2 ** attempt);
    if (res && res.status === 429) {
      const fromBody = res.json && Number(res.json.retryAfterMs);
      const fromHeader = Number(res.headers['retry-after']);
      if (fromBody > 0) waitMs = fromBody + 250;
      else if (fromHeader > 0) waitMs = fromHeader * 1000 + 250;
      else waitMs = Math.max(waitMs, 3000);
    }
    if (opts.onRetry) opts.onRetry({ attempt: attempt + 1, waitMs, status: res ? res.status : 0, host });
    await sleep(waitMs);
  }
}

module.exports = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body, opts) => request('POST', url, body, opts),
  ApiError,
  errorText,
  isServerTrouble,
  serverTroubleText,
};
