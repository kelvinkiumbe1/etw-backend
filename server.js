// ETW multi-platform trade-sync backend.
//   MT5 / MT4 ....... POST /api/mt5-direct/connect   { login, password, server, platform, journalAccountId }
//                     POST /api/mt5-direct/disconnect { forget }
//   TradeLocker ..... POST /api/tradelocker/connect   { email, password, server, env, journalAccountId }
//                     POST /api/tradelocker/disconnect
//   DXtrade ......... POST /api/dxtrade/connect        { webUrl, username, password, domain, journalAccountId }
//                     POST /api/dxtrade/disconnect
//   cTrader ......... GET  /api/ctrader/auth           (returns { url } to open — OAuth)
//                     GET  /api/ctrader/callback       (Spotware redirect target)
//                     POST /api/ctrader/disconnect
// All POST/GET-auth routes require  Authorization: Bearer <Firebase idToken>
// (except the OAuth callback, which Spotware calls directly).
require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { admin, initFirebase } = require('./src/firebaseAdmin');
const store = require('./src/store');
const mt5 = require('./src/mt5sync');
const tradelocker = require('./src/connectors/tradelocker');
const dxtrade = require('./src/connectors/dxtrade');
const ctrader = require('./src/connectors/ctrader');
const gumroad = require('./src/gumroad');
const mt5ea = require('./src/connectors/mt5ea');
const email = require('./src/email');
const access = require('./src/access');

initFirebase();
const db = admin.firestore();
store.init(db);
mt5.init();
ctrader.init();

const app = express();
app.set('trust proxy', 1); // behind Render's proxy — needed for correct client IP in rate limiting
// CORS allowlist. `origin: true` reflected ANY origin, so a pirated frontend on
// someone else's domain could call this API straight from the browser. Server-side
// clients ignore CORS entirely — this only closes the browser-based copy — but
// that's the realistic piracy vector. Extra origins via CORS_ORIGINS (comma-sep).
const ALLOWED_ORIGINS = [
  'https://etwiz.space', 'https://www.etwiz.space',
  ...String(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
];
const isDevOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o || '');
app.use(cors({
  origin(origin, cb) {
    // No Origin header = same-origin, curl, the MT5 EA, or Gumroad's ping. Allow:
    // those paths are authenticated by token or sync key, not by origin.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || isDevOrigin(origin)) return cb(null, true);
    console.warn('[cors] blocked origin:', origin);
    return cb(null, false);
  },
}));
app.use('/api/ai/groq', express.json({ limit: '8mb' })); // AI vision payloads (base64 images) exceed 1mb
app.use('/api/ai/transcribe', express.json({ limit: '25mb' })); // base64 voice audio
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' })); // Gumroad pings are form-encoded

// Rate limiters (per-IP) — throttle auth/credential, unauthenticated, and proxy endpoints.
const rl = (windowMs, max, message) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });
const authLimiter   = rl(15 * 60 * 1000, 40, 'Too many attempts. Please wait a few minutes and try again.');
const eaLimiter     = rl(60 * 1000, 120, 'Too many requests, please slow down.');
const aiLimiter     = rl(60 * 1000, 20,  'Too many AI requests, please wait a moment.');
const marketLimiter = rl(60 * 1000, 60,  'Too many market-data requests, please wait.');
// Webhooks: every posted sale id costs a Firestore read + a Gumroad API call,
// so cap the rate — Gumroad's real traffic (sales + retries) sits far below this.
const webhookLimiter = rl(60 * 1000, 60, 'Too many requests.');

app.get('/', (_req, res) => res.json({
  ok: true,
  service: 'etw-sync-backend',
  version: 'ea-2',
  platforms: { mt5: true, mt4: true, mt5ea: true, tradelocker: true, dxtrade: true, ctrader: ctrader.configured() },
  email: email.configured(),
  eodhd: require('./src/eodhd').configured(),
  gumroad: gumroad.configured(),
  paymentProvider: 'gumroad',
  grantHours: true,   // admin grant accepts {hours} for short passes
  appCheck: String(process.env.APPCHECK_ENFORCE || '').toLowerCase() === 'true',
}));

async function requireAuth(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Missing Authorization: Bearer <idToken>' });
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    req.uid = decoded.uid;
    req.token = decoded;              // carries the subscription claim for the gates below
    next();
  }
  catch (e) { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ── App Check ──────────────────────────────────────────────
// Proves the caller is our real frontend, not a copy of it running elsewhere.
// OFF by default: turn on with APPCHECK_ENFORCE=true only AFTER the Firebase
// console shows verified requests arriving, or you lock out your own users.
// Firestore enforcement is a separate switch in the console — this covers the
// Render API, which App Check can't police on its own.
async function requireAppCheck(req, res, next) {
  if (String(process.env.APPCHECK_ENFORCE || '').toLowerCase() !== 'true') return next();
  const token = req.get('X-Firebase-AppCheck') || '';
  if (!token) return res.status(401).json({ error: 'App Check token required.', code: 'appcheck_missing' });
  try {
    await admin.appCheck().verifyToken(token);
    next();
  } catch (e) {
    console.warn('[appcheck] rejected:', e.message);
    res.status(401).json({ error: 'App Check verification failed.', code: 'appcheck_invalid' });
  }
}

// Applied to every /api route except the ones that physically cannot carry an
// App Check token: Gumroad's server-to-server ping, Spotware's OAuth redirect, the
// MT5 Expert Advisor's push (authenticated by its sync key) and the cron sweep
// (authenticated by CRON_SECRET).
const APPCHECK_EXEMPT = [
  /^\/api\/gumroad\/ping/,
  /^\/api\/ctrader\/callback/,
  /^\/api\/mt5\/trades/,
  /^\/api\/mt5-ea\/push/,
  /^\/api\/cron\//,
  // Admin routes carry their own stronger auth (admin uid or ADMIN_SECRET) and
  // must stay callable from a terminal, where no App Check token exists.
  /^\/api\/admin\//,
];
app.use(function (req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  if (APPCHECK_EXEMPT.some((re) => re.test(req.path))) return next();
  return requireAppCheck(req, res, next);
});

// ── Subscription gates ─────────────────────────────────────
// Chain AFTER requireAuth. These are what make a copied frontend worthless:
// the value lives behind these routes, and only a real claim opens them.
// 402 = "payment required" — the client turns that into the paywall.
async function requireSub(req, res, next) {
  try {
    const a = await access.accessFor(req.uid, req.token);
    if (!a.active) return res.status(402).json({ error: 'A subscription is required to use this feature.', code: 'subscription_required' });
    req.access = a; next();
  } catch (e) { console.error('requireSub:', e.message); res.status(500).json({ error: 'Access check failed.' }); }
}
async function requirePro(req, res, next) {
  try {
    const a = await access.accessFor(req.uid, req.token);
    if (!a.active) return res.status(402).json({ error: 'A subscription is required to use this feature.', code: 'subscription_required' });
    if (!access.isPro(a)) return res.status(402).json({ error: 'This feature is on the Pro plan.', code: 'pro_required', plan: a.plan || null });
    req.access = a; next();
  } catch (e) { console.error('requirePro:', e.message); res.status(500).json({ error: 'Access check failed.' }); }
}

// ── MT5 / MT4 ──────────────────────────────────────────────
app.post('/api/mt5-direct/connect', authLimiter, requireAuth, requireSub, async (req, res) => {
  const { login, password, server, platform, journalAccountId } = req.body || {};
  if (!login || !password || !server) return res.status(400).json({ error: 'login, password and server are required' });
  await mt5.setStatus(req.uid, { status: 'connecting', platform: platform || 'mt5', login: String(login), server, error: null });
  res.json({ ok: true, status: 'connecting' });
  mt5.startSync({ uid: req.uid, login: String(login), password, server, platform: platform || 'mt5', accountId: journalAccountId || '' })
    .catch(async (e) => { console.error('mt5 startSync:', e.message); await mt5.setStatus(req.uid, { status: 'error', error: mt5.friendlyError(e) }).catch(() => {}); });
});
app.post('/api/mt5-direct/disconnect', requireAuth, async (req, res) => {
  try { await mt5.stopSync(req.uid, { forget: !!(req.body && req.body.forget) }); } catch (e) { console.warn(e.message); }
  await mt5.setStatus(req.uid, { status: 'disconnected' }).catch(() => {});
  res.json({ ok: true });
});

// ── MT5 EA (FREE — no MetaApi) ─────────────────────────────
// register: Firebase-auth'd, mints a key for the active account.
app.post('/api/mt5-ea/register', authLimiter, requireAuth, requireSub, async (req, res) => {
  try {
    const key = await mt5ea.register(req.uid, (req.body && req.body.journalAccountId) || '');
    res.json({ ok: true, key });
  } catch (e) { console.error('ea register:', e.message); res.status(500).json({ error: e.message }); }
});
// push: called by the EA in MT5 (no Firebase — authed by the X-ETW-Key header).
async function eaPush(req, res) {
  const key = req.headers['x-etw-key'] || (req.body && req.body.key) || '';
  const trades = (req.body && req.body.trades) || [];
  try { const saved = await mt5ea.push(key, trades); res.json({ ok: true, saved }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}
app.post('/api/mt5/trades', eaLimiter, eaPush);   // matches the EA's default ServerURL path
app.post('/api/mt5-ea/push', eaLimiter, eaPush);

// ── TradeLocker ────────────────────────────────────────────
app.post('/api/tradelocker/connect', authLimiter, requireAuth, requireSub, async (req, res) => {
  const { email, password, server, env, journalAccountId } = req.body || {};
  if (!email || !password || !server) return res.status(400).json({ error: 'email, password and server are required' });
  await store.setStatus(req.uid, 'tradelocker', { status: 'connecting', server: env || 'demo', error: null });
  res.json({ ok: true, status: 'connecting' });
  tradelocker.startSync({ uid: req.uid, email, password, server, env: env === 'live' ? 'live' : 'demo', accountId: journalAccountId || '' })
    .catch(async (e) => { console.error('tradelocker:', e.message); await store.setStatus(req.uid, 'tradelocker', { status: 'error', error: tradelocker.friendlyError(e) }).catch(() => {}); });
});
app.post('/api/tradelocker/disconnect', requireAuth, async (req, res) => {
  try { await tradelocker.stopSync(req.uid); } catch (e) {}
  await store.setStatus(req.uid, 'tradelocker', { status: 'disconnected' }).catch(() => {});
  res.json({ ok: true });
});

// ── DXtrade ────────────────────────────────────────────────
app.post('/api/dxtrade/connect', authLimiter, requireAuth, requireSub, async (req, res) => {
  const { webUrl, username, password, domain, journalAccountId } = req.body || {};
  if (!webUrl || !username || !password) return res.status(400).json({ error: 'webUrl, username and password are required' });
  await store.setStatus(req.uid, 'dxtrade', { status: 'connecting', error: null });
  res.json({ ok: true, status: 'connecting' });
  dxtrade.startSync({ uid: req.uid, webUrl, username, password, domain, accountId: journalAccountId || '' })
    .catch(async (e) => { console.error('dxtrade:', e.message); await store.setStatus(req.uid, 'dxtrade', { status: 'error', error: dxtrade.friendlyError(e) }).catch(() => {}); });
});
app.post('/api/dxtrade/disconnect', requireAuth, async (req, res) => {
  try { await dxtrade.stopSync(req.uid); } catch (e) {}
  await store.setStatus(req.uid, 'dxtrade', { status: 'disconnected' }).catch(() => {});
  res.json({ ok: true });
});

// ── cTrader (OAuth) ────────────────────────────────────────
app.get('/api/ctrader/auth', authLimiter, requireAuth, requireSub, async (req, res) => {
  try { res.json({ ok: true, url: ctrader.createAuthUrl(req.uid, (req.query && req.query.journalAccountId) || '') }); }
  catch (e) { res.status(400).json({ error: ctrader.friendlyError(e) }); }
});
app.get('/api/ctrader/callback', async (req, res) => {
  const { code, state, error } = req.query || {};
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const close = (msg) => res.send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0b16;color:#e7ecff;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h3>' + esc(msg) + '</h3><p>You can close this window and return to ETW.</p><script>setTimeout(function(){window.close();},1500);</script></div></body>');
  if (error) return close('cTrader authorization was cancelled.');
  try { await ctrader.handleCallback(code, state); close('cTrader connected ✓'); }
  catch (e) { console.error('ctrader callback:', e.message); close('cTrader connect failed: ' + e.message); }
});
app.post('/api/ctrader/disconnect', requireAuth, async (req, res) => {
  try { await ctrader.disconnect(req.uid); } catch (e) {}
  res.json({ ok: true });
});

// ── AI proxy (Groq) ────────────────────────────────────────
// Keeps the Groq key server-side (was hardcoded in the client). Firebase-auth'd
// + rate-limited. Transparent pass-through of the OpenAI-style chat body.
app.post('/api/ai/groq', aiLimiter, requireAuth, requirePro, async (req, res) => {
  const key = process.env.GROQ_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'AI is not configured on the server.' });
  const body = req.body || {};
  if (!Array.isArray(body.messages) || !body.messages.length) return res.status(400).json({ error: 'messages[] is required' });
  const wantStream = body.stream === true;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: body.model || 'llama-3.3-70b-versatile',
        messages: body.messages,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
        max_tokens: Math.min(Number(body.max_tokens) || 1024, 8192),
        ...(body.response_format ? { response_format: body.response_format } : {}),
        ...(wantStream ? { stream: true } : {}),
      }),
    });

    // ── Streaming: pipe Groq's SSE straight through to the browser ──
    // no-transform + X-Accel-Buffering:no stop Render's proxy from buffering
    // the stream, which would defeat the whole point (tokens arriving late).
    if (wantStream) {
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return res.status(r.status).type('application/json').send(t || '{"error":"AI upstream error."}');
      }
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (res.flushHeaders) res.flushHeaders();
      const { Readable } = require('stream');
      const upstream = Readable.fromWeb(r.body);
      req.on('close', () => { try { upstream.destroy(); } catch (_) {} });   // client left mid-answer
      upstream.on('error', (e) => { console.warn('groq stream:', e.message); try { res.end(); } catch (_) {} });
      upstream.pipe(res);
      return;
    }

    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error('groq proxy:', e.message);
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    res.status(502).json({ error: 'AI upstream error.' });
  }
});

// ── Speech-to-text proxy (Groq Whisper) ────────────────────
// Accepts base64 audio from the browser (the in-browser Google speech service
// is blocked on some networks) and returns { text }. Reuses the Groq key.
app.post('/api/ai/transcribe', aiLimiter, requireAuth, requirePro, async (req, res) => {
  const key = process.env.GROQ_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'AI is not configured on the server.' });
  const b = req.body || {};
  if (!b.audio || typeof b.audio !== 'string') return res.status(400).json({ error: 'audio (base64) is required' });
  try {
    const buf = Buffer.from(b.audio, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'empty audio' });
    if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'audio too large' });
    const mime = (b.mime && /^audio\//.test(b.mime)) ? b.mime : 'audio/webm';
    const ext = mime.indexOf('mp4') >= 0 ? 'mp4' : mime.indexOf('ogg') >= 0 ? 'ogg' : mime.indexOf('wav') >= 0 ? 'wav' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), 'audio.' + ext);
    form.append('model', b.model || 'whisper-large-v3');   // full model = better accuracy than turbo
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('language', (b.language && /^[a-z]{2}$/i.test(b.language)) ? b.language.toLowerCase() : 'en');
    // Bias decoding toward trading terms so pairs/jargon transcribe correctly.
    form.append('prompt', typeof b.prompt === 'string' && b.prompt ? b.prompt.slice(0, 500)
      : 'Trading journal voice note. Symbols: XAUUSD gold, XAGUSD silver, EURUSD, GBPUSD, USDJPY, GBPJPY, AUDUSD, USDCAD, NAS100, US30, US100, SPX500, GER40, UK100, BTCUSD, ETHUSD. Terms: buy, sell, long, short, entry, exit, stop loss, take profit, lot, pips, profit, loss, breakeven, London, New York, Asian session.');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key }, // let fetch set the multipart boundary
      body: form,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: (data && data.error && (data.error.message || data.error)) || 'transcription upstream error' });
    res.json({ text: (data && data.text) || '' });
  } catch (e) { console.error('transcribe proxy:', e.message); res.status(502).json({ error: 'Transcription upstream error.' }); }
});

// ── Market-data proxy (Twelve Data) ────────────────────────
// Keeps the Twelve Data key server-side (was base64-obfuscated in the client).
// Public market data, so no Firebase auth — protected by rate limiting only.
//
// In-memory cache: replay/backtest requests are windowed around PAST trades,
// and historical candles never change — so a window fetched once can be served
// to every later viewer for free (0 Twelve Data credits). Only the still-forming
// most-recent window gets a short TTL. Bounded by entry count + a byte budget
// (LRU eviction) so it can't blow the dyno's memory. Cache resets on redeploy;
// that's fine — it simply re-warms from live requests.
const MKT_CACHE = new Map();                 // key -> { body, status, exp, bytes }
let   MKT_BYTES = 0, MKT_HITS = 0, MKT_MISS = 0;
const MKT_MAX_ENTRIES = 500;
const MKT_MAX_BYTES    = 80 * 1024 * 1024;   // ~80 MB budget
function mktGet(k) {
  const e = MKT_CACHE.get(k);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { MKT_CACHE.delete(k); MKT_BYTES -= e.bytes; return null; }
  MKT_CACHE.delete(k); MKT_CACHE.set(k, e);  // LRU touch (move to newest)
  return e;
}
function mktSet(k, body, status, ttlMs) {
  const bytes = Buffer.byteLength(body);
  if (bytes > MKT_MAX_BYTES) return;         // single item too big to ever fit
  const prev = MKT_CACHE.get(k);
  if (prev) { MKT_BYTES -= prev.bytes; MKT_CACHE.delete(k); }
  MKT_CACHE.set(k, { body, status, exp: ttlMs ? Date.now() + ttlMs : 0, bytes });
  MKT_BYTES += bytes;
  while ((MKT_CACHE.size > MKT_MAX_ENTRIES || MKT_BYTES > MKT_MAX_BYTES) && MKT_CACHE.size) {
    const oldest = MKT_CACHE.keys().next().value;   // oldest = first inserted
    const o = MKT_CACHE.get(oldest); MKT_CACHE.delete(oldest); MKT_BYTES -= o.bytes;
  }
}

// requireSub, not requirePro: this endpoint feeds BOTH Trade Replay (Pro) and
// Backtesting (Essential). Gating it at all is what stops the open internet —
// and a pirated frontend — from spending our Twelve Data credits.
app.get('/api/market/twelvedata', marketLimiter, requireAuth, requireSub, async (req, res) => {
  const key = process.env.TWELVE_DATA_KEY || '';
  if (!key) return res.status(503).json({ error: 'Market data is not configured on the server.' });
  const q = req.query || {};
  const p = new URLSearchParams();
  ['symbol', 'interval', 'outputsize', 'order', 'start_date', 'end_date'].forEach((k) => {
    if (q[k] != null && q[k] !== '') p.set(k, String(q[k]));
  });
  if (!p.get('symbol') || !p.get('interval')) return res.status(400).json({ error: 'symbol and interval are required' });

  // Cache key = the normalised query WITHOUT the apikey (added below).
  const cacheKey = p.toString();
  const hit = mktGet(cacheKey);
  if (hit) { MKT_HITS++; res.set('X-Cache', 'HIT'); return res.status(hit.status).type('application/json').send(hit.body); }
  MKT_MISS++;

  p.set('apikey', key);
  try {
    const r = await fetch('https://api.twelvedata.com/time_series?' + p.toString());
    const text = await r.text();
    // Only cache genuinely good payloads — never rate-limit (429) or error responses.
    let ok = r.ok;
    if (ok) { try { const j = JSON.parse(text); if (!j || j.status === 'error' || !Array.isArray(j.values) || !j.values.length) ok = false; } catch (_) { ok = false; } }
    if (ok) {
      // Immutable if the requested window ends in the past; else short TTL (last bar still forming).
      const endMs  = Date.parse(String(q.end_date || '').replace(' ', 'T') + 'Z');
      const isPast = isFinite(endMs) && endMs < Date.now() - 2 * 60 * 1000;
      mktSet(cacheKey, text, r.status, isPast ? 30 * 24 * 3600 * 1000 : 60 * 1000);
    }
    res.set('X-Cache', 'MISS');
    res.status(r.status).type('application/json').send(text);
  } catch (e) { console.error('twelvedata proxy:', e.message); res.status(502).json({ error: 'Market-data upstream error.' }); }
});

// Lightweight cache observability (no secrets exposed).
app.get('/api/market/cache-stats', (req, res) => {
  const total = MKT_HITS + MKT_MISS;
  res.json({
    entries: MKT_CACHE.size,
    approxBytes: MKT_BYTES,
    approxMB: +(MKT_BYTES / 1048576).toFixed(1),
    hits: MKT_HITS, misses: MKT_MISS,
    hitRate: total ? +(MKT_HITS / total).toFixed(3) : 0,
  });
});

// ── Broker-native candles from cTrader (trendbars) ─────────
// Returns the user's own broker candles so Trade Replay / Backtesting line up with
// their fills (vs Twelve Data/Binance which can differ for OTC forex/metals).
// Requires the caller to be signed in AND to have a connected cTrader account.
// Broker-native candles are only used by Trade Replay, which is a Pro feature —
// so this one can be Pro-gated without touching Backtesting.
// ── EODHD: real index data (Twelve Data carries no US indices) ─────────
// Same gate as the Twelve Data proxy so every subscriber gets it, rather than
// the Pro-only cTrader path.
app.get('/api/market/eodhd', marketLimiter, requireAuth, requireSub, async (req, res) => {
  const eodhd = require('./src/eodhd');
  if (!eodhd.configured()) return res.status(503).json({ error: 'EODHD is not configured on the server.' });
  const q = req.query || {};
  if (!q.symbol || !q.interval) return res.status(400).json({ error: 'symbol and interval are required' });
  // Refuse daily too when intraday is blocked: mixing EODHD's real index level
  // with the proxy's level inside one session would corrupt drawings and entries.
  if (eodhd.intradayBlocked()) return res.status(403).json({ error: 'EODHD plan is end-of-day only; charts need one consistent source.' });
  const from = Number(q.from) || 0, to = Number(q.to) || Date.now();
  const cacheKey = 'eod:' + q.symbol + ':' + q.interval + ':' + from + ':' + to;
  const hit = mktGet(cacheKey);
  if (hit) { MKT_HITS++; res.set('X-Cache', 'HIT'); return res.status(hit.status).type('application/json').send(hit.body); }
  MKT_MISS++;
  try {
    const out = await eodhd.getCandles({ symbol: q.symbol, interval: q.interval, from, to });
    const body = JSON.stringify(out);
    if (out.candles.length) {
      const isPast = to && to < Date.now() - 2 * 60 * 1000;
      mktSet(cacheKey, body, 200, isPast ? 30 * 24 * 3600 * 1000 : 60 * 1000);
    }
    res.set('X-Cache', 'MISS').type('application/json').send(body);
  } catch (e) {
    // Verbatim, so a wrong symbol or an out-of-plan interval is obvious.
    console.error('eodhd:', e.message);
    res.status(e.status || 502).json({ error: e.message });
  }
});

// Definitive check for one symbol: actually fetch candles and report what EODHD
// said. Search matches on name and is unreliable for index codes, and a plan
// without the .INDX entitlement fails only at fetch time — this distinguishes
// 'wrong symbol' from 'not in your plan' rather than leaving us to guess.
app.get('/api/market/eodhd-probe', authLimiter, requireAdmin, async (req, res) => {
  const eodhd = require('./src/eodhd');
  if (!eodhd.configured()) return res.status(503).json({ error: 'EODHD is not configured on the server.' });
  const q = req.query || {};
  const symbol = String(q.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'pass ?symbol=GSPC.INDX (&interval=1d)' });
  const interval = String(q.interval || '1d');
  const to = Date.now(), from = to - 30 * 24 * 3600 * 1000;
  try {
    const out = await eodhd.getCandles({ symbol, interval, from, to });
    const c = out.candles;
    res.json({
      ok: true, symbol, interval, count: c.length, meta: out.meta,
      first: c[0] || null, last: c[c.length - 1] || null,
    });
  } catch (e) {
    res.status(e.status || 502).json({ ok: false, symbol, interval, error: e.message });
  }
});

// Confirm an index/ticker code in one call instead of guessing at the mapping.
// Admin-gated: it is a symbol lookup used from a terminal, so the admin secret
// is a better fit than making someone extract a Firebase ID token from devtools.
app.get('/api/market/eodhd-search', authLimiter, requireAdmin, async (req, res) => {
  const eodhd = require('./src/eodhd');
  if (!eodhd.configured()) return res.status(503).json({ error: 'EODHD is not configured on the server.' });
  const q = String((req.query || {}).q || '').trim();
  if (!q) return res.status(400).json({ error: 'pass ?q=<name or code>' });
  try {
    const rows = await eodhd.search(q);
    res.json((Array.isArray(rows) ? rows : []).map((r) => ({
      code: r.Code, exchange: r.Exchange, name: r.Name, country: r.Country, type: r.Type,
      symbol: r.Code + '.' + r.Exchange,
    })));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get('/api/market/ctrader-bars', marketLimiter, requireAuth, requirePro, async (req, res) => {
  if (!ctrader.configured()) return res.status(503).json({ error: 'cTrader is not configured on the server.' });
  const q = req.query || {};
  if (!q.symbol || !q.tf) return res.status(400).json({ error: 'symbol and tf are required' });
  const from = Number(q.from) || 0, to = Number(q.to) || Date.now();
  const cacheKey = 'ctb:' + req.uid + ':' + (q.accountId || '') + ':' + q.symbol + ':' + q.tf + ':' + from + ':' + to;
  const hit = mktGet(cacheKey);
  if (hit) { MKT_HITS++; res.set('X-Cache', 'HIT'); return res.status(hit.status).type('application/json').send(hit.body); }
  MKT_MISS++;
  try {
    const bars = await ctrader.getBars(req.uid, { symbol: q.symbol, tf: q.tf, from, to, accountId: q.accountId || '' });
    const body = JSON.stringify({ candles: bars || [] });
    if (bars && bars.length) {
      const isPast = to && to < Date.now() - 2 * 60 * 1000;
      mktSet(cacheKey, body, 200, isPast ? 30 * 24 * 3600 * 1000 : 60 * 1000);
    }
    res.set('X-Cache', 'MISS'); res.type('application/json').send(body);
  } catch (e) { console.error('ctrader-bars:', e.message); res.status(502).json({ error: 'cTrader bars error: ' + e.message }); }
});

// ── New-device sign-in alert ───────────────────────────────
// The client pings this on login with its persistent deviceId. We keep a
// server-only record of known devices (users/{uid}/private/knownDevices) and
// email the account the first time a new device appears. The very first device
// (account creation) is recorded silently. Emails require BREVO_* env vars;
// without them this records devices but sends nothing.
function friendlyDevice(ua) {
  ua = String(ua || '');
  const br = /edg/i.test(ua) ? 'Edge'
    : /(chrome|crios)/i.test(ua) ? 'Chrome'
    : /(firefox|fxios)/i.test(ua) ? 'Firefox'
    : /safari/i.test(ua) ? 'Safari' : 'Browser';
  const os = /windows/i.test(ua) ? 'Windows'
    : /android/i.test(ua) ? 'Android'
    : /(iphone|ipad|ios)/i.test(ua) ? 'iOS'
    : /mac os/i.test(ua) ? 'macOS'
    : /linux/i.test(ua) ? 'Linux' : 'device';
  return br + ' on ' + os;
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
app.post('/api/auth/login-alert', authLimiter, requireAuth, async (req, res) => {
  res.json({ ok: true });   // respond immediately; do the work in the background
  try {
    const deviceId = (req.body && req.body.deviceId) || '';
    const userAgent = (req.body && req.body.userAgent) || '';
    if (!deviceId) return;
    const ref = admin.firestore().collection('users').doc(req.uid).collection('private').doc('knownDevices');
    const snap = await ref.get();
    const known = (snap.exists && snap.data()) || {};
    if (known[deviceId]) return;                       // already seen — no alert

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    let loc = '';
    try {
      const g = await (await fetch('https://ipwho.is/' + encodeURIComponent(ip))).json();
      if (g && g.success) loc = [g.city, g.country].filter(Boolean).join(', ');
    } catch (e) {}

    const firstEver = Object.keys(known).length === 0;
    await ref.set({ [deviceId]: { firstSeen: Date.now(), ua: String(userAgent).slice(0, 200), ip, loc } }, { merge: true });
    if (firstEver) return;                             // don't alert on the very first (signup) device

    const user = await admin.auth().getUser(req.uid).catch(() => null);
    if (!user || !user.email) return;
    await email.sendEmail({
      to: user.email,
      toName: user.displayName || '',
      subject: 'New sign-in to your ETW Journal account',
      html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:auto;color:#1a1a1a">
        <h2 style="margin:0 0 12px">New sign-in detected</h2>
        <p>Your ETW Journal account was just signed in on a new device:</p>
        <table style="border-collapse:collapse;margin:12px 0">
          <tr><td style="padding:4px 12px 4px 0;color:#666">Device</td><td style="padding:4px 0"><b>${escapeHtml(friendlyDevice(userAgent))}</b></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666">Location</td><td style="padding:4px 0"><b>${escapeHtml(loc || 'Unknown')}</b></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666">Time</td><td style="padding:4px 0"><b>${new Date().toUTCString()}</b></td></tr>
        </table>
        <p>If this was you, no action is needed.</p>
        <p><b>If this wasn't you</b>, reset your password immediately from the login page and review your account.</p>
        <p style="color:#999;font-size:12px;margin-top:20px">ETW Journal security</p>
      </div>`,
    });
  } catch (e) { console.error('login-alert:', e.message); }
});

// ── Branded auth emails via Brevo (path B) ─────────────────
// The Admin SDK generates the secure Firebase action link; Brevo sends a
// branded email carrying it — replacing Firebase's default sender that lands
// in spam. Continue URL must be a Firebase-authorized domain (APP_URL).
const APP_URL = process.env.APP_URL || 'https://etwiz.space';
const actionSettings = { url: APP_URL, handleCodeInApp: false };

function emailShell(title, bodyHtml, ctaText, ctaLink) {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:480px;margin:auto;color:#1a1a1a;padding:8px">
    <h2 style="margin:0 0 12px;color:#C8973A">${title}</h2>
    ${bodyHtml}
    <p style="margin:22px 0"><a href="${ctaLink}" style="background:#C8973A;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">${ctaText}</a></p>
    <p style="color:#666;font-size:12px">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all">${ctaLink}</span></p>
    <p style="color:#999;font-size:12px;margin-top:20px">ETW Journal</p>
  </div>`;
}

// Signed-in user requests their verification email.
app.post('/api/auth/send-verification', authLimiter, requireAuth, async (req, res) => {
  try {
    const user = await admin.auth().getUser(req.uid);
    if (!user.email) return res.status(400).json({ error: 'No email on this account' });
    if (user.emailVerified) return res.json({ ok: true, already: true });
    const link = await admin.auth().generateEmailVerificationLink(user.email, actionSettings);
    const sent = await email.sendEmail({
      to: user.email, toName: user.displayName || '',
      subject: 'Verify your ETW Journal email',
      html: emailShell('Verify your email',
        `<p>Welcome to ETW Journal${user.displayName ? ', ' + escapeHtml(user.displayName) : ''}! Confirm your email address to activate your account.</p>`,
        'Verify email', link),
    });
    if (!sent) return res.status(502).json({ error: 'Email send failed' });   // client falls back to Firebase
    res.json({ ok: true, sent: true });
  } catch (e) {
    console.error('send-verification:', e.message);
    res.status(500).json({ error: 'Could not send verification email' });
  }
});

// Unauthenticated password-reset request. Always returns ok (no account
// enumeration); only actually sends when the account exists.
app.post('/api/auth/send-reset', authLimiter, async (req, res) => {
  const addr = String((req.body && req.body.email) || '').trim();
  if (!addr) return res.status(400).json({ error: 'email required' });
  try {
    const link = await admin.auth().generatePasswordResetLink(addr, actionSettings);
    await email.sendEmail({
      to: addr,
      subject: 'Reset your ETW Journal password',
      html: emailShell('Reset your password',
        `<p>We received a request to reset your ETW Journal password. Click below to choose a new one. This link expires shortly.</p><p>If you didn't request this, you can safely ignore this email.</p>`,
        'Reset password', link),
    });
  } catch (e) {
    if (!/user-not-found|no user record|EMAIL_NOT_FOUND/i.test(e.message || '')) console.error('send-reset:', e.message);
  }
  res.json({ ok: true });
});

// ── Email 2FA (new/untrusted-device only) ──────────────────
// Opt-in via users/{uid}.mfaEnabled. On login from a device not in the user's
// trusted list, a 6-digit code is emailed (Brevo) and must be verified before
// the app proceeds. Codes are stored hashed + expiring, with attempt lockout,
// in users/{uid}/private/mfa (server-only). Client-side gate for v1.
const MFA_CODE_TTL = 10 * 60 * 1000;         // 10 minutes
const MFA_TRUST_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const mfaLimiter = rl(10 * 60 * 1000, 15, 'Too many 2FA attempts. Please wait a few minutes.');
function hashCode(code, uid) { return crypto.createHash('sha256').update(String(code) + '|' + uid).digest('hex'); }
function mfaRef(uid) { return admin.firestore().collection('users').doc(uid).collection('private').doc('mfa'); }
function codeEmailHtml(code) {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:440px;margin:auto;color:#1a1a1a;padding:8px">
    <h2 style="margin:0 0 8px;color:#C8973A">Your sign-in code</h2>
    <p>Use this code to finish signing in to ETW Journal on your new device:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f4f4f6;border-radius:10px;padding:16px;text-align:center;margin:16px 0">${escapeHtml(code)}</div>
    <p style="color:#666;font-size:13px">This code expires in 10 minutes. If you didn't try to sign in, someone may have your password — reset it immediately.</p>
    <p style="color:#999;font-size:12px;margin-top:16px">ETW Journal security</p>
  </div>`;
}

// Decide whether this login needs a code; if so, generate + email it.
app.post('/api/mfa/gate', mfaLimiter, requireAuth, async (req, res) => {
  try {
    const deviceId = String((req.body && req.body.deviceId) || '');
    const udoc = await admin.firestore().collection('users').doc(req.uid).get();
    if (!(udoc.exists && udoc.data().mfaEnabled === true)) return res.json({ required: false });
    const snap = await mfaRef(req.uid).get();
    const data = (snap.exists && snap.data()) || {};
    const trusted = data.trusted || {};
    if (deviceId && trusted[deviceId] && trusted[deviceId] > Date.now()) return res.json({ required: false });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await mfaRef(req.uid).set({ pending: { hash: hashCode(code, req.uid), exp: Date.now() + MFA_CODE_TTL, attempts: 0, deviceId } }, { merge: true });
    const user = await admin.auth().getUser(req.uid).catch(() => null);
    if (user && user.email) {
      const sent = await email.sendEmail({ to: user.email, toName: user.displayName || '', subject: 'Your ETW Journal sign-in code', html: codeEmailHtml(code) });
      if (!sent) return res.status(502).json({ required: true, sent: false, error: 'Could not send code email' });
    }
    res.json({ required: true, sent: true });
  } catch (e) { console.error('mfa gate:', e.message); res.status(500).json({ error: 'MFA error' }); }
});

// Verify a submitted code; optionally trust the device for 30 days.
app.post('/api/mfa/verify', mfaLimiter, requireAuth, async (req, res) => {
  try {
    const deviceId = String((req.body && req.body.deviceId) || '');
    const code = String((req.body && req.body.code) || '');
    const snap = await mfaRef(req.uid).get();
    const data = (snap.exists && snap.data()) || {};
    const p = data.pending;
    if (!p) return res.status(400).json({ ok: false, error: 'No code pending — request a new one.' });
    if (Date.now() > p.exp) { await mfaRef(req.uid).set({ pending: null }, { merge: true }); return res.status(400).json({ ok: false, error: 'Code expired — request a new one.' }); }
    if ((p.attempts || 0) >= 5) { await mfaRef(req.uid).set({ pending: null }, { merge: true }); return res.status(429).json({ ok: false, error: 'Too many attempts — request a new code.' }); }
    if (hashCode(code, req.uid) !== p.hash) {
      await mfaRef(req.uid).set({ pending: { ...p, attempts: (p.attempts || 0) + 1 } }, { merge: true });
      return res.status(401).json({ ok: false, error: 'Incorrect code.' });
    }
    const patch = { pending: null };
    if (req.body && req.body.trust && deviceId) { const trusted = data.trusted || {}; trusted[deviceId] = Date.now() + MFA_TRUST_TTL; patch.trusted = trusted; }
    await mfaRef(req.uid).set(patch, { merge: true });
    res.json({ ok: true });
  } catch (e) { console.error('mfa verify:', e.message); res.status(500).json({ ok: false, error: 'MFA error' }); }
});

// ══════════════════════════════════════════════════════════════
//  SUBSCRIPTIONS (Gumroad)  —  server-side verify + grant only
// ══════════════════════════════════════════════════════════════
// Pricing lives on the Gumroad membership products, not here. The server only
// needs to know how long a paid cycle lasts: 31/366 (not 30/365) so Gumroad's
// next recurring charge lands before the previous grant expires — access never
// flickers off the morning a renewal is due.
const PLAN_DAYS = { monthly: 31, quarterly: 92, yearly: 366 };

// Free-forever comp accounts — always full access, never charged.
// Defined once in src/access.js so the gates and the grant path agree.
const isComp = access.isComp;

// The ONE place access is granted: sets the custom claim (source of truth for
// Firestore rules + the frontend) and mirrors it to users/{uid}.subscription.
// keepExpiresAt preserves an existing period (used by mid-cycle upgrades).
async function grantSubscription(uid, plan, cycle, extra = {}, keepExpiresAt = 0) {
  const days = PLAN_DAYS[cycle] || 31;
  const expiresAt = Number(keepExpiresAt) > Date.now()
    ? Number(keepExpiresAt)
    : Date.now() + days * 24 * 60 * 60 * 1000;
  const user = await admin.auth().getUser(uid);
  const claims = Object.assign({}, user.customClaims || {}, { subscribed: true, plan, expiresAt });
  await admin.auth().setCustomUserClaims(uid, claims);

  // startedAt = when this subscriber first paid. Preserved across renewals and
  // upgrades so the Settings card can show a real "Subscribed on" date instead
  // of the most recent charge.
  let startedAt = Date.now();
  try {
    const prev = await db.collection('users').doc(uid).get();
    const prevStart = prev.exists && prev.data().subscription && prev.data().subscription.startedAt;
    if (prevStart) startedAt = Number(prevStart);
  } catch (e) { /* first-time subscriber, or read failed — today is correct enough */ }

  await db.collection('users').doc(uid).set(
    { subscription: { plan, cycle, status: 'active', expiresAt, startedAt, updatedAt: Date.now(), ...extra } },
    { merge: true }
  );
  return expiresAt;
}

// The inverse, for refunds and chargebacks: strips the claim and marks the
// mirror doc. Access dies at the user's next token refresh — under an hour.
async function revokeSubscription(uid, extra = {}) {
  const user = await admin.auth().getUser(uid);
  const claims = Object.assign({}, user.customClaims || {});
  delete claims.subscribed; delete claims.plan; delete claims.expiresAt;
  await admin.auth().setCustomUserClaims(uid, claims);
  await db.collection('users').doc(uid).set(
    { subscription: { status: 'revoked', revokedAt: Date.now(), ...extra } },
    { merge: true }
  );
  syncBrevoContact(uid, { force: true }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
//  BREVO AUDIENCE SYNC + SUBSCRIPTION LIFECYCLE EMAILS
// ══════════════════════════════════════════════════════════════
const DAY_MS = 24 * 60 * 60 * 1000;
const ymd = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : '');

// Mirror the user into Brevo with their live plan data, so campaigns can segment
// on it ("all Essential users expiring this week") instead of a stale import.
// Deduped by an attribute signature: this gets called on ordinary app loads, and
// re-POSTing unchanged contacts would burn API quota for nothing.
const BREVO_SYNC_TTL = 7 * DAY_MS;
async function syncBrevoContact(uid, opts) {
  const force = !!(opts && opts.force);
  if (!email.configured()) return false;
  // Contacts exist purely to power campaigns/segments. Transactional email (the
  // receipt and expiry notices below) needs none of this, so the whole sync stays
  // OFF until a BREVO_LIST_ID is configured.
  if (!email.listIdsFromEnv().length) return false;
  try {
    const user = await admin.auth().getUser(uid);
    if (!user.email) return false;
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    const d = snap.exists ? snap.data() : {};
    const sub = d.subscription || {};
    const a = await access.accessFor(uid, null);
    const name = String(user.displayName || '').trim();

    const attributes = {
      FIRSTNAME: name.split(' ')[0] || '',
      LASTNAME: name.split(' ').slice(1).join(' '),
      PLAN: a.active ? (a.plan || 'essential') : 'none',
      STATUS: a.active ? 'active' : 'inactive',
      CYCLE: sub.cycle || '',
      EXPIRES_AT: ymd(a.expiresAt || sub.expiresAt),
      SUBSCRIBED_ON: ymd(sub.startedAt),
      COMP: !!sub.comp,
    };
    const sig = JSON.stringify(attributes);
    const last = d.brevo || {};
    if (!force && last.sig === sig && Date.now() - Number(last.at || 0) < BREVO_SYNC_TTL) return false;

    const ok = await email.upsertContact({ email: user.email, attributes });
    if (ok) await ref.set({ brevo: { sig, at: Date.now() } }, { merge: true });
    return ok;
  } catch (e) {
    console.warn('brevo sync:', e.message);
    return false;
  }
}

const money = (amount, currency) => (currency || 'KES') + ' ' + Number(amount || 0).toLocaleString('en-KE');
const nice = (ms) => (ms ? new Date(Number(ms)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

// Receipt after a settled payment. Fire-and-forget: a failed email must never
// break the payment path — the subscription is already granted at this point.
async function sendReceiptEmail(uid, order, expiresAt) {
  try {
    const user = await admin.auth().getUser(uid);
    if (!user.email) return;
    const isUpgrade = order.kind === 'upgrade';
    const planName = (order.plan === 'pro' ? 'Pro' : 'Essential');
    const body = isUpgrade
      ? `<p>You're on <b>Pro</b> — Mentor mode, ETW AI and Trade Replay are unlocked right now.</p>
         <p>You paid only the difference (<b>${money(order.amount, order.currency)}</b>), and your end date is unchanged: <b>${nice(expiresAt)}</b>.</p>`
      : `<p>Thanks — your payment of <b>${money(order.amount, order.currency)}</b> went through and your <b>${planName}</b> plan is active.</p>
         <table style="border-collapse:collapse;margin:14px 0;font-size:14px">
           <tr><td style="padding:4px 14px 4px 0;color:#666">Plan</td><td><b>${planName}</b> (${['yearly','quarterly','monthly'].indexOf(order.cycle) >= 0 ? order.cycle : 'monthly'})</td></tr>
           <tr><td style="padding:4px 14px 4px 0;color:#666">Amount</td><td>${money(order.amount, order.currency)}</td></tr>
           <tr><td style="padding:4px 14px 4px 0;color:#666">Access until</td><td>${nice(expiresAt)}</td></tr>
           <tr><td style="padding:4px 14px 4px 0;color:#666">Auto-renew</td><td>Yes — manage or cancel any time from your Gumroad receipt</td></tr>
         </table>`;
    await email.sendEmail({
      to: user.email, toName: user.displayName || '',
      subject: isUpgrade ? "You're on ETW Journal Pro" : 'Payment received — ETW Journal ' + planName,
      html: emailShell(isUpgrade ? 'Welcome to Pro' : 'Payment received', body, 'Open your journal', APP_URL + '/journal.html'),
    });
  } catch (e) { console.warn('receipt email:', e.message); }
}

// Mark a lapsed subscription expired and email the owner — exactly once. The
// status flip IS the dedupe, so this is safe to call from anywhere (the daily
// sweep, or lazily when the user next opens the app).
async function notifyExpired(uid, ref, sub) {
  if (!sub || sub.comp || sub.status !== 'active') return false;
  if (!Number(sub.expiresAt) || Number(sub.expiresAt) >= Date.now()) return false;
  await ref.set({ subscription: { status: 'expired', expiredAt: Date.now() } }, { merge: true });
  try {
    const user = await admin.auth().getUser(uid);
    if (user.email) {
      await email.sendEmail({
        to: user.email, toName: user.displayName || '',
        subject: 'Your ETW Journal subscription has ended',
        html: emailShell('Your subscription has ended',
          `<p>Your <b>${sub.plan === 'pro' ? 'Pro' : 'Essential'}</b> plan ended on <b>${nice(sub.expiresAt)}</b>, so journalling, broker sync and analytics are locked for now.</p>
           <p><b>Nothing has been deleted.</b> Every trade, note and playbook is exactly where you left it and comes straight back the moment you resubscribe.</p>`,
          'Reactivate my plan', APP_URL + '/payment.html'),
      });
    }
  } catch (e) { console.warn('expiry email ' + uid + ':', e.message); }
  syncBrevoContact(uid, { force: true }).catch(() => {});   // no-op unless a list is configured
  return true;
}

// Daily sweep: warn before a plan lapses, and confirm once it has. Render's free
// tier has no scheduler, so this is an endpoint for an external cron (cron-job.org,
// GitHub Actions, UptimeRobot) to hit once a day. Guarded by CRON_SECRET — with no
// secret set it refuses to run rather than sitting open.
const REMIND_DAYS = 3;
async function sweepSubscriptions() {
  const now = Date.now();
  const out = { warned: 0, expired: 0, skipped: 0 };

  // Expiring within the window. Two range filters on ONE field, so the automatic
  // single-field index covers it — no composite index to create.
  const soon = await db.collection('users')
    .where('subscription.expiresAt', '>=', now)
    .where('subscription.expiresAt', '<=', now + REMIND_DAYS * DAY_MS)
    .limit(300).get();

  for (const doc of soon.docs) {
    const sub = doc.data().subscription || {};
    if (sub.comp || sub.status !== 'active') { out.skipped++; continue; }
    if (Number(sub.remindedFor || 0) === Number(sub.expiresAt)) { out.skipped++; continue; }  // once per period
    try {
      const user = await admin.auth().getUser(doc.id);
      if (!user.email) { out.skipped++; continue; }
      const left = Math.max(1, Math.ceil((Number(sub.expiresAt) - now) / DAY_MS));
      await email.sendEmail({
        to: user.email, toName: user.displayName || '',
        subject: 'Your ETW Journal plan ends in ' + left + ' day' + (left === 1 ? '' : 's'),
        html: emailShell('Your plan is about to end',
          `<p>Your <b>${sub.plan === 'pro' ? 'Pro' : 'Essential'}</b> plan ends on <b>${nice(sub.expiresAt)}</b> — that's ${left} day${left === 1 ? '' : 's'} away.</p>
           <p>Nothing renews automatically, so pay again before then to keep going. Your trades stay exactly where they are either way; they just become read-only until you're back.</p>`,
          'Pay for another period', APP_URL + '/payment.html'),
      });
      await doc.ref.set({ subscription: { remindedFor: Number(sub.expiresAt) } }, { merge: true });
      out.warned++;
    } catch (e) { console.warn('sweep warn ' + doc.id + ':', e.message); }
  }

  // Recently lapsed. Bounded to the last 14 days so this never re-scans years of
  // old records.
  const gone = await db.collection('users')
    .where('subscription.expiresAt', '>=', now - 14 * DAY_MS)
    .where('subscription.expiresAt', '<', now)
    .limit(300).get();

  for (const doc of gone.docs) {
    try {
      if (await notifyExpired(doc.id, doc.ref, doc.data().subscription || {})) out.expired++;
      else out.skipped++;
    } catch (e) { console.warn('sweep expire ' + doc.id + ':', e.message); }
  }
  return out;
}

app.all('/api/cron/subscriptions', authLimiter, async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not set on the server.' });
  const given = req.get('X-Cron-Key') || (req.query && req.query.key) || '';
  if (given !== secret) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await sweepSubscriptions();
    // Also heal any Gumroad sales whose ping never landed. Failure here must
    // not fail the sweep — the two jobs are independent.
    let gumroadSweep = null;
    try { gumroadSweep = await reconcileGumroadSales(3); }
    catch (e) { gumroadSweep = { error: e.message }; }
    res.json({ ok: true, ...r, gumroad: gumroadSweep });
  } catch (e) {
    console.error('cron/subscriptions:', e.message);
    res.status(500).json({ error: 'sweep failed' });
  }
});

// Verify a Gumroad sale and grant. Idempotent by sale id: Gumroad retries pings
// it thinks failed, and every recurring membership charge arrives as a NEW sale
// id — so a GRANTED doc means "this exact charge is handled", while renewals
// still land as fresh grants that push expiresAt forward.
async function settleGumroadSale(saleId, ping) {
  const ref = db.collection('gumroadSales').doc(saleId);
  const seen = await ref.get();
  const granted = seen.exists && seen.data().status === 'GRANTED' ? seen.data() : null;

  // The ping is unauthenticated, so nothing in it is trusted. Re-fetching the
  // sale under OUR access token is the authenticity check — a forged sale id
  // dies here — and the verified copy decides plan, cycle and amount.
  const sale = await gumroad.getSale(saleId);
  const refunded = !!(sale.refunded || sale.chargedback);

  if (granted && !refunded) return { ok: true, already: true };

  // ── Auto-revoke: a sale we granted has since been refunded/charged back ──
  // Only pull access when THIS sale is the one backing the CURRENT period —
  // refunding an old charge must not kill a period paid for by a newer one.
  if (granted && refunded) {
    const kind = sale.chargedback ? 'chargeback' : 'refund';
    const snap = await db.collection('users').doc(granted.uid).get();
    const sub = (snap.exists && snap.data().subscription) || {};
    const backsAccess = sub.saleId === saleId && sub.status === 'active';
    if (backsAccess) {
      await revokeSubscription(granted.uid, { reason: kind, saleId });
      console.log('[gumroad] revoked access for', granted.uid, 'after', kind, 'of sale', saleId);
    }
    await ref.set({ status: 'REFUNDED', reason: kind, refundedAt: Date.now(), revoked: backsAccess }, { merge: true });
    return { ok: true, revoked: backsAccess };
  }

  if (refunded) {
    await ref.set({ status: 'IGNORED', reason: sale.refunded ? 'refunded' : 'chargedback', at: Date.now() }, { merge: true });
    return { ok: false, reason: 'refunded' };
  }
  const matched = gumroad.matchSale(sale);
  if (!matched) {
    await ref.set({ status: 'IGNORED', reason: 'unknown product', productId: sale.product_id || null, at: Date.now() }, { merge: true });
    return { ok: false, reason: 'not an ETW product' };
  }
  const { plan, cycle } = matched;

  // Who is this for? payment.html stamps the buyer's Firebase uid onto the
  // checkout URL and Gumroad echoes it back in url_params. Fall back to matching
  // the purchase email, for anyone who bought from the Gumroad page directly.
  let uid = null;
  const rawUid = String((ping && ping.url_params && ping.url_params.uid) || '').trim();
  if (/^[A-Za-z0-9]{10,128}$/.test(rawUid)) {
    try { uid = (await admin.auth().getUser(rawUid)).uid; } catch (e) { /* stale uid — try email */ }
  }
  if (!uid && sale.email) {
    try { uid = (await admin.auth().getUserByEmail(String(sale.email).trim())).uid; } catch (e) { /* no account under that email */ }
  }
  if (!uid) {
    // Real money, no matching account. Keep the sale so support can attach it by
    // hand (/api/admin/grant), instead of the payment silently vanishing.
    await ref.set({ status: 'UNMATCHED', email: sale.email || null, plan, cycle, at: Date.now() }, { merge: true });
    console.warn('[gumroad] paid sale with no matching account:', saleId, sale.email || '(no email)');
    return { ok: false, reason: 'no matching account' };
  }

  // Gumroad has returned price both as cents (500) and as a formatted string
  // ("$5"); the amount is only used on the receipt, so parse forgivingly.
  const rawPrice = String(sale.price == null ? '' : sale.price);
  const priceNum = Number(rawPrice.replace(/[^0-9.]/g, '')) || 0;
  const amount = rawPrice.includes('$') ? priceNum : priceNum / 100;
  const currency = String(sale.currency || 'USD').toUpperCase();

  const expiresAt = await grantSubscription(uid, plan, cycle, {
    provider: 'gumroad', saleId, subscriptionId: sale.subscription_id || null,
  });
  await ref.set({
    status: 'GRANTED', uid, plan, cycle, expiresAt, at: Date.now(),
    email: sale.email || null, subscriptionId: sale.subscription_id || null,
    recurring: !!(ping && String(ping.is_recurring_charge) === 'true'),
    amount, currency,
  }, { merge: true });

  // Receipt + audience sync are fire-and-forget: access is already granted, and
  // a Brevo hiccup must never turn a successful payment into an error.
  sendReceiptEmail(uid, { plan, cycle, kind: 'new', amount, currency }, expiresAt).catch(() => {});
  syncBrevoContact(uid, { force: true }).catch(() => {});
  return { ok: true, uid, plan, cycle, expiresAt };
}

// Reconciliation: heal missed pings. A sale that lands while Render is down
// (deploy, outage) never gets granted once Gumroad's retries run out — this
// sweep re-settles any recent, unrefunded sale of our products that has no
// GRANTED record. Runs once at boot and from the daily cron. Idempotent:
// settleGumroadSale re-verifies every sale and skips ones already granted.
async function reconcileGumroadSales(days = 3) {
  if (!gumroad.configured()) return { checked: 0, healed: 0 };
  const sales = await gumroad.recentSales(days);
  let checked = 0, healed = 0;
  for (const s of sales) {
    const saleId = String(s.id || s.sale_id || '');
    if (!saleId || !gumroad.matchSale(s)) continue;    // not one of our products
    if (s.refunded || s.chargedback) continue;         // refund path handles these
    checked++;
    const seen = await db.collection('gumroadSales').doc(saleId).get();
    if (seen.exists && seen.data().status === 'GRANTED') continue;
    try {
      // The API sale object doubles as the "ping": it carries url_params/email
      // for uid resolution, and settle re-fetches + verifies by id anyway.
      const r = await settleGumroadSale(saleId, s);
      if (r.ok && !r.already) { healed++; console.log('[gumroad] reconciled missed sale', saleId); }
    } catch (e) { console.warn('[gumroad] reconcile', saleId + ':', e.message); }
  }
  return { checked, healed };
}

// ══════════════════════════════════════════════════════════════
//  ADMIN: grant / revoke access without a payment
// ══════════════════════════════════════════════════════════════
// For trials, influencers, goodwill after a support issue, and refunds. Unlike
// COMP_EMAILS these grants EXPIRE on their own and can be revoked, which is why
// comp should stay reserved for your own accounts.
//
// Two ways to authenticate, so this works from the app AND from a terminal:
//   * a Firebase token whose uid exists in the `admins` collection, or
//   * header  X-Admin-Secret: <ADMIN_SECRET>
async function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET || '';
  if (secret && req.get('X-Admin-Secret') === secret) { req.adminBy = 'secret'; return next(); }
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Admin auth required.' });
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    const isAdmin = (await db.collection('admins').doc(decoded.uid).get()).exists;
    if (!isAdmin) return res.status(403).json({ error: 'Not an admin.' });
    req.uid = decoded.uid; req.adminBy = decoded.email || decoded.uid;
    next();
  } catch (e) { res.status(401).json({ error: 'Invalid token.' }); }
}

// Accept either an email or a uid, so support can act on what they actually have.
async function resolveTarget(body) {
  const emailAddr = String((body && body.email) || '').trim();
  const uid = String((body && body.uid) || '').trim();
  if (!uid && !emailAddr) { const e = new Error('email or uid is required'); e.status = 400; throw e; }
  try {
    return uid ? await admin.auth().getUser(uid) : await admin.auth().getUserByEmail(emailAddr);
  } catch (err) {
    // Firebase's "no user record" surfaced as a bare 500, which reads like a
    // server fault rather than "this person hasn't signed up yet".
    if (String(err.code || '') === 'auth/user-not-found' || /no user record/i.test(err.message || '')) {
      const e = new Error('No ETW account exists for ' + (emailAddr || uid) + ' — they need to sign up first, then run this again.');
      e.status = 404; e.code = 'user_not_found'; throw e;
    }
    throw err;
  }
}

app.post('/api/admin/grant', authLimiter, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const plan = String(b.plan || 'pro').toLowerCase();
    if (plan !== 'pro' && plan !== 'essential') return res.status(400).json({ error: "plan must be 'pro' or 'essential'" });
    // Duration: whole days (default 30), or hours for short passes ({hours: 2}).
    const hours = parseFloat(b.hours);
    const durMs = (isFinite(hours) && hours > 0)
      ? Math.min(3650 * 24, hours) * 3600 * 1000
      : Math.max(1, Math.min(3650, parseInt(b.days, 10) || 30)) * DAY_MS;
    const days = Math.round(durMs / DAY_MS * 100) / 100;   // for logs/response
    const user = await resolveTarget(b);

    // keepExpiresAt doubles as an explicit expiry override, so an admin grant is
    // an ordinary subscription with a custom end date — nothing special to
    // special-case anywhere else.
    const expiresAt = Date.now() + durMs;
    const cycle = days > 200 ? 'yearly' : 'monthly';
    await grantSubscription(user.uid, plan, cycle, {
      source: 'admin', grantedBy: req.adminBy || 'admin', grantedAt: Date.now(),
      note: String(b.note || '').slice(0, 300), paid: false,
    }, expiresAt);

    syncBrevoContact(user.uid, { force: true }).catch(() => {});
    // Awaited, and the outcome goes back in the response: a silent fire-and-forget
    // send made a rejected email look identical to a delivered one.
    let notified = null, notifyError = null;
    if (b.notify !== false && user.email) {
      const sent = await email.sendEmailVerbose({
        to: user.email, toName: user.displayName || '',
        subject: 'Your ETW Journal access is active',
        html: emailShell('You’re in',
          `<p>Your <b>${plan === 'pro' ? 'Pro' : 'Essential'}</b> access to ETW Journal is active until <b>${nice(expiresAt)}</b>.</p>
           <p>Nothing to pay — just sign in and start journalling.</p>`,
          'Open ETW Journal', APP_URL + '/journal.html'),
      }).catch((e) => ({ ok: false, reason: 'threw', body: e.message }));
      notified = !!sent.ok;
      if (!sent.ok) notifyError = [sent.reason, sent.status, sent.body].filter(Boolean).join(' ');
    } else if (!user.email) {
      notifyError = 'account has no email address';
    }
    console.log('[admin] granted', plan, days + 'd to', user.email || user.uid, 'by', req.adminBy);
    res.json({ ok: true, uid: user.uid, email: user.email || null, plan, days, expiresAt, expiresOn: ymd(expiresAt), notified, notifyError });
  } catch (e) {
    console.error('admin/grant:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'grant failed' });
  }
});

// Send a test email and hand back exactly what Brevo said. Turns "why aren't
// emails arriving?" into one command instead of digging through Render logs.
app.post('/api/admin/email-test', authLimiter, requireAdmin, async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!to) return res.status(400).json({ error: 'pass {"to":"someone@example.com"}' });
  const r = await email.sendEmailVerbose({
    to, toName: 'ETW test',
    subject: 'ETW Journal — email delivery test',
    html: emailShell('Delivery test',
      '<p>If you can read this, transactional email from the ETW backend is working.</p>',
      'Open ETW Journal', APP_URL + '/journal.html'),
  });
  res.status(r.ok ? 200 : 502).json({
    configured: email.configured(),
    sender: process.env.BREVO_SENDER || null,
    senderName: process.env.BREVO_SENDER_NAME || 'ETW Journal',
    to, ...r,
  });
});

app.post('/api/admin/revoke', authLimiter, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const user = await resolveTarget(b);
    const claims = Object.assign({}, user.customClaims || {});
    delete claims.subscribed; delete claims.plan; delete claims.expiresAt;
    await admin.auth().setCustomUserClaims(user.uid, claims);
    // Kills the refresh token as well, otherwise the cached ID token keeps its
    // old claim until it expires (up to an hour).
    await admin.auth().revokeRefreshTokens(user.uid);
    await db.collection('users').doc(user.uid).set(
      { subscription: { status: 'revoked', revokedAt: Date.now(), revokedBy: req.adminBy || 'admin' } },
      { merge: true }
    );
    syncBrevoContact(user.uid, { force: true }).catch(() => {});

    // Silent by default: revocations follow refunds, chargebacks and abuse, where
    // announcing it is rarely wanted. Opt in with notify:true, and pass a reason
    // to have it shown to them.
    let notified = null, notifyError = null;
    if (b.notify === true && user.email) {
      const reason = String(b.reason || '').slice(0, 300);
      const sent = await email.sendEmailVerbose({
        to: user.email, toName: user.displayName || '',
        subject: 'Your ETW Journal access has ended',
        html: emailShell('Your access has ended',
          `<p>Your ETW Journal subscription has been closed, so journalling, broker sync and analytics are locked.</p>`
          + (reason ? `<p><b>Reason:</b> ${escapeHtml(reason)}</p>` : '')
          + `<p><b>Nothing has been deleted.</b> Every trade, note and playbook is exactly where you left it and comes straight back if you subscribe again.</p>`,
          'View plans', APP_URL + '/payment.html'),
      }).catch((e) => ({ ok: false, reason: 'threw', body: e.message }));
      notified = !!sent.ok;
      if (!sent.ok) notifyError = [sent.reason, sent.status, sent.body].filter(Boolean).join(' ');
    }
    console.log('[admin] revoked', user.email || user.uid, 'by', req.adminBy, b.notify === true ? '(notified)' : '(silent)');
    res.json({
      ok: true, uid: user.uid, email: user.email || null,
      // Revoking a comp address achieves nothing: /api/subscribe/me re-grants it
      // on their next app load. Say so instead of reporting a hollow success.
      warning: access.isComp(user.email) ? 'This email is in COMP_EMAILS — it will be re-granted on next sign-in. Remove it there first.' : undefined,
      notified, notifyError,
    });
  } catch (e) {
    console.error('admin/revoke:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'revoke failed' });
  }
});

// Diagnostic: is Gumroad fully wired? Config flags plus the refund/dispute
// resource subscriptions actually registered on Gumroad's side.
app.get('/api/admin/gumroad-probe', authLimiter, requireAdmin, async (req, res) => {
  const out = {
    configured: gumroad.configured(),
    tokenSet: !!process.env.GUMROAD_ACCESS_TOKEN,
    products: {
      essential: !!process.env.GUMROAD_PRODUCT_ESSENTIAL,
      pro: !!process.env.GUMROAD_PRODUCT_PRO,
      essentialYearly: !!process.env.GUMROAD_PRODUCT_ESSENTIAL_YEARLY,
      proYearly: !!process.env.GUMROAD_PRODUCT_PRO_YEARLY,
    },
  };
  if (!out.configured) return res.status(503).json(out);
  try {
    out.resourceSubscriptions = await gumroad.listResourceSubscriptions();
    res.json(out);
  } catch (e) {
    res.status(502).json({ ...out, error: e.message });
  }
});

// Support lookup: what access does this person actually have?
app.get('/api/admin/user', authLimiter, requireAdmin, async (req, res) => {
  try {
    const user = await resolveTarget({ email: req.query.email, uid: req.query.uid });
    const a = await access.accessFor(user.uid, null);
    const snap = await db.collection('users').doc(user.uid).get();
    const sub = (snap.exists && snap.data().subscription) || null;
    res.json({
      uid: user.uid, email: user.email || null, displayName: user.displayName || null,
      emailVerified: user.emailVerified, disabled: user.disabled,
      comp: access.isComp(user.email),
      access: a.active, plan: a.plan || null, pro: access.isPro(a),
      expiresAt: a.expiresAt || null, expiresOn: ymd(a.expiresAt),
      subscription: sub,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'lookup failed' });
  }
});

// Gumroad ping (server-to-server, form-encoded). Fires on every sale, including
// each recurring membership charge. Registered once in Gumroad → Settings →
// Advanced → Ping as  <backend>/api/gumroad/ping.  Always 200 — Gumroad retries
// failures and a retry storm helps nobody; the sale is recorded either way, and
// settleGumroadSale never trusts this body (it re-fetches the sale by id).
app.post('/api/gumroad/ping', webhookLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    // Sales pings carry sale_id; refund/dispute resource posts have been seen
    // with id — accept either, the sale is re-fetched by id regardless.
    const saleId = String(b.sale_id || b.id || '').trim();
    if (!saleId) return res.status(200).json({ status: 'ignored', reason: 'no sale_id' });
    const r = await settleGumroadSale(saleId, b);
    res.status(200).json({ status: r.ok ? 'ok' : 'ignored', reason: r.reason });
  } catch (e) {
    console.error('gumroad ping:', e.message);
    res.status(200).json({ status: 'error' });
  }
});

// "What access do I have?" — also auto-grants comp accounts on first check.
app.get('/api/subscribe/me', requireAuth, async (req, res) => {
  try {
    const user = await admin.auth().getUser(req.uid);
    if (isComp(user.email)) {
      const c = user.customClaims || {};
      // Re-grant when the claim is MISSING **or EXPIRED**. Checking only
      // !c.subscribed left comp accounts stranded after a year: the claim keeps
      // subscribed:true with a past expiresAt, so nothing re-granted while
      // Firestore rules — which read expiresAt from the token — denied every
      // read. The backend would still let them in; only their data vanished.
      const stale = !c.subscribed || (c.expiresAt && Date.now() > Number(c.expiresAt) - 7 * DAY_MS);
      if (stale) await grantSubscription(req.uid, 'pro', 'yearly', { comp: true });
      return res.json({ access: true, comp: true, plan: 'pro', pro: true });
    }
    const a = await access.accessFor(req.uid, null);   // null = always read fresh claims
    const out = { access: a.active, plan: a.plan || null, pro: access.isPro(a), expiresAt: a.expiresAt || null };

    // Keep the Brevo audience current (no-op unless BREVO_LIST_ID is set).
    syncBrevoContact(req.uid).catch(() => {});

    // Lazy expiry notice: if their plan has lapsed, send the "subscription has
    // ended" email the next time they open the app. This is what makes the
    // expiry email work with NO cron configured at all — the daily sweep just
    // catches the people who never come back.
    if (!a.active) {
      (async () => {
        const ref = db.collection('users').doc(req.uid);
        const s = await ref.get();
        if (s.exists) await notifyExpired(req.uid, ref, s.data().subscription || {});
      })().catch(() => {});
    }

    // Active Essential? Flag that an upgrade path exists. Gumroad cannot bill a
    // mid-cycle price difference, so upgrading means: subscribe to Pro, then
    // cancel the Essential membership from the Gumroad receipt — the pricing
    // page explains this next to the button.
    if (a.active && !access.isPro(a)) out.upgrade = { via: 'gumroad' };
    res.json(out);
  } catch (e) {
    console.error('subscribe/me:', e.message);
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

// ── ETW UNIVERSITY (1-on-1 mentorship) ─────────────────────────────
// Server-enforced booking (Pro-only, one session per month) + mentor
// notifications (Web Push + email) + the 1-hour reminder sweep.
require('./src/mentorship').mount(app, requireAuth, db);

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log('etw-sync-backend listening on :' + port);
  mt5.resumeAll();
  // Refunds/disputes are only delivered via Gumroad's Resource Subscriptions
  // API — the Settings → Ping URL fires on sales alone. Registration is
  // idempotent, so doing it on every boot is safe.
  const gumroadBase = (process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (gumroad.configured() && gumroadBase) {
    gumroad.ensureResourceSubscriptions(gumroadBase + '/api/gumroad/ping')
      .then((r) => console.log('[gumroad] resource subscriptions:', JSON.stringify(r)))
      .catch((e) => console.warn('[gumroad] resource subscriptions:', e.message));
  }
  // Boot-time reconciliation: exactly the moment missed pings need healing is
  // right after downtime — which is right now, since we just started.
  if (gumroad.configured()) {
    reconcileGumroadSales(3)
      .then((r) => { if (r.checked) console.log('[gumroad] boot reconcile:', JSON.stringify(r)); })
      .catch((e) => console.warn('[gumroad] boot reconcile:', e.message));
  }
});
