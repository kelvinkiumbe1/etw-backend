// cTrader connector (Spotware Open API, OAuth2).
// App-level Client ID/Secret come from https://openapi.ctrader.com (env vars).
// Each user authorises via OAuth; we store their tokens in a private subcollection
// (users/{uid}/private/ctrader) and their status/accounts under users/{uid}.ctrader.
//
// Deal history is pulled server-side over the Open API JSON WebSocket — see
// ./ctraderOpenApi.js (ported from the ETW frontend's proven flow).
const crypto = require('crypto');
const store = require('../store');
const engine = require('./ctraderOpenApi');

const STATUS_KEY = 'ctrader';
// Documented authorize screen (grantingaccess) and REST token endpoint.
const AUTH_URL = 'https://id.ctrader.com/my/settings/openapi/grantingaccess/';
const TOKEN_URL = 'https://openapi.ctrader.com/apps/token';
const pendingStates = new Map(); // state -> { uid, ts }

let CLIENT_ID = '', CLIENT_SECRET = '', REDIRECT_URI = '';
let pollTimer = null;

function init() {
  CLIENT_ID = process.env.CTRADER_CLIENT_ID || '';
  CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET || '';
  REDIRECT_URI = process.env.CTRADER_REDIRECT_URI || '';
  if (configured() && !pollTimer) {
    // Periodically pull new closed deals for every connected user (24/7 sync).
    pollTimer = setInterval(() => { pollAll().catch((e) => console.error('ctrader poll error:', e.message)); }, 180000);
    setTimeout(() => pollAll().catch((e) => console.error('ctrader initial poll:', e.message)), 8000);
    console.log('cTrader connector configured — sync poller started.');
  }
}
function configured() { return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI); }
const setStatus = (uid, patch) => store.setStatus(uid, STATUS_KEY, patch);

// Step 1 — build the authorize URL the user is sent to.
function createAuthUrl(uid) {
  if (!configured()) throw new Error('cTrader is not configured (set CTRADER_CLIENT_ID / SECRET / REDIRECT_URI).');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { uid, ts: Date.now() });
  for (const [k, v] of pendingStates) if (Date.now() - v.ts > 600000) pendingStates.delete(k); // prune >10 min
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'accounts',   // view-only is enough to read deal history
    product: 'web',
    state,
  });
  return AUTH_URL + '?' + p.toString();
}

// cTrader returns camelCase keys (accessToken/refreshToken/expiresIn); tolerate snake_case too.
function normalizeToken(b) {
  const accessToken = b.accessToken || b.access_token;
  if (!accessToken) throw new Error(b.errorCode || b.description || b.error || 'cTrader token exchange failed');
  return {
    accessToken,
    refreshToken: b.refreshToken || b.refresh_token || '',
    expiresIn: Number(b.expiresIn || b.expires_in || 0),
  };
}

async function exchangeToken(code) {
  const p = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch(TOKEN_URL + '?' + p.toString(), { method: 'GET', headers: { Accept: 'application/json' } });
  return normalizeToken(await r.json());
}

async function refreshAccessToken(refreshToken) {
  const p = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch(TOKEN_URL + '?' + p.toString(), { method: 'POST', headers: { Accept: 'application/json' } });
  const tok = normalizeToken(await r.json());
  if (!tok.refreshToken) tok.refreshToken = refreshToken; // refresh token has no expiry; reuse if not rotated
  return tok;
}

function tokenDocRef(uid) {
  return store.db.collection('users').doc(uid).collection('private').doc('ctrader');
}
async function loadTokens(uid) {
  const snap = await tokenDocRef(uid).get();
  return snap.exists ? snap.data() : null;
}
async function saveTokens(uid, tok) {
  await tokenDocRef(uid).set({
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAt: Date.now() + (tok.expiresIn || 0) * 1000,
    updatedAt: Date.now(),
  }, { merge: true });
}

// Return a valid access token, refreshing if within ~1 day of expiry.
async function ensureToken(uid) {
  const t = await loadTokens(uid);
  if (!t || !t.accessToken) throw new Error('No cTrader tokens stored — reconnect required.');
  if (t.refreshToken && t.expiresAt && t.expiresAt - Date.now() < 86400000) {
    try {
      const refreshed = await refreshAccessToken(t.refreshToken);
      await saveTokens(uid, refreshed);
      return { ...t, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
    } catch (e) { console.error('ctrader token refresh failed for', uid, '-', e.message); }
  }
  return t;
}

// Pull closed deals and write new ones. backfill=true widens the window to 90 days.
async function syncUser(uid, { backfill } = {}) {
  const t = await ensureToken(uid);
  const statusSnap = await store.db.collection('users').doc(uid).get();
  const status = (statusSnap.exists && statusSnap.data()[STATUS_KEY]) || {};
  const now = Date.now();
  const from = backfill
    ? now - 90 * 86400000
    : Math.max(Number(status.lastDealSyncAt || 0), now - 7 * 86400000);

  const { accounts, trades } = await engine.fetchClosedTrades({
    uid, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, accessToken: t.accessToken, from, to: now,
  });

  // Dedup per account against already-stored tickets, then batch-write the rest.
  let written = 0;
  const byAccount = new Map();
  for (const tr of trades) {
    const k = tr.accountId || '';
    if (!byAccount.has(k)) byAccount.set(k, []);
    byAccount.get(k).push(tr);
  }
  for (const [accId, list] of byAccount) {
    const existing = await store.existingTickets(uid, 'ctrader_open_api', accId);
    const fresh = list.filter((tr) => !existing.has(String(tr.ticket)));
    if (fresh.length) written += await store.writeTrades(fresh);
  }

  await setStatus(uid, {
    status: 'connected',
    accounts,
    historyImported: Number(status.historyImported || 0) + written,
    lastSyncAt: now,
    lastDealSyncAt: now - 60000,
    note: null,
    error: null,
  });
  if (written) console.log('ctrader: wrote', written, 'new trade(s) for', uid);
  return written;
}

// Step 2 — Spotware redirects here with ?code=&state=
async function handleCallback(code, state) {
  const rec = state && pendingStates.get(state);
  if (!rec) throw new Error('Invalid or expired OAuth state.');
  pendingStates.delete(state);
  const uid = rec.uid;
  await setStatus(uid, { status: 'connecting', error: null });
  const tok = await exchangeToken(code);   // fail fast if the code is bad
  await saveTokens(uid, tok);
  // Backfill runs in the background so the popup can close immediately; the
  // frontend watches the status doc and flips to "connected" when it finishes.
  syncUser(uid, { backfill: true }).catch(async (e) => {
    console.error('ctrader initial sync failed for', uid, '-', e.message);
    await setStatus(uid, { status: 'error', error: friendlyError(e) }).catch(() => {});
  });
  return uid;
}

async function disconnect(uid) {
  await setStatus(uid, { status: 'disconnected' });
  try { await tokenDocRef(uid).delete(); } catch (e) {}
}

async function pollAll() {
  if (!configured()) return;
  const snap = await store.db.collection('users').where('ctrader.status', '==', 'connected').get();
  for (const doc of snap.docs) {
    try { await syncUser(doc.id); }
    catch (e) { console.error('ctrader poll sync failed for', doc.id, '-', e.message); }
  }
}

function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/not configured/i.test(m)) return m;
  if (/state/i.test(m)) return 'cTrader authorization expired — please try connecting again.';
  return 'cTrader connect failed: ' + m;
}

module.exports = { init, configured, createAuthUrl, handleCallback, disconnect, syncUser, friendlyError };
