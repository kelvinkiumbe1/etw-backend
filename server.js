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

initFirebase();
const db = admin.firestore();
store.init(db);
mt5.init();
ctrader.init();

const app = express();
app.set('trust proxy', 1); // behind Render's proxy — needed for correct client IP in rate limiting
app.use(cors({ origin: true }));
app.use('/api/ai/groq', express.json({ limit: '8mb' })); // AI vision payloads (base64 images) exceed 1mb
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
}));

async function requireAuth(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Missing Authorization: Bearer <idToken>' });
  try { req.uid = (await admin.auth().verifyIdToken(m[1])).uid; next(); }
  catch (e) { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ── MT5 / MT4 ──────────────────────────────────────────────
app.post('/api/mt5-direct/connect', authLimiter, requireAuth, async (req, res) => {
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
app.post('/api/mt5-ea/register', authLimiter, requireAuth, async (req, res) => {
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
app.post('/api/tradelocker/connect', authLimiter, requireAuth, async (req, res) => {
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
app.post('/api/dxtrade/connect', authLimiter, requireAuth, async (req, res) => {
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
app.get('/api/ctrader/auth', authLimiter, requireAuth, async (req, res) => {
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
app.post('/api/ai/groq', aiLimiter, requireAuth, async (req, res) => {
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

// ── Market-data proxy (Twelve Data) ────────────────────────
// Keeps the Twelve Data key server-side (was base64-obfuscated in the client).
// Public market data, so no Firebase auth — protected by rate limiting only.
app.get('/api/market/twelvedata', marketLimiter, async (req, res) => {
  const key = process.env.TWELVE_DATA_KEY || '';
  if (!key) return res.status(503).json({ error: 'Market data is not configured on the server.' });
  const q = req.query || {};
  const p = new URLSearchParams();
  ['symbol', 'interval', 'outputsize', 'order', 'start_date', 'end_date'].forEach((k) => {
    if (q[k] != null && q[k] !== '') p.set(k, String(q[k]));
  });
  if (!p.get('symbol') || !p.get('interval')) return res.status(400).json({ error: 'symbol and interval are required' });
  p.set('apikey', key);
  try {
    const r = await fetch('https://api.twelvedata.com/time_series?' + p.toString());
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) { console.error('twelvedata proxy:', e.message); res.status(502).json({ error: 'Market-data upstream error.' }); }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log('etw-sync-backend listening on :' + port);
  mt5.resumeAll();
});
