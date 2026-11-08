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
const cashflows = require('../cashflows');

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

function p2(n) { return String(n).padStart(2, '0'); }
function eaOpenTime(t, openMs) {
  const s = String(t.openTime || '').trim();
  if (/^\d{4}[.\-]\d{2}[.\-]\d{2}[ T]\d{2}:\d{2}/.test(s) && s !== String(t.closeTime || '').trim()) return s.slice(0, 25);
  if (!Number(t.tradeDate)) return '';
  const d = new Date(openMs);
  return d.getUTCFullYear() + '.' + p2(d.getUTCMonth() + 1) + '.' + p2(d.getUTCDate()) + ' '
    + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
}
function holdMin(t) {
  const h = Number(t.holdSeconds);
  return t.holdSeconds != null && t.holdSeconds !== '' && Number.isFinite(h) && h >= 0 ? Math.round(h / 6) / 10 : null;
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
    // Open time in the same terminal-clock format as closeTime, so the two read
    // consistently. Older EAs don't send it: tradeDate is the open time in the
    // terminal clock (written as if UTC), so it is rebuilt from that.
    openTime: eaOpenTime(t, openMs),
    ...(holdMin(t) != null ? { holdMinutes: holdMin(t) } : {}),
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

// Every journal account syncs ONE MT5 account. The EA reports its MT5 login
// (EA builds from this release on); the first login seen is bound to the
// journal account, and a different MT5 account pushing into it is refused.
// Older EAs that do not send a login keep working unchanged.
const bindCache = new Map();     // uid -> { at, login }
async function boundLogin(uid) {
  const hit = bindCache.get(uid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.login;
  let login = '';
  const snap = await store.db.collection('eaKeys').where('uid', '==', uid).get();
  snap.docs.forEach((d) => { const x = d.data(); if (!x.hosted && x.mt5Login && !login) login = String(x.mt5Login); });
  bindCache.set(uid, { at: Date.now(), login }); cap(bindCache);
  return login;
}
async function checkLogin(key, k, meta) {
  const login = String((meta && meta.login) || '').replace(/[^0-9]/g, '').slice(0, 20);
  if (!login || k.hosted) return;
  if (k.mt5Login && String(k.mt5Login) === login) return;
  const bound = k.mt5Login ? String(k.mt5Login) : await boundLogin(k.uid);
  if (bound && bound !== login) {
    const e = new Error('This journal account is already linked to MT5 account #' + bound
      + '. Each journal account syncs one MT5 account — create another account in ETW Journal for #' + login + '.');
    e.status = 403; e.code = 'mt5_account_limit'; throw e;
  }
  const server = String((meta && meta.server) || '').slice(0, 80);
  await store.db.collection('eaKeys').doc(key).set({ mt5Login: login, mt5Server: server, boundAt: Date.now() }, { merge: true });
  k.mt5Login = login;
  keyCache.set(key, { at: Date.now(), data: k });
  bindCache.set(k.uid, { at: Date.now(), login });
}

// Handle an EA push: { login, server, trades:[...] } + key (header or body). Returns count written.
async function push(key, trades, meta, cash) {
  if (!key) { const e = new Error('Missing sync key'); e.status = 401; throw e; }
  // The key is used as a document path, so only accept the shape register() mints.
  if (!/^etw_[0-9a-f]{36}$/.test(String(key))) { const e = new Error('Invalid sync key'); e.status = 401; throw e; }
  const k = await keyData(key);
  if (!k) { const e = new Error('Invalid sync key'); e.status = 401; throw e; }
  const { uid, accountId } = k;
  // The key outlives the subscription, so re-check the owner's access on every
  // push — otherwise a lapsed account's EA would keep syncing forever.
  await checkAccess(uid);
  await checkLogin(key, k, meta);
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
  // Deposits / withdrawals / credits from EA v1.06+ (balance-type deals).
  if (Array.isArray(cash) && cash.length) {
    const cdocs = cash.slice(0, 500).map((c) => {
      const amount = Number(c.amount);
      const cl = cashflows.classifyMt5(c.type, amount);
      if (!cl || !c.ticket || !Number.isFinite(amount)) return null;
      const tsMs = Number(c.timeMs) || Date.parse(String(c.time || '').replace(/^(\d{4})\.(\d{2})\.(\d{2}) /, '$1-$2-$3T') + 'Z');
      return { uid, accountId, source: 'mt5-ea', extId: 'mt5_' + String((meta && meta.login) || k.mt5Login || '') + '_' + String(c.ticket).slice(0, 32),
        kind: cl.kind, sub: cl.sub, amount, currency: c.currency || '', ts: tsMs, note: c.comment || '',
        brokerAccount: String((meta && meta.server) || '').slice(0, 60) + ' ' + String((meta && meta.login) || '') };
    }).filter(Boolean);
    await cashflows.writeCash(cdocs).catch((e) => console.warn('[mt5ea] cash write:', e.message));
  }
  if (docs.length) { await store.writeTrades(docs); store.indexTrades(uid, docs); }
  // A position that just closed comes off the dashboard's open positions at once,
  // even when the next positions snapshot is a while away (hosted runs, EA closed).
  if (docs.length) await dropClosedPositions(uid, docs).catch((e) => console.warn('[mt5ea] drop closed positions:', e.message));
  if (k.hosted && docs.length) {
    // Required here, not at the top: hostedSync requires this module.
    await require('../hostedSync').noteWeekendTrades(uid, k.accountKey, docs)
      .catch((e) => console.warn('[hosted] weekend flag:', e.message));
  }

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


// Live open positions from the user's own EA: a snapshot every ~30s and on
// every trade change. Stored server-side only (brokerPositions/{uid}; no client
// rules exist for that collection) and served to the dashboard by
// GET /api/broker/positions. One slot per EA key, so several MT5 accounts on
// different journal accounts never overwrite each other.
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
// Which open position a closed trade belongs to: its positionId when the EA sends
// one, else the same symbol, side and open time (both are the terminal's clock,
// to the second). A partial close (less volume than the position) keeps it open.
async function dropClosedPositions(uid, docs) {
  const ids = new Set(), keys = [];
  const norm = (v) => String(v || '').trim().replace(/-/g, '.').replace('T', ' ').slice(0, 19);
  docs.forEach((t) => {
    if (t.positionId) ids.add(String(t.positionId));
    if (t.openTime) keys.push({ pair: String(t.pair || '').toUpperCase(), dir: t.direction, at: norm(t.openTime), lot: parseFloat(t.lot) || 0 });
  });
  if (!ids.size && !keys.length) return;
  const closes = (p) => {
    if (ids.has(String(p.id))) return true;
    const at = norm(p.openTime), pair = String(p.pair || '').toUpperCase();
    return !!at && keys.some((k) => k.at === at && k.pair === pair && k.dir === p.dir && !(k.lot && +p.lots && k.lot < +p.lots - 0.001));
  };
  const ref = store.db.collection('brokerPositions').doc(uid);
  await store.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const mt5 = (snap.exists && snap.data().mt5) || {};
    const patch = {};
    Object.keys(mt5).forEach((slot) => {
      const list = (mt5[slot] && mt5[slot].positions) || [];
      const keep = list.filter((p) => !closes(p));
      if (keep.length !== list.length) patch['mt5.' + slot + '.positions'] = keep;
    });
    if (Object.keys(patch).length) tx.update(ref, patch);
  });
}

async function positions(key, list, meta) {
  if (!key || !/^etw_[0-9a-f]{36}$/.test(String(key))) { const e = new Error('Invalid sync key'); e.status = 401; throw e; }
  const k = await keyData(key);
  if (!k) { const e = new Error('Invalid sync key'); e.status = 401; throw e; }
  await checkAccess(k.uid);
  const clean = (Array.isArray(list) ? list : []).slice(0, 200).map((p) => ({
    id: String(p.ticket || p.id || '').slice(0, 32),
    pair: String(p.symbol || '').slice(0, 32),
    dir: /sell|short/i.test(String(p.type || p.dir || '')) ? 'SHORT' : 'LONG',
    lots: num(p.volume || p.lots),
    entry: num(p.priceOpen || p.entry),
    price: num(p.priceCurrent || p.price),
    sl: num(p.sl), tp: num(p.tp),
    pnl: num(p.profit != null ? p.profit : p.pnl), swap: num(p.swap),
    openTime: String(p.time || p.openTime || '').slice(0, 25),
  })).filter((p) => p.id && p.pair);
  const slot = 'k' + require('crypto').createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
  await store.db.collection('brokerPositions').doc(k.uid).set({
    mt5: { [slot]: {
      at: Date.now(), accountId: k.accountId || '', hosted: !!k.hosted,
      login: String((meta && meta.login) || k.mt5Login || '').slice(0, 20),
      server: String((meta && meta.server) || k.mt5Server || '').slice(0, 80),
      currency: String((meta && meta.currency) || '').slice(0, 6),
      balance: num(meta && meta.balance), equity: num(meta && meta.equity),
      positions: clean,
    } },
  }, { merge: true });
  // No deposit in the broker history (prop firms)? Keep an estimated starting balance (hourly at most).
  if (num(meta && meta.balance) > 0) {
    cashflows.ensureMt5Initial(k.uid, { accountId: k.accountId || '', login: String((meta && meta.login) || k.mt5Login || ''), server: String((meta && meta.server) || k.mt5Server || ''),
      currency: String((meta && meta.currency) || ''), balance: num(meta && meta.balance), at: Date.now() }, { everyMs: 60 * 60 * 1000 }).catch(() => {});
  }
  return clean.length;
}

module.exports = { register, registerHosted, revoke, push, positions };
