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
const cashflows = require('../cashflows');

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
// journalAccountId = the ETW journal profile the imported trades should belong to
// (mirrors TradeLocker/DXtrade). Threaded through OAuth state so the callback can tag trades.
function createAuthUrl(uid, journalAccountId) {
  if (!configured()) throw new Error('cTrader is not configured (set CTRADER_CLIENT_ID / SECRET / REDIRECT_URI).');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { uid, journalAccountId: journalAccountId || '', ts: Date.now() });
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

// Pull closed deals and write new ones.
// The 90-day backfill keeps running (on every poll) until it completes without
// errors — so a rate-limited/partial backfill self-heals instead of leaving a
// permanent gap. Only once a backfill fully succeeds do we switch to the light
// 7-day incremental window, and we only advance the cursor when the sync is clean.
// Trades imported before the fix carry the CLOSE time in openTime. For trades this
// sync saw again, put the real open time on the stored copy — only where the stored
// openTime is blank or equals the close time, so an open time the trader typed in
// by hand is never overwritten. Nothing else on the trade is touched.
const OPEN_TIME_FIX_V = 1;

// ── Verified Track Record proof (server-only collections) ──────────────────
// A trade doc lives where the trader can edit it, so the track record does not
// take its word for "live". Every closed deal this sync pulls is also recorded
// in ctProof/{du}__{ticket} = { live, ctid, pnl } — live is cTrader's own
// isLive flag for the account it came from — and the token's accounts in
// ctAccounts/{du}. Both are written by this server only (no client rule allows
// them), and src/trackrecord.js counts a cTrader trade only when its proof says
// live and the P&L still matches. proofPass() (below) builds proofs for history
// imported before this existed, a step at a time; bumping PROOF_V redoes it.
const PROOF_V = 1;

// Which cTrader accounts count for the Verified Track Record:
//   live  — a real-money account (cTrader isLive)                       → counts
//   prop  — cTrader demo environment at a recognised prop firm (paid
//           challenge, verification or funded account — prop firms run
//           simulated accounts, so they are demo-hosted by design)       → counts
//   trial — anything whose broker name, account label or deposit notes say
//           free trial / competition / contest / giveaway                → never
//   demo  — any other demo-environment account                          → never
// cTrader's own "FREE" trial flag is not in the Open API, so trials are caught
// by name and deposit notes; ctraderOpenApi logs each demo-env account's raw
// fields so a real trial can show a sharper signal. Extra prop firms can be
// added without a deploy: CTRADER_PROP_FIRMS="Firm One,Firm Two".
const PROP_FIRMS = ['ftmo', 'fundednext', 'the5ers', '5ers', 'fundingpips', 'alphacapital', 'pipfarm', 'aquafunded',
  'thetradingpit', 'tradingpit', 'instantfunding', 'visiontrade', 'funderpro', 'goatfunded', 'larkfunding', 'onefunded',
  'tfunded', 'thefundedtrader', 'audacitycapital', 'audacityfx', 'mentfunding'];
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function propFirms() { return PROP_FIRMS.concat(String(process.env.CTRADER_PROP_FIRMS || '').split(',').map(squash).filter((x) => x.length >= 3)); }
const NOT_REAL = /\b(free|trial|competitions?|contests?|tournaments?|giveaways?|demo\s*contest|practice)\b/i;
function classifyAccount(a) {
  const text = [a.brokerName, a.brokerTitle, a.label].filter(Boolean).join(' ');
  const sq = squash(text);
  const firm = propFirms().find((f) => sq.includes(f)) || '';
  if (NOT_REAL.test(text) || a.trialHint) return { kind: 'trial', firm };
  if (a.live) return { kind: 'live', firm };
  if (firm) return { kind: 'prop', firm };
  return { kind: 'demo', firm: '' };
}
const PROOF_BACKFILL_DAYS = 365;
const _proofSeen = new Map();   // key -> "live|pnl" already written by this process
const proofKey = (uid, ticket) => uid + '__' + String(ticket).replace(/[^A-Za-z0-9_-]/g, '_');
// Accounts on the token → ctAccounts/{du}.accounts, classified. Keeps a trial
// mark from deposit notes. A complete list replaces the old one; a partial one
// only adds. Other fields of the doc (the proof cursor) are left alone.
async function writeAccounts(uid, accounts, complete) {
  const ref = store.db.collection('ctAccounts').doc(uid);
  let prevAcc = {};
  try { const p = await ref.get(); prevAcc = (p.exists && p.data().accounts) || {}; } catch (e) {}
  const kindOf = {}, map = complete ? {} : Object.assign({}, prevAcc);
  (accounts || []).forEach((a) => {
    const id = String(a.accountId), prev = prevAcc[id] || {};
    const c = classifyAccount({ live: a.live, brokerName: a.brokerName || prev.brokerName, brokerTitle: a.brokerTitle || prev.brokerTitle, label: a.label, trialHint: prev.trialHint });
    kindOf[id] = c.kind;
    map[id] = { label: a.label || prev.label || '', live: !!a.live, kind: c.kind, firm: c.firm, brokerName: a.brokerName || prev.brokerName || '', brokerTitle: a.brokerTitle || prev.brokerTitle || '',
      trialHint: !!prev.trialHint, registeredAt: a.registeredAt || prev.registeredAt || null, at: Date.now() };
  });
  if (accounts && accounts.length) await ref.set({ accounts: map, at: Date.now() }, { mergeFields: ['accounts', 'at'] });
  Object.keys(prevAcc).forEach((id) => { if (!kindOf[id] && prevAcc[id].kind) kindOf[id] = prevAcc[id].kind; });
  return kindOf;
}
// items: { ticket, ctid, live, pnl, closeTime, account }
async function writeProofs(uid, items, kindOf) {
  let batch = store.db.batch(), inBatch = 0, n = 0;
  for (const it of items) {
    if (!it.ticket) continue;
    const key = proofKey(uid, it.ticket), sig = (it.live ? 1 : 0) + '|' + it.pnl;
    if (_proofSeen.get(key) === sig) continue;
    batch.set(store.db.collection('ctProof').doc(key), {
      du: uid, ticket: String(it.ticket), ctid: String(it.ctid || ''), live: !!it.live, kind: (kindOf && kindOf[String(it.ctid || '')]) || (it.live ? 'live' : 'demo'),
      pnl: Number(it.pnl) || 0, closeTime: it.closeTime || null, account: it.account || '', at: Date.now(),
    });
    _proofSeen.set(key, sig); n++;
    if (++inBatch >= 400) { await batch.commit(); batch = store.db.batch(); inBatch = 0; }
  }
  if (inBatch) await batch.commit();
  if (_proofSeen.size > 200000) _proofSeen.clear();
  return n;
}
// Proofs for the trades a normal sync just pulled.
async function saveProofs(uid, trades, accounts, ok) {
  const kindOf = await writeAccounts(uid, accounts, ok);
  return writeProofs(uid, trades.map((tr) => ({ ticket: tr.ticket, ctid: tr.ctid, live: tr.brokerLive, pnl: tr.pnl, closeTime: tr.closeTime, account: tr.brokerAccount })), kindOf);
}

// The proof pass: separate from the trade sync and light (cTrader's deal list
// only — no order history, symbols or lot sizes). It walks back through a year
// of history 12 weeks per sync, keeping its place in ctAccounts/{du}, so a
// timeout or rate limit only costs one step, never the whole backfill. Once
// done it re-checks the last 8 days every sync, and starts over if an account
// it has not seen appears on the token.
const PROOF_STEP = 12 * 7 * 86400000;
async function proofPass(uid) {
  if (!configured()) return 0;
  const ref = store.db.collection('ctAccounts').doc(uid);
  const snap = await ref.get();
  const st = (snap.exists && snap.data()) || {};
  const now = Date.now(), horizon = now - PROOF_BACKFILL_DAYS * 86400000;
  const done = st.proofDone === true && st.proofV === PROOF_V;
  const to = done ? now : Math.min(Number(st.proofCursor) || now, now);
  const from = done ? now - 8 * 86400000 : Math.max(horizon, to - PROOF_STEP);
  const t = await ensureToken(uid);
  const r = await engine.fetchDealProofs({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, accessToken: t.accessToken, from, to });
  const kindOf = r.accounts.length ? await writeAccounts(uid, r.accounts, r.ok) : {};
  const n = await writeProofs(uid, r.deals, kindOf);
  const seen = r.accounts.map((a) => String(a.accountId));
  const patch = {};
  if (r.ok) {
    if (!done) { patch.proofCursor = from; if (from <= horizon) { patch.proofDone = true; patch.proofV = PROOF_V; } else patch.proofDone = false; }
    const known = new Set((st.proofCtids || []).map(String));
    if (done && seen.some((id) => !known.has(id))) { patch.proofDone = false; patch.proofCursor = now; }   // new account: backfill it too
    patch.proofCtids = [...new Set([...known, ...seen])];
  }
  patch.proofAt = now;
  await ref.set(patch, { merge: true });
  console.log('ctrader: proof pass for', uid, new Date(from).toISOString().slice(0, 10), '→', new Date(to).toISOString().slice(0, 10) + ':', r.deals.length, 'deal(s),', n, 'new proof(s)' + (r.ok ? '' : ' — incomplete, will retry this step') + (patch.proofDone ? ' — backfill complete' : ''));
  return n;
}
function toMs(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (/^\d+$/.test(String(v))) { const n = Number(v); return n > 1e12 ? n : n * 1000; }
  const p = Date.parse(String(v).replace(/^(\d{4})\.(\d{2})\.(\d{2}) /, '$1-$2-$3T'));
  return Number.isFinite(p) ? p : NaN;
}
async function repairOpenTimes(uid, seen) {
  const byTicket = new Map();
  seen.forEach((tr) => { if (tr.openTime) byTicket.set(String(tr.ticket), tr); });
  if (!byTicket.size) return 0;
  const snap = await store.db.collection('trades').where('uid', '==', uid).where('source', '==', 'ctrader_open_api').get();
  let batch = store.db.batch(), n = 0, inBatch = 0;
  for (const doc of snap.docs) {
    const x = doc.data() || {};
    const tr = byTicket.get(String(x.ticket || ''));
    if (!tr) continue;
    const cur = toMs(x.openTime), closeMs = toMs(x.closeTime) || toMs(x.tradeDate);
    const wrong = !Number.isFinite(cur) || (Number.isFinite(closeMs) && Math.abs(cur - closeMs) < 1000);
    if (!wrong) continue;
    const patch = { openTime: tr.openTime, session: tr.session, updatedAt: Date.now() };
    if (tr.holdMinutes != null) patch.holdMinutes = tr.holdMinutes;
    batch.update(doc.ref, patch); n++; inBatch++;
    if (inBatch >= 400) { await batch.commit(); batch = store.db.batch(); inBatch = 0; }
  }
  if (inBatch) await batch.commit();
  return n;
}

async function syncUser(uid, { backfill, journalAccountId } = {}) {
  const t = await ensureToken(uid);
  const statusSnap = await store.db.collection('users').doc(uid).get();
  const status = (statusSnap.exists && statusSnap.data()[STATUS_KEY]) || {};
  // Which ETW journal profile these trades belong to. Prefer the value captured at
  // connect time; fall back to what's stored on the status doc; default to '' (= default profile).
  const jid = (journalAccountId != null ? journalAccountId : (status.journalAccountId || '')) || '';
  const now = Date.now();
  // One-off: re-pull the 90-day history so trades imported before the open-time
  // fix get their real open time (see repairOpenTimes).
  const needTimeFix = status.openTimeFixV !== OPEN_TIME_FIX_V;
  const doBackfill = backfill || status.backfillDone !== true || needTimeFix;
  const from = doBackfill
    ? now - 90 * 86400000
    : Math.max(Number(status.lastDealSyncAt || 0), now - 7 * 86400000);

  const { accounts, trades, ok } = await engine.fetchClosedTrades({
    uid, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, accessToken: t.accessToken, from, to: now,
  });

  // All cTrader trades are tagged with the chosen journal profile so the frontend's
  // per-account filter shows them (the cTrader account number stays in brokerAccount).
  trades.forEach((tr) => { tr.accountId = jid; });

  // Proof first (every deal pulled, new or already journaled) — the track record's
  // live / demo source of truth.
  let proofs = 0;
  try { proofs = await saveProofs(uid, trades, accounts, ok); }
  catch (e) { console.warn('ctrader: proof write failed for', uid, '-', e.message); }

  const existing = await store.existingTickets(uid, 'ctrader_open_api', jid);
  const fresh = trades.filter((tr) => !existing.has(String(tr.ticket)));
  const written = fresh.length ? await store.writeTrades(fresh) : 0;
  let repaired = 0;
  try { repaired = await repairOpenTimes(uid, trades.filter((tr) => existing.has(String(tr.ticket)))); }
  catch (e) { console.warn('ctrader: open-time repair failed for', uid, '-', e.message); }

  const patch = {
    status: 'connected',
    accounts,
    journalAccountId: jid,
    historyImported: Number(status.historyImported || 0) + written,
    lastSyncAt: now,
    note: null,
    error: null,
  };
  // Only advance the cursor / mark backfill done when the pull was COMPLETE.
  // If it failed (e.g. rate-limited), leave them so the next poll retries the
  // same window instead of skipping past missed deals.
  if (ok) {
    patch.lastDealSyncAt = now - 60000;
    if (doBackfill) patch.backfillDone = true;
    if (needTimeFix) patch.openTimeFixV = OPEN_TIME_FIX_V;
  }
  await setStatus(uid, patch);
  // Deposits / withdrawals ride along, at most every 30 minutes (first time: a year back).
  try { await syncCash(uid, { jid, status }); }
  catch (e) { console.warn('ctrader: cash flow sync failed for', uid, '-', e.message); }
  if (repaired) console.log('ctrader: fixed open time on', repaired, 'existing trade(s) for', uid);
  if (proofs) console.log('ctrader: recorded', proofs, 'track-record proof(s) for', uid);
  if (written) console.log('ctrader: wrote', written, 'new trade(s) for', uid, 'profile', jid || '(default)');
  else if (!ok) console.log('ctrader: sync incomplete for', uid, '— will retry on next poll');
  return written;
}

// Deposits / withdrawals / other balance operations → `cashflows`.
const CASH_EVERY = 30 * 60 * 1000;
const CASH_BACKFILL_V = 1;
async function syncCash(uid, { jid, status, force } = {}) {
  if (!status) { const s = await store.db.collection('users').doc(uid).get(); status = (s.exists && s.data()[STATUS_KEY]) || {}; }
  if (jid == null) jid = status.journalAccountId || '';
  const now = Date.now();
  const first = status.cashBackfillV !== CASH_BACKFILL_V;
  if (!force && !first && now - Number(status.lastCashSyncAt || 0) < CASH_EVERY) return 0;
  const from = first ? now - 365 * 86400000 : Math.max(Number(status.lastCashSyncAt || 0) - 2 * 86400000, now - 60 * 86400000);
  const t = await ensureToken(uid);
  const r = await engine.fetchCashFlows({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, accessToken: t.accessToken, from, to: now });
  const docs = r.items.map((it) => {
    const c = cashflows.classifyCtrader(it.op, it.delta);
    return { uid, accountId: jid, source: 'ctrader_open_api', extId: 'ct' + it.ctid + '_' + it.id, kind: c.kind, sub: c.sub, amount: c.amount,
      ts: it.ts, note: it.note, balance: it.balance, brokerAccount: it.label };
  });
  const n = await cashflows.writeCash(docs);
  // A free trial / competition account often says so in its funding note.
  const hinted = [...new Set(r.items.filter((it) => NOT_REAL.test(String(it.note || ''))).map((it) => String(it.ctid)))];
  if (hinted.length) {
    try {
      const ref = store.db.collection('ctAccounts').doc(uid), cur = await ref.get();
      const accs = (cur.exists && cur.data().accounts) || {};
      const patch = {};
      hinted.forEach((id) => { const a = accs[id] || {}; if (!a.trialHint) patch[id] = Object.assign({}, a, { trialHint: true, kind: 'trial' }); });
      if (Object.keys(patch).length) { await ref.set({ accounts: patch }, { merge: true }); console.log('ctrader: marked', Object.keys(patch).length, 'account(s) as trial / competition from deposit notes for', uid); }
    } catch (e) { console.warn('ctrader: trial hint failed for', uid, '-', e.message); }
  }
  const balances = {};
  (r.accounts || []).forEach((a) => { if (a.balance != null) balances[a.ctid] = { balance: a.balance, label: a.label, live: a.live, at: now }; });
  const patch = { cashBalances: balances };
  if (r.ok) { patch.lastCashSyncAt = now; patch.cashBackfillV = CASH_BACKFILL_V; }
  await setStatus(uid, patch);
  if (n) console.log('ctrader: synced', n, 'balance operation(s) for', uid);
  return n;
}

// Step 2 — Spotware redirects here with ?code=&state=
async function handleCallback(code, state) {
  const rec = state && pendingStates.get(state);
  if (!rec) throw new Error('Invalid or expired OAuth state.');
  pendingStates.delete(state);
  const uid = rec.uid;
  const journalAccountId = rec.journalAccountId || '';
  await setStatus(uid, { status: 'connecting', error: null, journalAccountId });
  const tok = await exchangeToken(code);   // fail fast if the code is bad
  await saveTokens(uid, tok);
  // Backfill runs in the background so the popup can close immediately; the
  // frontend watches the status doc and flips to "connected" when it finishes.
  syncUser(uid, { backfill: true, journalAccountId }).catch(async (e) => {
    console.error('ctrader initial sync failed for', uid, '-', e.message);
    await setStatus(uid, { status: 'error', error: friendlyError(e) }).catch(() => {});
  }).then(() => proofPass(uid)).catch((e) => console.warn('ctrader: proof pass failed for', uid, '-', e.message));
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
    // Runs even when the trade sync failed, so verification never waits on it.
    try { await proofPass(doc.id); }
    catch (e) { console.warn('ctrader: proof pass failed for', doc.id, '-', e.message); }
  }
}

function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/not configured/i.test(m)) return m;
  if (/state/i.test(m)) return 'cTrader authorization expired — please try connecting again.';
  return 'cTrader connect failed: ' + m;
}

// Broker-native candles for one symbol/timeframe/window, using the user's stored
// cTrader token. Resolves the account env (live/demo) via discoverAccounts so the
// bars come from the same host the trades were executed on.
async function getBars(uid, { symbol, tf, from, to, accountId }) {
  if (!configured()) throw new Error('cTrader is not configured.');
  const t = await ensureToken(uid);
  let env = 'live', ctid = accountId;
  try {
    const accts = await engine.discoverAccounts({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, accessToken: t.accessToken });
    const match = (accts || []).find((a) => String(a.ctidTraderAccountId) === String(accountId)) || (accts || [])[0];
    if (match) { env = match.isLive ? 'live' : 'demo'; ctid = match.ctidTraderAccountId; }
  } catch (e) { /* fall back to the provided accountId on live */ }
  if (!ctid) throw new Error('No cTrader account resolved for bars.');
  return engine.fetchTrendbars({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, accessToken: t.accessToken, ctid, env, symbolName: symbol, tf, from, to });
}


// Live open positions for the dashboard (read-only), cached briefly so a
// dashboard left open does not hammer cTrader.
// A position stays listed until cTrader itself no longer reports it: when an
// account (or cTrader as a whole) cannot be read for a moment, the last known
// positions of that account are kept (marked stale) instead of disappearing.
// The last good list is also kept in Firestore so a server restart keeps it.
const _posCache = new Map();
const _lastGood = new Map();   // uid -> { at, list }
const POS_KEEP_MS = 14 * 86400000;
function posRef(uid) { return store.db.collection('brokerPositions').doc(uid); }
async function lastGood(uid) {
  if (_lastGood.has(uid)) return _lastGood.get(uid);
  let v = { at: 0, list: [] };
  try { const s = await posRef(uid).get(); const c = s.exists && s.data().ctrader; if (c && Array.isArray(c.positions)) v = { at: +c.at || 0, list: c.positions }; } catch (e) {}
  _lastGood.set(uid, v); if (_lastGood.size > 2000) _lastGood.delete(_lastGood.keys().next().value);
  return v;
}
async function saveGood(uid, list) {
  const prev = _lastGood.get(uid);
  const sig = (l) => l.map((p) => p.id + ':' + p.sl + ':' + p.tp + ':' + p.lots).sort().join('|');
  // everything still open, incl. positions of an account that could not be read (they keep lastSeen)
  const fresh = list.map((p) => (p.stale ? Object.assign({}, p, { stale: false }) : p));
  _lastGood.set(uid, { at: Date.now(), list: fresh });
  if (prev && sig(prev.list) === sig(fresh) && Date.now() - prev.at < 3600000) return;   // unchanged: no write
  try { await posRef(uid).set({ ctrader: { at: Date.now(), positions: fresh.map((p) => Object.assign({}, p, { pnl: null })) } }, { merge: true }); } catch (e) {}
}
async function getPositions(uid) {
  if (!configured()) return [];
  const hit = _posCache.get(uid);
  if (hit && Date.now() - hit.at < 20000) return hit.list;
  const prev = await lastGood(uid);
  const keepOld = (p) => Object.assign({}, p, { stale: true, pnl: null, lastSeen: p.lastSeen || prev.at });
  let list;
  try {
    const t = await ensureToken(uid);
    const got = await engine.fetchOpenPositions({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, accessToken: t.accessToken });
    const failed = new Set(got.failedAccounts || []);
    list = got.slice();
    if (failed.size && Date.now() - prev.at < POS_KEEP_MS) {
      const have = new Set(list.map((p) => String(p.id)));
      prev.list.forEach((p) => { if (!have.has(String(p.id)) && (!p.ctid || failed.has(String(p.ctid)))) list.push(keepOld(p)); });
    }
    await saveGood(uid, list);
  } catch (e) {
    // cTrader did not answer at all: show what was open last time, marked stale.
    if (!prev.list.length || Date.now() - prev.at > POS_KEEP_MS) throw e;
    list = prev.list.map(keepOld);
    list.stale = true;
  }
  _posCache.set(uid, { at: Date.now(), list });
  if (_posCache.size > 2000) _posCache.delete(_posCache.keys().next().value);
  return list;
}

module.exports = { init, configured, createAuthUrl, handleCallback, disconnect, syncUser, syncCash, friendlyError, getBars, getPositions, classifyAccount, proofPass };
