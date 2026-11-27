// ETW multi-platform trade-sync backend.
//   MT5 / MT4 ....... POST /api/mt5-direct/connect   { login, password, server, platform, journalAccountId }
//                     POST /api/mt5-direct/disconnect { forget }
//   TradeLocker ..... POST /api/tradelocker/connect   { email, password, server, env, journalAccountId }
//                     POST /api/tradelocker/disconnect
//   DXtrade ......... POST /api/dxtrade/connect        { webUrl, username, password, domain, journalAccountId }
//                     POST /api/dxtrade/disconnect
//   Bybit ........... POST /api/bybit/connect          { apiKey, apiSecret, env, journalAccountId }  (read-only key)
//                     POST /api/bybit/disconnect
//   IBKR ............ POST /api/ibkr/connect           { token, queryId, journalAccountId }  (Flex Web Service, read-only)
//                     POST /api/ibkr/disconnect
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
const bybit = require('./src/connectors/bybit');
const ibkr = require('./src/connectors/ibkr');
const cashflows = require('./src/cashflows');
const gumroad = require('./src/gumroad');
const mt5ea = require('./src/connectors/mt5ea');
const hosted = require('./src/hostedSync');
const email = require('./src/email');
const access = require('./src/access');
const tokens = require('./src/tokens');
const aiGuard = require('./src/aiGuard');

// ══ PLANS: Essential · Pro · Ultra ═══════════════════════════════════
// Ultra includes everything in Pro, so every existing Pro gate (access.isPro,
// requirePro, Firestore hasPro) also lets Ultra through. The plan claim rides in
// the ID token (grantSubscription sets it), so req.token.plan is authoritative
// for a request; planFor() falls back to the access lookup.
const PLAN_LIMITS = {
  //            independent journal accounts · MT5 per account · AI chat messages/day · AI calls/day (hidden safety cap) · trade replays/month
  essential: { accounts: 2,  mt5PerAccount: 1, aiMessages: 0,  aiCalls: 0,   replays: 0 },
  pro:       { accounts: 3,  mt5PerAccount: 1, aiMessages: 5,  aiCalls: 150, replays: 10 },
  ultra:     { accounts: 10, mt5PerAccount: 1, aiMessages: 20, aiCalls: 600, replays: Infinity },
};
// What the pricing page advertises for the daily AI allowance.
const AI_CREDITS = { pro: 500, ultra: 10000 };
const PLAN_TITLE = { essential: 'Essential', pro: 'Pro', ultra: 'Ultra' };
function planTitle(p) { return PLAN_TITLE[String(p || '').toLowerCase()] || 'Essential'; }
function limitsFor(p) {
  const L = PLAN_LIMITS[p] || PLAN_LIMITS.essential;
  return { accounts: L.accounts, mt5PerAccount: L.mt5PerAccount, aiMessages: L.aiMessages, aiCredits: AI_CREDITS[p] || 0,
           replays: L.replays === Infinity ? null : L.replays, voice: p === 'ultra', backtesting: p === 'ultra' ? 'unlimited' : p === 'pro' ? 3 : 0, backtestCloudBackup: p === 'ultra', universityUnlimited: p === 'ultra', prioritySupport: p === 'ultra' };
}
function tokenPlan(tok) {
  if (!tok || tok.subscribed !== true) return null;
  if (tok.expiresAt && Date.now() >= Number(tok.expiresAt)) return null;
  const p = String(tok.plan || 'essential').toLowerCase();
  return PLAN_LIMITS[p] ? p : 'essential';
}
function planOfAccess(a) {
  if (!a || a.active === false) return null;
  const p = String(a.plan || 'essential').toLowerCase();
  return PLAN_LIMITS[p] ? p : 'essential';
}
async function planFor(req) {
  const t = tokenPlan(req.token);
  if (t) return t;
  try { return planOfAccess(req.access || await access.accessFor(req.uid, req.token)); } catch (e) { return null; }
}
const _accessIsPro = access.isPro.bind(access);
// Ultra counts as Pro — but only while the plan is live. A lapsed Ultra keeps
// plan:'ultra' on its record, and must not keep Pro features or look "current".
access.isPro = (a) => !!a && a.active !== false && (String(a.plan || '').toLowerCase() === 'ultra' || _accessIsPro(a));
access.isUltra = (a) => !!a && a.active !== false && String(a.plan || '').toLowerCase() === 'ultra';

initFirebase();
const db = admin.firestore();
store.init(db);
aiGuard.init(db, { isPro: async (uid) => (await directPlanGate(uid)) === 'pro' });   // risk interventions, pushed the moment synced trades land (Pro / Ultra only)
mt5.init();
ctrader.init();
// onDeplete is injected rather than required, so tokens.js does not have to
// require mt5sync.js (which would be a cycle via store).
// MT5_ENGINE=hosted sends new links to our own worker (src/hostedSync.js) AND
// retires the MetaApi engine: legacy MetaApi-linked accounts are never resumed,
// pulled or re-deployed again, so MetaApi's own failures (expired subscription,
// "balance is not enough", quota errors) can no longer surface to users. Those
// accounts keep every imported trade and show one clear ask instead: reconnect
// once, which routes them through the hosted worker.
const HOSTED_ENGINE = String(process.env.MT5_ENGINE || '').trim().toLowerCase() === 'hosted';
const RELINK_HOSTED_MSG = 'MT5 sync has moved to ETW’s own sync engine. Reconnect this account once — login, investor (read-only) password and server — and syncing resumes automatically. Your imported trades are safe.';
// true = this account is a legacy MetaApi link and has been retired (caller must
// NOT touch MetaApi for it). Hosted accounts and non-hosted mode return false.
async function retireIfMetaApi(uid, accountKey) {
  if (!HOSTED_ENGINE) return false;
  try {
    const d = await db.collection('users').doc(uid).get();
    const data = d.exists ? d.data() : {};
    const acc = (data.mt5DirectAccounts || {})[accountKey]
      || ((((data.mt5Direct || {}).accountKey) || 'legacy') === accountKey ? data.mt5Direct : null);
    if (!acc || hosted.isHosted(acc)) return false;
    if (acc.errorCode !== 'relink_hosted') {
      await mt5.stopSync(uid, { undeploy: true, accountKey }).catch(() => {});
      await mt5.setStatus(uid, { status: 'error', error: RELINK_HOSTED_MSG, errorCode: 'relink_hosted', syncing: false }, accountKey).catch(() => {});
      console.log('[mt5] retired MetaApi account', uid, accountKey, '-> relink_hosted');
    }
    return true;
  } catch (e) { return false; }
}
tokens.init({
  onDeplete: async (uid) => {
    await mt5.stopSync(uid, { undeploy: true }).catch(() => {});
    await mt5.setStatus(uid, { status: 'depleted', error: null }).catch(() => {});
    console.log('[tokens] depleted -> undeployed and stopped sync for', uid);
  },
  onPause:  (uid, reason) => mt5.pause(uid, reason),
  // MT5/MT4 Direct auto-sync is a Pro feature. Every automatic resume and every
  // scheduled pull checks the plan first, so Essential accounts that were linked
  // before the change never sync again until the user upgrades to Pro.
  onResume: async (uid, accountKey) => {
    if (await retireIfMetaApi(uid, accountKey)) return;
    const g = await directPlanGate(uid);
    if (g === 'pro') return mt5.resumeOne(uid, accountKey);
    if (g === 'locked') await holdDirectForPro(uid, accountKey);
  },
  onPull:   async (uid, accountKey) => {
    if (await retireIfMetaApi(uid, accountKey)) return;
    const g = await directPlanGate(uid);
    if (g === 'pro') return mt5.pullOnce(uid, accountKey);
    if (g === 'locked') await holdDirectForPro(uid, accountKey);
  },
});

// ── MT5 Direct = Pro only ──────────────────────────────────
// 'pro' → sync; 'locked' → active Essential (or lapsed) plan, hold the sync;
// 'unknown' → the plan lookup failed, skip this one pull and try again later.
// ── Independent accounts ("spaces") ──────────────────────────
// One login can own several fully independent journals. The main journal keeps
// the login's uid; every other account lives under the data uid
// `${uid}__${accountId}` (accountId = the doc id in users/{uid}/accounts).
// Broker connections, synced trades and their status all live under that data
// uid, so every connector below just receives it in place of the login uid.
// Plans, tokens of identity and subscriptions always belong to the login, so
// any plan lookup goes through ownerUid().
const SPACE_SEP = '__';
function ownerUid(id) { return String(id || '').split(SPACE_SEP)[0]; }
function isSpaceUid(id) { return String(id || '').indexOf(SPACE_SEP) > 0; }
const _spaceOk = new Map();   // `${uid}/${accountId}` -> expiry (ms) of a positive ownership check
// `${uid}/${accountId}/${plan}` -> { exp, blocked } — the plan-allowance check, cached so
// every API call made from an independent account doesn't re-read the whole
// accounts list. Keyed by plan, so an upgrade takes effect on the next call.
const _spaceIdx = new Map();
function spaceCachePrune() {
  if (_spaceOk.size + _spaceIdx.size < 20000) return;
  const now = Date.now();
  for (const [k, v] of _spaceOk) if (v < now) _spaceOk.delete(k);
  for (const [k, v] of _spaceIdx) if (v.exp < now) _spaceIdx.delete(k);
  if (_spaceOk.size > 20000) _spaceOk.clear();
  if (_spaceIdx.size > 20000) _spaceIdx.clear();
}
async function dataUidFor(req) {
  const raw = String(req.get('X-ETW-Space') || (req.body && req.body.etwSpace) || (req.query && req.query.etwSpace) || '').trim();
  if (!raw) return req.uid;
  if (!/^[A-Za-z0-9]{6,40}$/.test(raw)) { const e = new Error('Invalid account.'); e.status = 400; throw e; }
  const key = req.uid + '/' + raw;
  const exp = _spaceOk.get(key);
  if (!exp || exp < Date.now()) {
    const snap = await db.collection('users').doc(req.uid).collection('accounts').doc(raw).get();
    if (!snap.exists) { const e = new Error('That account no longer exists.'); e.status = 404; throw e; }
    _spaceOk.set(key, Date.now() + 10 * 60 * 1000);
  }
  // Plan limit: accounts are counted oldest first (the main one is #1), so an
  // account past the plan's allowance is locked until the user upgrades.
  const plan = (await planFor(req)) || 'essential';
  const allowed = PLAN_LIMITS[plan].accounts;
  const ikey = key + '/' + plan;
  let hit = _spaceIdx.get(ikey);
  if (!hit || hit.exp < Date.now()) {
    const all = await db.collection('users').doc(req.uid).collection('accounts').orderBy('created', 'asc').get().catch(() => null);
    const idx = all ? all.docs.findIndex((d) => d.id === raw) : -1;
    const blocked = idx >= allowed;
    // allowed: re-checked every 10 min; blocked: every minute (so an upgrade or
    // a deleted account frees it quickly); a failed read is not cached.
    hit = { blocked, exp: Date.now() + (all ? (blocked ? 60 * 1000 : 10 * 60 * 1000) : 0) };
    if (all) { _spaceIdx.set(ikey, hit); spaceCachePrune(); }
  }
  if (hit.blocked) {
    const e = new Error('Your ' + planTitle(plan) + ' plan includes ' + allowed + ' accounts. Upgrade to use this one.');
    e.status = 402; e.code = 'account_limit'; throw e;
  }
  return req.uid + SPACE_SEP + raw;
}
// Express middleware: resolves req.duid (data uid) for the routes that store
// per-account data (broker links). Everything else keeps using req.uid.
async function withSpace(req, res, next) {
  try { req.duid = await dataUidFor(req); next(); }
  catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not resolve the account.', code: e.code || undefined }); }
}
// Every independent account a login owns (data uids, main excluded).
async function spacesOf(uid) {
  try {
    const snap = await db.collection('users').doc(uid).collection('accounts').get();
    return snap.docs.map((d) => uid + SPACE_SEP + d.id);
  } catch (e) { return []; }
}

async function directPlanGate(uid) {
  try {
    const a = await access.accessFor(ownerUid(uid), null);
    if (a.active && access.isPro(a)) return 'pro';
    // Ultra lives in the custom claim; check it directly in case the access
    // lookup does not know the plan name yet.
    try { const u = await admin.auth().getUser(ownerUid(uid)); if (tokenPlan(u.customClaims || {}) === 'ultra') return 'pro'; } catch (e) {}
    return 'locked';
  }
  catch (e) { console.warn('[mt5-pro] plan check failed for', uid, e.message); return 'unknown'; }
}
const PRO_HOLD_MSG = 'MT5 Direct auto-sync is on the Pro plan. Upgrade to Pro to resume syncing — your imported trades are safe.';
// MetaApi-linked accounts only. Hosted accounts (engine: 'hosted') are open to
// every plan and are gated by hostedSync.claim instead.
function directAccountKeys(data) {
  const accs = (data && data.mt5DirectAccounts) || {};
  const keys = Object.keys(accs).filter((k) => !hosted.isHosted(accs[k]));
  if (!Object.keys(accs).length && data && data.mt5Direct && !hosted.isHosted(data.mt5Direct)) keys.push((data.mt5Direct && data.mt5Direct.accountKey) || 'legacy');
  return keys;
}
// Stop (but do NOT forget) a linked account: credentials stay stored so an
// upgrade can bring it straight back without the user re-entering anything.
async function holdDirectForPro(uid, accountKey) {
  let keys = accountKey ? [accountKey] : [];
  if (!keys.length) { try { const d = await db.collection('users').doc(uid).get(); keys = directAccountKeys(d.exists ? d.data() : {}); } catch (e) {} }
  if (!keys.length) keys = ['legacy'];
  for (const k of keys) {
    await mt5.stopSync(uid, { undeploy: true, accountKey: k }).catch(() => {});
    await mt5.setStatus(uid, { status: 'pro_required', error: PRO_HOLD_MSG, heldAt: Date.now() }, k).catch(() => {});
  }
  console.log('[mt5-pro] held MT5 Direct sync (not Pro) for', uid, keys.join(','));
}
// After an upgrade to Pro: restart every account that was held for the plan.
async function releaseDirectForPro(uid) {
  try {
    const d = await db.collection('users').doc(uid).get(); const data = d.exists ? d.data() : {};
    const accs = data.mt5DirectAccounts || {};
    let keys = Object.keys(accs).filter((k) => accs[k] && accs[k].status === 'pro_required' && !hosted.isHosted(accs[k]));
    if (!keys.length && data.mt5Direct && data.mt5Direct.status === 'pro_required' && !hosted.isHosted(data.mt5Direct)) keys = [data.mt5Direct.accountKey || 'legacy'];
    for (const k of keys) {
      if (await retireIfMetaApi(uid, k)) continue;
      await mt5.setStatus(uid, { status: 'connecting', error: null }, k).catch(() => {});
      mt5.resumeOne(uid, k)
        .then(() => mt5.setStatus(uid, { status: 'connected', error: null }, k).catch(() => {}))
        .catch((e) => mt5.setStatus(uid, { status: 'error', error: mt5.friendlyError(e) }, k).catch(() => {}));
    }
    if (keys.length) console.log('[mt5-pro] resumed MT5 Direct sync after Pro upgrade for', uid, keys.join(','));
  } catch (e) { console.warn('[mt5-pro] release failed for', uid, e.message); }
}
// Hold or release one user according to their current plan — the login's own
// journal and, when called with a login uid, every independent account it owns.
async function enforceDirectPlan(uid) {
  await enforceDirectPlanOne(uid);
  if (!isSpaceUid(uid)) for (const s of await spacesOf(uid)) await enforceDirectPlanOne(s).catch(() => {});
}
async function enforceDirectPlanOne(uid) {
  hosted.recheck(uid).catch((e) => console.warn('[hosted] recheck failed for', uid, e.message));
  const g = await directPlanGate(uid);
  if (g === 'pro') return releaseDirectForPro(uid);
  if (g !== 'locked') return;
  const d = await db.collection('users').doc(uid).get().catch(() => null); const data = d && d.exists ? d.data() : {};
  const accs = data.mt5DirectAccounts || {};
  const live = directAccountKeys(data).filter((k) => {
    const st = (accs[k] && accs[k].status) || (data.mt5Direct && data.mt5Direct.status) || '';
    return st && st !== 'disconnected' && st !== 'pro_required';
  });
  if (live.length) for (const k of live) await holdDirectForPro(uid, k);
}
// Sweep every linked MT5 Direct user. Runs at boot (after resumeAll, so nothing
// that resumed on restart keeps syncing) and from the daily cron.
async function sweepDirectPlans() {
  let checked = 0, held = 0;
  try {
    const snap = await db.collection('users')
      .where('mt5Direct.status', 'in', ['connected', 'connecting', 'paused', 'error', 'depleted']).get();
    for (const doc of snap.docs) {
      checked++;
      const g = await directPlanGate(doc.id);
      if (g === 'locked') { await enforceDirectPlan(doc.id); held++; }
    }
  } catch (e) { console.warn('[mt5-pro] sweep failed:', e.message); }
  if (checked) console.log('[mt5-pro] sweep checked', checked, 'held', held);
  return { checked, held };
}

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
app.use('/api/backtest/backup', express.json({ limit: '24mb' })); // Ultra backtesting cloud backup
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

// Constant-time secret check, so response timing can't leak a shared secret
// (ADMIN_SECRET, CRON_SECRET) one character at a time. Hashing first gives
// timingSafeEqual equal-length inputs whatever was sent.
function secretMatches(given, secret) {
  if (!secret || !given) return false;
  const h = (v) => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(h(given), h(secret));
}

app.get('/', (_req, res) => res.json({
  ok: true,
  service: 'etw-sync-backend',
  version: 'ea-2',
  platforms: { mt5: true, mt4: true, mt5ea: true, tradelocker: true, dxtrade: true, ctrader: ctrader.configured(), bybit: hosted.configured(), ibkr: hosted.configured() },
  email: email.configured(),
  eodhd: require('./src/eodhd').configured(),
  gumroad: gumroad.configured(),
  paymentProvider: 'gumroad',
  grantHours: true,   // admin grant accepts {hours} for short passes
  appCheck: String(process.env.APPCHECK_ENFORCE || '').toLowerCase() === 'true',
}));

// Email 2FA is enforced on the token, not in the browser. When a user has 2FA on,
// their custom claims carry mfaRequired:true plus mfaSessions — the auth_time of
// every sign-in session that has passed a code (or a trusted-device check).
// auth_time is fixed for the life of a sign-in and survives token refreshes, so a
// fresh sign-in with a stolen password gets a new auth_time that is not on the
// list, and is refused here and by the Firestore rules until a code is entered.
// RETIRED: email 2FA has been switched off for everyone. Every session passes,
// whatever mfaRequired / mfaSessions an old token still carries (the boot-time
// cleanup below strips those claims; tokens refresh within the hour).
function mfaSatisfied(/* decoded */) {
  return true;
}

// Verify an ID token AND that its session hasn't been revoked. Plain
// verifyIdToken only checks the signature, so after a password change, a disable
// or revokeRefreshTokens() a stolen token kept working until it expired (up to an
// hour). checkRevoked costs one Auth lookup per call. On failure the 401 carries
// a `code` the client acts on: session_revoked / account_disabled sign it out.
async function verifySession(idToken) {
  try { return { decoded: await admin.auth().verifyIdToken(idToken, true) }; }
  catch (e) {
    const c = String(e.code || e.errorInfo && e.errorInfo.code || '');
    if (c === 'auth/id-token-revoked') return { error: 'Your session was signed out. Please sign in again.', code: 'session_revoked' };
    if (c === 'auth/user-disabled') return { error: 'This account has been disabled.', code: 'account_disabled' };
    return { error: 'Invalid or expired token', code: 'invalid_token' };
  }
}

// Verifies the Firebase ID token only. Used directly by the /api/mfa/* routes,
// which an unverified session must still be able to reach to enter its code.
async function requireAuthPreMfa(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Missing Authorization: Bearer <idToken>' });
  const v = await verifySession(m[1]);
  if (v.error) return res.status(401).json({ error: v.error, code: v.code });
  req.uid = v.decoded.uid;
  req.token = v.decoded;              // carries the subscription claim for the gates below
  next();
}

async function requireAuth(req, res, next) {
  return requireAuthPreMfa(req, res, () => {
    if (!mfaSatisfied(req.token)) return res.status(401).json({ error: 'Two-factor verification required.', code: 'mfa_required' });
    next();
  });
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
  /^\/api\/notion\/callback/,
  /^\/api\/mt5\/trades/,
  /^\/api\/mt5-ea\/push/,
  /^\/api\/cron\//,
  /^\/api\/worker\//,
  // Admin routes carry their own stronger auth (admin uid or ADMIN_SECRET) and
  // must stay callable from a terminal, where no App Check token exists.
  /^\/api\/admin\//,
  // Unsubscribe links are opened from an email, and mail apps post to them for one-click unsubscribe.
  /^\/api\/email\/unsubscribe/,
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
    if (tokenPlan(req.token) === 'ultra') { req.access = Object.assign({}, a, { active: true, plan: 'ultra' }); return next(); }
    if (!a.active) return res.status(402).json({ error: 'A subscription is required to use this feature.', code: 'subscription_required' });
    if (!access.isPro(a)) return res.status(402).json({ error: 'This feature is on the Pro plan.', code: 'pro_required', plan: a.plan || null });
    req.access = a; next();
  } catch (e) { console.error('requirePro:', e.message); res.status(500).json({ error: 'Access check failed.' }); }
}
async function requireUltra(req, res, next) {
  try {
    const plan = await planFor(req);
    if (!plan) return res.status(402).json({ error: 'A subscription is required to use this feature.', code: 'subscription_required' });
    if (plan !== 'ultra') return res.status(402).json({ error: 'This feature is on the Ultra plan.', code: 'ultra_required', plan });
    next();
  } catch (e) { console.error('requireUltra:', e.message); res.status(500).json({ error: 'Access check failed.' }); }
}

// ── MT5 / MT4 ──────────────────────────────────────────────
// HOSTED_ENGINE (defined above, next to retireIfMetaApi) sends new links to our
// own worker (src/hostedSync.js) instead of MetaApi, and retires legacy MetaApi
// accounts the moment anything would touch them.
// Auto-sync is a Pro feature on both engines (admin decision 2026-10-26).
const requireDirectPlan = requirePro;

// Accounts in this journal account (other than the one being linked now) that
// never completed a sync: no lastSyncAt on their status, never on MetaApi, and
// their hosted record (if any) never synced. They are unlinked from the hosted
// worker, removed from the account list and their period slot is given back.
// Anything that ever synced keeps counting, so this can't be used to swap
// working accounts within a period.
async function freeFailedMt5Attempts(uid, keepKey, periodKey) {
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return [];
  const data = snap.data() || {};
  const accounts = data.mt5DirectAccounts || {};
  const freed = [];
  for (const key of Object.keys(accounts)) {
    if (key === keepKey) continue;
    const a = accounts[key] || {};
    if (a.lastSyncAt || a.metaApiAccountId || a.status === 'connected' || a.status === 'paused') continue;
    const h = await db.collection(hosted.COL).doc(uid + '_' + key).get().catch(() => null);
    if (h && h.exists && (h.data() || {}).everSynced) continue;
    await hosted.unlink(uid, key).catch((e) => console.warn('[mt5] unlink failed attempt:', e.message));
    freed.push(key);
  }
  if (!freed.length) return freed;
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    const d = (cur.exists && cur.data()) || {};
    const usage = d.mt5DirectPeriod || {};
    const updates = [];
    freed.forEach((k) => updates.push(new admin.firestore.FieldPath('mt5DirectAccounts', k), admin.firestore.FieldValue.delete()));
    if (usage.periodKey === periodKey && Array.isArray(usage.accountKeys)) {
      updates.push('mt5DirectPeriod.accountKeys', usage.accountKeys.filter((k) => !freed.includes(k)), 'mt5DirectPeriod.updatedAt', Date.now());
    }
    if (d.mt5Direct && freed.includes(d.mt5Direct.accountKey)) updates.push('mt5Direct', admin.firestore.FieldValue.delete());
    tx.update(ref, ...updates);
  });
  console.log('[mt5] freed', freed.length, 'never-synced attempt(s) for', uid);
  return freed;
}

app.post('/api/mt5-direct/connect', authLimiter, requireAuth, withSpace, requireDirectPlan, async (req, res) => {
  const { login, password, server, platform, journalAccountId } = req.body || {};
  if (!login || !password || !server) return res.status(400).json({ error: 'login, password and server are required' });
  if (!/^\d{1,20}$/.test(String(login).trim()) || String(server).length > 128 || String(password).length > 128) {
    return res.status(400).json({ error: 'Check the login (numbers only), password and server.' });
  }
  if (HOSTED_ENGINE && !hosted.configured()) return res.status(503).json({ error: 'MT5 sync is not set up on the server yet.' });

  // One MT5 / MT4 account per journal account, on every plan (an Ultra user
  // gets more journal accounts, not more MT5 links inside one).
  const accountKey = crypto.createHash('sha256')
    .update(String(platform || 'mt5') + '|' + String(login) + '|' + String(server).toLowerCase()).digest('hex').slice(0, 32);
  const accountLimit = 1;
  const periodKey = String(req.access.expiresAt || req.access.periodStart || req.access.plan || 'active');
  // A previous attempt that never synced (wrong server name, wrong password,
  // broker unreachable…) is not a used account: free it so the trader can retry
  // with corrected details instead of hitting "1 new MT5 account per period".
  try { await freeFailedMt5Attempts(req.duid, accountKey, periodKey); }
  catch (e) { console.warn('[mt5] free failed attempts:', e.message); }
  let reservation;
  try {
    reservation = await mt5.reserveAccount(req.duid, accountKey, {
      status: 'connecting', platform: platform || 'mt5', login: String(login), server,
      error: null, journalAccountId: journalAccountId || '',
    }, accountLimit, periodKey);
  } catch (e) {
    if (e.code === 'mt5_account_limit' || e.code === 'mt5_period_limit') {
      return res.status(409).json({ error: e.message, code: e.code, limit: e.limit, linked: e.linked, used: e.used });
    }
    console.error('mt5 account reservation:', e.message);
    return res.status(500).json({ error: 'Could not reserve an MT5 account slot. Please try again.' });
  }

  if (HOSTED_ENGINE) {
    try {
      // Moving an account off MetaApi: delete it there so it stops billing.
      const prev = await db.collection('users').doc(req.duid).get();
      const was = prev.exists && prev.data().mt5DirectAccounts && prev.data().mt5DirectAccounts[accountKey];
      if (was && was.metaApiAccountId) {
        await mt5.removeAccount(req.duid, accountKey).catch((e) => console.warn('[hosted] MetaApi removal failed:', e.message));
      }
      await hosted.link(req.duid, { accountKey, login: String(login).trim(), password: String(password), server: String(server).trim(), platform, journalAccountId });
      return res.json({ ok: true, status: 'connecting', accountKey, accountLimit, engine: 'hosted' });
    } catch (e) {
      console.error('hosted link:', e.message);
      if (reservation && reservation.reservedNewPeriodSlot) await mt5.releaseNewPeriodSlot(req.duid, accountKey, periodKey).catch(() => {});
      await mt5.setStatus(req.duid, { status: 'error', error: 'Could not save your account. Please try again.' }, accountKey).catch(() => {});
      return res.status(e.status || 500).json({ error: 'Could not save your account. Please try again.' });
    }
  }

  // Direct sync runs as a daily pull so MetaApi accounts are not held deployed.
  let mode = 'daily';
  try {
    const prev = await db.collection('users').doc(req.duid).get();
    mode = ((prev.exists && prev.data().mt5DirectAccounts &&
      prev.data().mt5DirectAccounts[accountKey] &&
      prev.data().mt5DirectAccounts[accountKey].mode) || 'daily');
  } catch (e) {}
  await mt5.setStatus(req.duid, { status: 'connecting', platform: platform || 'mt5', login: String(login), server, error: null, accountKey, mode, journalAccountId: journalAccountId || '' }, accountKey);
  res.json({ ok: true, status: 'connecting', accountKey, accountLimit });
  mt5.startSync({ uid: req.duid, login: String(login), password, server, platform: platform || 'mt5', accountId: journalAccountId || '', accountKey })
    .then(async (r) => {
      await mt5.setStatus(req.duid, { status: 'connected' }, accountKey).catch(() => {});
    })
    .catch(async (e) => {
      console.error('mt5 startSync:', e.message);
      await mt5.setStatus(req.duid, { status: 'error', error: mt5.friendlyError(e) }, accountKey).catch(() => {});
      if (reservation && reservation.reservedNewPeriodSlot) {
        await mt5.releaseNewPeriodSlot(req.duid, accountKey, periodKey).catch((releaseError) => {
          console.error('mt5 reservation rollback:', releaseError.message);
        });
      }
    });
});
// ── MT5 server directory (autocomplete for the Server field) ────────────
// Every server name a user has ACTUALLY linked successfully is recorded once
// per user, so the suggestion list grows with real, working servers only —
// nobody can add a made-up name: the server must match a connected account on
// the caller's own user doc. Stored server-side only (no client rules exist
// for these collections, so the catch-all deny keeps them Admin-SDK only).
const MT5_DIR = () => db.collection('mt5ServerDirectory').doc('all');
let _mt5DirCache = { at: 0, list: [] };
function cleanServerName(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return s.length >= 3 && s.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9 ._\-()&]*$/.test(s) ? s : '';
}
app.get('/api/mt5/servers', requireAuth, async (req, res) => {
  try {
    if (Date.now() - _mt5DirCache.at > 10 * 60 * 1000) {
      const snap = await MT5_DIR().get();
      const map = (snap.exists && snap.data().servers) || {};
      const list = Object.keys(map).map((k) => ({ s: map[k].name || k, n: Number(map[k].n) || 0, mt5: Number(map[k].mt5) || 0, mt4: Number(map[k].mt4) || 0 }))
        .filter((x) => cleanServerName(x.s)).sort((a, b) => b.n - a.n).slice(0, 5000);
      _mt5DirCache = { at: Date.now(), list };
    }
    res.set('Cache-Control', 'private, max-age=600');
    res.json({ ok: true, servers: _mt5DirCache.list });
  } catch (e) {
    console.error('mt5/servers:', e.message);
    res.json({ ok: true, servers: [] });
  }
});
app.post('/api/mt5/servers/seen', authLimiter, requireAuth, withSpace, async (req, res) => {
  try {
    const name = cleanServerName(req.body && req.body.server);
    if (!name) return res.status(400).json({ ok: false, error: 'server required' });
    const snap = await db.collection('users').doc(req.duid).get();
    const d = snap.exists ? snap.data() : {};
    const accs = Object.values(d.mt5DirectAccounts || {}).concat(d.mt5Direct ? [d.mt5Direct] : []);
    const hit = accs.find((a) => a && a.status === 'connected' && String(a.server || '').trim().toLowerCase() === name.toLowerCase());
    const plat = hit && String(hit.platform || 'mt5').toLowerCase() === 'mt4' ? 'mt4' : 'mt5';
    if (!hit) return res.status(409).json({ ok: false, error: 'Only a server with a connected account can be added.' });
    const key = name.toLowerCase();
    const mark = db.collection('mt5ServerSeen').doc(crypto.createHash('sha256').update(req.uid + '|' + plat + '|' + key).digest('hex').slice(0, 40));
    try { await mark.create({ at: Date.now() }); } catch (e) { return res.json({ ok: true, already: true }); }
    // set+merge treats map keys literally, so names with dots/spaces are safe.
    await MT5_DIR().set({ servers: { [key]: { name, n: admin.firestore.FieldValue.increment(1), [plat]: admin.firestore.FieldValue.increment(1), last: Date.now() } } }, { merge: true });
    _mt5DirCache.at = 0;
    res.json({ ok: true });
  } catch (e) {
    console.error('mt5/servers/seen:', e.message);
    res.status(500).json({ ok: false });
  }
});
// Daily mode is the only supported direct-sync mode. This endpoint remains for
// old clients that may still send a mode preference.
app.post('/api/mt5-direct/mode', authLimiter, requireAuth, withSpace, requirePro, async (req, res) => {
  const mode = String((req.body && req.body.mode) || '').toLowerCase();
  if (mode !== 'daily') return res.status(400).json({ error: "only daily sync is supported" });
  const accountKey = String((req.body && req.body.accountKey) || 'legacy');
  try {
    const snap = await db.collection('users').doc(req.duid).get();
    const data = snap.exists ? snap.data() : {};
    const d = (data.mt5DirectAccounts && data.mt5DirectAccounts[accountKey]) || data.mt5Direct || {};
    const was = d.mode || 'daily';
    if (was === mode) return res.json({ ok: true, mode, unchanged: true });

    await mt5.setStatus(req.duid, { mode }, accountKey);

    // Only reshape the connection if one exists. Switching while disconnected
    // just records the preference for the next connect.
    if (d.status === 'paused' && !(await retireIfMetaApi(req.duid, accountKey))) mt5.resumeOne(req.duid, accountKey).catch((e) => console.error('mode resume:', e.message));
    res.json({ ok: true, mode });
  } catch (e) {
    console.error('mt5 mode:', e.message);
    res.status(500).json({ error: 'Could not change sync mode.' });
  }
});

app.post('/api/mt5-direct/disconnect', requireAuth, withSpace, async (req, res) => {
  let accountKey = String((req.body && req.body.accountKey) || '');
  if (!/^[0-9a-f]{32}$|^legacy$/.test(accountKey)) {
    // Old clients send no key; use the account the panel is showing.
    const snap = await db.collection('users').doc(req.duid).get().catch(() => null);
    accountKey = (snap && snap.exists && snap.data().mt5Direct && snap.data().mt5Direct.accountKey) || 'legacy';
  }
  try { await hosted.unlink(req.duid, accountKey); } catch (e) { console.warn('hosted unlink:', e.message); }
  try { await mt5.stopSync(req.duid, { forget: !!(req.body && req.body.forget), accountKey }); } catch (e) { console.warn(e.message); }
  await mt5.setStatus(req.duid, { status: 'disconnected' }, accountKey).catch(() => {});
  res.json({ ok: true });
});

// Hosted accounts only: move this account to the front of the worker's queue.
app.post('/api/mt5-direct/sync-now', authLimiter, requireAuth, withSpace, requireSub, async (req, res) => {
  const accountKey = String((req.body && req.body.accountKey) || '');
  if (!/^[0-9a-f]{32}$/.test(accountKey)) return res.status(400).json({ error: 'accountKey is required' });
  try {
    await hosted.syncNow(req.duid, accountKey);
    await mt5.setStatus(req.duid, { syncNowAt: Date.now() }, accountKey).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    if (!e.status) console.error('sync-now:', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not queue a sync.', retryInMin: e.retryInMin });
  }
});

// ── Hosted MT5 worker (~/Desktop/wine/worker.py) ───────────
// Authenticated by WORKER_SECRET. jobs hands out decrypted investor passwords,
// so the secret must only ever live on the worker machine.
function requireWorker(req, res, next) {
  const secret = String(process.env.WORKER_SECRET || '').trim();
  if (!secret) return res.status(503).json({ error: 'WORKER_SECRET is not set on the server.' });
  if (!secretMatches(req.get('X-Worker-Key'), secret)) return res.status(403).json({ error: 'forbidden' });
  req.workerId = String(req.get('X-Worker-Id') || 'worker').replace(/[^\w.-]/g, '').slice(0, 64) || 'worker';
  next();
}
const workerLimiter = rl(60 * 1000, 120, 'Too many requests.');
app.post('/api/worker/jobs', workerLimiter, requireWorker, async (req, res) => {
  try { res.json({ jobs: await hosted.claim(req.workerId, req.body && req.body.max) }); }
  catch (e) { console.error('worker/jobs:', e.message); res.status(500).json({ error: 'claim failed' }); }
});
app.post('/api/worker/report', workerLimiter, requireWorker, async (req, res) => {
  try { res.json(await hosted.report(req.workerId, req.body || {})); }
  catch (e) { if (!e.status) console.error('worker/report:', e.message); res.status(e.status || 500).json({ error: e.message }); }
});

// ── MT5 EA (FREE — no MetaApi) ─────────────────────────────
// register: Firebase-auth'd, mints a key for the active account.
app.post('/api/mt5-ea/register', authLimiter, requireAuth, withSpace, requireSub, async (req, res) => {
  try {
    const key = await mt5ea.register(req.duid, (req.body && req.body.journalAccountId) || '');
    res.json({ ok: true, key });
  } catch (e) { console.error('ea register:', e.message); res.status(500).json({ error: e.message }); }
});
// push: called by the EA in MT5 (no Firebase — authed by the X-ETW-Key header).
async function eaPush(req, res) {
  const key = req.headers['x-etw-key'] || (req.body && req.body.key) || '';
  const trades = (req.body && req.body.trades) || [];
  const meta = { login: (req.body && req.body.login) || '', server: (req.body && req.body.server) || '' };
  const cash = (req.body && Array.isArray(req.body.cash)) ? req.body.cash : [];
  try { const saved = await mt5ea.push(key, trades, meta, cash); res.json({ ok: true, saved, cash: cash.length }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}
app.post('/api/mt5/trades', eaLimiter, eaPush);   // matches the EA's default ServerURL path
// EA → live open-positions snapshot (sent every ~30s and on each trade change).
app.post('/api/mt5/positions', eaLimiter, async (req, res) => {
  const b = req.body || {};
  const key = req.headers['x-etw-key'] || b.key || '';
  try {
    const n = await mt5ea.positions(key, b.positions, { login: b.login, server: b.server, currency: b.currency, balance: b.balance, equity: b.equity });
    res.json({ ok: true, n });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Dashboard → Recent activity → Open positions: the trader's REAL open
// positions, straight from the broker side. cTrader is read live; MT5 comes
// from the ETW EA's snapshots (fresh = under 3 minutes old).
app.get('/api/broker/positions', marketLimiter, requireAuth, withSpace, async (req, res) => {
  const out = { ok: true, positions: [], sources: [], at: Date.now() };
  const jid = String((req.query && req.query.journalAccountId) || '');
  try {
    const u = await db.collection('users').doc(req.duid).get();
    const ud = u.exists ? u.data() : {};
    if (ud.ctrader && ud.ctrader.status === 'connected' && ctrader.configured() && (!jid || !ud.ctrader.journalAccountId || ud.ctrader.journalAccountId === jid)) {
      try {
        const list = await ctrader.getPositions(req.duid);
        list.forEach((p) => out.positions.push(Object.assign({ source: 'ctrader' }, p)));
        // stale = cTrader could not be read just now; these are the last positions it reported
        const st = !!list.stale || list.some((p) => p.stale);
        out.sources.push({ source: 'ctrader', ok: !list.stale, count: list.length, stale: st, at: st ? (list.reduce((m, p) => Math.max(m, +p.lastSeen || 0), 0) || null) : Date.now() });
      } catch (e) { out.sources.push({ source: 'ctrader', ok: false, error: 'cTrader did not answer — try again in a moment.' }); }
    }
    const bp = await db.collection('brokerPositions').doc(req.duid).get();
    const mt5 = (bp.exists && bp.data().mt5) || {};
    Object.keys(mt5).forEach((slot) => {
      const s = mt5[slot] || {};
      if (jid && s.accountId && s.accountId !== jid) return;
      const age = Date.now() - (+s.at || 0);
      // Fresh = the EA (or hosted sync) reported in the last 3 minutes. Older snapshots
      // are still shown — marked stale, with when they were last seen — because the
      // position is open until MT5 says otherwise: it leaves the list when a newer
      // snapshot no longer has it, or the moment its closed trade is imported.
      const fresh = age < 3 * 60 * 1000;
      if (age > 14 * 86400000) return;   // a sync that has been gone for two weeks
      out.sources.push({ source: 'mt5', ok: fresh, login: s.login || '', at: s.at || 0, count: (s.positions || []).length, stale: !fresh, hosted: !!s.hosted });
      (s.positions || []).forEach((p) => out.positions.push(Object.assign({ source: 'mt5', broker: 'MT5', account: (s.server ? s.server + ' ' : '') + (s.login || '') }, p, fresh ? {} : { stale: true, lastSeen: +s.at || 0 })));
    });
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) {
    console.error('broker/positions:', e.message);
    res.status(500).json({ ok: false, error: 'Could not load open positions.' });
  }
});
app.post('/api/mt5-ea/push', eaLimiter, eaPush);

// ── Deposits & withdrawals (Settings › Deposits & Withdrawals) ──
// The operations themselves live in `cashflows` and are read by the app directly;
// these two endpoints add what the browser can't reach: the balances the brokers
// report right now, and an on-demand cTrader balance-history pull.
app.get('/api/cashflow/balances', marketLimiter, requireAuth, withSpace, requireSub, async (req, res) => {
  try {
    const out = { ok: true, accounts: [] };
    const [u, bp] = await Promise.all([db.collection('users').doc(req.duid).get(), db.collection('brokerPositions').doc(req.duid).get()]);
    const ct = (u.exists && u.data().ctrader) || {};
    if (ct.status === 'connected') Object.keys(ct.cashBalances || {}).forEach((id) => {
      const b = ct.cashBalances[id] || {};
      out.accounts.push({ source: 'ctrader', via: 'ctrader', login: String(id), accountId: ct.journalAccountId || '', label: b.label || ('cTrader ' + id), balance: b.balance, equity: null, currency: '', at: b.at || 0, live: !!b.live });
    });
    const ib = (u.exists && u.data().ibkr) || {};
    if (ib.status === 'connected') Object.keys(ib.accounts || {}).forEach((id) => {
      const b = ib.accounts[id] || {};
      if (b.nav == null) return;
      out.accounts.push({ source: 'ibkr', via: 'flex', login: String(id), accountId: ib.journalAccountId || '', label: 'IBKR ' + id, balance: b.nav, equity: b.nav, currency: b.currency || '', at: +ib.lastSyncAt || b.at || 0, live: !ibkr.isPaper(id) });
    });
    const mt5 = (bp.exists && bp.data().mt5) || {};
    Object.keys(mt5).forEach((slot) => {
      const x = mt5[slot] || {};
      if (!x.balance && !x.equity) return;
      if (Date.now() - (+x.at || 0) > 30 * 86400000) return;
      out.accounts.push({ source: 'mt5', via: x.hosted ? 'hosted' : 'ea', login: x.login || '', accountId: x.accountId || '', label: ((x.server ? x.server + ' ' : '') + (x.login || '')).trim() || 'MT5', balance: x.balance, equity: x.equity, currency: x.currency || '', at: x.at || 0, hosted: !!x.hosted });
    });
    // MT5 accounts linked through MetaApi report balance/equity on every sync.
    const api = (bp.exists && bp.data().mt5api) || {};
    Object.keys(api).forEach((slot) => {
      const x = api[slot] || {};
      if (Date.now() - (+x.at || 0) > 30 * 86400000) return;
      if (out.accounts.some((a) => a.source === 'mt5' && a.login && a.login === x.login)) return;   // same account also on the EA
      out.accounts.push({ source: 'mt5', via: 'direct', accountId: x.accountId || '', login: x.login || '', label: ((x.server ? x.server + ' ' : '') + (x.login || '')).trim() || 'MT5', balance: x.balance, equity: x.equity, currency: x.currency || '', at: x.at || 0 });
    });
    // MT5 accounts with no deposit in their history (prop firms): make sure the estimated starting balance exists.
    await Promise.all(Object.keys(mt5).map((slot) => { const x = mt5[slot] || {}; return x.balance > 0 && Date.now() - (+x.at || 0) <= 30 * 86400000 ? cashflows.ensureMt5Initial(req.duid, x, { everyMs: 10 * 60 * 1000 }) : null; }));
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) { console.error('cashflow/balances:', e.message); res.status(500).json({ ok: false, error: 'Could not load balances.' }); }
});
app.post('/api/cashflow/sync', authLimiter, requireAuth, withSpace, requireSub, async (req, res) => {
  const out = { ok: true, ctrader: null };
  try {
    const u = await db.collection('users').doc(req.duid).get();
    const ib = (u.exists && u.data().ibkr) || {};
    if (ib.status === 'connected') out.ibkr = ibkr.syncNow(req.duid) ? 'started' : 'recent';   // runs in the background
    const ct = (u.exists && u.data().ctrader) || {};
    if (ct.status === 'connected' && ctrader.configured()) out.ctrader = await ctrader.syncCash(req.duid, { force: true });
    res.json(out);
  } catch (e) { console.error('cashflow/sync:', e.message); res.status(502).json({ ok: false, error: 'cTrader did not answer — try again in a minute.' }); }
});

// ── Delete synced trades (Accounts menu › Delete synced trades) ──────────
// The trader picks which connections' trades to remove from the account that
// is open (X-ETW-Space): MT5 / MT4, cTrader, Notion, Bybit, TradeLocker,
// DXtrade, or other broker syncs. Manual, AI-logged and file-imported trades
// are never touched. Deleted broker trades are remembered (syncTombstones/
// {dataUid}) so the next sync does not bring them back; trades that close
// after the delete keep syncing as normal.
const SYNC_DEL_GROUPS = ['mt5', 'ctrader', 'notion', 'bybit', 'ibkr', 'tradelocker', 'dxtrade', 'other'];
const SYNC_REIMPORTS = { mt5: 1, ctrader: 1, bybit: 1, ibkr: 1, tradelocker: 1, dxtrade: 1 };   // servers that would sync them again
function syncGroupOf(t) {
  if (!t) return '';
  const src = String(t.source || '').toLowerCase(), ex = String(t.execSource || '').toLowerCase(), br = String(t.brokerName || '').toLowerCase();
  if (/report|csv|file|manual|chat|draft/.test(ex)) return '';                       // file imports / hand-entered
  if (src === 'notion_import' || ex === 'notion') return 'notion';
  if (/^(mt[45](-ea|-direct|-live|-initial|-sync)?|metatrader[45]?)$/.test(src)) return 'mt5';
  if (src === 'ctrader' || src === 'ctrader_open_api') return 'ctrader';
  if (src === 'bybit') return 'bybit';
  if (src === 'ibkr') return 'ibkr';
  if (src === 'tradelocker') return 'tradelocker';
  if (src === 'dxtrade') return 'dxtrade';
  if (src === 'broker_sync') {
    if (/ctrader/.test(br)) return 'ctrader';
    if (/bybit/.test(br)) return 'bybit';
    if (/tradelocker/.test(br)) return 'tradelocker';
    if (/dxtrade/.test(br)) return 'dxtrade';
    if (/mt[45]|metatrader/.test(br)) return 'mt5';
    return 'other';
  }
  return '';
}
const TOMB_MAX = 40000;
const _tombs = new Map();   // dataUid -> { at, set }
async function tombsFor(duid) {
  const hit = _tombs.get(duid);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.set;
  let set = new Set();
  try { const d = await db.collection('syncTombstones').doc(duid).get(); if (d.exists) set = new Set((d.data() || {}).keys || []); } catch (e) {}
  _tombs.set(duid, { at: Date.now(), set });
  if (_tombs.size > 2000) _tombs.delete(_tombs.keys().next().value);
  return set;
}
function tombKeys(t) {
  const g = syncGroupOf(t); if (!g || !SYNC_REIMPORTS[g]) return [];
  const out = [];
  if (t.ticket != null && String(t.ticket) !== '') out.push(g + '|' + String(t.ticket));
  if (t.positionId != null && String(t.positionId) !== '') out.push(g + '|pos:' + String(t.positionId));
  if (t.extId) out.push(g + '|x:' + String(t.extId));
  return out;
}
// Every connector writes through store.writeTrades — drop anything the trader deleted.
const _writeTrades = store.writeTrades;
store.writeTrades = async function (trades) {
  const list = Array.isArray(trades) ? trades : [];
  const uids = [...new Set(list.map((t) => t && t.uid).filter(Boolean))];
  const sets = {};
  for (const u of uids) sets[u] = await tombsFor(u);
  const keep = list.filter((t) => { const set = t && sets[t.uid]; return !set || !set.size || !tombKeys(t).some((k) => set.has(k)); });
  if (keep.length < list.length) console.log('[delete-synced] skipped', list.length - keep.length, 'deleted trade(s) on re-sync');
  return keep.length ? _writeTrades.call(store, keep) : 0;
};

app.post('/api/trades/delete-synced', authLimiter, requireAuth, withSpace, async (req, res) => {
  const want = [...new Set(((req.body && req.body.groups) || []).map(String))].filter((g) => SYNC_DEL_GROUPS.includes(g));
  if (!want.length) return res.status(400).json({ error: 'Choose at least one source to delete.' });
  const preview = !!(req.body && req.body.preview);
  try {
    const duid = req.duid;
    // Main journal: trades still tagged with another account's id belong to that account.
    let others = new Set();
    if (duid === req.uid) {
      try { const a = await db.collection('users').doc(req.uid).collection('accounts').orderBy('created', 'asc').get(); a.docs.slice(1).forEach((d) => others.add(d.id)); } catch (e) {}
    }
    const snap = await db.collection('trades').where('uid', '==', duid).get();
    const hits = [], byGroup = {};
    snap.docs.forEach((d) => {
      const t = d.data() || {};
      if (others.size && t.accountId && others.has(t.accountId)) return;
      const g = syncGroupOf(t);
      if (!g || !want.includes(g)) return;
      hits.push({ ref: d.ref, t }); byGroup[g] = (byGroup[g] || 0) + 1;
    });
    if (preview) return res.json({ ok: true, preview: true, total: hits.length, byGroup });
    // Remember them first, so a sync running at this moment cannot re-add them.
    const keys = []; hits.forEach((h) => tombKeys(h.t).forEach((k) => keys.push(k)));
    if (keys.length) {
      const ref = db.collection('syncTombstones').doc(duid);
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        const set = new Set((cur.exists && (cur.data() || {}).keys) || []);
        keys.forEach((k) => { set.delete(k); set.add(k); });
        const arr = [...set]; tx.set(ref, { keys: arr.slice(-TOMB_MAX), updatedAt: Date.now() });
      });
      _tombs.delete(duid);
    }
    let deleted = 0;
    for (let i = 0; i < hits.length; i += 400) {
      const b = db.batch();
      hits.slice(i, i + 400).forEach((h) => b.delete(h.ref));
      await b.commit(); deleted += Math.min(400, hits.length - i);
    }
    console.log('[delete-synced]', duid, want.join(','), '->', deleted);
    res.json({ ok: true, deleted, byGroup });
  } catch (e) {
    console.error('delete-synced:', e.message);
    res.status(500).json({ error: 'Could not delete those trades. Please try again.' });
  }
});

// ── TradeLocker ────────────────────────────────────────────
app.post('/api/tradelocker/connect', authLimiter, requireAuth, withSpace, requireSub, async (req, res) => {
  const { email, password, server, env, journalAccountId } = req.body || {};
  if (!email || !password || !server) return res.status(400).json({ error: 'email, password and server are required' });
  await store.setStatus(req.duid, 'tradelocker', { status: 'connecting', server: env || 'demo', error: null });
  res.json({ ok: true, status: 'connecting' });
  tradelocker.startSync({ uid: req.duid, email, password, server, env: env === 'live' ? 'live' : 'demo', accountId: journalAccountId || '' })
    .catch(async (e) => { console.error('tradelocker:', e.message); await store.setStatus(req.duid, 'tradelocker', { status: 'error', error: tradelocker.friendlyError(e) }).catch(() => {}); });
});
app.post('/api/tradelocker/disconnect', requireAuth, withSpace, async (req, res) => {
  try { await tradelocker.stopSync(req.duid); } catch (e) {}
  await store.setStatus(req.duid, 'tradelocker', { status: 'disconnected' }).catch(() => {});
  res.json({ ok: true });
});

// ── DXtrade ────────────────────────────────────────────────
app.post('/api/dxtrade/connect', authLimiter, requireAuth, withSpace, requireSub, async (req, res) => {
  const { webUrl, username, password, domain, journalAccountId } = req.body || {};
  if (!webUrl || !username || !password) return res.status(400).json({ error: 'webUrl, username and password are required' });
  await store.setStatus(req.duid, 'dxtrade', { status: 'connecting', error: null });
  res.json({ ok: true, status: 'connecting' });
  dxtrade.startSync({ uid: req.duid, webUrl, username, password, domain, accountId: journalAccountId || '' })
    .catch(async (e) => { console.error('dxtrade:', e.message); await store.setStatus(req.duid, 'dxtrade', { status: 'error', error: dxtrade.friendlyError(e) }).catch(() => {}); });
});
app.post('/api/dxtrade/disconnect', requireAuth, withSpace, async (req, res) => {
  try { await dxtrade.stopSync(req.duid); } catch (e) {}
  await store.setStatus(req.duid, 'dxtrade', { status: 'disconnected' }).catch(() => {});
  res.json({ ok: true });
});

// ── Bybit ──────────────────────────────────────────────────
// Read-only API key, verified before we answer so a bad / trading-enabled key
// fails in the form; the history import then runs in the background.
app.post('/api/bybit/connect', authLimiter, requireAuth, withSpace, requireSub, async (req, res) => {
  const { apiKey, apiSecret, env, journalAccountId } = req.body || {};
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'apiKey and apiSecret are required' });
  if (String(apiKey).length > 200 || String(apiSecret).length > 200) return res.status(400).json({ error: 'That does not look like a Bybit API key.' });
  if (!hosted.configured()) return res.status(503).json({ error: 'Bybit sync is not configured on the server yet.' });
  try {
    await bybit.connect(req.duid, { apiKey, apiSecret, env, journalAccountId });
    res.json({ ok: true, status: 'connecting' });
  } catch (e) {
    console.warn('bybit connect:', e.message);
    res.status(400).json({ error: bybit.friendlyError(e), code: e.code || undefined });
  }
});
app.post('/api/bybit/disconnect', requireAuth, withSpace, async (req, res) => {
  try { await bybit.disconnect(req.duid); } catch (e) {}
  await store.setStatus(req.duid, 'bybit', { status: 'disconnected' }).catch(() => {});
  res.json({ ok: true });
});

// ── Interactive Brokers (Flex Web Service) ─────────────────
// Token + Activity Flex Query ID. Checked with IB before we answer, so a wrong
// token or query fails in the form; the report import then runs in the background.
app.post('/api/ibkr/connect', authLimiter, requireAuth, withSpace, requireSub, async (req, res) => {
  const { token, queryId, journalAccountId } = req.body || {};
  const tok = String(token || '').trim(), qid = String(queryId || '').trim();
  if (!tok || !qid) return res.status(400).json({ error: 'Your Flex token and Query ID are both required.' });
  if (!/^[A-Za-z0-9]{8,64}$/.test(tok)) return res.status(400).json({ error: 'That does not look like a Flex Web Service token. Copy the whole Current Token from IBKR.' });
  if (!/^\d{3,12}$/.test(qid)) return res.status(400).json({ error: 'The Query ID is a number, shown next to your Activity Flex Query in IBKR.' });
  if (!hosted.configured()) return res.status(503).json({ error: 'Interactive Brokers sync is not configured on the server yet.' });
  try {
    await ibkr.connect(req.duid, { token: tok, queryId: qid, journalAccountId: String(journalAccountId || '').slice(0, 128) });
    res.json({ ok: true, status: 'connecting' });
  } catch (e) {
    console.warn('ibkr connect:', e.flexCode || '', e.message);
    res.status(400).json({ error: ibkr.friendlyError(e), code: e.flexCode || e.code || undefined });
  }
});
app.post('/api/ibkr/disconnect', requireAuth, withSpace, async (req, res) => {
  try { await ibkr.disconnect(req.duid); } catch (e) {}
  await store.setStatus(req.duid, 'ibkr', { status: 'disconnected' }).catch(() => {});
  res.json({ ok: true });
});

// ── cTrader (OAuth) ────────────────────────────────────────
app.get('/api/ctrader/auth', authLimiter, requireAuth, withSpace, requireSub, async (req, res) => {
  try { res.json({ ok: true, url: ctrader.createAuthUrl(req.duid, (req.query && req.query.journalAccountId) || '') }); }
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
app.post('/api/ctrader/disconnect', requireAuth, withSpace, async (req, res) => {
  try { await ctrader.disconnect(req.duid); } catch (e) {}
  res.json({ ok: true });
});

// ── AI proxy (Groq) ────────────────────────────────────────
// Keeps the Groq key server-side (was hardcoded in the client). Firebase-auth'd
// + rate-limited. Transparent pass-through of the OpenAI-style chat body.
// ── ETW AI daily allowance ────────────────────────────────────────────
// A "message" is one user turn in the chat (typed, voice or image). The app
// tags every request of that turn with X-ETW-AI-Turn, so retries and the extra
// calls one answer needs are counted once. Background AI work (insights,
// tagging) carries no turn and only counts toward a hidden daily safety cap.
// Resets at 00:00 UTC. Stored on users/{uid}.aiUsage (server-owned field).
function utcDay(t) { return new Date(t || Date.now()).toISOString().slice(0, 10); }
function nextUtcMidnight() { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }
function aiLimitMessage(plan, limit) {
  const credits = AI_CREDITS[plan] ? ' (' + AI_CREDITS[plan].toLocaleString('en-US') + ' daily credits)' : '';
  return 'Your daily ETW AI credits are used up — ' + limit + ' of ' + limit + ' messages today on ' + planTitle(plan) + credits + '. '
    + 'They refresh tomorrow at 00:00 UTC, so come back then'
    + (plan === 'ultra' ? '.' : ', or upgrade to Ultra for 20 messages a day.');
}
// How many daily messages one AI request costs (1–4). The server weighs the
// request itself — its size and reasoning depth — and takes the client's
// X-ETW-AI-Cost hint (paged reviews, long analyses) only as a floor, so a
// client can make a request cost more but never less than it really is.
function aiWeight(req) {
  const body = req.body || {};
  let chars = 0;
  try { chars = JSON.stringify(body.messages || []).length; } catch (e) {}
  let w = 1;
  if (chars > 70000) w++;
  if (chars > 140000) w++;
  if (body.reasoning_effort === 'high') w++;
  if (Array.isArray(body.messages) && body.messages.some((m) => Array.isArray(m && m.content) && m.content.some((c) => c && c.type === 'image_url'))) w++;
  const hint = Math.floor(Number(req.get('X-ETW-AI-Cost')) || 0);
  if (hint > w) w = hint;
  return Math.max(1, Math.min(4, w));
}
async function aiQuota(req, res, next) {
  const plan = (await planFor(req)) || 'pro';
  req.aiPlan = plan;
  const L = PLAN_LIMITS[plan] || PLAN_LIMITS.pro;
  const turn = String(req.get('X-ETW-AI-Turn') || '').replace(/[^\w-]/g, '').slice(0, 40);
  const ref = db.collection('users').doc(req.uid);
  try {
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const u = (snap.exists && snap.data().aiUsage) || {};
      const day = utcDay();
      const turns = (u.day === day && Array.isArray(u.turns)) ? u.turns.slice() : [];
      let calls = u.day === day ? Number(u.calls || 0) : 0;
      if (turn) {
        // A heavy request counts as more than one message: entries turn, turn#2,
        // turn#3… are charged once each, so a turn that grows heavier (a big
        // review after a light call) is topped up, never double-charged.
        const have = turns.filter((x) => x === turn || x.indexOf(turn + '#') === 0).length;
        const want = aiWeight(req);
        if (!have && turns.length >= L.aiMessages) return { blocked: true, used: turns.length };
        for (let k = have + 1; k <= want && turns.length < L.aiMessages; k++) turns.push(k === 1 ? turn : turn + '#' + k);
      }
      if (calls >= L.aiCalls) return { blocked: true, used: turns.length };
      calls++;
      tx.set(ref, { aiUsage: { day, turns, calls, limit: L.aiMessages, plan, resetAt: nextUtcMidnight(), updatedAt: Date.now() } }, { merge: true });
      return { used: turns.length };
    });
    if (out.blocked) {
      return res.status(402).json({ error: aiLimitMessage(plan, L.aiMessages), code: 'ai_daily_limit', plan, limit: L.aiMessages, used: out.used, resetAt: nextUtcMidnight() });
    }
    next();
  } catch (e) {
    console.warn('[ai quota] check failed, allowing:', e.message);   // never block on our own fault
    next();
  }
}
app.get('/api/ai/usage', requireAuth, async (req, res) => {
  const plan = (await planFor(req)) || null;
  const L = PLAN_LIMITS[plan] || PLAN_LIMITS.essential;
  try {
    const snap = await db.collection('users').doc(req.uid).get();
    const u = (snap.exists && snap.data().aiUsage) || {};
    const used = u.day === utcDay() && Array.isArray(u.turns) ? u.turns.length : 0;
    res.json({ ok: true, plan, limit: L.aiMessages, used, left: Math.max(0, L.aiMessages - used), credits: AI_CREDITS[plan] || 0, resetAt: nextUtcMidnight(), voice: plan === 'ultra' });
  } catch (e) { res.status(500).json({ error: 'Lookup failed.' }); }
});

// ── Groq free-plan limits are per MODEL and shared by every user ─────────
// On the free plan each chat model has its own 8,000 tokens-per-minute budget
// for the whole organisation (all ETW users together), and a request counts its
// prompt PLUS max_tokens. One busy minute on openai/gpt-oss-120b used to turn
// into "The AI assistant is busy" for everyone. Now a request that hits a
// per-minute (or daily) limit moves to the next model in the pool, each with its
// own budget; a model that said "wait" is skipped until its reset time, and if
// every model is busy the server waits a few seconds for the first one to free
// up before giving up. Requests with images stay on the model they asked for.
const AI_POOL = String(process.env.GROQ_MODEL_POOL || 'openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b')
  .split(',').map((s) => s.trim()).filter(Boolean);
const _aiCool = new Map();   // `${keyTag}|${model}` -> epoch ms when it may be tried again
function aiParseWait(v) {
  // "7.66s", "1m2.5s", "2h3m", "250ms" or plain seconds
  const s = String(v || '').trim(); if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.ceil(parseFloat(s) * 1000);
  let ms = 0, m;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  while ((m = re.exec(s))) ms += parseFloat(m[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]);
  return Math.ceil(ms);
}
function aiCooldownFor(r, text) {
  const daily = /per day|TPD|RPD/i.test(text);
  const fromMsg = (String(text).match(/try again in\s+([0-9hms.]+)/i) || [])[1];
  const ms = aiParseWait(fromMsg) || aiParseWait(r.headers.get('retry-after')) || aiParseWait(r.headers.get('x-ratelimit-reset-tokens')) || (daily ? 10 * 60000 : 20000);
  return Math.min(Math.max(ms, 1500), daily ? 6 * 3600000 : 90000);
}
function aiHasImage(messages) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m && m.content) && m.content.some((c) => c && c.type === 'image_url'));
}
async function groqChatPooled(key, body, ultra) {
  const keyTag = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
  const asked = body.model || AI_POOL[0];
  const pool = aiHasImage(body.messages) || AI_POOL.indexOf(asked) < 0 && /vision|scout|maverick|llava/i.test(asked)
    ? [asked] : [asked].concat(AI_POOL.filter((m) => m !== asked));
  let last = null;
  for (let pass = 0; pass < 2; pass++) {
    let soonest = Infinity;
    for (const model of pool) {
      const ck = keyTag + '|' + model, until = _aiCool.get(ck) || 0;
      if (until > Date.now()) { soonest = Math.min(soonest, until); continue; }
      const gptOss = /gpt-oss/.test(model);
      const effort = ['low', 'medium', 'high'].includes(body.reasoning_effort) ? body.reasoning_effort : null;
      const payload = {
        model,
        messages: body.messages,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
        max_tokens: Math.min(Number(body.max_tokens) || 1024, ultra ? 8192 : 4096),
        ...(gptOss && effort && (effort !== 'high' || ultra) ? { reasoning_effort: effort } : {}),
        // qwen thinks out loud by default; keep that out of the answer.
        ...(/qwen/i.test(model) ? { reasoning_format: 'hidden' } : {}),
        ...(body.response_format ? { response_format: body.response_format } : {}),
        ...(Array.isArray(body.tools) && body.tools.length && body.tools.length <= 16 && JSON.stringify(body.tools).length < 20000
          ? { tools: body.tools, ...(['auto', 'none', 'required'].includes(body.tool_choice) ? { tool_choice: body.tool_choice } : {}) } : {}),
        ...(body.stream === true ? { stream: true } : {}),
      };
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(payload),
      });
      if (r.status !== 429) {
        if (model !== asked) console.log('[ai] served on', model, '(', asked, 'was busy )');
        return { r, model };
      }
      const text = await r.text().catch(() => '');
      const wait = aiCooldownFor(r, text);
      _aiCool.set(ck, Date.now() + wait);
      soonest = Math.min(soonest, Date.now() + wait);
      last = { status: 429, text, wait };
      console.warn('[ai] 429 on', model, '- cooling', Math.round(wait / 1000) + 's');
    }
    // Every model is cooling down: wait for the first one if that is only a few seconds away.
    const gap = soonest - Date.now();
    if (pass === 0 && isFinite(gap) && gap <= 12000) { await new Promise((ok) => setTimeout(ok, Math.max(gap, 300))); continue; }
    const retryAfter = Math.max(1, Math.ceil((isFinite(gap) ? gap : (last && last.wait) || 20000) / 1000));
    return { busy: true, retryAfter, text: (last && last.text) || '' };
  }
  return { busy: true, retryAfter: 20, text: (last && last.text) || '' };
}

app.post('/api/ai/groq', aiLimiter, requireAuth, requirePro, aiQuota, async (req, res) => {
  // Ultra can run on its own Groq key (GROQ_API_KEY_ULTRA) so its requests have
  // their own rate-limit bucket and never queue behind other plans.
  const ultra = req.aiPlan === 'ultra';
  const key = (ultra && process.env.GROQ_API_KEY_ULTRA) || process.env.GROQ_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'AI is not configured on the server.' });
  const body = req.body || {};
  if (!Array.isArray(body.messages) || !body.messages.length) return res.status(400).json({ error: 'messages[] is required' });
  const wantStream = body.stream === true;
  try {
    const out = await groqChatPooled(key, body, ultra);
    if (out.busy) {
      // Same shape Groq uses, so the app's existing "busy, try again in N seconds" handling reads it.
      res.set('Retry-After', String(out.retryAfter));
      return res.status(429).json({ error: { message: 'Rate limit reached: every ETW AI model is busy. Please try again in ' + out.retryAfter + 's.', type: 'tokens', code: 'rate_limit_exceeded' } });
    }
    const r = out.r;
    res.set('X-ETW-AI-Model', out.model);

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
app.post('/api/ai/transcribe', aiLimiter, requireAuth, requireUltra, async (req, res) => {   // voice = Ultra
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

// ── ETW AI market pulse: live news, TradingView technicals, trader sentiment ──
require('./src/marketPulse').mount(app, { requireAuth, requireSub, limiter: marketLimiter });

// ── AI connectors (MCP): let Claude, ChatGPT, Cursor… read the trader's journal (see src/mcp.js) ──
// Endpoint: POST /mcp/<connector key>  (or POST /mcp with "Authorization: Bearer <key>").
// Keys are created / revoked from Settings › AI Connectors (Pro / Ultra).
async function mcpPlanOf(uid) {
  try { const u = await admin.auth().getUser(uid); if (tokenPlan(u.customClaims || {}) === 'ultra') return 'ultra'; } catch (e) {}
  let a; try { a = await access.accessFor(uid, null); } catch (e) { return undefined; }
  if (!a || !a.active) return null;
  if (access.isUltra(a)) return 'ultra';
  return access.isPro(a) ? 'pro' : 'essential';
}
require('./src/mcp').mount(app, {
  db, requireAuth,
  planOf: async (uid) => { const p = await mcpPlanOf(uid); return p === 'essential' ? null : p; },
  accountLimit: async (uid) => { const p = await mcpPlanOf(uid); return (PLAN_LIMITS[p] || PLAN_LIMITS.essential).accounts; },
});

// ── Verified Track Record: server-side proof of performance (src/trackrecord.js) ──
require('./src/trackrecord').mount(app, { db, requireAuth, getUser: (uid) => admin.auth().getUser(uid) });

// ── Notion Sync: import a trading journal kept in Notion (see src/notionSync.js) ──
require('./src/notionSync').mount(app, { requireAuth, requireSub, limiter: rl(60 * 1000, 90, 'Too many Notion requests, please wait a moment.'), db, admin });

// ── Economic calendar (Forex Factory weekly feed) ──────────
// Forex Factory publishes the current week as JSON. Browsers can't read it
// directly (no CORS) and it is rate-limited, so the server fetches it at most
// every 10 minutes, serves everyone from memory, and keeps a copy of every week
// in Firestore (econCalendar/{sundayYMD}) — that history is what lets the app
// tag past trades as Before / During / After news. Unofficial feed: if it is
// down or blocks us, the last good copy keeps being served.
const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FF_TTL = 10 * 60 * 1000;
let FF_MEM = { at: 0, week: '', events: null, error: null };
let FF_INFLIGHT = null;
function ffWeekKey(ts) { const d = new Date(ts); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.toISOString().slice(0, 10); }
function ffNorm(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((e) => {
    if (!e || !e.date || !e.title) return;
    const ts = Date.parse(e.date); if (!isFinite(ts)) return;
    const impact = String(e.impact || '').toLowerCase();
    const cur = String(e.country || '').toUpperCase().slice(0, 4);
    const id = crypto.createHash('sha1').update(cur + '|' + e.title + '|' + e.date).digest('hex').slice(0, 16);
    out.push({ id, ts, cur, title: String(e.title).slice(0, 160),
      impact: /high/.test(impact) ? 'high' : /medium/.test(impact) ? 'medium' : /low/.test(impact) ? 'low' : /holiday/.test(impact) ? 'holiday' : 'none',
      forecast: String(e.forecast || ''), previous: String(e.previous || ''), actual: String(e.actual || '') });
  });
  return out.sort((a, b) => a.ts - b.ts);
}
async function ffRefresh(force) {
  if (!force && FF_MEM.events && Date.now() - FF_MEM.at < FF_TTL) return FF_MEM;
  if (FF_INFLIGHT) return FF_INFLIGHT;
  FF_INFLIGHT = (async () => {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(FF_URL, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (ETW Journal calendar)', 'Accept': 'application/json' } });
      clearTimeout(to);
      if (!r.ok) throw new Error('feed HTTP ' + r.status);
      const events = ffNorm(await r.json());
      if (!events.length) throw new Error('feed returned no events');
      const week = ffWeekKey(events[0].ts + 6 * 3600 * 1000);
      FF_MEM = { at: Date.now(), week, events, error: null };
      db.collection('econCalendar').doc(week).set({ week, events, updatedAt: Date.now(), source: 'forexfactory' }).catch((e) => console.warn('[calendar] store:', e.message));
    } catch (e) {
      console.warn('[calendar] refresh failed:', e.message);
      FF_MEM.error = e.message; FF_MEM.at = FF_MEM.events ? Date.now() - FF_TTL + 2 * 60 * 1000 : 0;   // retry in ~2 min
      if (!FF_MEM.events) {
        // cold start + feed down: fall back to the newest stored week
        try {
          const snap = await db.collection('econCalendar').orderBy(admin.firestore.FieldPath.documentId(), 'desc').limit(1).get();
          snap.forEach((d) => { const x = d.data() || {}; FF_MEM = { at: Date.now() - FF_TTL + 2 * 60 * 1000, week: d.id, events: x.events || [], error: e.message }; });
        } catch (e2) {}
      }
    } finally { FF_INFLIGHT = null; }
    return FF_MEM;
  })();
  return FF_INFLIGHT;
}
app.get('/api/calendar/week', marketLimiter, requireAuth, requireSub, async (req, res) => {
  const m = await ffRefresh(false);
  if (!m.events) return res.status(503).json({ error: 'The economic calendar is unavailable right now. Please try again shortly.' });
  res.set('Cache-Control', 'private, max-age=120');
  res.json({ week: m.week, updatedAt: m.at, stale: !!m.error, events: m.events, source: 'Forex Factory' });
});
// Stored weeks for a time range (max ~4 months) — used to tag past trades with news.
app.get('/api/calendar/range', marketLimiter, requireAuth, requireSub, async (req, res) => {
  const to = Math.min(Number(req.query.to) || Date.now(), Date.now() + 8 * 86400000);
  const from = Math.max(Number(req.query.from) || (to - 60 * 86400000), to - 125 * 86400000);
  try {
    await ffRefresh(false).catch(() => {});
    const FP = admin.firestore.FieldPath.documentId();
    const snap = await db.collection('econCalendar').where(FP, '>=', ffWeekKey(from)).where(FP, '<=', ffWeekKey(to)).get();
    const weeks = []; let events = [];
    snap.forEach((d) => { weeks.push(d.id); events = events.concat(((d.data() || {}).events || []).filter((e) => e.impact === 'high' || e.impact === 'medium')); });
    res.json({ weeks: weeks.sort(), events: events.filter((e) => e.ts >= from - 86400000 && e.ts <= to + 86400000) });
  } catch (e) { console.error('calendar range:', e.message); res.status(500).json({ error: 'Could not load calendar history.' }); }
});
// Keep each week stored even when nobody opens the app.
setInterval(() => { ffRefresh(false).catch(() => {}); }, 30 * 60 * 1000);
setTimeout(() => { ffRefresh(true).catch(() => {}); }, 15000);

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

// ── Dukascopy: NDX100 (Nasdaq 100 CFD) for Backtesting and Trade Replay ──
// Minute data back to ~2013 at the CFD price brokers quote. Same gate as the
// other market routes. from / to are milliseconds; interval is one of
// 1m 5m 15m 30m 1h 4h 1d 1w. Long ranges are cut to what one chart can hold
// (meta.truncated, meta.to says where it stopped).
app.get('/api/market/dukascopy', marketLimiter, requireAuth, requireSub, async (req, res) => {
  const duka = require('./src/dukascopy');
  const q = req.query || {};
  if (!q.symbol || !q.interval) return res.status(400).json({ error: 'symbol and interval are required' });
  if (!duka.instrumentFor(q.symbol)) return res.status(404).json({ error: 'No Dukascopy data for ' + String(q.symbol).slice(0, 20) });
  if (!duka.PLAN[q.interval]) return res.status(400).json({ error: 'interval must be one of ' + Object.keys(duka.PLAN).join(', ') });
  const from = Number(q.from) || 0, to = Number(q.to) || Date.now();
  const cacheKey = 'duka:' + duka.instrumentFor(q.symbol).code + ':' + q.interval + ':' + from + ':' + to;
  const hit = mktGet(cacheKey);
  if (hit) { MKT_HITS++; res.set('X-Cache', 'HIT'); return res.status(hit.status).type('application/json').send(hit.body); }
  MKT_MISS++;
  try {
    const out = await duka.getCandles({ symbol: q.symbol, interval: q.interval, from, to });
    const body = JSON.stringify(out);
    if (out.candles.length && !out.meta.missingFiles) {
      const isPast = to < Date.now() - 24 * 3600 * 1000;
      mktSet(cacheKey, body, 200, isPast ? 30 * 24 * 3600 * 1000 : 5 * 60 * 1000);
    }
    res.set('X-Cache', 'MISS').type('application/json').send(body);
  } catch (e) {
    console.error('dukascopy:', e.message);
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
    const deviceId = String((req.body && req.body.deviceId) || '');
    const userAgent = (req.body && req.body.userAgent) || '';
    // It becomes a field name in knownDevices, so keep it to a plain short token.
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) return;
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

// Sign out everywhere: revokes every refresh token, so other devices are cut off
// at their next API call (requireAuth checks revocation) and at their next token
// refresh for Firestore (within the hour). It also moves tokensValidAfterTime,
// which retires every 2FA trusted device. The caller is signed out too.
app.post('/api/auth/signout-all', authLimiter, requireAuth, async (req, res) => {
  try {
    await admin.auth().revokeRefreshTokens(req.uid);
    res.json({ ok: true });
  } catch (e) { console.error('signout-all:', e.message); res.status(500).json({ error: 'Could not sign out other devices.' }); }
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

// The Admin SDK's links point at <project>.firebaseapp.com/__/auth/action. A
// button whose link goes to a different domain than the sender is a classic
// phishing signal, so reset emails carry a link to our own login page instead
// (same domain as the receipts, which land in the inbox). The page reads the
// one-time oobCode and finishes the reset with the Firebase client SDK.
function ownActionLink(firebaseLink, mode) {
  try {
    const code = new URL(firebaseLink).searchParams.get('oobCode');
    if (code) return APP_URL.replace(/\/+$/, '') + '/?mode=' + encodeURIComponent(mode) + '&oobCode=' + encodeURIComponent(code);
  } catch (e) {}
  return firebaseLink;
}

// Unauthenticated password-reset request. Answers ok whether or not the
// account exists (no account enumeration). Only when the account exists but
// Brevo could not send does it answer 502, so the page can fall back to
// Firebase's own email instead of telling the user to wait for nothing.
app.post('/api/auth/send-reset', authLimiter, async (req, res) => {
  const addr = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!addr || addr.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return res.status(400).json({ error: 'A valid email is required.' });
  let user = null;
  try { user = await admin.auth().getUserByEmail(addr); }
  catch (e) {
    if (/user-not-found|no user record|EMAIL_NOT_FOUND/i.test((e.code || '') + ' ' + (e.message || ''))) return res.json({ ok: true });
    // Any other failure (credentials, quota, network) used to be answered "ok" too, so the
    // page told the trader an email was coming when nothing was sent. Say it failed instead.
    console.error('send-reset lookup:', e.message);
    return res.status(502).json({ error: 'Could not look up the account' });
  }
  try {
    const link = ownActionLink(await admin.auth().generatePasswordResetLink(addr, actionSettings), 'resetPassword');
    const hasPassword = (user.providerData || []).some((p) => p.providerId === 'password');
    const hi = user.displayName ? 'Hi ' + escapeHtml(user.displayName.split(' ')[0]) + ',' : 'Hi,';
    const sent = await email.sendEmail({
      to: user.email || addr, toName: user.displayName || '',
      subject: hasPassword ? 'Reset your ETW Journal password' : 'Set a password for your ETW Journal account',
      html: emailShell(hasPassword ? 'Reset your password' : 'Set your password',
        `<p>${hi}</p><p>We received a request to ${hasPassword ? 'reset the password for' : 'add a password to'} your ETW Journal account (${escapeHtml(user.email || addr)}). Use the button below to choose a new one. The link works once and expires in 1 hour.</p>` +
        `<p>If you didn't ask for this, ignore this email: your password stays the same.</p>`,
        hasPassword ? 'Choose a new password' : 'Set my password', link),
      // A plain-text part next to the HTML is part of what keeps mail out of spam.
      text: `${hi}\n\nWe received a request to ${hasPassword ? 'reset the password for' : 'add a password to'} your ETW Journal account (${user.email || addr}).\n\nChoose a new password here (works once, expires in 1 hour):\n${link}\n\nIf you didn't ask for this, ignore this email: your password stays the same.\n\nETW Journal`,
    });
    if (!sent) return res.status(502).json({ error: 'Email send failed' });
    res.json({ ok: true, sent: true });
  } catch (e) {
    console.error('send-reset:', e.message);
    res.status(502).json({ error: 'Could not send the reset email' });
  }
});

// Security notice after a password change (Settings, or a completed reset).
// Sent by the server so it comes from the same verified sender as receipts.
app.post('/api/auth/password-changed', authLimiter, requireAuth, async (req, res) => {
  try {
    const user = await admin.auth().getUser(req.uid);
    if (!user.email) return res.json({ ok: true });
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const when = new Date().toUTCString();
    await email.sendEmail({
      to: user.email, toName: user.displayName || '',
      subject: 'Your ETW Journal password was changed',
      html: emailShell('Your password was changed',
        `<p>The password for your ETW Journal account (${escapeHtml(user.email)}) was changed on <b>${when}</b>${ip ? ' from IP ' + escapeHtml(ip) : ''}. Other devices have been signed out.</p>` +
        `<p>If this was you, no action is needed.</p><p><b>If it wasn't you</b>, reset your password right away from the login page and contact support.</p>`,
        'Open ETW Journal', APP_URL),
      text: `The password for your ETW Journal account (${user.email}) was changed on ${when}${ip ? ' from IP ' + ip : ''}. Other devices have been signed out.\n\nIf this was you, no action is needed. If it wasn't you, reset your password right away from the login page (${APP_URL}) and contact support.\n\nETW Journal`,
    });
    res.json({ ok: true });
  } catch (e) { console.error('password-changed:', e.message); res.json({ ok: true }); }
});

// ── Email 2FA (new/untrusted-device only) ──────────────────
// Opt-in via POST /api/mfa/settings. On login from a device not in the user's
// trusted list, a 6-digit code is emailed (Brevo) and must be verified before
// the session can use the API or Firestore. Codes are stored hashed + expiring,
// with attempt lockout, in users/{uid}/private/mfa (server-only).
//
// TRUSTED DEVICES are proven with a key, not remembered by an ID. On "trust this
// device" the browser makes a non-extractable ECDSA P-256 key (WebCrypto, kept in
// IndexedDB) and sends only the public half. To skip the code later it signs a
// one-time challenge from the gate. The private key can't be read out by any
// script, so copying the browser's storage to another machine gets nothing.
// trusted[] is keyed by the key's RFC 7638 thumbprint (a hash), and each entry
// records the account's tokensValidAfterTime: a password change or "sign out
// everywhere" moves that, which silently retires every trusted device.
//
// ENFORCEMENT lives in the token: the claims mfaRequired + mfaSessions (see
// mfaSatisfied above requireAuth). requireAuth and the Firestore rules both
// refuse a session whose auth_time has not passed a code, so skipping the
// browser overlay — or signing in straight through the Firebase REST API with a
// stolen password — gets nothing. users/{uid}.mfaEnabled is only a mirror for
// the Settings toggle, and the rules make it server-owned.
const MFA_CODE_TTL = 10 * 60 * 1000;         // 10 minutes
const MFA_TRUST_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const MFA_LOCK_MS = 15 * 60 * 1000;          // lockout after MFA_MAX_ATTEMPTS wrong codes
const MFA_MAX_ATTEMPTS = 5;
const MFA_MAX_SESSIONS = 10;                 // custom claims are capped at 1000 bytes
const MFA_CHALLENGE_TTL = 2 * 60 * 1000;     // device-key challenge lifetime
const MFA_MAX_DEVICES = 10;
// Each sign-in now makes two gate calls (challenge, then proof or send).
const mfaLimiter = rl(10 * 60 * 1000, 30, 'Too many 2FA attempts. Please wait a few minutes.');
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

function disableCodeEmailHtml(code) {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:440px;margin:auto;color:#1a1a1a;padding:8px">
    <h2 style="margin:0 0 8px;color:#C8973A">Turn off 2-factor authentication?</h2>
    <p>Someone signed in to your ETW Journal account asked to turn off email 2-factor authentication. Enter this code to confirm:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f4f4f6;border-radius:10px;padding:16px;text-align:center;margin:16px 0">${escapeHtml(code)}</div>
    <p style="color:#666;font-size:13px">This code expires in 10 minutes. <b>If this wasn't you</b>, don't share the code — reset your password immediately.</p>
    <p style="color:#999;font-size:12px;margin-top:16px">ETW Journal security</p>
  </div>`;
}

// Accept only a P-256 public JWK, reduced to the members that define the key.
function cleanDeviceJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  const b64u = /^[A-Za-z0-9_-]{43}$/;          // 32-byte coordinate, base64url
  if (!b64u.test(String(jwk.x)) || !b64u.test(String(jwk.y))) return null;
  try { crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }); }
  catch (e) { return null; }                   // not a point on the curve
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}
// RFC 7638 thumbprint: the device's id in trusted[], a hash rather than a secret.
function jwkThumbprint(jwk) {
  return crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
}
// What the browser signs: bound to the account and to this sign-in session, so a
// signature can't be replayed for anyone else or any other sign-in.
function deviceProofMessage(uid, authTime, challenge) {
  return Buffer.from('etw-mfa-device|' + uid + '|' + authTime + '|' + challenge);
}
function verifyDeviceSig(jwk, message, sigB64u) {
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    // WebCrypto ECDSA signatures are raw r||s (IEEE P1363), not DER.
    return crypto.verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(sigB64u), 'base64url'));
  } catch (e) { return false; }
}
// Live trusted devices only: unexpired, key-based (the old plain-ID entries are
// dropped), and minted under the account's current tokensValidAfterTime.
function liveTrusted(trusted, validAfter) {
  const now = Date.now(), out = {};
  for (const [id, t] of Object.entries(trusted || {})) {
    if (t && typeof t === 'object' && t.jwk && t.exp > now && t.validAfter === validAfter) out[id] = t;
  }
  return out;
}
// Add (or refresh) a trusted device, pruning dead entries in the same write.
async function trustDevice(uid, jwk, ua) {
  const user = await admin.auth().getUser(uid);
  const validAfter = user.tokensValidAfterTime || '';
  const ref = mfaRef(uid);
  await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const trusted = liveTrusted(((snap.exists && snap.data()) || {}).trusted, validAfter);
    trusted[jwkThumbprint(jwk)] = { jwk, exp: Date.now() + MFA_TRUST_TTL, addedAt: Date.now(), validAfter, ua: String(ua || '').slice(0, 200) };
    // Over the cap → forget the oldest.
    const ids = Object.keys(trusted).sort((a, b) => trusted[a].addedAt - trusted[b].addedAt);
    while (ids.length > MFA_MAX_DEVICES) delete trusted[ids.shift()];
    tx.set(ref, { trusted }, { mergeFields: ['trusted'] });
  });
}

// Edit the 2FA claims, keeping every other claim (subscription etc.) intact.
// Serialised with grantSubscription & co. so neither overwrites the other.
function editMfaClaims(uid, fn) {
  return withUidLock(uid, async () => {
    const user = await admin.auth().getUser(uid);
    const claims = Object.assign({}, user.customClaims || {});
    fn(claims);
    await admin.auth().setCustomUserClaims(uid, claims);
  });
}
// Mark one sign-in session (by its auth_time) as having passed 2FA.
function markSessionVerified(uid, authTime) {
  return editMfaClaims(uid, (c) => {
    c.mfaRequired = true;
    const prev = Array.isArray(c.mfaSessions) ? c.mfaSessions.filter((t) => t !== authTime) : [];
    c.mfaSessions = prev.concat(authTime).slice(-MFA_MAX_SESSIONS);
  });
}

// Email a fresh code for `purpose` ('signin' | 'disable'), bound to this sign-in
// session. `data` is the current private/mfa doc. Returns { status, error? }.
async function issueCode(uid, authTime, purpose, data) {
  const now = Date.now();
  if (data.lockedUntil && data.lockedUntil > now) return { status: 429, error: 'Too many wrong codes — try again in a few minutes.' };
  const code = String(crypto.randomInt(100000, 1000000));
  // A resend must not reset the wrong-guess counter, or resending would buy
  // unlimited guesses. It only starts over once the previous code has expired.
  const p = data.pending;
  const attempts = (p && p.exp > now && p.authTime === authTime) ? (p.attempts || 0) : 0;
  await mfaRef(uid).set({ pending: { hash: hashCode(code, uid), exp: now + MFA_CODE_TTL, attempts, authTime, purpose } }, { merge: true });
  const user = await admin.auth().getUser(uid).catch(() => null);
  if (!user || !user.email) return { status: 400, error: 'No email on this account to send a code to.' };
  const sent = await email.sendEmail(purpose === 'disable'
    ? { to: user.email, toName: user.displayName || '', subject: 'Confirm turning off 2-factor authentication', html: disableCodeEmailHtml(code) }
    : { to: user.email, toName: user.displayName || '', subject: 'Your ETW Journal sign-in code', html: codeEmailHtml(code) });
  if (!sent) return { status: 502, error: 'Could not send code email' };
  return { status: 200 };
}

// Check a submitted code for `purpose`, consuming it on success. Read-check-write
// runs in a transaction so parallel guesses can't all slip in under the attempt
// limit. Returns { status, error? }.
function checkCode(uid, authTime, code, purpose) {
  const ref = mfaRef(uid);
  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = (snap.exists && snap.data()) || {};
    const p = data.pending;
    const now = Date.now();
    if (data.lockedUntil && data.lockedUntil > now) return { status: 429, error: 'Too many wrong codes — try again in a few minutes.' };
    // Pre-purpose codes were all sign-in codes.
    if (!p || p.authTime !== authTime || (p.purpose || 'signin') !== purpose) return { status: 400, error: 'No code pending — request a new one.' };
    if (now > p.exp) { tx.set(ref, { pending: null }, { merge: true }); return { status: 400, error: 'Code expired — request a new one.' }; }
    if (hashCode(code, uid) !== p.hash) {
      const attempts = (p.attempts || 0) + 1;
      if (attempts >= MFA_MAX_ATTEMPTS) {
        tx.set(ref, { pending: null, lockedUntil: now + MFA_LOCK_MS }, { merge: true });
        return { status: 429, error: 'Too many wrong codes — try again in a few minutes.' };
      }
      tx.set(ref, { pending: { ...p, attempts } }, { merge: true });
      return { status: 401, error: 'Incorrect code.' };
    }
    tx.set(ref, { pending: null, lockedUntil: null }, { merge: true });
    return { status: 200 };
  });
}

// Decide whether this session needs a code. Three calls, one route:
//   {}                          → { required:true, challenge } (nothing emailed yet)
//   { proof:{ jwk, challenge, sig } } → trusted-device check; on failure emails a code
//   { send:true }               → email a code (no device key, or "Resend code")
// `refresh: true` tells the client its claims changed and it must fetch a new
// ID token (getIdToken(true)) before Firestore will let it in.
app.post('/api/mfa/gate', mfaLimiter, requireAuthPreMfa, async (req, res) => {
  // 2FA retired: no session is ever asked for a code.
  return res.json({ required: false });
  try {
    const body = req.body || {};
    const authTime = req.token.auth_time;
    let required = req.token.mfaRequired === true;
    if (!required) {
      // Accounts that switched 2FA on before it moved into the claim: the doc
      // flag is all they have. Promote it to the claim so it is enforced.
      const udoc = await admin.firestore().collection('users').doc(req.uid).get();
      if (!(udoc.exists && udoc.data().mfaEnabled === true)) return res.json({ required: false });
      await editMfaClaims(req.uid, (c) => { c.mfaRequired = true; });
      required = true;
    }
    if (mfaSatisfied(req.token)) return res.json({ required: false });

    const now = Date.now();
    const ref = mfaRef(req.uid);
    const snap = await ref.get();
    const data = (snap.exists && snap.data()) || {};

    if (body.proof) {
      // The challenge is single-use whatever the outcome.
      const ch = data.challenge;
      await ref.set({ challenge: null }, { merge: true });
      const jwk = cleanDeviceJwk(body.proof.jwk);
      const okChallenge = ch && ch.exp > now && ch.authTime === authTime && ch.value === String(body.proof.challenge || '');
      if (jwk && okChallenge) {
        const user = await admin.auth().getUser(req.uid);
        const t = liveTrusted(data.trusted, user.tokensValidAfterTime || '')[jwkThumbprint(jwk)];
        if (t && verifyDeviceSig(t.jwk, deviceProofMessage(req.uid, authTime, ch.value), body.proof.sig)) {
          await markSessionVerified(req.uid, authTime);
          return res.json({ required: false, refresh: true });
        }
      }
      // Not a (still) trusted device — fall through and email a code.
    } else if (!body.send) {
      const value = crypto.randomBytes(32).toString('base64url');
      await ref.set({ challenge: { value, exp: now + MFA_CHALLENGE_TTL, authTime } }, { merge: true });
      return res.json({ required: true, challenge: value });
    }

    const r = await issueCode(req.uid, authTime, 'signin', data);
    res.status(r.status).json({ required: true, sent: r.status === 200, ...(r.error ? { error: r.error } : {}) });
  } catch (e) { console.error('mfa gate:', e.message); res.status(500).json({ error: 'MFA error' }); }
});

// Verify a submitted sign-in code; optionally trust the device for 30 days.
app.post('/api/mfa/verify', mfaLimiter, requireAuthPreMfa, async (req, res) => {
  try {
    const code = String((req.body && req.body.code) || '');
    const jwk = req.body && req.body.trust ? cleanDeviceJwk(req.body.publicKey) : null;
    const authTime = req.token.auth_time;
    const result = await checkCode(req.uid, authTime, code, 'signin');
    if (result.status !== 200) return res.status(result.status).json({ ok: false, error: result.error });
    await markSessionVerified(req.uid, authTime);
    if (jwk) await trustDevice(req.uid, jwk, req.get('user-agent'));
    res.json({ ok: true, refresh: true });
  } catch (e) { console.error('mfa verify:', e.message); res.status(500).json({ ok: false, error: 'MFA error' }); }
});

// Whether 2FA is on, from the live user record rather than the caller's token,
// which can be up to an hour stale. The doc flag covers not-yet-backfilled accounts.
async function mfaIsOn(uid) {
  const user = await admin.auth().getUser(uid);
  if ((user.customClaims || {}).mfaRequired === true) return true;
  const udoc = await db.collection('users').doc(uid).get();
  return udoc.exists && udoc.data().mfaEnabled === true;
}

// Turn 2FA on or off. Switching it ON marks the current session (and device, if
// given) as verified, so the user isn't locked out of the tab they are using.
// Switching it OFF takes two calls: without `code` it emails a fresh one and
// answers { codeRequired: true }; with `code` it checks it and turns 2FA off. A
// verified session alone isn't enough — someone at an unlocked, trusted laptop
// must not be able to strip 2FA without access to the mailbox.
app.post('/api/mfa/settings', mfaLimiter, requireAuth, async (req, res) => {
  // 2FA retired: it can no longer be switched on. Any call simply makes sure
  // it is off for this account (claims removed, doc flag cleared).
  try {
    await editMfaClaims(req.uid, (c) => { delete c.mfaRequired; delete c.mfaSessions; });
    await db.collection('users').doc(req.uid).set({ mfaEnabled: false }, { merge: true });
    return res.json({ ok: true, enabled: false, refresh: true });
  } catch (e) { console.error('mfa settings:', e.message); return res.status(500).json({ ok: false, error: 'Could not update settings.' }); }
  try {
    const on = !!(req.body && req.body.enabled);
    const jwk = cleanDeviceJwk(req.body && req.body.publicKey);
    if (on) {
      await markSessionVerified(req.uid, req.token.auth_time);
      if (jwk) await trustDevice(req.uid, jwk, req.get('user-agent'));
    } else if (await mfaIsOn(req.uid)) {
      const authTime = req.token.auth_time;
      if (!(req.body && req.body.code)) {
        const snap = await mfaRef(req.uid).get();
        const r = await issueCode(req.uid, authTime, 'disable', (snap.exists && snap.data()) || {});
        if (r.status !== 200) return res.status(r.status).json({ ok: false, error: r.error });
        return res.json({ ok: false, codeRequired: true, sent: true });
      }
      const result = await checkCode(req.uid, authTime, String(req.body.code), 'disable');
      if (result.status !== 200) return res.status(result.status).json({ ok: false, codeRequired: true, error: result.error });
      await editMfaClaims(req.uid, (c) => { delete c.mfaRequired; delete c.mfaSessions; });
      await mfaRef(req.uid).set({ pending: null, challenge: null, trusted: {}, lockedUntil: null }, { mergeFields: ['pending', 'challenge', 'trusted', 'lockedUntil'] });
    } else {
      // 2FA was never really on (no claim) — nothing to protect, just tidy up.
      await mfaRef(req.uid).set({ pending: null, challenge: null, trusted: {}, lockedUntil: null }, { mergeFields: ['pending', 'challenge', 'trusted', 'lockedUntil'] });
    }
    await db.collection('users').doc(req.uid).set({ mfaEnabled: on }, { merge: true });
    res.json({ ok: true, enabled: on, refresh: true });
  } catch (e) { console.error('mfa settings:', e.message); res.status(500).json({ ok: false, error: 'Could not update 2FA.' }); }
});

// Trusted devices, for Settings. `current` is the thumbprint of the key the
// caller's browser holds (it sends its public key), so the list can say "this device".
app.post('/api/mfa/devices', mfaLimiter, requireAuth, async (req, res) => {
  try {
    const user = await admin.auth().getUser(req.uid);
    const snap = await mfaRef(req.uid).get();
    const live = liveTrusted(((snap.exists && snap.data()) || {}).trusted, user.tokensValidAfterTime || '');
    const mine = cleanDeviceJwk(req.body && req.body.publicKey);
    const current = mine ? jwkThumbprint(mine) : '';
    const devices = Object.entries(live)
      .map(([id, t]) => ({ id, ua: t.ua || '', addedAt: t.addedAt, exp: t.exp, current: id === current }))
      .sort((a, b) => b.addedAt - a.addedAt);
    res.json({ ok: true, devices });
  } catch (e) { console.error('mfa devices:', e.message); res.status(500).json({ ok: false, error: 'Could not load devices.' }); }
});
// Forget one trusted device ({ id }) or all of them ({ all: true }). It takes
// effect at that device's next sign-in; sessions already verified stay so.
app.post('/api/mfa/devices/remove', mfaLimiter, requireAuth, async (req, res) => {
  try {
    const ref = mfaRef(req.uid);
    if (req.body && req.body.all === true) {
      await ref.set({ trusted: {} }, { mergeFields: ['trusted'] });
    } else {
      const id = String((req.body && req.body.id) || '');
      if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return res.status(400).json({ ok: false, error: 'Unknown device.' });
      await ref.update(new admin.firestore.FieldPath('trusted', id), admin.firestore.FieldValue.delete());
    }
    res.json({ ok: true });
  } catch (e) { console.error('mfa devices remove:', e.message); res.status(500).json({ ok: false, error: 'Could not remove device.' }); }
});

// Boot-time cleanup (2FA retired): strip the 2FA claims from every account
// that still carries them and clear the users/{uid}.mfaEnabled flag, so no
// account is held back by an old 2FA setting. Other claims (subscription,
// plan, expiry) are kept exactly as they are. Safe to run on every boot.
async function backfillMfaClaims() {
  let cleared = 0;
  try {
    let pageToken;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      for (const u of page.users) {
        const c = u.customClaims || {};
        if (!('mfaRequired' in c) && !('mfaSessions' in c)) continue;
        await editMfaClaims(u.uid, (cl) => { delete cl.mfaRequired; delete cl.mfaSessions; });
        cleared++;
      }
      pageToken = page.pageToken;
    } while (pageToken);
    const snap = await db.collection('users').where('mfaEnabled', '==', true).get();
    for (const doc of snap.docs) await doc.ref.set({ mfaEnabled: false }, { merge: true });
    if (snap.size) console.log('[mfa] cleared mfaEnabled flag for', snap.size, 'user(s)');
  } catch (e) { console.warn('[mfa] cleanup failed:', e.message); }
  if (cleared) console.log('[mfa] removed 2FA claims from', cleared, 'user(s)');
}

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

// Serialise claim edits per uid (grants, bonus credits, clawbacks) so two events
// landing together can't read the same expiresAt and overwrite each other.
const _uidLocks = new Map();
function withUidLock(uid, fn) {
  const prev = _uidLocks.get(uid) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  _uidLocks.set(uid, tail);
  tail.then(() => { if (_uidLocks.get(uid) === tail) _uidLocks.delete(uid); });
  return run;
}

// The ONE place access is granted: sets the custom claim (source of truth for
// Firestore rules + the frontend) and mirrors it to users/{uid}.subscription.
// keepExpiresAt preserves an existing period (used by mid-cycle upgrades).
async function grantSubscription(uid, plan, cycle, extra = {}, keepExpiresAt = 0) {
  // Serialised per uid with the referral bonus credits/clawbacks below, so two
  // writers can never read the same claim and overwrite each other's expiresAt.
  return withUidLock(uid, async () => {
    const days = PLAN_DAYS[cycle] || 31;
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // startedAt = when this subscriber first paid. Preserved across renewals and
    // upgrades so the Settings card can show a real "Subscribed on" date instead
    // of the most recent charge. The same read gives us the referral bonus state.
    let startedAt = now, ref = {};
    try {
      const prev = await db.collection('users').doc(uid).get();
      const prevStart = prev.exists && prev.data().subscription && prev.data().subscription.startedAt;
      if (prevStart) startedAt = Number(prevStart);
      ref = (prev.exists && prev.data().referral) || {};
    } catch (e) { /* first-time subscriber, or read failed — today is correct enough */ }

    const user = await admin.auth().getUser(uid);
    const prevClaims = user.customClaims || {};
    let expiresAt, bonusMs = Math.max(0, Number(ref.bonusMs || 0)), bankUsed = 0;

    if (Number(keepExpiresAt) > now) {
      expiresAt = Number(keepExpiresAt);
    } else {
      expiresAt = now + days * DAY;
      // Referral bonus days already sitting on the current period are carried
      // over (a renewal must not wipe them), capped at what is actually unused.
      const carry = Math.min(bonusMs, Math.max(0, Number(prevClaims.expiresAt || 0) - now));
      // Banked bonus days (earned while not subscribed) — or a negative balance
      // left by a clawback — are settled on this new period.
      bankUsed = Math.trunc(Number(ref.bankedDays || 0));
      expiresAt = Math.max(now + DAY, expiresAt + carry + bankUsed * DAY);
      bonusMs = carry + Math.max(0, bankUsed) * DAY;
    }

    const claims = Object.assign({}, prevClaims, { subscribed: true, plan, expiresAt });
    await admin.auth().setCustomUserClaims(uid, claims);

    const doc = { subscription: { plan, cycle, status: 'active', expiresAt, startedAt, updatedAt: Date.now(), ...extra } };
    if (Number(keepExpiresAt) <= now) {
      doc.referral = { bonusMs };
      if (bankUsed) doc.referral.bankedDays = admin.firestore.FieldValue.increment(-bankUsed);
    }
    await db.collection('users').doc(uid).set(doc, { merge: true });
    // Pro → resume any MT5 Direct account held for the plan; Essential → hold it.
    setTimeout(() => { enforceDirectPlan(uid).catch(() => {}); }, 1500);
    return expiresAt;
  });
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
  enforceDirectPlan(uid).catch(() => {});
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
    const isRenewal = order.kind === 'renewal';
    const planName = planTitle(order.plan);
    const body = isUpgrade
      ? `<p>You're on <b>Pro</b> — Mentor mode, ETW AI and Trade Replay are unlocked right now.</p>
         <p>You paid only the difference (<b>${money(order.amount, order.currency)}</b>), and your end date is unchanged: <b>${nice(expiresAt)}</b>.</p>`
      : `<p>${isRenewal ? `Your <b>${planName}</b> membership renewed automatically — <b>${money(order.amount, order.currency)}</b> was charged to your saved card and your access now runs to <b>${nice(expiresAt)}</b>.` : `Thanks — your payment of <b>${money(order.amount, order.currency)}</b> went through and your <b>${planName}</b> plan is active.`}</p>
         <table style="border-collapse:collapse;margin:14px 0;font-size:14px">
           <tr><td style="padding:4px 14px 4px 0;color:#666">Plan</td><td><b>${planName}</b> (${['yearly','quarterly','monthly'].indexOf(order.cycle) >= 0 ? order.cycle : 'monthly'})</td></tr>
           <tr><td style="padding:4px 14px 4px 0;color:#666">Amount</td><td>${money(order.amount, order.currency)}</td></tr>
           <tr><td style="padding:4px 14px 4px 0;color:#666">Access until</td><td>${nice(expiresAt)}</td></tr>
           <tr><td style="padding:4px 14px 4px 0;color:#666">Auto-renew</td><td>Yes — your card is charged automatically each period. Manage or cancel any time from your Gumroad receipt or library</td></tr>
         </table>`;
    await email.sendEmail({
      to: user.email, toName: user.displayName || '',
      subject: isUpgrade ? "You're on ETW Journal Pro" : isRenewal ? 'Your ETW Journal ' + planName + ' membership renewed' : 'Payment received — ETW Journal ' + planName,
      html: emailShell(isUpgrade ? 'Welcome to Pro' : isRenewal ? 'Membership renewed' : 'Payment received', body, 'Open your journal', APP_URL + '/journal.html'),
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
          `<p>Your <b>${planTitle(sub.plan)}</b> plan ended on <b>${nice(sub.expiresAt)}</b>, so journalling, broker sync and analytics are locked for now.</p>
           <p><b>Nothing has been deleted.</b> Every trade, note and playbook is exactly where you left it and comes straight back the moment you resubscribe.</p>`,
          'Reactivate my plan', APP_URL + '/payment'),
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
    // An alive membership renews by itself — no "pay again" email for it.
    if (sub.autoRenew && sub.subscriptionId) { out.skipped++; continue; }
    try {
      const user = await admin.auth().getUser(doc.id);
      if (!user.email) { out.skipped++; continue; }
      const left = Math.max(1, Math.ceil((Number(sub.expiresAt) - now) / DAY_MS));
      await email.sendEmail({
        to: user.email, toName: user.displayName || '',
        subject: 'Your ETW Journal plan ends in ' + left + ' day' + (left === 1 ? '' : 's'),
        html: emailShell('Your plan is about to end',
          `<p>Your <b>${planTitle(sub.plan)}</b> plan ends on <b>${nice(sub.expiresAt)}</b> — that's ${left} day${left === 1 ? '' : 's'} away.</p>
           <p>Nothing renews automatically, so pay again before then to keep going. Your trades stay exactly where they are either way; they just become read-only until you're back.</p>`,
          'Pay for another period', APP_URL + '/payment'),
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
      const gsub = doc.data().subscription || {};
      if (gsub.subscriptionId && gsub.autoRenew && gsub.status === 'active') {
        const r = await refreshMembership(doc.id, { force: true }).catch(() => null);
        if (r && r.healed) { out.renewed = (out.renewed || 0) + 1; continue; }
      }
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
  if (!secretMatches(given, secret)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await sweepSubscriptions();
    // Also heal any Gumroad sales whose ping never landed. Failure here must
    // not fail the sweep — the two jobs are independent.
    let gumroadSweep = null;
    try { gumroadSweep = await reconcileGumroadSales(3); }
    catch (e) { gumroadSweep = { error: e.message }; }
    let mt5Pro = null;
    try { mt5Pro = await sweepDirectPlans(); } catch (e) { mt5Pro = { error: e.message }; }
    res.json({ ok: true, ...r, gumroad: gumroadSweep, mt5Pro });
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

    // Token packs aren't access, they're balance — so claw the tokens back
    // rather than revoking a subscription this sale never granted. Anything
    // already spent on sync is unrecoverable (we can't un-import trades), so
    // clawback takes only what's still unspent and logs the shortfall.
    if (granted.kind === 'tokens') {
      const recovered = await tokens.clawback(granted.uid, granted.tokens || 0, {
        ref: saleId, note: 'Gumroad ' + kind,
      }).catch((e) => { console.error('[gumroad] token clawback:', e.message); return 0; });
      await ref.set({ status: 'REFUNDED', reason: kind, refundedAt: Date.now(), recovered }, { merge: true });
      console.log(`[gumroad] ${kind} on token sale ${saleId}: recovered ${recovered}/${granted.tokens} from ${granted.uid}`);
      return { ok: true, recovered };
    }

    const snap = await db.collection('users').doc(granted.uid).get();
    const sub = (snap.exists && snap.data().subscription) || {};
    const backsAccess = sub.saleId === saleId && sub.status === 'active';
    if (backsAccess) {
      await revokeSubscription(granted.uid, { reason: kind, saleId });
      console.log('[gumroad] revoked access for', granted.uid, 'after', kind, 'of sale', saleId);
    }
    await ref.set({ status: 'REFUNDED', reason: kind, refundedAt: Date.now(), revoked: backsAccess }, { merge: true });
    await referralOnRefund(granted.uid, saleId)
      .catch((e) => console.error('[referral] clawback for sale', saleId + ':', e.message));
    return { ok: true, revoked: backsAccess };
  }

  if (refunded) {
    await ref.set({ status: 'IGNORED', reason: sale.refunded ? 'refunded' : 'chargedback', at: Date.now() }, { merge: true });
    return { ok: false, reason: 'refunded' };
  }
  // Who is this for? The checkout URL stamps the buyer's Firebase uid on and
  // Gumroad echoes it back in url_params. Fall back to matching the purchase
  // email, for anyone who bought from the Gumroad page directly. Shared by the
  // plan and token paths below.
  async function resolveUid() {
    const rawUid = String((ping && ping.url_params && ping.url_params.uid) || '').trim();
    if (/^[A-Za-z0-9]{10,128}$/.test(rawUid)) {
      try { return (await admin.auth().getUser(rawUid)).uid; } catch (e) { /* stale uid — try email */ }
    }
    // Automatic renewal charges don't always carry the checkout's url_params,
    // but they carry the membership's subscription_id: the account that the
    // first charge of this membership unlocked is the one it keeps renewing.
    const subId = String(sale.subscription_id || (ping && ping.subscription_id) || '').trim();
    if (subId) {
      const u = await uidForSubscription(subId);
      if (u) return u;
    }
    if (sale.email) {
      try { return (await admin.auth().getUserByEmail(String(sale.email).trim())).uid; } catch (e) { /* no account */ }
    }
    return null;
  }

  // ── Auto-Sync token pack? ─────────────────────────────────────────────────
  // Checked BEFORE matchSale so a token product can never fall through into the
  // plan path and hand someone a free subscription.
  const tokenSale = gumroad.matchTokenSale(sale);
  if (tokenSale) {
    const tuid = await resolveUid();
    if (!tuid) {
      await ref.set({ status: 'UNMATCHED', kind: 'tokens', email: sale.email || null, tokens: tokenSale.tokens, at: Date.now() }, { merge: true });
      console.warn('[gumroad] paid token pack with no matching account:', saleId, sale.email || '(no email)');
      return { ok: false, reason: 'no matching account' };
    }
    // Claim the sale id and credit in that order: the ledger entry carries the
    // sale id, so a retry of this ping finds `granted` above and stops.
    await ref.set({
      status: 'GRANTED', kind: 'tokens', uid: tuid, tokens: tokenSale.tokens,
      email: sale.email || null, productId: sale.product_id || null, at: Date.now(),
    }, { merge: true });
    const balance = await tokens.credit(tuid, tokenSale.tokens, {
      kind: 'purchase', ref: saleId, note: 'Gumroad token pack',
    });
    console.log(`[gumroad] +${tokenSale.tokens} sync tokens -> ${tuid} (sale ${saleId}, balance ${balance})`);
    return { ok: true, uid: tuid, tokens: tokenSale.tokens, balance };
  }

  const matched = gumroad.matchSale(sale);
  if (!matched) {
    await ref.set({ status: 'IGNORED', reason: 'unknown product', productId: sale.product_id || null, at: Date.now() }, { merge: true });
    return { ok: false, reason: 'not an ETW product' };
  }
  const { plan, cycle } = matched;

  let uid = await resolveUid();
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

  const subscriptionId = sale.subscription_id || null;
  const recurring = !!((ping && String(ping.is_recurring_charge) === 'true') || sale.is_recurring_charge === true
    || String(sale.is_recurring_charge) === 'true');

  // Two memberships at once (someone upgraded and hasn't cancelled the old
  // one yet): a renewal of the LOWER plan must never pull the higher plan's
  // access down. Record the charge, keep the better plan and its end date, and
  // flag it so the app can tell them they're still paying for the old one.
  const RANK = { essential: 1, pro: 2, ultra: 3 };
  try {
    const u = await admin.auth().getUser(uid);
    const c = u.customClaims || {};
    const curSnap = await db.collection('users').doc(uid).get();
    const cur = (curSnap.exists && curSnap.data().subscription) || {};
    const higherActive = c.subscribed && Number(c.expiresAt) > Date.now() && !cur.comp
      && (RANK[c.plan] || 0) > (RANK[plan] || 0)
      && subscriptionId && cur.subscriptionId !== subscriptionId;
    if (higherActive) {
      // HELD, not GRANTED: once the higher plan runs out this charge is settled
      // for real (see settleHeldSales) — so a deliberate downgrade still gets
      // every day it paid for, just after the better plan ends.
      await ref.set({
        status: 'HELD', uid, plan, cycle, at: Date.now(), heldUnder: c.plan, heldUntil: Number(c.expiresAt),
        email: sale.email || null, subscriptionId, recurring, amount, currency,
      }, { merge: true });
      await db.collection('users').doc(uid).set({ subscription: { extraMembership: {
        plan, cycle, subscriptionId, lastChargeAt: Date.now(), amount, currency,
      } } }, { merge: true });
      console.warn(`[gumroad] ${uid} paid ${plan} (sale ${saleId}) while on active ${c.plan} — held until it ends`);
      return { ok: true, uid, plan: c.plan, held: true, expiresAt: Number(c.expiresAt) };
    }
  } catch (e) { /* the normal grant below is the safe default */ }

  // Moving from an older one-off plan onto an auto-renewing membership of the
  // SAME plan: the days already paid for are kept, and the new period starts
  // after them. (Renewals of the same membership start from now — the charge
  // lands on the renewal date, so nothing is lost.)
  let keepUntil = 0;
  try {
    const u2 = await admin.auth().getUser(uid);
    const c2 = u2.customClaims || {};
    const s2 = await db.collection('users').doc(uid).get();
    const cur2 = (s2.exists && s2.data().subscription) || {};
    const prevExp = Number(c2.expiresAt || 0);
    if (!recurring && subscriptionId && !cur2.comp && c2.subscribed && c2.plan === plan
        && prevExp > Date.now() && cur2.subscriptionId !== subscriptionId) {
      keepUntil = prevExp + (PLAN_DAYS[cycle] || 31) * DAY_MS;
    }
  } catch (e) { /* default: a fresh period from now */ }

  const expiresAt = await grantSubscription(uid, plan, cycle, {
    provider: 'gumroad', saleId, subscriptionId,
    // Auto-renew state, shown in Settings. A charge means the membership is alive.
    autoRenew: !!subscriptionId, membershipStatus: subscriptionId ? 'alive' : null,
    lastChargeAt: Date.now(), renewals: recurring ? admin.firestore.FieldValue.increment(1) : admin.firestore.FieldValue.increment(0),
    cancelledAt: null, endedAt: null, failedAt: null,
  }, keepUntil);
  await ref.set({
    status: 'GRANTED', uid, plan, cycle, expiresAt, at: Date.now(),
    email: sale.email || null, subscriptionId, recurring,
    amount, currency,
  }, { merge: true });
  if (recurring) console.log(`[gumroad] auto-renewed ${plan}/${cycle} for ${uid} (sale ${saleId}) — access until ${new Date(expiresAt).toISOString()}`);

  // Receipt + audience sync are fire-and-forget: access is already granted, and
  // a Brevo hiccup must never turn a successful payment into an error.
  sendReceiptEmail(uid, { plan, cycle, kind: recurring ? 'renewal' : 'new', amount, currency }, expiresAt).catch(() => {});
  syncBrevoContact(uid, { force: true }).catch(() => {});
  // Referral reward for whoever referred this buyer (verified sale only).
  await referralOnPaidSale({ uid, plan, cycle, saleId, saleEmail: sale.email || '' })
    .catch((e) => console.error('[referral] reward for sale', saleId + ':', e.message));
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
//  AUTO-RENEWING MEMBERSHIPS — keeping the app in step with Gumroad
// ══════════════════════════════════════════════════════════════
// How a renewal reaches the app:
//  1. Gumroad charges the saved card and fires the sale Ping → /api/gumroad/ping
//     → settleGumroadSale() grants a fresh period (the access end date moves on).
//  2. If that ping is missed (Render asleep, deploy), it is caught by: the
//     reconcile sweep (boot, every few hours, the daily cron), and by
//     refreshMembership() the moment the trader opens the app near/after the
//     end date — it asks Gumroad for the membership's charges and settles any
//     we haven't seen.
//  3. Cancellation / end / restart arrive as resource-subscription posts; they
//     only update the "auto-renew" state shown in Settings. Access itself always
//     runs to the end of the period already paid for.

// Which account does a Gumroad membership belong to? The one its earlier
// charges were granted to.
async function uidForSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  try {
    const q = await db.collection('gumroadSales').where('subscriptionId', '==', String(subscriptionId)).limit(10).get();
    for (const d of q.docs) { const x = d.data(); if (x && x.uid && (x.status === 'GRANTED' || x.status === 'HELD')) return x.uid; }
  } catch (e) { console.warn('[gumroad] uid for subscription', subscriptionId + ':', e.message); }
  return null;
}

// The membership that backs this trader's access, taken from OUR sales records
// (gumroadSales is server-only), never from users/{uid}.subscription. The
// latest charge we actually granted to this uid decides it, so nobody can
// point their account at someone else's membership and collect its charges.
async function subscriptionIdForUid(uid) {
  try {
    const q = await db.collection('gumroadSales').where('uid', '==', uid).limit(100).get();
    let best = null;
    for (const d of q.docs) {
      const x = d.data() || {};
      if (x.status !== 'GRANTED' || !x.subscriptionId) continue;
      if (!best || Number(x.at || 0) > Number(best.at || 0)) best = x;
    }
    return best ? String(best.subscriptionId) : null;
  } catch (e) { console.warn('[gumroad] subscription for uid', uid + ':', e.message); return null; }
}

// Charges parked while a higher plan was active (see settleGumroadSale).
async function settleHeldSales(uid) {
  let n = 0;
  try {
    const q = await db.collection('gumroadSales').where('uid', '==', uid).where('status', '==', 'HELD').limit(5).get();
    for (const d of q.docs) {
      try { const r = await settleGumroadSale(d.id, { subscription_id: d.data().subscriptionId || '' }); if (r && r.ok && !r.held) n++; }
      catch (e) { console.warn('[gumroad] held sale', d.id + ':', e.message); }
    }
  } catch (e) { /* index still building or no held sales */ }
  return n;
}

// Mirror a membership's live Gumroad state onto users/{uid}.subscription.
function membershipMirror(sub) {
  const st = String(sub.status || '').toLowerCase();
  const ms = (v) => { const t = v ? Date.parse(v) : NaN; return isFinite(t) ? t : null; };
  return {
    membershipStatus: st || null,
    autoRenew: st === 'alive' || st === 'pending_failure',
    cancelledAt: ms(sub.cancelled_at) || ms(sub.user_requested_cancellation_at),
    endedAt: ms(sub.ended_at),
    failedAt: ms(sub.failed_at),
    membershipCheckedAt: Date.now(),
  };
}

// Ask Gumroad about this trader's membership: update the auto-renew mirror and
// settle any renewal charge whose ping we never received. Throttled per uid.
const _memRefreshAt = new Map();
async function refreshMembership(uid, opts) {
  const force = !!(opts && opts.force);
  if (!gumroad.configured()) return null;
  const last = _memRefreshAt.get(uid) || 0;
  if (!force && Date.now() - last < 10 * 60 * 1000) return null;
  _memRefreshAt.set(uid, Date.now());
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const cur = (snap.exists && snap.data().subscription) || {};
  if (cur.comp) return null;
  const subId = await subscriptionIdForUid(uid);   // trusted source, not the doc
  if (!subId) return null;
  let sub;
  try { sub = await gumroad.getSubscriber(subId); }
  catch (e) { console.warn('[gumroad] membership refresh', uid + ':', e.message); return null; }
  let healed = 0;
  const ids = Array.isArray(sub.purchase_ids) ? sub.purchase_ids.slice(-6) : [];
  for (const id of ids) {
    try {
      const seen = await db.collection('gumroadSales').doc(String(id)).get();
      if (seen.exists && ['GRANTED', 'HELD', 'REFUNDED'].includes(seen.data().status)) continue;
      const r = await settleGumroadSale(String(id), { subscription_id: subId, url_params: { uid } });
      if (r && r.ok && !r.already) healed++;
    } catch (e) { console.warn('[gumroad] refresh settle', id + ':', e.message); }
  }
  await ref.set({ subscription: membershipMirror(sub) }, { merge: true });
  if (healed) console.log(`[gumroad] membership refresh for ${uid}: settled ${healed} missed renewal charge(s)`);
  return { status: sub.status, healed };
}

// Cancellation / subscription_ended / subscription_restarted / subscription_updated
// posts. Unauthenticated, so only the subscription id is used — the real state
// is fetched from Gumroad with our token.
async function handleMembershipEvent(subscriptionId, body) {
  const subId = String(subscriptionId || '').trim();
  if (!subId) return { ok: false, reason: 'no subscription_id' };
  let sub;
  try { sub = await gumroad.getSubscriber(subId); }
  catch (e) { return { ok: false, reason: 'unknown subscription' }; }
  let uid = await uidForSubscription(subId);
  if (!uid && sub.user_email) {
    try { uid = (await admin.auth().getUserByEmail(String(sub.user_email).trim())).uid; } catch (e) { /* no account */ }
  }
  if (!uid) return { ok: false, reason: 'no matching account' };
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const cur = (snap.exists && snap.data().subscription) || {};
  const mirror = membershipMirror(sub);
  // A different membership than the one backing access (e.g. the old plan after
  // an upgrade) only updates that side note.
  const backing = await subscriptionIdForUid(uid);
  if (backing && backing !== subId) {
    if (cur.extraMembership && cur.extraMembership.subscriptionId === subId) {
      await ref.set({ subscription: { extraMembership: { membershipStatus: mirror.membershipStatus, autoRenew: mirror.autoRenew } } }, { merge: true });
    }
    return { ok: true, uid, side: true };
  }
  await ref.set({ subscription: mirror }, { merge: true });
  // A restart charges the card — make sure that charge is settled right away.
  if (mirror.autoRenew) refreshMembership(uid, { force: true }).catch(() => {});
  console.log(`[gumroad] membership ${subId} for ${uid}: ${sub.status}`);
  return { ok: true, uid, status: sub.status };
}

// ══════════════════════════════════════════════════════════════
//  REFERRAL PROGRAM — server-owned end to end
// ══════════════════════════════════════════════════════════════
// Rewards (to the REFERRER, when the person they referred pays):
//   Essential plan ............ 7 bonus days
//   Pro plan .................. 15 bonus days
//   Quarterly or yearly cycle . +5 bonus days on top of the above
//
// Why nothing here can be gamed from a browser:
//  * Codes, referral links and rewards live in referralCodes/{code},
//    referrals/{referredUid} and users/{uid}.referral / .referredBy — all
//    written ONLY here (Admin SDK). Firestore rules deny every client write.
//  * A reward is paid only from settleGumroadSale(), i.e. after Gumroad itself
//    confirms a real, unrefunded sale. Admin grants and comp accounts never pay
//    out. Bonus days go onto the referrer's custom claim (the real access gate).
//  * One referrer per user, forever. You can only be referred BEFORE you have
//    ever paid, never by yourself (same uid or same normalised email), and a
//    sale paid from the referrer's own email does not count.
//  * Rewards are tracked per sale and capped per referred user at the value of
//    the best plan they bought: renewals add nothing, an upgrade (Essential →
//    Pro, monthly → yearly) only tops up the difference, and every award is
//    idempotent on the sale id, so Gumroad retries/reconciles cannot double pay.
//  * A refund or chargeback of the paying sale claws the bonus back.
const REFERRAL_BASE_DAYS = { essential: 7, pro: 15, ultra: 15 };
const REFERRAL_LONG_CYCLE_BONUS = 5;              // quarterly or yearly
const REFERRAL_DAY_MS = 24 * 60 * 60 * 1000;
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I
const referralLimiter      = rl(15 * 60 * 1000, 60, 'Too many requests. Please wait a few minutes.');
const referralClaimLimiter = rl(60 * 60 * 1000, 10, 'Too many referral attempts. Please try again later.');

function referralDaysFor(plan, cycle) {
  const base = REFERRAL_BASE_DAYS[String(plan || '').toLowerCase()] || 0;
  if (!base) return 0;
  const c = String(cycle || '').toLowerCase();
  return base + (c === 'quarterly' || c === 'yearly' ? REFERRAL_LONG_CYCLE_BONUS : 0);
}

// Gmail ignores dots and +tags — normalise so "a.b+x@gmail.com" == "ab@gmail.com".
function normEmail(e) {
  let s = String(e || '').trim().toLowerCase();
  const at = s.lastIndexOf('@'); if (at < 1) return s;
  let local = s.slice(0, at), dom = s.slice(at + 1);
  local = local.split('+')[0];
  if (dom === 'gmail.com' || dom === 'googlemail.com') { local = local.replace(/\./g, ''); dom = 'gmail.com'; }
  return local + '@' + dom;
}
function maskEmail(e) {
  const s = String(e || ''); const at = s.indexOf('@');
  if (at < 1) return 'New trader';
  return s.slice(0, Math.min(2, at)) + '•••' + s.slice(at);
}
function referralCodeOk(c) { return /^[A-HJ-NP-Z2-9]{8}$/.test(c); }
function newReferralCode() {
  let s = ''; for (let i = 0; i < 8; i++) s += REFERRAL_ALPHABET[crypto.randomInt(REFERRAL_ALPHABET.length)];
  return s;
}

async function getOrCreateReferralCode(uid) {
  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  const existing = snap.exists && snap.data().referral && snap.data().referral.code;
  if (existing && referralCodeOk(existing)) return existing;
  for (let i = 0; i < 6; i++) {
    const code = newReferralCode();
    const ok = await db.runTransaction(async (tx) => {
      const cRef = db.collection('referralCodes').doc(code);
      const [c, u] = await Promise.all([tx.get(cRef), tx.get(userRef)]);
      const cur = u.exists && u.data().referral && u.data().referral.code;
      if (cur) return cur;                      // another request created it first
      if (c.exists) return null;                // collision — try a new code
      tx.set(cRef, { uid, createdAt: Date.now() });
      tx.set(userRef, { referral: { code, createdAt: Date.now() } }, { merge: true });
      return code;
    });
    if (ok) return ok;
  }
  throw new Error('Could not create a referral code, please retry.');
}

// Has this account EVER paid (or been granted) access? Then it can't be referred.
async function hasEverBeenCustomer(uid, userRecord) {
  const c = (userRecord && userRecord.customClaims) || {};
  if (c.subscribed) return true;
  const u = await db.collection('users').doc(uid).get();
  const sub = (u.exists && u.data().subscription) || {};
  if (sub.startedAt || sub.saleId || sub.provider || sub.comp || sub.status === 'active' || sub.status === 'revoked') return true;
  const sales = await db.collection('gumroadSales').where('uid', '==', uid).limit(5).get();
  return sales.docs.some((d) => ['GRANTED', 'REFUNDED'].includes(d.data().status));
}

// Add (days > 0) or remove (days < 0) bonus time on a user's access.
// Active subscriber → moves the claim's expiresAt. Otherwise the days are banked
// and grantSubscription() adds them to the next period they pay for.
async function adjustReferralBonus(uid, days, why) {
  if (!days) return { applied: 0, banked: 0 };
  return withUidLock(uid, async () => {
    const user = await admin.auth().getUser(uid);
    if (isComp(user.email)) return { applied: 0, banked: 0, comp: true };
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    const r = (snap.exists && snap.data().referral) || {};
    const c = user.customClaims || {};
    const now = Date.now();
    const deltaMs = days * REFERRAL_DAY_MS;
    const earned = Math.max(0, Number(r.earnedDays || 0) + days);

    if (c.subscribed && Number(c.expiresAt) > now) {
      const expiresAt = Math.max(now, Number(c.expiresAt) + deltaMs);
      await admin.auth().setCustomUserClaims(uid, Object.assign({}, c, { expiresAt }));
      const bonusMs = Math.max(0, Number(r.bonusMs || 0) + deltaMs);
      await ref.set({
        subscription: { expiresAt, updatedAt: now },
        referral: { bonusMs, earnedDays: earned, lastBonusAt: now },
      }, { merge: true });
      console.log(`[referral] ${days > 0 ? '+' : ''}${days}d on ${uid} (${why}) → ${ymd(expiresAt)}`);
      return { applied: days, banked: 0, expiresAt };
    }
    // Not active right now: bank it. A clawback may take the bank below zero —
    // that debt comes off the next paid period, so a refund can't keep free days.
    const banked = Number(r.bankedDays || 0) + days;
    await ref.set({ referral: { bankedDays: banked, earnedDays: earned, lastBonusAt: now } }, { merge: true });
    console.log(`[referral] ${days > 0 ? 'banked +' : 'bank '}${days}d for ${uid} (${why}) → ${banked}d banked`);
    return { applied: 0, banked: days };
  });
}

// Called after settleGumroadSale() has granted a PLAN sale. Never throws into
// the payment path — a referral hiccup must not turn a payment into an error.
async function referralOnPaidSale({ uid, plan, cycle, saleId, saleEmail }) {
  const ref = db.collection('referrals').doc(uid);
  const pre = await ref.get();
  if (!pre.exists) return null;
  const referrerUid = pre.data().referrerUid;
  if (!referrerUid || referrerUid === uid) return null;

  let referrer;
  try { referrer = await admin.auth().getUser(referrerUid); } catch (e) { return null; }
  const selfPaid = saleEmail && normEmail(saleEmail) === normEmail(referrer.email);
  const target = referralDaysFor(plan, cycle);

  let award = null;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return;
    const d = s.data();
    const awards = Array.isArray(d.awards) ? d.awards : [];
    if (awards.some((a) => a.saleId === saleId)) return;          // already handled (retry/reconcile)
    if (selfPaid) {
      tx.update(ref, { awards: awards.concat([{ saleId, days: 0, plan, cycle, at: Date.now(), blocked: 'self-purchase' }]) });
      return;
    }
    const already = Math.max(0, Number(d.rewardedDays || 0));
    const days = target - already;                                 // renewals → 0, upgrades → top-up
    if (days <= 0) return;
    award = { saleId, days, plan, cycle, at: Date.now(), reversed: false };
    tx.update(ref, {
      status: 'rewarded', rewardedDays: already + days, awards: awards.concat([award]),
      plan, cycle, rewardedAt: Date.now(),
    });
  });
  if (!award) return null;
  try {
    const out = await adjustReferralBonus(referrerUid, award.days, 'referral sale ' + saleId);
    return { referrerUid, days: award.days, ...out };
  } catch (e) {
    // Recorded but not credited — flag it so support can settle it by hand.
    await ref.set({ creditError: { saleId, message: e.message, at: Date.now() } }, { merge: true }).catch(() => {});
    throw e;
  }
}

// Refund/chargeback of a sale that earned a referral bonus → take it back.
async function referralOnRefund(uid, saleId) {
  const ref = db.collection('referrals').doc(uid);
  let take = null;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return;
    const d = s.data();
    const awards = Array.isArray(d.awards) ? d.awards.slice() : [];
    const i = awards.findIndex((a) => a.saleId === saleId && !a.reversed && Number(a.days) > 0);
    if (i < 0) return;
    awards[i] = Object.assign({}, awards[i], { reversed: true, reversedAt: Date.now() });
    const left = Math.max(0, Number(d.rewardedDays || 0) - Number(awards[i].days));
    take = { referrerUid: d.referrerUid, days: Number(awards[i].days) };
    tx.update(ref, { awards, rewardedDays: left, status: left > 0 ? 'rewarded' : 'reversed' });
  });
  if (take) await adjustReferralBonus(take.referrerUid, -take.days, 'refund of ' + saleId);
  return take;
}

// GET  /api/referral/me — the caller's code, link, totals and referral list.
app.get('/api/referral/me', referralLimiter, requireAuth, async (req, res) => {
  try {
    const code = await getOrCreateReferralCode(req.uid);
    const [userSnap, mineSnap, list] = await Promise.all([
      db.collection('users').doc(req.uid).get(),
      db.collection('referrals').doc(req.uid).get(),
      db.collection('referrals').where('referrerUid', '==', req.uid).limit(200).get(),
    ]);
    const r = (userSnap.exists && userSnap.data().referral) || {};
    const rows = list.docs.map((d) => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const user = await admin.auth().getUser(req.uid);
    const canEnterCode = !mineSnap.exists && !(await hasEverBeenCustomer(req.uid, user));
    res.json({
      code,
      link: APP_URL + '/journal?ref=' + code,          // clean URL (same style as mentor invite links)
      rewards: { essential: REFERRAL_BASE_DAYS.essential, pro: REFERRAL_BASE_DAYS.pro, longCycleBonus: REFERRAL_LONG_CYCLE_BONUS },
      stats: {
        joined: rows.length,
        rewarded: rows.filter((x) => Number(x.rewardedDays) > 0).length,
        pending: rows.filter((x) => !(Number(x.rewardedDays) > 0) && x.status !== 'reversed').length,
        earnedDays: Math.max(0, Number(r.earnedDays || 0)),
        bankedDays: Math.max(0, Number(r.bankedDays || 0)),
      },
      referrals: rows.slice(0, 50).map((x) => ({
        label: x.referredLabel || 'New trader',
        status: Number(x.rewardedDays) > 0 ? 'rewarded' : (x.status === 'reversed' ? 'reversed' : 'pending'),
        plan: x.plan || null, cycle: x.cycle || null,
        days: Math.max(0, Number(x.rewardedDays || 0)),
        joinedAt: x.createdAt || null,
      })),
      referredBy: mineSnap.exists ? { at: mineSnap.data().createdAt || null } : null,
      canEnterCode,
    });
  } catch (e) {
    console.error('referral/me:', e.message);
    res.status(500).json({ error: 'Could not load your referral details.' });
  }
});

// POST /api/referral/claim { code } — attach the caller to a referrer.
app.post('/api/referral/claim', referralClaimLimiter, requireAuth, async (req, res) => {
  try {
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (!referralCodeOk(code)) return res.status(400).json({ error: 'That referral code is not valid.', code: 'invalid' });
    const cSnap = await db.collection('referralCodes').doc(code).get();
    if (!cSnap.exists) return res.status(404).json({ error: 'That referral code does not exist.', code: 'invalid' });
    const referrerUid = cSnap.data().uid;
    if (!referrerUid || referrerUid === req.uid) return res.status(400).json({ error: 'You cannot use your own referral code.', code: 'self' });

    const [me, them] = await Promise.all([admin.auth().getUser(req.uid), admin.auth().getUser(referrerUid)]);
    if (isComp(me.email)) return res.status(400).json({ error: 'This account cannot be referred.', code: 'comp' });
    if (me.email && normEmail(me.email) === normEmail(them.email)) return res.status(400).json({ error: 'You cannot use your own referral code.', code: 'self' });
    if (await hasEverBeenCustomer(req.uid, me)) {
      return res.status(409).json({ error: 'Referral codes only work for new members who have not subscribed before.', code: 'existing_customer' });
    }

    const ref = db.collection('referrals').doc(req.uid);
    const created = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists) return false;                     // one referrer per user, forever
      tx.set(ref, {
        referredUid: req.uid, referrerUid, code, status: 'pending',
        referredLabel: maskEmail(me.email), rewardedDays: 0, awards: [], createdAt: Date.now(),
      });
      tx.set(db.collection('users').doc(req.uid), { referredBy: { code, at: Date.now() } }, { merge: true });
      return true;
    });
    if (!created) return res.status(409).json({ error: 'A referral is already linked to your account.', code: 'already' });
    res.json({ ok: true });
  } catch (e) {
    console.error('referral/claim:', e.message);
    res.status(500).json({ error: 'Could not apply the referral code.' });
  }
});

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
  if (secretMatches(req.get('X-Admin-Secret'), secret)) { req.adminBy = 'secret'; return next(); }
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Admin auth required.' });
  try {
    const v = await verifySession(m[1]);
    if (v.error) return res.status(401).json({ error: v.error, code: v.code });
    const decoded = v.decoded;
    if (!mfaSatisfied(decoded)) return res.status(401).json({ error: 'Two-factor verification required.', code: 'mfa_required' });
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
    if (!PLAN_LIMITS[plan]) return res.status(400).json({ error: "plan must be 'essential', 'pro' or 'ultra'" });
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
          `<p>Your <b>${planTitle(plan)}</b> access to ETW Journal is active until <b>${nice(expiresAt)}</b>.</p>
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

// ══════════════════════════════════════════════════════════════
//  ADMIN: one-off announcement to active subscribers (new brand logo)
// ══════════════════════════════════════════════════════════════
// Same route as every other account email: Brevo transactional through
// email.sendEmail() and the shared emailShell(). Admin-only (ADMIN_SECRET or an
// admin uid), dry run unless {"send":true}, and each user is stamped with
// announcements.<id> once their email goes out, so running it again never sends
// anyone a second copy. Works in batches (default 100) to stay well inside the
// request timeout and Brevo's rate limit — call again until `remaining` is 0.
const BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || 'https://etwjournal.space/assets/etw-logo-email-v4.png';
const BRAND_LOGO_HTML = `<p style="text-align:center;margin:6px 0 18px"><img src="${BRAND_LOGO_URL}" width="120" height="120" alt="The new ETW Journal logo" style="display:inline-block;width:120px;height:120px;border:0;border-radius:26px"></p>`;
// Footer line with the unsubscribe link, added inside emailShell's wrapper.
function withUnsubscribe(html, why, url) {
  if (!url) return html;
  const foot = `<p style="color:#999;font-size:12px;margin-top:6px">${why} <a href="${url}" style="color:#999">Unsubscribe from product updates</a>.</p>`;
  return html.replace(/<\/div>\s*$/, foot + '</div>');
}
// ── Marketing layout (win-back) ──────────────────────────────────
// 600px table layout with inline styles so it holds up in Gmail, Outlook and
// Apple Mail. The hero image links to the payment page like the button.
const WINBACK_IMG = process.env.WINBACK_IMG_URL || 'https://etwjournal.space/assets/etw-email-winback-2026-11.jpg';
function marketingShell({ preheader, hero, heroAlt, heroLink, body, cta, ctaLink, footNote, unsub }) {
  const pre = preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#F2EFFA">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2EFFA"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1d1530">
<tr><td style="background:#170A33;padding:0"><a href="${heroLink}" style="display:block"><img src="${hero}" width="600" alt="${escapeHtml(heroAlt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0"></a></td></tr>
<tr><td style="padding:30px 34px 8px;font-size:16px;line-height:1.6">${body}</td></tr>
<tr><td align="center" style="padding:10px 34px 6px"><a href="${ctaLink}" style="display:inline-block;background:#6D4AFF;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:15px 34px;border-radius:12px">${cta}</a></td></tr>
<tr><td align="center" style="padding:6px 34px 28px;font-size:13px;color:#6b6585">Plans from $7 a month. Cancel any time.</td></tr>
<tr><td style="padding:18px 34px 26px;border-top:1px solid #eeeaf7;font-size:12px;line-height:1.6;color:#8a84a3">${footNote}${unsub ? ` <a href="${unsub}" style="color:#8a84a3">Unsubscribe from product updates</a>.` : ''}<br>ETW Journal · <a href="https://etwjournal.space" style="color:#8a84a3">etwjournal.space</a></td></tr>
</table></td></tr></table></body></html>`;
}
function featureRows(items) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 6px;width:100%">' + items.map(([b, s]) =>
    `<tr><td valign="top" style="width:30px;padding:7px 0"><span style="display:inline-block;width:20px;height:20px;border-radius:10px;background:#EDE8FF;color:#6D4AFF;font-size:13px;line-height:20px;text-align:center;font-weight:700">&#10003;</span></td>
     <td style="padding:6px 0;font-size:15px;line-height:1.5;color:#3b3452"><b style="color:#1d1530">${b}</b> ${s}</td></tr>`).join('') + '</table>';
}
const WINBACK_FEATURES = [
  ['Trades sync themselves.', 'MT5, MT4, cTrader, TradeLocker, DXtrade, Bybit and Interactive Brokers, with your past history imported.'],
  ['See where you make and lose money.', 'P&amp;L calendar, win rate, profit factor and drawdown by day, week and month.'],
  ['ETW AI reads your journal.', 'Ask it about your trades and it points out the patterns behind your wins and losses (Pro and Ultra).'],
  ['A track record you can share.', 'Built only from live synced trades, so the numbers can be trusted.'],
];
const firstName = (n) => escapeHtml(String(n || '').trim().split(/\s+/)[0] || '');

// audience: 'active' = paying members now · 'lapsed' = their plan ended (not refunds, not comp)
//           'winback' = every account without a live plan: past subscribers + people who never subscribed.
//           html(name, unsub, ctx) gets ctx.lapsed so each group reads the right copy.
const ANNOUNCEMENTS = {
  'winback-2026-11': {
    audience: 'winback',
    unsubscribe: true,
    subject: (ctx) => ctx && ctx.lapsed ? 'Your ETW Journal is still here' : 'Your trading journal is ready when you are',
    html: (name, unsub, ctx) => {
      const lapsed = !!(ctx && ctx.lapsed), nm = firstName(name);
      const intro = lapsed
        ? `<p style="margin:0 0 14px">Hi${nm ? ' ' + nm : ''},</p>
           <p style="margin:0 0 14px">Your ETW Journal is still here. Every trade, note and playbook you saved is exactly where you left it.</p>
           <p style="margin:0">Reactivate your plan and it all opens up again, with everything ETW does today:</p>`
        : `<p style="margin:0 0 14px">Hi${nm ? ' ' + nm : ''},</p>
           <p style="margin:0 0 14px">You created an ETW Journal account but haven't picked a plan yet. Choose one, connect your trading account once, and your trades start filling your journal on their own.</p>
           <p style="margin:0">Here's what you get:</p>`;
      return marketingShell({
        preheader: lapsed ? 'Every trade and note you saved is waiting. Pick up where you left off.' : 'Connect MT5 once and every trade is journaled for you.',
        hero: WINBACK_IMG, heroAlt: 'ETW Journal dashboard with P&L calendar, and the Connect MT5 screen', heroLink: APP_URL + '/payment',
        body: intro + featureRows(WINBACK_FEATURES),
        cta: lapsed ? 'Reactivate my plan' : 'Choose my plan', ctaLink: APP_URL + '/payment',
        footNote: lapsed ? 'You’re getting this because you had an ETW Journal plan.' : 'You’re getting this because you created an ETW Journal account.',
        unsub,
      });
    },
  },

  'brand-2026-11': {
    audience: 'active',
    subject: 'ETW Journal has a new look',
    html: (name) => emailShell('Meet the new ETW Journal logo',
      `${BRAND_LOGO_HTML}
       <p>Hi${name ? ' ' + escapeHtml(name) : ''},</p>
       <p>ETW Journal has a new logo: gold ETW lettering with a quill, on our signature purple. You'll see it across the app, on your home-screen icon, in your browser tab and on etwjournal.space.</p>
       <p><b>Nothing else changes.</b> Your trades, notes, playbooks, plan and sign-in stay exactly as they were, and there's nothing you need to do.</p>
       <p style="color:#555;font-size:13px">Still seeing the old icon on your phone? On iPhone, remove the home-screen shortcut and add it again from Safari. On Android it updates by itself within a few days, or straight away if you reinstall it.</p>`,
      'Open your journal', APP_URL + '/journal.html'),
  },
  'brand-2026-11-lapsed': {
    audience: 'lapsed',
    unsubscribe: true,
    subject: 'ETW Journal has a new look',
    html: (name, unsub) => withUnsubscribe(emailShell('Meet the new ETW Journal logo',
      `${BRAND_LOGO_HTML}
       <p>Hi${name ? ' ' + escapeHtml(name) : ''},</p>
       <p>ETW Journal has a new logo: gold ETW lettering with a quill, on our signature purple.</p>
       <p><b>Your journal is still here.</b> Every trade, note and playbook you saved is exactly where you left it. Pick a plan and it all opens up again, right where you stopped.</p>`,
      'Reactivate my plan', APP_URL + '/payment'),
      'You’re getting this because you had an ETW Journal plan.', unsub),
  },
};

// ── Unsubscribe from product updates ──────────────────────────────
// Signed per-user links (HMAC with a random key kept server-side in Firestore,
// created on first use), so nobody can unsubscribe someone else. Opening the
// link shows a confirm button (mail scanners that pre-open links can't
// unsubscribe anyone); the button and mail apps' one-click unsubscribe POST.
// Sets users/{uid}.emailPrefs.announcements = false; every announcement skips
// those users. Account emails (receipts, resets, security) are unaffected.
let _unsubKey = null;
async function unsubKey() {
  if (_unsubKey) return _unsubKey;
  const ref = db.collection('serverConfig').doc('unsubscribe');
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.exists && s.data().key) { _unsubKey = s.data().key; return; }
    _unsubKey = crypto.randomBytes(32).toString('base64url');
    tx.set(ref, { key: _unsubKey, createdAt: Date.now() });
  });
  return _unsubKey;
}
async function unsubToken(uid) { return crypto.createHmac('sha256', await unsubKey()).update('unsub|' + uid).digest('base64url').slice(0, 32); }
function backendBase() {
  return (process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://etwappmeta5-2.onrender.com').replace(/\/+$/, '');
}
async function unsubUrl(uid) { return backendBase() + '/api/email/unsubscribe?u=' + encodeURIComponent(uid) + '&t=' + (await unsubToken(uid)); }
function unsubPage(title, body, form) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#140A24;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#eeecf7;padding:20px">
  <div style="max-width:420px;width:100%;background:#1E1233;border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:30px 26px;text-align:center">
  <img src="${BRAND_LOGO_URL}" width="72" height="72" alt="ETW Journal" style="border-radius:17px">
  <h2 style="margin:16px 0 8px;font-size:20px">${title}</h2><p style="color:#a7a1bf;line-height:1.55;margin:0">${body}</p>${form || ''}</div></body></html>`;
}
async function unsubCheck(q) {
  const uid = String((q && q.u) || ''), t = String((q && q.t) || '');
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid) || !t) return null;
  return secretMatches(t, await unsubToken(uid)) ? uid : null;
}
app.get('/api/email/unsubscribe', authLimiter, async (req, res) => {
  try {
    const uid = await unsubCheck(req.query);
    if (!uid) return res.status(400).type('html').send(unsubPage('This link isn’t valid', 'It may have been copied incompletely. Open it again from the email.'));
    const action = '/api/email/unsubscribe?u=' + encodeURIComponent(uid) + '&t=' + encodeURIComponent(String(req.query.t));
    res.type('html').send(unsubPage('Stop product updates?', 'You won’t get emails like the new-logo announcement any more. Receipts, password resets and security alerts still arrive.',
      `<form method="post" action="${action}" style="margin-top:22px"><button style="width:100%;padding:13px;border:0;border-radius:12px;background:linear-gradient(135deg,#7C3AED,#DB2777);color:#fff;font-weight:700;font-size:15px;cursor:pointer">Unsubscribe</button></form>`));
  } catch (e) { console.error('unsubscribe page:', e.message); res.status(500).type('html').send(unsubPage('Something went wrong', 'Please try again in a minute.')); }
});
app.post('/api/email/unsubscribe', authLimiter, async (req, res) => {
  try {
    const uid = await unsubCheck(req.query);
    if (!uid) return res.status(400).type('html').send(unsubPage('This link isn’t valid', 'Open it again from the email.'));
    await db.collection('users').doc(uid).set({ emailPrefs: { announcements: false, announcementsOffAt: Date.now() } }, { merge: true });
    console.log('[unsubscribe]', uid);
    res.type('html').send(unsubPage('You’re unsubscribed', 'You won’t get product update emails from ETW Journal any more. Your account and journal are unaffected.'));
  } catch (e) { console.error('unsubscribe:', e.message); res.status(500).type('html').send(unsubPage('Something went wrong', 'Please try again in a minute.')); }
});

// A plan counts as live while active and unexpired (a Gumroad membership stays
// active past expiresAt while its renewal is in flight).
const subLive = (sub, now) => sub.status === 'active' && !(Number(sub.expiresAt) && Number(sub.expiresAt) < now && !(sub.autoRenew && sub.subscriptionId));
// Who an announcement goes to. Returns { todo: [doc], skipped, alreadySent }.
async function announceAudience(id, A, now) {
  if (A.audience === 'winback') return winbackAudience(id, now);
  const out = { todo: [], skipped: 0, alreadySent: 0, optedOut: 0 };
  const statuses = A.audience === 'lapsed' ? ['active', 'expired'] : ['active'];
  const snap = await db.collection('users').where('subscription.status', 'in', statuses).get();
  for (const doc of snap.docs) {
    const d = doc.data() || {}, sub = d.subscription || {};
    if (sub.comp) { out.skipped++; continue; }
    // A Gumroad membership stays active past expiresAt while its renewal is in flight.
    const live = sub.status === 'active' && !(Number(sub.expiresAt) && Number(sub.expiresAt) < now && !(sub.autoRenew && sub.subscriptionId));
    if (A.audience === 'lapsed' ? live : !live) { out.skipped++; continue; }
    if (d.emailPrefs && d.emailPrefs.announcements === false) { out.optedOut++; continue; }
    if (d.announcements && d.announcements[id]) { out.alreadySent++; continue; }
    out.todo.push(doc);
  }
  return out;
}

// Win-back: every sign-in account with an email and no live plan. Accounts that
// never subscribed may have no users doc at all, so this walks Firebase Auth and
// reads the users docs in batches. Skips comp plans, refunds/chargebacks, opt-outs,
// disabled accounts and anyone already sent this id. todo items carry .lapsed.
async function winbackAudience(id, now) {
  const out = { todo: [], skipped: 0, alreadySent: 0, optedOut: 0, lapsed: 0, never: 0, unverified: 0 };
  let token;
  do {
    const page = await admin.auth().listUsers(1000, token);
    token = page.pageToken;
    const users = page.users.filter((u) => u.email && !u.disabled);
    out.skipped += page.users.length - users.length;
    for (let i = 0; i < users.length; i += 100) {
      const chunk = users.slice(i, i + 100);
      const snaps = await db.getAll(...chunk.map((u) => db.collection('users').doc(u.uid)));
      snaps.forEach((s, k) => {
        const d = s.exists ? (s.data() || {}) : {}, sub = d.subscription || {}, u = chunk[k];
        if (sub.comp || subLive(sub, now)) { out.skipped++; return; }
        if (/refund|chargeback|dispute|revoked/i.test(String(sub.status || ''))) { out.skipped++; return; }
        if (d.emailPrefs && d.emailPrefs.announcements === false) { out.optedOut++; return; }
        if (d.announcements && d.announcements[id]) { out.alreadySent++; return; }
        const lapsed = !!(sub.status || sub.plan || sub.expiresAt);
        lapsed ? out.lapsed++ : out.never++;
        if (!u.emailVerified) out.unverified++;
        out.todo.push({ id: u.uid, ref: db.collection('users').doc(u.uid), lapsed, user: u });
      });
    }
  } while (token);
  // Past subscribers first: they know the product.
  out.todo.sort((a, b) => (b.lapsed ? 1 : 0) - (a.lapsed ? 1 : 0));
  return out;
}

app.post('/api/admin/announce', authLimiter, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  const A = ANNOUNCEMENTS[id];
  if (!A) return res.status(400).json({ error: 'unknown announcement id', ids: Object.keys(ANNOUNCEMENTS) });
  const send = b.send === true;
  const batch = Math.min(Math.max(parseInt(b.limit, 10) || 100, 1), 300);
  if (send && !email.configured()) return res.status(503).json({ error: 'Brevo is not configured (BREVO_API_KEY / BREVO_SENDER).' });
  // {"testTo":"you@example.com"} sends this one email to that address only, so you can see it in a real inbox first.
  const testTo = String(b.testTo || '').trim();
  if (testTo) {
    let link = '';
    if (A.unsubscribe) { try { link = await unsubUrl((await admin.auth().getUserByEmail(testTo)).uid); } catch (e) { link = backendBase() + '/api/email/unsubscribe?u=test&t=test'; } }
    const tctx = { lapsed: b.testLapsed !== false };
    const r = await email.sendEmailVerbose({ to: testTo, toName: '', subject: typeof A.subject === 'function' ? A.subject(tctx) : A.subject, html: A.html(String(b.testName || ''), link, tctx),
      headers: link ? { 'List-Unsubscribe': '<' + link + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined });
    return res.status(r.ok ? 200 : 502).json({ id, test: true, to: testTo, ...r });
  }

  const now = Date.now();
  const out = { id, audience: A.audience, send, sent: 0, failed: 0, eligible: 0, alreadySent: 0, optedOut: 0, skipped: 0, remaining: 0, failures: [], sample: [] };
  try {
    const aud = await announceAudience(id, A, now);
    const todo = aud.todo;
    out.skipped = aud.skipped; out.alreadySent = aud.alreadySent; out.optedOut = aud.optedOut;
    out.eligible = todo.length;
    if (A.audience === 'winback') { out.lapsed = aud.lapsed; out.neverSubscribed = aud.never; out.unverifiedEmails = aud.unverified; }
    const slice = todo.slice(0, batch);
    for (const doc of slice) {
      let user = doc.user;
      if (!user) { try { user = await admin.auth().getUser(doc.id); } catch (e) { out.skipped++; continue; } }
      if (!user.email || user.disabled) { out.skipped++; continue; }
      if (!send) { if (out.sample.length < 20) out.sample.push(user.email + (A.audience === 'winback' ? (doc.lapsed ? ' (past plan)' : ' (never subscribed)') : '')); continue; }
      const link = A.unsubscribe ? await unsubUrl(doc.id) : '';
      const ctx = { lapsed: !!doc.lapsed };
      const r = await email.sendEmailVerbose({ to: user.email, toName: user.displayName || '', subject: typeof A.subject === 'function' ? A.subject(ctx) : A.subject, html: A.html(user.displayName || '', link, ctx),
        headers: link ? { 'List-Unsubscribe': '<' + link + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined });
      if (r.ok) {
        out.sent++;
        await doc.ref.set({ announcements: { [id]: { sentAt: Date.now(), messageId: r.messageId || null } } }, { merge: true });
      } else {
        out.failed++;
        if (out.failures.length < 20) out.failures.push({ email: user.email, reason: r.reason, status: r.status || null });
      }
      await new Promise((ok) => setTimeout(ok, 150));   // gentle on Brevo's rate limit
    }
    out.remaining = send ? Math.max(0, todo.length - out.sent - out.failed) : todo.length;
    console.log('[announce]', id, JSON.stringify({ send, sent: out.sent, failed: out.failed, remaining: out.remaining, by: req.adminBy }));
    res.json(out);
  } catch (e) {
    console.error('announce:', e.message);
    res.status(500).json({ error: 'announce failed', detail: e.message, ...out });
  }
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
          'View plans', APP_URL + '/payment'),
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
    // Which product keys each plan accepts (built-in memberships + any env extras).
    products: gumroad.acceptedProducts(),
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
    // Membership lifecycle posts (cancelled, ended, restarted, plan changed)
    // carry a subscription_id but no sale_id.
    const isMembershipEvent = !b.sale_id && b.subscription_id && (
      b.resource_name ? /cancellation|subscription_/.test(String(b.resource_name))
        : ('cancelled' in b || 'ended_at' in b || 'ended_reason' in b || 'restarted_at' in b || 'new_plan' in b || 'old_plan' in b || 'cancelled_at' in b));
    if (isMembershipEvent) {
      const r = await handleMembershipEvent(b.subscription_id, b);
      return res.status(200).json({ status: r.ok ? 'ok' : 'ignored', reason: r.reason });
    }
    // Sales pings carry sale_id (every automatic renewal charge is one); refund/
    // dispute resource posts have been seen with id — accept either, the sale is
    // re-fetched by id regardless.
    const saleId = String(b.sale_id || b.id || '').trim();
    if (!saleId) return res.status(200).json({ status: 'ignored', reason: 'no sale_id' });
    const r = await settleGumroadSale(saleId, b);
    res.status(200).json({ status: r.ok ? 'ok' : 'ignored', reason: r.reason });
  } catch (e) {
    console.error('gumroad ping:', e.message);
    res.status(200).json({ status: 'error' });
  }
});

// Admin: grant or adjust a balance by hand — comps, support fixes, settling a
// parked payment. Signed, audited through the same ledger as everything else.
app.post('/api/admin/tokens', authLimiter, requireAdmin, async (req, res) => {
  try {
    const { uid, email: who, tokens: n, note } = req.body || {};
    let target = uid;
    if (!target && who) { const u = await admin.auth().getUserByEmail(String(who).trim()); target = u.uid; }
    const amt = Math.trunc(Number(n));
    if (!target || !Number.isFinite(amt) || amt === 0) return res.status(400).json({ error: 'uid (or email) and a non-zero tokens amount are required' });
    const after = amt > 0
      ? await tokens.credit(target, amt, { kind: 'adjust', ref: 'admin', note: note || 'Admin grant' })
      : await tokens.charge(target, -amt, { kind: 'adjust', ref: 'admin', note: note || 'Admin deduction' });
    res.json({ ok: true, uid: target, balance: after });
  } catch (e) {
    console.error('admin tokens:', e.message);
    res.status(e.status || 500).json({ error: e.message });
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
      if (stale || c.plan !== 'ultra') await grantSubscription(req.uid, 'ultra', 'yearly', { comp: true });
      return res.json({ access: true, comp: true, plan: 'ultra', pro: true, ultra: true, limits: limitsFor('ultra') });
    }
    // Auto-renewing memberships: near or past the end date, ask Gumroad whether
    // the card was charged and settle any renewal whose ping never arrived —
    // so the app sees the new end date the moment the trader opens it. A charge
    // parked under a higher plan is settled once that plan has run out.
    let subDoc = {};
    try {
      const us = await db.collection('users').doc(req.uid).get();
      subDoc = (us.exists && us.data().subscription) || {};
      const c0 = user.customClaims || {};
      const exp0 = Number(c0.expiresAt || subDoc.expiresAt || 0);
      let changed = false;
      if (subDoc.subscriptionId && !subDoc.comp && (!exp0 || exp0 - Date.now() < 2 * DAY_MS)) {
        const r = await refreshMembership(req.uid);
        changed = !!(r && r.healed);
      }
      if (!c0.subscribed || exp0 < Date.now()) changed = (await settleHeldSales(req.uid)) > 0 || changed;
      if (changed) {
        const us2 = await db.collection('users').doc(req.uid).get();
        subDoc = (us2.exists && us2.data().subscription) || {};
      }
    } catch (e) { console.warn('subscribe/me membership check:', e.message); }

    const a = await access.accessFor(req.uid, null);   // null = always read fresh claims
    const p = tokenPlan(req.token) || planOfAccess(a);
    // A lapsed plan is reported as lapsed: pro/ultra are false and the old plan
    // name moves to lastPlan, so the pricing page offers every plan to buy again.
    const live = !!a.active && !!p;
    const out = { access: !!a.active, plan: live ? p : null, lastPlan: live ? null : (a.plan || null), expired: !a.active && !!a.plan,
                  pro: live && (p === 'pro' || p === 'ultra'), ultra: live && p === 'ultra',
                  expiresAt: a.expiresAt || null, limits: live ? limitsFor(p) : null };

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
    if (a.active && p !== 'ultra') out.upgrade = { via: 'gumroad', to: out.pro ? 'ultra' : 'pro' };

    // Auto-renew state for Settings / the plans page. nextChargeAt is the next
    // automatic charge (same calendar day each month / quarter / year).
    if (subDoc.subscriptionId && !subDoc.comp) {
      const months = { monthly: 1, quarterly: 3, yearly: 12 }[subDoc.cycle] || 1;
      let next = null;
      if (subDoc.autoRenew && subDoc.lastChargeAt) {
        const d = new Date(Number(subDoc.lastChargeAt)); d.setUTCMonth(d.getUTCMonth() + months);
        next = d.getTime();
      }
      out.renewal = {
        autoRenew: !!subDoc.autoRenew, status: subDoc.membershipStatus || null,
        nextChargeAt: next, cancelledAt: subDoc.cancelledAt || null, failedAt: subDoc.failedAt || null,
        lastChargeAt: subDoc.lastChargeAt || null, cycle: subDoc.cycle || null,
        manageUrl: 'https://app.gumroad.com/library',
      };
      const x = subDoc.extraMembership;
      if (x && x.subscriptionId && x.subscriptionId !== subDoc.subscriptionId && x.autoRenew !== false
          && Number(x.lastChargeAt) > Date.now() - 400 * DAY_MS) {
        out.renewal.alsoPaying = { plan: x.plan, cycle: x.cycle };
      }
    }
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

// ── Trade Replay allowance ─────────────────────────────────────────────
// Pro: 10 different trades per calendar month (UTC); replaying a trade again
// in the same month is free. Ultra: unlimited. Essential: no Trade Replay.
const replayLimiter = rl(60 * 1000, 30, 'Too many requests.');
function monthKey(t) { return new Date(t || Date.now()).toISOString().slice(0, 7); }
function nextMonthStart() { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
app.get('/api/replay/quota', replayLimiter, requireAuth, async (req, res) => {
  const plan = (await planFor(req)) || null;
  if (plan === 'ultra') return res.json({ ok: true, plan, unlimited: true });
  const limit = (PLAN_LIMITS[plan] || PLAN_LIMITS.essential).replays;
  const snap = await db.collection('users').doc(req.uid).get().catch(() => null);
  const q = (snap && snap.exists && snap.data().replayQuota) || {};
  const used = q.month === monthKey() && Array.isArray(q.ids) ? q.ids.length : 0;
  res.json({ ok: true, plan, limit, used, left: Math.max(0, limit - used), resetAt: nextMonthStart() });
});
app.post('/api/replay/consume', replayLimiter, requireAuth, requirePro, async (req, res) => {
  const plan = (await planFor(req)) || 'pro';
  if (plan === 'ultra') return res.json({ ok: true, plan, unlimited: true });
  const limit = PLAN_LIMITS[plan].replays;
  const want = [...new Set(((req.body && req.body.ids) || []).map(String).filter((x) => /^[\w-]{1,120}$/.test(x)))].slice(0, 60);
  if (!want.length) return res.status(400).json({ error: 'ids[] is required' });
  const ref = db.collection('users').doc(req.uid);
  try {
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const q = (snap.exists && snap.data().replayQuota) || {};
      const month = monthKey();
      const ids = q.month === month && Array.isArray(q.ids) ? q.ids.slice() : [];
      const fresh = want.filter((x) => ids.indexOf(x) < 0);
      if (ids.length + fresh.length > limit) return { blocked: true, used: ids.length, need: fresh.length };
      const next = ids.concat(fresh);
      tx.set(ref, { replayQuota: { month, ids: next, limit, updatedAt: Date.now() } }, { merge: true });
      return { used: next.length };
    });
    if (out.blocked) {
      const left = Math.max(0, limit - out.used);
      return res.status(402).json({
        code: 'replay_limit', plan, limit, used: out.used, left, resetAt: nextMonthStart(),
        error: 'Your Pro plan includes ' + limit + ' trade replays a month and ' + (left ? 'only ' + left + ' ' + (left === 1 ? 'is' : 'are') + ' left — this needs ' + out.need : 'you have used them all') + '. They reset on the 1st. Upgrade to Ultra for unlimited Trade Replay.',
      });
    }
    res.json({ ok: true, plan, limit, used: out.used, left: Math.max(0, limit - out.used), resetAt: nextMonthStart() });
  } catch (e) { console.warn('[replay quota]', e.message); res.json({ ok: true, plan, degraded: true }); }
});

// ── Backtesting: Pro gets 3 sessions a cycle, Ultra unlimited + cloud backup ──
// Essential has no backtesting. Deletes never decrement the counter.
require('./src/backtestQuota').mount(app, requireAuth, db, access, planFor);

// ── Dormant MetaApi account pruning ────────────────────────────────
// An idle registered account costs $0.00105/hr ($0.77/mo); deleting it stops
// that, but re-adding costs $2.10 — so the threshold has to sit past the
// ~3-month break-even or we lose money on everyone who returns. The user's
// connect fee (800 tokens ~ KSh 400) covers the re-add when they do.
async function pruneDormantAccounts() {
  const days = Math.max(30, Number(process.env.SYNC_PRUNE_AFTER_DAYS || 90));
  try {
    const dormant = await mt5.findDormant(days);
    if (!dormant.length) return { pruned: 0 };
    let pruned = 0;
    for (const { uid, lastSeen } of dormant) {
      try {
        await mt5.removeAccount(uid);
        // Must follow the delete: MetaApi will bill the add fee again, so the
        // user's connect fee has to be chargeable again too.
        await tokens.clearConnectCharge(uid);
        pruned++;
        console.log(`[prune] removed MetaApi account for ${uid} (idle since ${new Date(lastSeen).toISOString().slice(0, 10)})`);
      } catch (e) { console.error('[prune] failed for', uid, '-', e.message); }
    }
    console.log(`[prune] ${pruned}/${dormant.length} dormant accounts removed (threshold ${days}d)`);
    return { pruned };
  } catch (e) { console.error('[prune]', e.message); return { pruned: 0, error: e.message }; }
}

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log('etw-sync-backend listening on :' + port);
tokens.startMeter();
bybit.resumeAll();   // Bybit links poll from this process; restart them after every deploy
ibkr.resumeAll();    // same for Interactive Brokers Flex links
// Hosted engine: never re-deploy MetaApi accounts at boot — deploying is what
// makes MetaApi bill (and fail with its own balance/subscription errors).
if (HOSTED_ENGINE) {
  console.log('[mt5] hosted engine on — MetaApi boot resume skipped; legacy accounts retire on first touch');
  setTimeout(() => { hosted.healUnknownServer().catch(() => {}); }, 8000);
} else mt5.resumeAll();
// 2FA retired: remove leftover 2FA claims/flags from every account (see backfillMfaClaims).
setTimeout(() => { backfillMfaClaims().catch(() => {}); }, 3000);
// Essential users linked MT5 Direct before it moved to Pro: stop them right after
// the boot-time resume, then re-check once the resumes have settled.
setTimeout(() => { sweepDirectPlans().catch(() => {}); }, 5000);
setTimeout(() => { sweepDirectPlans().catch(() => {}); }, 90000);
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
  // Renewal charges whose ping was missed are healed every 3 hours as well as
  // at boot and from the daily cron.
  if (gumroad.configured()) {
    setInterval(() => {
      reconcileGumroadSales(2)
        .then((r) => { if (r.healed) console.log('[gumroad] periodic reconcile:', JSON.stringify(r)); })
        .catch((e) => console.warn('[gumroad] periodic reconcile:', e.message));
    }, 3 * 60 * 60 * 1000);
  }
  if (gumroad.configured()) {
    reconcileGumroadSales(3)
      .then((r) => { if (r.checked) console.log('[gumroad] boot reconcile:', JSON.stringify(r)); })
      .catch((e) => console.warn('[gumroad] boot reconcile:', e.message));
  }
});
