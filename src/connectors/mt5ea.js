// FREE MT5 sync via an Expert Advisor (no MetaApi cost).
// The user's MT5 terminal runs the ETW EA, which POSTs closed trades here with an
// X-ETW-Key header. We map the key -> {uid, accountId} and write to Firestore.
// Keys are minted by /register (Firebase-authenticated) and stored in the
// backend-owned `eaKeys` collection (Admin SDK bypasses client security rules).
const crypto = require('crypto');
const store = require('../store');
const { getSessionFromTime } = require('../tradeMapper');

// Mint (or reuse) a key for this user+account.
async function register(uid, accountId) {
  accountId = accountId || '';
  try {
    const snap = await store.db.collection('eaKeys')
      .where('uid', '==', uid).where('accountId', '==', accountId).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  } catch (e) { /* fall through to create */ }
  const key = 'etw_' + crypto.randomBytes(18).toString('hex');
  await store.db.collection('eaKeys').doc(key).set({ uid, accountId, createdAt: Date.now() });
  await store.setStatus(uid, 'mt5Ea', { key, accountId, status: 'waiting', createdAt: Date.now() });
  return key;
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
    source: 'mt5-ea', rr: '', notes: '', rules: '', psychology: '', model: '',
    accountId: accountId || '', createdAt: Date.now(), updatedAt: Date.now(),
  };
}

// Handle an EA push: { trades:[...] } + key (header or body). Returns count written.
async function push(key, trades) {
  if (!key) { const e = new Error('Missing sync key'); e.status = 401; throw e; }
  const doc = await store.db.collection('eaKeys').doc(key).get();
  if (!doc.exists) { const e = new Error('Invalid sync key'); e.status = 401; throw e; }
  const { uid, accountId } = doc.data();
  // The key outlives the subscription, so re-check the owner's access on every
  // push — otherwise a lapsed account's EA would keep syncing forever.
  await require('../access').assertAccess(uid);
  const written = await store.existingTickets(uid, 'mt5-ea', accountId);
  const docs = (trades || [])
    .map(t => normalize(t, uid, accountId))
    .filter(t => t.ticket && !written.has(String(t.ticket)));
  if (docs.length) await store.writeTrades(docs);
  await store.setStatus(uid, 'mt5Ea', {
    status: 'connected', accountId, lastSyncAt: Date.now(), imported: written.size + docs.length,
  });
  return docs.length;
}

module.exports = { register, push };
