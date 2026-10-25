// FREE MT5 sync via an Expert Advisor (no MetaApi cost).
// The user's MT5 terminal runs the ETW EA, which POSTs closed trades here with an
// X-ETW-Key header. We map the key -> {uid, accountId} and write to Firestore.
// Keys are minted by /register (Firebase-authenticated) and stored in the
// backend-owned `eaKeys` collection (Admin SDK bypasses client security rules).
//
// The hosted worker (src/hostedSync.js) uses the same push path with its own
// key per linked account: those keys carry `hosted: true` and the account's
// accountKey, and report status under mt5DirectAccounts instead of mt5Ea.
const crypto = require('crypto');
const store = require('../store');
const { getSessionFromTime } = require('../tradeMapper');

// Mint (or reuse) a key for this user+account.
async function register(uid, accountId) {
  accountId = accountId || '';
  try {
    const snap = await store.db.collection('eaKeys')
      .where('uid', '==', uid).where('accountId', '==', accountId).limit(1).get();
    const own = snap.docs.find((d) => !d.data().hosted);
    if (own) return own.id;
  } catch (e) { /* fall through to create */ }
  const key = newKey();
  await store.db.collection('eaKeys').doc(key).set({ uid, accountId, createdAt: Date.now() });
  await store.setStatus(uid, 'mt5Ea', { key, accountId, status: 'waiting', createdAt: Date.now() });
  return key;
}

function newKey() { return 'etw_' + crypto.randomBytes(18).toString('hex'); }

// A key for the hosted worker. Separate from the user's own EA key, so
// disconnecting the hosted account can delete it without breaking their EA.
async function registerHosted(uid, accountId, accountKey) {
  const key = newKey();
  await store.db.collection('eaKeys').doc(key)
    .set({ uid, accountId: accountId || '', accountKey, hosted: true, createdAt: Date.now() });
  return key;
}

async function revoke(key) {
  if (!key) return;
  keyCache.delete(key);
  await store.db.collection('eaKeys').doc(key).delete();
}

function normalize(t, uid, accountId) {
  const openMs = Number(t.tradeDate) || Date.now();
  const pnl = Math.round(((parseFloat(t.pnl) || 0) + Number.EPSILON) * 100) / 100;
  const result = t.result || (pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAKEVEN');
  return {
    uid,
    pair: String(t.pair || ''),
    direction: String(t.direction || '').toUpperCase() === 'LONG' ? 'LONG' : 'SHORT',
    entry: String(t.entry || ''), closePrice: String(t.closePrice || ''),
    sl: String(t.sl || ''), tp: String(t.tp || ''), lot: String(t.lot || ''),
    pnl, result,
    tradeDate: openMs, closeTime: String(t.closeTime || ''),
    swap: parseFloat(t.swap) || 0, commission: parseFloat(t.commission) || 0,
    session: t.session || getSessionFromTime(openMs),
    ticket: String(t.ticket || ''),
    positionId: t.positionId ? String(t.positionId) : '',
    source: 'mt5-ea', rr: '', notes: '', rules: '', psychology: '', model: '',
    accountId: accountId || '', createdAt: Date.now(), updatedAt: Date.now(),
  };
}

// The EA posts one deal per request, so a backfill sends hundreds in a row.
// Each of these lookups is cached briefly so those pushes cost a few reads
// instead of hundreds. A revoked key or lapsed plan takes effect within a minute.
const CACHE_MS = 60 * 1000;
const keyCache = new Map();      // key -> { at, data }
const accessCache = new Map();   // uid -> at (last time access was confirmed)
const statusAt = new Map();      // key -> last status write
const STATUS_EVERY_MS = 30 * 1000;

function cap(map) { if (map.size > 2000) map.delete(map.keys().next().value); }

async function keyData(key) {
  const hit = keyCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const doc = await store.db.collection('eaKeys').doc(key).get();
  const data = doc.exists ? doc.data() : null;
  keyCache.set(key, { at: Date.now(), data }); cap(keyCache);
  return data;
}

async function checkAccess(uid) {
  const at = accessCache.get(uid);
  if (at && Date.now() - at < CACHE_MS) return;
  await require('../access').assertAccess(uid);
  accessCache.set(uid, Date.now()); cap(accessCache);
}

// Handle an EA push: { trades:[...] } + key (header or body). Returns count written.
async function push(key, trades) {
  if (!key) { const e = new Error('Missing sync key'); e.status = 401; throw e; }
  // The key is used as a document path, so only accept the shape register() mints.
  if (!/^etw_[0-9a-f]{36}$/.test(String(key))) { const e = new Error('Invalid sync key'); e.status = 401; throw e; }
  const k = await keyData(key);
  if (!k) { const e = new Error('Invalid sync key'); e.status = 401; throw e; }
  const { uid, accountId } = k;
  // The key outlives the subscription, so re-check the owner's access on every
  // push — otherwise a lapsed account's EA would keep syncing forever.
  await checkAccess(uid);
  const index = await store.tradeIndex(uid);
  const written = index.get('mt5-ea|' + (accountId || '')) || new Set();
  // Hosted accounts may replace a MetaApi link that already imported this
  // history. MetaApi stores one trade per position, keyed by position id.
  const direct = k.hosted ? (index.get('mt5-direct|' + (accountId || '')) || new Set()) : new Set();
  const seen = new Set();
  const docs = (trades || [])
    .map(t => normalize(t, uid, accountId))
    .filter(t => {
      if (!t.ticket || written.has(t.ticket) || seen.has(t.ticket)) return false;
      if (t.positionId && direct.has(t.positionId)) return false;
      seen.add(t.ticket);
      return true;
    });
  if (k.hosted) docs.forEach(t => { t.mt5AccountKey = k.accountKey; });
  if (docs.length) { await store.writeTrades(docs); store.indexTrades(uid, docs); }

  const last = statusAt.get(key) || 0;
  if (Date.now() - last > STATUS_EVERY_MS) {
    statusAt.set(key, Date.now()); cap(statusAt);
    let imported = 0;
    (index.get('mt5-ea|' + (accountId || '')) || written).forEach((t) => { if (!t.startsWith('pos:')) imported++; });
    if (k.hosted) {
      // The worker's report sets status and last-sync time; this only keeps the
      // import count moving during a long backfill.
      await require('../mt5sync').setStatus(uid, { historyImported: imported }, k.accountKey);
    } else {
      await store.setStatus(uid, 'mt5Ea', { status: 'connected', accountId, lastSyncAt: Date.now(), imported });
    }
  }
  return docs.length;
}

module.exports = { register, registerHosted, revoke, push };
