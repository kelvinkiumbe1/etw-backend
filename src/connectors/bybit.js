// Bybit connector (REST V5, per-user read-only API key).
//
// The trader creates a READ-ONLY API key on Bybit and pastes key + secret into
// the Brokers page. We check the key really is read-only (refusing anything
// that can trade or withdraw), store it encrypted (AES-256-GCM via
// hostedSync.encrypt, key in MT5_CRED_KEY) in the server-only `bybitLinks`
// collection, import the closed-PnL history for USDT/USDC perpetuals+futures
// (category=linear) and inverse contracts, then poll for new closes.
//
// Unlike the TradeLocker/DXtrade connectors, links survive a restart:
// resumeAll() at boot picks every stored link back up.
//
// Bybit refuses API traffic from US IP addresses, and this backend runs in
// Virginia. Set BYBIT_RELAY_URL + BYBIT_RELAY_SECRET to route every Bybit call
// (all environments) through the Frankfurt relay in ./bybit-relay. Without
// them we call Bybit directly, which only works from a non-US region.
const crypto = require('crypto');
const store = require('../store');
const access = require('../access');
const { encrypt, decrypt } = require('../hostedSync');
const { getSessionFromTime } = require('../tradeMapper');

const STATUS_KEY = 'bybit';
const SOURCE = 'bybit';
const COL = 'bybitLinks';
const RECV_WINDOW = '10000';
const POLL_MS = 60 * 1000;
const WINDOW_MS = 7 * 24 * 3600 * 1000;          // closed-pnl max range per request
const HISTORY_MS = 730 * 24 * 3600 * 1000;       // Bybit keeps 2 years of closed PnL
const CATEGORIES = ['linear', 'inverse'];
const active = new Map(); // duid -> { timer, stopped }

const HOSTS = {
  mainnet: 'https://api.bybit.com',
  eu: 'https://api.bybit.eu',
  demo: 'https://api-demo.bybit.com',
  testnet: 'https://api-testnet.bybit.com',
};
const RELAY_URL = String(process.env.BYBIT_RELAY_URL || '').trim().replace(/\/+$/, '');
const RELAY_SECRET = String(process.env.BYBIT_RELAY_SECRET || '').trim();
const useRelay = () => !!(RELAY_URL && RELAY_SECRET);
const normEnv = (env) => (HOSTS[env] ? env : 'mainnet');
const setStatus = (uid, patch) => store.setStatus(uid, STATUS_KEY, patch);
const ref = (uid) => store.db.collection(COL).doc(uid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Signed GET ───────────────────────────────────────────────────────────────
// sign = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + queryString)
async function signedGet(creds, path, params) {
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== '')).toString();
  const ts = String(Date.now());
  const sign = crypto.createHmac('sha256', creds.secret).update(ts + creds.key + RECV_WINDOW + qs).digest('hex');
  const env = normEnv(creds.env);
  const headers = {
    'X-BAPI-API-KEY': creds.key, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    'X-BAPI-SIGN': sign, 'accept': 'application/json',
  };
  if (useRelay()) { headers['X-Relay-Secret'] = RELAY_SECRET; headers['X-Relay-Target'] = env; }
  const r = await fetch((useRelay() ? RELAY_URL : HOSTS[env]) + path + (qs ? '?' + qs : ''),
    { headers, signal: AbortSignal.timeout(25000) });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
  if (!r.ok) {
    const err = new Error(r.status === 403 ? 'blocked_region' : r.status === 401 && useRelay() ? 'relay_auth' : ('HTTP ' + r.status));
    err.status = r.status; throw err;
  }
  if (body.retCode !== 0) {
    const err = new Error(body.retMsg || ('Bybit error ' + body.retCode));
    err.retCode = body.retCode; throw err;
  }
  return body.result || {};
}

// Refuse keys that can do anything but read. readOnly: 1 = read-only.
async function verifyKey(creds) {
  const info = await signedGet(creds, '/v5/user/query-api');
  if (Number(info.readOnly) !== 1) {
    const e = new Error('This API key can trade. Create a READ-ONLY key on Bybit and paste that instead.');
    e.code = 'not_read_only'; throw e;
  }
  return info;
}

// ── Normalise ────────────────────────────────────────────────────────────────
// A closed-pnl row is one closing order. `side` is the CLOSING side, so a Sell
// closed a long. closedPnl is already net of open+close fees and funding.
// Bybit doesn't report when the position was opened, so open = close time.
const r2 = (n) => Math.round(((+n || 0) + Number.EPSILON) * 100) / 100;
function toTrade(row, { uid, accountId }) {
  const pnl = parseFloat(row.closedPnl);
  const closeMs = Number(row.updatedTime || row.createdTime);
  if (!row.orderId || !row.symbol || isNaN(pnl) || !closeMs) return null;
  const fees = (parseFloat(row.openFee) || 0) + (parseFloat(row.closeFee) || 0);
  const p = r2(pnl);
  return {
    uid, pair: String(row.symbol),
    direction: String(row.side) === 'Sell' ? 'LONG' : 'SHORT',
    entry: String(row.avgEntryPrice ?? ''), closePrice: String(row.avgExitPrice ?? ''),
    sl: '', tp: '', lot: String(row.closedSize ?? row.qty ?? ''),
    pnl: p, result: p > 0 ? 'WIN' : p < 0 ? 'LOSS' : 'BREAKEVEN',
    tradeDate: closeMs, openTime: new Date(closeMs).toISOString(), closeTime: new Date(closeMs).toISOString(),
    swap: 0, commission: fees ? -r2(fees) : 0,
    session: getSessionFromTime(closeMs), ticket: String(row.orderId),
    leverage: row.leverage ? String(row.leverage) : '', bybitCategory: row._category || '',
    source: SOURCE, brokerName: 'Bybit', rr: '', notes: '', rules: '', psychology: '', model: '',
    accountId: accountId || '', createdAt: Date.now(), updatedAt: Date.now(),
  };
}

// Every closed-pnl row in [startMs, endMs] for one category, 7-day windows, cursor-paged.
async function fetchRange(creds, category, startMs, endMs, onRows) {
  for (let to = endMs; to > startMs; to -= WINDOW_MS) {
    const from = Math.max(startMs, to - WINDOW_MS + 1);
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const res = await signedGet(creds, '/v5/position/closed-pnl',
        { category, startTime: from, endTime: to, limit: 100, cursor });
      const rows = (res.list || []).map((r) => Object.assign(r, { _category: category }));
      if (rows.length) await onRows(rows);
      cursor = res.nextPageCursor || '';
      if (!cursor || !rows.length) break;
      await sleep(120);
    }
    await sleep(120);
  }
}

async function importRange(ctx, startMs, endMs) {
  let n = 0;
  for (const category of CATEGORIES) {
    await fetchRange(ctx.creds, category, startMs, endMs, async (rows) => {
      const fresh = rows.map((r) => toTrade(r, ctx)).filter((t) => t && !ctx.written.has(t.ticket));
      if (!fresh.length) return;
      await store.writeTrades(fresh);
      fresh.forEach((t) => ctx.written.add(t.ticket));
      n += fresh.length;
    });
  }
  return n;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (e && e.code === 'not_read_only') return m;
  if (m === 'relay_auth') return 'Bybit sync is misconfigured on the server (relay secret mismatch). Please contact support.';
  if (m === 'blocked_region') return 'Bybit refused the connection from our server region. Please contact support.';
  const c = e && e.retCode;
  if (c === 10003 || c === 33004) return 'Bybit rejected this API key — it may be wrong, deleted or expired. Check the key and environment.';
  if (c === 10004) return 'Bybit rejected the signature — check the API secret.';
  if (c === 10010) return 'This API key is restricted to other IP addresses. Remove the IP restriction on Bybit, or create a new read-only key.';
  if (c === 10005) return 'This API key lacks read permission for positions. Enable Contract/Derivatives read access.';
  if (c === 10002) return 'Clock mismatch talking to Bybit — please try again.';
  return 'Bybit sync failed: ' + m;
}
const isAuthError = (e) => [10003, 10004, 10005, 10010, 33004].includes(e && e.retCode) || (e && e.code === 'not_read_only');

async function run(uid, link, creds, { fullHistory }) {
  await stopSync(uid);
  const state = { timer: null, stopped: false };
  active.set(uid, state);
  const ctx = { uid, accountId: link.journalAccountId || '', creds, written: await store.existingTickets(uid, SOURCE, link.journalAccountId || '') };
  const now = Date.now();
  const since = fullHistory ? now - HISTORY_MS : Math.max(now - HISTORY_MS, (link.lastSyncAt || now) - 24 * 3600 * 1000);
  await setStatus(uid, { status: 'connecting', server: link.env, error: null });
  await importRange(ctx, since, now);
  if (state.stopped) return;
  let last = now;
  await ref(uid).set({ lastSyncAt: now }, { merge: true });
  await setStatus(uid, { status: 'connected', server: link.env, historyImported: ctx.written.size, lastSyncAt: now, error: null });

  const tick = async () => {
    if (state.stopped) return;
    const t = Date.now();
    try {
      const n = await importRange(ctx, last - 10 * 60 * 1000, t);
      last = t;
      await setStatus(uid, { status: 'connected', historyImported: ctx.written.size, lastSyncAt: t, error: null });
      if (n) await ref(uid).set({ lastSyncAt: t }, { merge: true });
    } catch (e) {
      console.error('bybit poll', uid, e.message);
      if (isAuthError(e)) { await stopSync(uid); await setStatus(uid, { status: 'error', error: friendlyError(e) }).catch(() => {}); return; }
    }
    if (!state.stopped) state.timer = setTimeout(tick, POLL_MS);
  };
  state.timer = setTimeout(tick, POLL_MS);
}

// Called from the route: verifies, stores encrypted, then imports in the background.
async function connect(uid, { apiKey, apiSecret, env, journalAccountId }) {
  const creds = { key: String(apiKey).trim(), secret: String(apiSecret).trim(), env: normEnv(env) };
  await verifyKey(creds);                                     // throws for bad / non-read-only keys
  const link = { uid, env: creds.env, journalAccountId: journalAccountId || '', keyHint: creds.key.slice(0, 4) + '…' + creds.key.slice(-4),
    cred: encrypt(JSON.stringify({ key: creds.key, secret: creds.secret }), uid), createdAt: Date.now(), lastSyncAt: null };
  await ref(uid).set(link);
  await setStatus(uid, { status: 'connecting', server: creds.env, keyHint: link.keyHint, error: null });
  run(uid, link, creds, { fullHistory: true }).catch(async (e) => {
    console.error('bybit:', e.message);
    await setStatus(uid, { status: 'error', error: friendlyError(e) }).catch(() => {});
  });
}

async function stopSync(uid) {
  const s = active.get(uid);
  if (s) { s.stopped = true; if (s.timer) clearTimeout(s.timer); }
  active.delete(uid);
}

async function disconnect(uid) {
  await stopSync(uid);
  await ref(uid).delete().catch(() => {});
}

// Boot: restart every stored link whose owner still has a subscription.
async function resumeAll() {
  let snap;
  try { snap = await store.db.collection(COL).get(); } catch (e) { console.warn('[bybit] resume failed:', e.message); return; }
  let i = 0;
  for (const doc of snap.docs) {
    const uid = doc.id, link = doc.data();
    setTimeout(async () => {
      try {
        await access.assertAccess(uid);
        const c = JSON.parse(decrypt(link.cred, uid));
        await run(uid, link, { key: c.key, secret: c.secret, env: normEnv(link.env) }, { fullHistory: !link.lastSyncAt });
      } catch (e) {
        if (e.status === 402) { await setStatus(uid, { status: 'error', error: 'Your subscription has ended — renew to resume Bybit sync.' }).catch(() => {}); return; }
        console.error('[bybit] resume', uid, e.message);
        await setStatus(uid, { status: 'error', error: friendlyError(e) }).catch(() => {});
      }
    }, 2000 + (i++) * 1500);                                  // stagger so boot doesn't burst Bybit
  }
  if (snap.size) console.log('[bybit] resuming', snap.size, 'link(s)');
}

module.exports = { connect, disconnect, stopSync, resumeAll, friendlyError, _toTrade: toTrade };
