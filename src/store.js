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
async function existingTickets(uid, source, accountId) {
  const snap = await db.collection('trades').where('uid', '==', uid).get();
  const s = new Set();
  snap.forEach(d => {
    const x = d.data();
    if (x.source !== source || x.ticket == null) return;
    if (accountId !== undefined && (x.accountId || '') !== (accountId || '')) return;
    s.add(String(x.ticket));
  });
  return s;
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

module.exports = { init, setStatus, existingTickets, writeTrades, get db() { return db; } };
