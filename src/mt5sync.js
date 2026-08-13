// MT5 / MT4 sync engine (via MetaApi.cloud).
// Deploys the account, then imports closed trades using an RPC connection
// (getDealsByTimeRange) — more reliable than the streaming historyStorage — and
// re-polls periodically for new trades. Status is written to
// users/{uid}.mt5Direct so the frontend can watch it live.
//
// SDK: targets metaapi.cloud-sdk v27. Version-sensitive calls are flagged "SDK:".

const MetaApi = require('metaapi.cloud-sdk').default;
const { buildTradesFromDeals } = require('./tradeMapper');
const store = require('./store');

const STATUS_KEY = 'mt5Direct';
let api = null;
const active = new Map(); // uid -> { account, rpc, timer, written, ... }

function init() {
  const token = process.env.METAAPI_TOKEN;
  if (!token) throw new Error('METAAPI_TOKEN env var is required.');
  api = new MetaApi(token, process.env.METAAPI_REGION ? { region: process.env.METAAPI_REGION } : {});
}

const setStatus = (uid, patch) => store.setStatus(uid, STATUS_KEY, patch);

async function findOrCreateAccount({ uid, login, password, server, platform }) {
  try {
    const acApi = api.metatraderAccountApi;
    // SDK name varies by version: v27 uses getAccountsWithInfiniteScrollPagination / -ClassicPagination.
    const lister = acApi.getAccountsWithInfiniteScrollPagination || acApi.getAccountsWithClassicPagination || acApi.getAccounts;
    if (lister) {
      const res = await lister.call(acApi, {});
      const list = Array.isArray(res) ? res : (res && (res.items || res.accounts)) || [];
      const found = list.find(a => String(a.login) === String(login) && a.server === server);
      if (found) return found;
    }
  } catch (e) { console.warn('account lookup skipped:', e.message); }
  return api.metatraderAccountApi.createAccount({ // SDK:
    name: `etw-${uid}-${login}`.slice(0, 64),
    // cloud-g1 supports the cheaper "regular" reliability; cloud-g2 is high-reliability only.
    type: process.env.METAAPI_ACCOUNT_TYPE || 'cloud-g1',
    login: String(login),
    password,
    server,
    platform: platform === 'mt4' ? 'mt4' : 'mt5',
    magic: 0,
    application: 'MetaApi',
    reliability: process.env.METAAPI_RELIABILITY || 'regular',
  });
}

async function fetchDeals(rpc) {
  const start = new Date(Date.UTC(2015, 0, 1));
  const end = new Date(Date.now() + 24 * 3600 * 1000);
  const res = await rpc.getDealsByTimeRange(start, end); // SDK:
  return (res && res.deals) || (Array.isArray(res) ? res : []);
}

async function syncOnce(sync) {
  const deals = await fetchDeals(sync.rpc);
  const trades = buildTradesFromDeals(deals, { uid: sync.uid, accountId: sync.accountId })
    .map(t => ({ ...t, source: sync.source }));
  const fresh = trades.filter(t => !sync.written.has(String(t.ticket)));
  if (fresh.length) { await store.writeTrades(fresh); fresh.forEach(t => sync.written.add(String(t.ticket))); }
  await setStatus(sync.uid, {
    status: 'connected', platform: sync.platform, login: String(sync.login || ''), server: sync.server || '',
    metaApiAccountId: sync.account.id, historyImported: sync.written.size, lastSyncAt: Date.now(), error: null,
  });
  console.log(`mt5 sync (uid ${sync.uid}): ${deals.length} deals, +${fresh.length} new trades, ${sync.written.size} total`);
  return fresh.length;
}

async function _connectAndSync(sync) {
  console.log(`mt5: deploying account ${sync.account.id}`);
  await sync.account.deploy();
  await sync.account.waitConnected();
  console.log('mt5: broker connected, opening RPC connection');
  sync.rpc = sync.account.getRPCConnection();
  await sync.rpc.connect();
  await sync.rpc.waitSynchronized();
  console.log('mt5: RPC synchronized, importing deals');
  await syncOnce(sync);
  sync.timer = setInterval(() => { syncOnce(sync).catch(e => console.error('mt5 poll error:', e.message)); }, 60000);
  active.set(sync.uid, sync);
}

async function startSync({ uid, login, password, server, accountId, platform }) {
  await stopSync(uid, { forget: false }).catch(() => {});
  console.log(`mt5 startSync: uid ${uid}, login ${login}, server ${server}`);
  const account = await findOrCreateAccount({ uid, login, password, server, platform });
  // Was this account ALREADY deployed? If so no history backfill is about to
  // happen, so MetaApi is not about to charge us for one — and the connect fee
  // the route just took should be handed back. Observing this beats guessing
  // whether MetaApi re-bills a redeploy. Read it before deploy(), which is a
  // no-op on an already-deployed account and would erase the distinction.
  const wasDeployed = String(account.state || '').toUpperCase() === 'DEPLOYED';
  const source = (platform === 'mt4' ? 'mt4' : 'mt5') + '-direct';
  const sync = {
    uid, login, server, accountId: accountId || '', platform: platform === 'mt4' ? 'mt4' : 'mt5',
    source, account, written: await store.existingTickets(uid, source),
  };
  await _connectAndSync(sync);
  return { ok: true, wasDeployed, metaApiAccountId: account.id };
}

// forget:   undeploy AND delete the MetaApi account (user disconnected for good)
// undeploy: undeploy but keep the account (token balance ran dry — they'll be
//           back, and keeping it spares them a fresh history import)
async function stopSync(uid, { forget, undeploy } = {}) {
  const sync = active.get(uid);
  if (!sync) return;
  if (sync.timer) clearInterval(sync.timer);
  try { if (sync.rpc) await sync.rpc.close(); } catch (e) {}
  if (forget) {
    try { await sync.account.undeploy(); } catch (e) {}
    try { await sync.account.remove(); } catch (e) {}
    await store.setStatus(uid, STATUS_KEY, { metaApiAccountId: null });
  } else if (undeploy) {
    // The point of stopping on depletion: an account left deployed keeps
    // billing us for a user who has stopped paying.
    try { await sync.account.undeploy(); } catch (e) { console.warn('mt5 undeploy:', e.message); }
  }
  active.delete(uid);
}

// Rebuild a sync context from Firestore alone. The MetaApi account keeps the
// broker credentials once created, so re-attaching never needs the password
// again — which is what makes weekend pause/resume and daily pulls possible
// without storing anything sensitive on our side.
async function _syncFromDoc(uid, d) {
  if (!d || !d.metaApiAccountId) throw new Error('No MetaApi account on file for this user.');
  const account = await api.metatraderAccountApi.getAccount(d.metaApiAccountId); // SDK:
  const platform = d.platform === 'mt4' ? 'mt4' : 'mt5';
  const source = platform + '-direct';
  return {
    uid, login: d.login, server: d.server, accountId: d.journalAccountId || '',
    platform, source, account, written: await store.existingTickets(uid, source),
  };
}

async function _readStatus(uid) {
  const snap = await store.db.collection('users').doc(uid).get();
  return (snap.exists && snap.data().mt5Direct) || null;
}

// ── Daily mode: one deploy → pull → undeploy cycle ─────────────────────────
// MetaApi charges $0.118125 per deployment but only $0.00105/hr while
// undeployed, so a once-a-day round trip costs roughly a third of holding the
// connection open — at the price of trades landing within a day, not a minute.
async function pullOnce(uid) {
  const d = await _readStatus(uid);
  const sync = await _syncFromDoc(uid, d);
  await sync.account.deploy();
  await sync.account.waitConnected();
  sync.rpc = sync.account.getRPCConnection();
  await sync.rpc.connect();
  await sync.rpc.waitSynchronized();
  let fresh = 0;
  try { fresh = await syncOnce(sync); }
  finally {
    try { if (sync.rpc) await sync.rpc.close(); } catch (e) {}
    // Undeploy in a finally: a pull that throws halfway must not leave the
    // account deployed and quietly billing at the live rate.
    try { await sync.account.undeploy(); } catch (e) { console.warn('mt5 pull undeploy:', e.message); }
  }
  await setStatus(uid, { lastPullAt: Date.now() });
  console.log(`mt5 daily pull (uid ${uid}): +${fresh} trades`);
  return fresh;
}

// ── Weekend pause / resume ─────────────────────────────────────────────────
// No trade can close while the market is shut, so ~206 hours a month were being
// billed for nothing. Pausing undeploys (19x cheaper) and keeps the account, so
// resuming costs one deployment rather than a fresh history import.
async function pause(uid, reason) {
  await stopSync(uid, { undeploy: true }).catch(() => {});
  // Not in the active map (e.g. after a restart)? Undeploy via the API anyway.
  if (!active.has(uid)) {
    try {
      const d = await _readStatus(uid);
      if (d && d.metaApiAccountId) {
        const account = await api.metatraderAccountApi.getAccount(d.metaApiAccountId);
        await account.undeploy();
      }
    } catch (e) { console.warn('mt5 pause undeploy:', e.message); }
  }
  await setStatus(uid, { status: 'paused', pausedReason: reason || 'market_closed', error: null });
  console.log(`mt5 paused (${reason}) for`, uid);
}

async function resumeOne(uid) {
  const d = await _readStatus(uid);
  const sync = await _syncFromDoc(uid, d);
  await _connectAndSync(sync);
  await setStatus(uid, { pausedReason: null });
  console.log('mt5 resumed for', uid);
  return true;
}

// After a process restart, re-attach to every previously-connected user (no
// password needed). Only 'connected' users in LIVE mode hold an open connection;
// daily-mode and paused users are intentionally left undeployed.
async function resumeAll() {
  try {
    const snap = await store.db.collection('users').where('mt5Direct.status', '==', 'connected').get();
    for (const doc of snap.docs) {
      const d = doc.data().mt5Direct || {};
      if (!d.metaApiAccountId) continue;
      if ((d.mode || 'live') !== 'live') continue;   // daily mode: the scheduler handles it
      const uid = doc.id;
      try {
        const sync = await _syncFromDoc(uid, d);
        await _connectAndSync(sync);
        console.log('resumed MT sync for', uid);
      } catch (e) { console.error('resume failed for', uid, '-', e.message); }
    }
  } catch (e) { console.error('resumeAll failed:', e.message); }
}

// ── Dormant-account pruning ────────────────────────────────────────────────
// A registered-but-idle account still costs $0.00105/hr ($0.77/mo) to sit in
// MetaApi's cloud. Deleting it stops that, but re-adding later costs $2.10 —
// so pruning only pays off past roughly three months of silence. Anything more
// eager loses money on every user who comes back.
async function findDormant(days) {
  const cutoff = Date.now() - Math.max(1, Number(days)) * 86400000;
  const out = [];
  // Only ever consider accounts that are NOT in use. 'paused' is excluded on
  // purpose — that's the weekend, not abandonment.
  const snap = await store.db.collection('users')
    .where('mt5Direct.status', 'in', ['disconnected', 'depleted', 'error']).get();
  snap.forEach((doc) => {
    const d = doc.data().mt5Direct || {};
    if (!d.metaApiAccountId) return;
    const seen = Number(d.lastSyncAt || d.lastPullAt || d.updatedAt || 0);
    if (seen && seen < cutoff) out.push({ uid: doc.id, lastSeen: seen });
  });
  return out;
}

async function removeAccount(uid) {
  const d = await _readStatus(uid);
  if (!d || !d.metaApiAccountId) return false;
  await stopSync(uid, { forget: false }).catch(() => {});
  const account = await api.metatraderAccountApi.getAccount(d.metaApiAccountId); // SDK:
  try { await account.undeploy(); } catch (e) {}
  await account.remove();
  // Null the id so a future connect provisions fresh rather than chasing an
  // account that no longer exists.
  await setStatus(uid, { metaApiAccountId: null, prunedAt: Date.now() });
  console.log('mt5: pruned dormant MetaApi account for', uid);
  return true;
}

function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/METAAPI_TOKEN/i.test(m)) return m;
  if (/top up|balance/i.test(m)) return 'MetaApi balance too low to deploy this account — top up at app.metaapi.cloud.';
  if (/token/i.test(m) && /metaapi|auth/i.test(m)) return 'MetaApi token invalid or expired — check METAAPI_TOKEN.';
  if (/server/i.test(m) && /not found|unknown|invalid/i.test(m)) return 'Server name not found. Copy it exactly from your terminal / prop dashboard.';
  if (/password|invalid account|authorization failed|login/i.test(m)) return 'Login or password was rejected by the broker.';
  return 'Could not connect: ' + m;
}

module.exports = {
  init, startSync, stopSync, resumeAll, setStatus, friendlyError,
  pullOnce, pause, resumeOne, findDormant, removeAccount,
  isActive: (uid) => active.has(uid),
};
