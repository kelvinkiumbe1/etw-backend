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
app.use(cors({ origin: true }));
app.use('/api/ai/groq', express.json({ limit: '8mb' })); // AI vision payloads (base64 images) exceed 1mb
app.use('/api/ai/transcribe', express.json({ limit: '25mb' })); // base64 voice audio
app.use(express.json({ limit: '1mb' }));

// Rate limiters (per-IP) — throttle auth/credential, unauthenticated, and proxy endpoints.
const rl = (windowMs, max, message) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });
const authLimiter   = rl(15 * 60 * 1000, 40, 'Too many attempts. Please wait a few minutes and try again.');
const eaLimiter     = rl(60 * 1000, 120, 'Too many requests, please slow down.');
const aiLimiter     = rl(60 * 1000, 20,  'Too many AI requests, please wait a moment.');
const marketLimiter = rl(60 * 1000, 60,  'Too many market-data requests, please wait.');

app.get('/', (_req, res) => res.json({
  ok: true,
  service: 'etw-sync-backend',
  version: 'ea-2',
  platforms: { mt5: true, mt4: true, mt5ea: true, tradelocker: true, dxtrade: true, ctrader: ctrader.configured() },
  email: email.configured(),
  pesapal: require('./src/pesapal').configured(),
  pesapalEnv: process.env.PESAPAL_ENV || 'live',
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
      }),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) { console.error('groq proxy:', e.message); res.status(502).json({ error: 'AI upstream error.' }); }
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

app.get('/api/market/twelvedata', marketLimiter, async (req, res) => {
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
app.get('/api/market/ctrader-bars', marketLimiter, requireAuth, requireSub, async (req, res) => {
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
//  SUBSCRIPTIONS (Pesapal)  —  server-side verify + grant only
// ══════════════════════════════════════════════════════════════
const pesapal = require('./src/pesapal');

// ⚠️ EDIT THESE before going live. Amounts are in the charge currency's
// major unit. M-Pesa settles in KES, so use KES here (not USD) unless your
// Pesapal account is set up for another currency.
// USD prices converted at 1 USD = 130 KES: Essential $5/$48, Pro $12/$120.
const PLAN_PRICES = {
  essential: { monthly: { amount: 650,  currency: 'KES' }, yearly: { amount: 6240,  currency: 'KES' } },
  pro:       { monthly: { amount: 1560, currency: 'KES' }, yearly: { amount: 15600, currency: 'KES' } },
};

// ⚠️ TEMPORARY TEST MODE — charges 1 KES on every plan for a live end-to-end
//    test. SET BACK TO false before launch so real prices apply.
const TEST_PRICING = true;
const PLAN_DAYS = { monthly: 31, yearly: 366 };

// Free-forever comp accounts — always full access, never charged.
// Defined once in src/access.js so the gates and the grant path agree.
const isComp = access.isComp;

// Mid-cycle Essential → Pro upgrade: charge only the price difference and KEEP
// the existing expiry date, so nobody has to wait for the period to end.
const UPGRADE_DELTA = {
  monthly: PLAN_PRICES.pro.monthly.amount - PLAN_PRICES.essential.monthly.amount,  //  910 KES ≈ $7
  yearly:  PLAN_PRICES.pro.yearly.amount  - PLAN_PRICES.essential.yearly.amount,   // 9360 KES ≈ $72
};
// false = flat difference (what a customer expects: "+$7 and I'm Pro").
// true  = bill only the unused portion of the period (fairer if they upgrade on day 28).
const PRORATE_UPGRADE = false;

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
  await db.collection('users').doc(uid).set(
    { subscription: { plan, cycle, status: 'active', expiresAt, updatedAt: Date.now(), ...extra } },
    { merge: true }
  );
  return expiresAt;
}

// Verify a Pesapal order and grant if it completed. Idempotent.
async function settleOrder(orderTrackingId) {
  const ref = db.collection('pendingOrders').doc(orderTrackingId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: 'unknown order' };
  const o = snap.data();
  if (o.status === 'COMPLETED') return { ok: true, already: true };
  const st = await pesapal.getStatus(orderTrackingId);
  const desc = String(st.payment_status_description || '').toLowerCase();
  if (desc === 'completed' || st.status_code === 1) {
    const expiresAt = await grantSubscription(
      o.uid, o.plan, o.cycle,
      { orderTrackingId, paymentMethod: st.payment_method || null, ...(o.kind === 'upgrade' ? { upgradedAt: Date.now() } : {}) },
      o.kind === 'upgrade' ? o.keepExpiresAt : 0,
    );
    await ref.set({ status: 'COMPLETED', paymentMethod: st.payment_method || null, settledAt: Date.now(), expiresAt }, { merge: true });
    return { ok: true };
  }
  await ref.set({ status: (desc || 'pending').toUpperCase() }, { merge: true });
  return { ok: false, reason: desc || 'pending' };
}

// Start a checkout. Requires auth so we bind the order to a real uid.
app.post('/api/subscribe/create-order', authLimiter, requireAuth, async (req, res) => {
  try {
    if (!pesapal.configured()) return res.status(503).json({ error: 'Payments are not configured on the server.' });
    const plan  = String((req.body && req.body.plan)  || '').toLowerCase();
    let   cycle = String((req.body && req.body.cycle) || 'monthly').toLowerCase();
    const price = PLAN_PRICES[plan] && PLAN_PRICES[plan][cycle];
    if (!price) return res.status(400).json({ error: 'Unknown plan or billing cycle.' });

    const user = await admin.auth().getUser(req.uid);

    // Comp accounts skip payment entirely.
    if (isComp(user.email)) {
      const expiresAt = await grantSubscription(req.uid, 'pro', 'yearly', { comp: true });
      return res.json({ comp: true, expiresAt });
    }

    // ── Mid-cycle upgrade: Essential → Pro for the price difference ──
    // Keeps the current expiry date, so the remaining days simply become Pro days.
    let kind = 'new', keepExpiresAt = 0, amount = price.amount;
    if (req.body && req.body.upgrade) {
      const cur = await access.accessFor(req.uid, null);
      if (!cur.active)      return res.status(400).json({ error: 'No active subscription to upgrade.', code: 'no_subscription' });
      if (access.isPro(cur)) return res.status(400).json({ error: "You're already on the Pro plan.", code: 'already_pro' });
      if (plan !== 'pro')    return res.status(400).json({ error: 'Upgrades target the Pro plan.' });

      const snap = await db.collection('users').doc(req.uid).get();
      const sub  = (snap.exists && snap.data().subscription) || {};
      cycle = PLAN_DAYS[sub.cycle] ? sub.cycle : 'monthly';   // bill the delta on THEIR cycle
      amount = UPGRADE_DELTA[cycle];
      if (PRORATE_UPGRADE && cur.expiresAt) {
        const frac = Math.max(0, Math.min(1, (Number(cur.expiresAt) - Date.now()) / (PLAN_DAYS[cycle] * 86400000)));
        amount = Math.max(1, Math.round(amount * frac));
      }
      kind = 'upgrade';
      keepExpiresAt = Number(cur.expiresAt) || 0;
    }
    const chargeAmount = TEST_PRICING ? 1 : amount;

    const publicBase = (process.env.PUBLIC_BACKEND_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
    const appBase    = (process.env.APP_BASE_URL || req.get('origin') || publicBase).replace(/\/+$/, '');
    const ipnId   = await pesapal.ensureIpnId(db, publicBase + '/api/pesapal/ipn');
    const orderId = 'sub_' + req.uid.slice(0, 8) + '_' + Date.now();
    const nameParts = String(user.displayName || '').split(' ').filter(Boolean);

    const order = await pesapal.submitOrder({
      id: orderId,
      amount: chargeAmount,
      currency: price.currency,
      description: kind === 'upgrade'
        ? 'ETW Journal — upgrade to Pro (' + cycle + ', rest of period)'
        : 'ETW Journal — ' + plan + ' (' + cycle + ')',
      callbackUrl: appBase + '/payment.html?paid=1',
      notificationId: ipnId,
      email: user.email,
      firstName: nameParts[0] || 'ETW',
      lastName: nameParts.slice(1).join(' ') || 'Trader',
      phone: (req.body && req.body.phone) || '',
    });
    if (!order.redirect_url || !order.order_tracking_id) {
      return res.status(502).json({ error: 'Pesapal did not return a checkout URL.', detail: order });
    }

    await db.collection('pendingOrders').doc(order.order_tracking_id).set({
      uid: req.uid, plan, cycle, amount: chargeAmount, currency: price.currency,
      kind, keepExpiresAt, status: 'PENDING', createdAt: Date.now(),
    });
    res.json({ redirect_url: order.redirect_url, order_tracking_id: order.order_tracking_id, kind, amount: chargeAmount, currency: price.currency });
  } catch (e) {
    console.error('subscribe/create-order:', e.message);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

// Pesapal IPN (server-to-server notification). Registered as GET type.
async function handleIpn(req, res) {
  try {
    const id = (req.query && req.query.OrderTrackingId) || (req.body && req.body.OrderTrackingId);
    if (!id) return res.status(400).json({ error: 'missing OrderTrackingId' });
    await settleOrder(id);
    res.json({
      orderNotificationType: (req.query && req.query.OrderNotificationType) || 'IPNCHANGE',
      orderTrackingId: id,
      orderMerchantReference: (req.query && req.query.OrderMerchantReference) || '',
      status: 200,
    });
  } catch (e) {
    console.error('pesapal ipn:', e.message);
    res.status(200).json({ status: 500 });
  }
}
app.get('/api/pesapal/ipn', handleIpn);
app.post('/api/pesapal/ipn', handleIpn);

// Client polls this after returning from the Pesapal sheet.
app.get('/api/subscribe/status/:id', authLimiter, requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('pendingOrders').doc(req.params.id).get();
    if (snap.exists && snap.data().uid !== req.uid) return res.status(403).json({ error: 'Not your order.' });
    const r = await settleOrder(req.params.id);
    const o = snap.exists ? snap.data() : {};
    res.json({ status: o.status || 'PENDING', settled: !!r.ok });
  } catch (e) {
    console.error('subscribe/status:', e.message);
    res.status(500).json({ error: 'Status check failed.' });
  }
});

// "What access do I have?" — also auto-grants comp accounts on first check.
app.get('/api/subscribe/me', requireAuth, async (req, res) => {
  try {
    const user = await admin.auth().getUser(req.uid);
    if (isComp(user.email)) {
      const c = user.customClaims || {};
      if (!c.subscribed) await grantSubscription(req.uid, 'pro', 'yearly', { comp: true });
      return res.json({ access: true, comp: true, plan: 'pro', pro: true });
    }
    const a = await access.accessFor(req.uid, null);   // null = always read fresh claims
    const out = { access: a.active, plan: a.plan || null, pro: access.isPro(a), expiresAt: a.expiresAt || null };

    // Active Essential? Quote the mid-cycle upgrade so the UI can price the button.
    if (a.active && !access.isPro(a)) {
      const snap = await db.collection('users').doc(req.uid).get();
      const sub  = (snap.exists && snap.data().subscription) || {};
      const cyc  = PLAN_DAYS[sub.cycle] ? sub.cycle : 'monthly';
      let amt = UPGRADE_DELTA[cyc];
      if (PRORATE_UPGRADE && a.expiresAt) {
        const frac = Math.max(0, Math.min(1, (Number(a.expiresAt) - Date.now()) / (PLAN_DAYS[cyc] * 86400000)));
        amt = Math.max(1, Math.round(amt * frac));
      }
      out.upgrade = { cycle: cyc, amount: TEST_PRICING ? 1 : amt, currency: PLAN_PRICES.pro[cyc].currency, keepsExpiry: true };
    }
    res.json(out);
  } catch (e) {
    console.error('subscribe/me:', e.message);
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log('etw-sync-backend listening on :' + port);
  mt5.resumeAll();
});
