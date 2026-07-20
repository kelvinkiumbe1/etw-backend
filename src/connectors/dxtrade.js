// DXtrade connector (Devexperts REST — deployed per broker/prop firm).
// The API base is derived from the DXtrade web URL the prop firm gives you.
// Auth is username/password/domain; returns a session token used as
// "Authorization: DXAPI <token>". History shapes vary a little by broker build,
// so mapping spots are marked "TODO(verify)" — confirm against a real account.
const store = require('../store');
const { getSessionFromTime } = require('../tradeMapper');

const STATUS_KEY = 'dxtrade';
const SOURCE = 'dxtrade';
const active = new Map();

// Validate the user-supplied DXtrade URL to prevent SSRF (server fetches this host).
// Require https and reject localhost / private / link-local / reserved IPs.
function validateWebUrl(webUrl) {
  let url;
  try { url = new URL(String(webUrl)); } catch (e) { throw new Error('Invalid DXtrade URL.'); }
  if (url.protocol !== 'https:') throw new Error('DXtrade URL must start with https://.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new Error('That DXtrade host is not allowed.');
  }
  if (host.includes(':')) throw new Error('That DXtrade host is not allowed.'); // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const o = host.split('.').map(Number);
    const isPrivate = o[0] === 10 || o[0] === 127 || o[0] === 0 ||
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
      (o[0] === 192 && o[1] === 168) ||
      (o[0] === 169 && o[1] === 254) ||
      o[0] >= 224; // multicast/reserved
    if (isPrivate) throw new Error('That DXtrade host is not allowed.');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}
function apiBase(webUrl) { return validateWebUrl(webUrl) + '/api'; }
const setStatus = (uid, patch) => store.setStatus(uid, STATUS_KEY, patch);

async function req(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
  if (!r.ok) { const err = new Error((body && (body.message || body.error)) || ('HTTP ' + r.status)); err.status = r.status; throw err; }
  return body;
}

async function login({ base, username, password, domain }) {
  const b = await req(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ username, password, domain: domain || 'default' }),
  });
  const token = b.sessionToken || b.token || b.session_token;
  if (!token) throw new Error('DXtrade did not return a session token.');
  return token;
}

const authHeaders = (token) => ({ 'Authorization': 'DXAPI ' + token, 'accept': 'application/json' });

async function listAccounts(base, token) {
  const b = await req(base + '/accounts', { headers: authHeaders(token) }).catch(() => ({}));
  return b.accounts || b || [];
}

// TODO(verify): confirm the history endpoint + field names for your broker build.
function normalize(rows, { uid, accountId }) {
  const out = [];
  for (const row of rows || []) {
    const ticket = row.positionCode || row.orderId || row.id || row.dealId;
    const pnl = parseFloat(row.realizedPnl ?? row.profit ?? row.pl);
    const symbol = row.symbol || row.instrument;
    if (ticket == null || isNaN(pnl) || !symbol) continue;
    const openMs = new Date(row.openTime || row.createdTime || row.time || Date.now()).getTime();
    const closeMs = new Date(row.closeTime || row.modifiedTime || openMs).getTime();
    const side = (row.side || row.direction || (row.quantity < 0 ? 'SELL' : 'BUY')).toString().toUpperCase();
    out.push({
      uid, pair: String(symbol),
      direction: side.startsWith('B') || side === 'LONG' ? 'LONG' : 'SHORT',
      entry: String(row.openPrice ?? row.avgPrice ?? ''),
      closePrice: String(row.closePrice ?? row.exitPrice ?? ''),
      sl: String(row.stopLoss ?? ''), tp: String(row.takeProfit ?? ''),
      lot: String(Math.abs(parseFloat(row.quantity ?? row.qty ?? row.lots ?? 0))),
      pnl: Math.round((pnl + Number.EPSILON) * 100) / 100,
      result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAKEVEN',
      tradeDate: openMs, closeTime: new Date(closeMs).toISOString(),
      swap: parseFloat(row.swap) || 0, commission: parseFloat(row.commission) || 0,
      session: getSessionFromTime(openMs), ticket: String(ticket),
      source: SOURCE, rr: '', notes: '', rules: '', psychology: '', model: '',
      accountId: accountId || '', createdAt: Date.now(), updatedAt: Date.now(),
    });
  }
  return out;
}

async function fetchAndStore({ uid, base, token, account, accountId, written }) {
  const accId = account && (account.id || account.account || account.code) || accountId || '';
  // TODO(verify): endpoint name for closed positions/history on your broker build.
  const payload = await req(base + '/accounts/' + encodeURIComponent(accId) + '/history', { headers: authHeaders(token) })
    .catch(async () => req(base + '/history?account=' + encodeURIComponent(accId), { headers: authHeaders(token) }).catch(() => ({})));
  const rows = payload.history || payload.positions || payload.orders || payload || [];
  const trades = normalize(Array.isArray(rows) ? rows : [], { uid, accountId: accountId || accId });
  const fresh = trades.filter(t => !written.has(String(t.ticket)));
  if (fresh.length) { await store.writeTrades(fresh); fresh.forEach(t => written.add(String(t.ticket))); }
  await setStatus(uid, { status: 'connected', historyImported: written.size, lastSyncAt: Date.now(), error: null });
  return fresh.length;
}

async function startSync({ uid, webUrl, username, password, domain, accountId }) {
  await stopSync(uid);
  await setStatus(uid, { status: 'connecting' });
  const base = apiBase(webUrl);
  const token = await login({ base, username, password, domain });
  const accounts = await listAccounts(base, token);
  const account = (accountId && (accounts.find ? accounts.find(a => String(a.id || a.account || a.code) === String(accountId)) : null)) || (Array.isArray(accounts) ? accounts[0] : accounts) || {};
  const written = await store.existingTickets(uid, SOURCE);
  await fetchAndStore({ uid, base, token, account, accountId, written });
  const timer = setInterval(() => {
    fetchAndStore({ uid, base, token, account, accountId, written }).catch(e => console.error('dxtrade poll:', e.message));
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
  if (/session|token|login|password/i.test(m)) return 'DXtrade login failed — check the URL, username, password and domain (and that the prop firm enabled API access).';
  return 'DXtrade sync failed: ' + m;
}

module.exports = { startSync, stopSync, friendlyError };
