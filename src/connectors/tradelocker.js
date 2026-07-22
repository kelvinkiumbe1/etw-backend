// TradeLocker connector (REST, per-user login — no app key).
// Auth with the trader's email/password/server, list accounts, pull closed
// positions, normalise into the ETW trade schema, then poll for new ones.
//
// Endpoints follow TradeLocker's public REST API. A couple of response shapes
// (esp. the column-config on history) MUST be verified against a real
// demo/live account — those spots are marked "TODO(verify)".
const store = require('../store');
const { getSessionFromTime } = require('../tradeMapper');

const STATUS_KEY = 'tradelocker';
const SOURCE = 'tradelocker';
const active = new Map(); // uid -> { timer }

function baseUrl(env) {
  return (env === 'live' ? 'https://live.tradelocker.com' : 'https://demo.tradelocker.com') + '/backend-api';
}
const setStatus = (uid, patch) => store.setStatus(uid, STATUS_KEY, patch);

async function api(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
  if (!r.ok) { const err = new Error((body && (body.message || body.error)) || ('HTTP ' + r.status)); err.status = r.status; throw err; }
  return body;
}

async function login({ email, password, server, env }) {
  const b = await api(baseUrl(env) + '/auth/jwt/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ email, password, server }),
  });
  const token = b.accessToken || b.access_token;
  if (!token) throw new Error('TradeLocker did not return an access token.');
  return token;
}

async function listAccounts(token, env) {
  const b = await api(baseUrl(env) + '/auth/jwt/all-accounts', {
    headers: { 'Authorization': 'Bearer ' + token, 'accept': 'application/json' },
  });
  return b.accounts || (b.d && b.d.accounts) || [];
}

// TradeLocker returns history rows as arrays + a separate columnConfig. This maps
// them to our trade docs. TODO(verify): confirm column names against a live pull.
function normalizeHistory(payload, { uid, accountId }) {
  const d = payload.d || payload;
  const rows = d.ordersHistory || d.positionsHistory || d.history || [];
  const cols = (d.config && (d.config.ordersHistoryConfig || d.config.positionsHistoryConfig)) || null;
  const idx = {};
  if (Array.isArray(cols)) cols.forEach((c, i) => { idx[(c.id || c.field || c).toString()] = i; });
  const pick = (row, key) => Array.isArray(row) ? (idx[key] != null ? row[idx[key]] : undefined) : row[key];

  const out = [];
  for (const row of rows) {
    const ticket = pick(row, 'id') || pick(row, 'positionId') || pick(row, 'orderId');
    const pnl = parseFloat(pick(row, 'pl') ?? pick(row, 'profit') ?? pick(row, 'realizedPl'));
    const symbol = pick(row, 'instrument') || pick(row, 'symbol') || pick(row, 'tradableInstrumentId');
    const openMs = new Date(pick(row, 'openTime') || pick(row, 'createdDate') || pick(row, 'time') || Date.now()).getTime();
    const closeMs = new Date(pick(row, 'closeTime') || pick(row, 'lastModified') || openMs).getTime();
    if (ticket == null || isNaN(pnl) || !symbol) continue; // skip rows we can't trust
    const sideRaw = (pick(row, 'side') || pick(row, 'direction') || '').toString().toUpperCase();
    out.push({
      uid, pair: String(symbol),
      direction: sideRaw.startsWith('B') || sideRaw === 'LONG' ? 'LONG' : 'SHORT',
      entry: String(pick(row, 'avgPrice') ?? pick(row, 'openPrice') ?? ''),
      closePrice: String(pick(row, 'closePrice') ?? pick(row, 'exitPrice') ?? ''),
      sl: String(pick(row, 'stopLoss') ?? ''), tp: String(pick(row, 'takeProfit') ?? ''),
      lot: String(pick(row, 'qty') ?? pick(row, 'lots') ?? ''),
      pnl: Math.round((pnl + Number.EPSILON) * 100) / 100,
      result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAKEVEN',
      tradeDate: openMs, openTime: openMs, closeTime: new Date(closeMs).toISOString(),
      swap: parseFloat(pick(row, 'swap')) || 0, commission: parseFloat(pick(row, 'commission')) || 0,
      session: getSessionFromTime(openMs), ticket: String(ticket),
      source: SOURCE, rr: '', notes: '', rules: '', psychology: '', model: '',
      accountId: accountId || '', createdAt: Date.now(), updatedAt: Date.now(),
    });
  }
  return out;
}

async function fetchAndStore({ uid, token, env, account, accountId, written }) {
  const accId = account.id;
  const accNum = account.accNum != null ? String(account.accNum) : '';
  const payload = await api(baseUrl(env) + '/trade/accounts/' + accId + '/ordersHistory', {
    headers: { 'Authorization': 'Bearer ' + token, 'accNum': accNum, 'accept': 'application/json' },
  }).catch(() => ({}));
  const trades = normalizeHistory(payload, { uid, accountId: accountId || accId });
  const fresh = trades.filter(t => !written.has(String(t.ticket)));
  if (fresh.length) { await store.writeTrades(fresh); fresh.forEach(t => written.add(String(t.ticket))); }
  await setStatus(uid, { status: 'connected', server: env, historyImported: written.size, lastSyncAt: Date.now(), error: null });
  return fresh.length;
}

async function startSync({ uid, email, password, server, env, accountId }) {
  await stopSync(uid);
  await setStatus(uid, { status: 'connecting', server: env });
  const token = await login({ email, password, server, env });
  const accounts = await listAccounts(token, env);
  if (!accounts.length) throw new Error('No TradeLocker accounts found for this login.');
  const account = (accountId && accounts.find(a => String(a.id) === String(accountId))) || accounts[0];
  const written = await store.existingTickets(uid, SOURCE);
  await fetchAndStore({ uid, token, env, account, accountId, written });
  // Poll every 60s while the process is alive (TradeLocker has no push stream).
  const timer = setInterval(() => {
    fetchAndStore({ uid, token, env, account, accountId, written })
      .catch(e => console.error('tradelocker poll:', e.message));
  }, 60000);
  active.set(uid, { timer });
  return true;
}

async function stopSync(uid) {
  const s = active.get(uid);
  if (s && s.timer) clearInterval(s.timer);
  active.delete(uid);
}

function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/token/i.test(m)) return 'TradeLocker login failed — check email, password and server.';
  if (/account/i.test(m)) return m;
  return 'TradeLocker sync failed: ' + m;
}

module.exports = { startSync, stopSync, friendlyError };
