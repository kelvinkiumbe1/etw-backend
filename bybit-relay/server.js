// ETW Bybit relay — runs in a non-US Render region (Frankfurt) because Bybit
// refuses API traffic from US IP addresses and the main backend is in Virginia.
//
// It is deliberately narrow so it can't be used as an open proxy:
//   • every request must carry X-Relay-Secret == RELAY_SECRET (timing-safe)
//   • GET only, path must start with /v5/
//   • the upstream host is picked from a fixed list via X-Relay-Target
//   • only Bybit's X-BAPI-* auth headers are forwarded
// Bybit signs over timestamp+key+recvWindow+query, all of which pass through
// unchanged, so API secrets never reach this service — it only sees signatures.
//
// No dependencies: Node 18+ built-in http + fetch.
const http = require('http');
const crypto = require('crypto');

const SECRET = String(process.env.RELAY_SECRET || '');
const PORT = Number(process.env.PORT || 10000);
const TARGETS = {
  mainnet: 'https://api.bybit.com',
  eu: 'https://api.bybit.eu',
  demo: 'https://api-demo.bybit.com',
  testnet: 'https://api-testnet.bybit.com',
};
const FORWARD = ['x-bapi-api-key', 'x-bapi-timestamp', 'x-bapi-recv-window', 'x-bapi-sign'];

function secretOk(given) {
  if (SECRET.length < 32) return false;                   // refuse to run open
  const h = (s) => crypto.createHash('sha256').update(String(s || '')).digest();
  return crypto.timingSafeEqual(h(given), h(SECRET));
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay');
  if (url.pathname === '/' || url.pathname === '/health') return send(res, 200, { ok: true, service: 'etw-bybit-relay', configured: SECRET.length >= 32 });
  if (!secretOk(req.headers['x-relay-secret'])) return send(res, 401, { error: 'unauthorized' });
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (!url.pathname.startsWith('/v5/') || url.pathname.includes('..')) return send(res, 404, { error: 'not found' });
  const base = TARGETS[String(req.headers['x-relay-target'] || 'mainnet')];
  if (!base) return send(res, 400, { error: 'unknown target' });

  const headers = { accept: 'application/json' };
  for (const k of FORWARD) if (req.headers[k]) headers[k] = String(req.headers[k]);
  try {
    const r = await fetch(base + url.pathname + url.search, { headers, signal: AbortSignal.timeout(20000) });
    const body = await r.text();
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' });
    res.end(body);
  } catch (e) {
    send(res, 502, { error: 'upstream failed', detail: e.message });
  }
}).listen(PORT, () => console.log('etw-bybit-relay on :' + PORT + (SECRET.length >= 32 ? '' : ' (RELAY_SECRET missing — refusing requests)')));
