// Shared Firestore helpers used by every platform connector so they all write
// trades in the identical schema the ETW journal reads, and all report status
// under users/{uid}.<key>.
let db = null;

function init(_db) { db = _db; }

async function setStatus(uid, key, patch) {
  await db.collection('users').doc(uid).set(
    { [key]: Object.assign({ updatedAt: Date.now() }, patch) },
    { merge: true }
  );
}

// Tickets already stored for this user+source (+account), so re-syncs never duplicate.
// Query by uid only (single-field — no composite index needed) and filter in memory.
// When accountId is given, dedup is scoped to that account so the same broker trades
// can sync into a different profile.
async function existingTickets(uid, source, accountId, accountKey) {
  const snap = await db.collection('trades').where('uid', '==', uid).get();
  const s = new Set();
  snap.forEach(d => {
    const x = d.data();
    if (x.source !== source || x.ticket == null) return;
    if (accountId !== undefined && (x.accountId || '') !== (accountId || '')) return;
    if (accountKey !== undefined && x.mt5AccountKey && x.mt5AccountKey !== accountKey) return;
    s.add(String(x.ticket));
  });
  return s;
}

// Per-uid index of stored tickets, for the EA push path. The EA posts one deal
// per request, so a 300-deal backfill used to read the user's whole trades
// collection 300 times. The index is read once, kept for INDEX_TTL_MS and
// updated in place as trades are written. Keyed `${source}|${accountId}`; the
// set holds tickets, plus `pos:<positionId>` for trades that carry one.
const INDEX_TTL_MS = 60 * 1000;
const tradeIndexes = new Map();   // uid -> { at, map: Map<string, Set<string>> }

function indexAdd(map, t) {
  if (t.ticket == null) return;
  const k = (t.source || '') + '|' + (t.accountId || '');
  if (!map.has(k)) map.set(k, new Set());
  map.get(k).add(String(t.ticket));
  if (t.positionId) map.get(k).add('pos:' + t.positionId);
}

async function tradeIndex(uid) {
  const hit = tradeIndexes.get(uid);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.map;
  const snap = await db.collection('trades').where('uid', '==', uid).get();
  const map = new Map();
  snap.forEach(d => indexAdd(map, d.data()));
  tradeIndexes.set(uid, { at: Date.now(), map });
  if (tradeIndexes.size > 500) tradeIndexes.delete(tradeIndexes.keys().next().value);
  return map;
}

function indexTrades(uid, trades) {
  const hit = tradeIndexes.get(uid);
  if (hit) trades.forEach(t => indexAdd(hit.map, t));
}

async function writeTrades(trades) {
  let n = 0;
  for (let i = 0; i < trades.length; i += 400) {
    const batch = db.batch();
    for (const t of trades.slice(i, i + 400)) { batch.set(db.collection('trades').doc(), t); n++; }
    await batch.commit();
  }
  // Single choke point for every connector, so risk interventions are evaluated
  // here rather than in each one. Fire-and-forget: a warning must never be able
  // to fail an import.
  try { require('./aiGuard').onTradesWritten(trades); } catch (e) { /* guard is optional */ }
  return n;
}

module.exports = { init, setStatus, existingTickets, tradeIndex, indexTrades, writeTrades, get db() { return db; } };
