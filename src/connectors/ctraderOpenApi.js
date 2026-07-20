// cTrader Open API deal-sync engine (JSON over WebSocket, port 5036).
// Ported from the ETW frontend's proven flow in journal.html (~17471-17619):
//   APP_AUTH -> GET_ACCOUNTS -> ACCOUNT_AUTH -> SYMBOLS -> DEAL_LIST -> map deals.
// Runs server-side with the `ws` package so cTrader trades sync without the
// browser tab being open and without exposing the client secret.
const WebSocket = require('ws');
const { getSessionFromTime } = require('../tradeMapper');

const PT = {
  HEARTBEAT: 51, APP_AUTH_REQ: 2100, APP_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102, ACCOUNT_AUTH_RES: 2103,
  SYMBOLS_LIST_REQ: 2114, SYMBOLS_LIST_RES: 2115,
  DEAL_LIST_REQ: 2133, DEAL_LIST_RES: 2134,
  ERROR_RES: 2142, GET_ACCOUNTS_REQ: 2149, GET_ACCOUNTS_RES: 2150,
};

const endpoint = (env) =>
  String(env || 'live').toLowerCase() === 'demo'
    ? 'wss://demo.ctraderapi.com:5036'
    : 'wss://live.ctraderapi.com:5036';

function r2(n) { return Math.round(((+n || 0) + Number.EPSILON) * 100) / 100; }
function money(value, digits) {
  const n = Number(value || 0);
  const d = Number.isFinite(Number(digits)) ? Number(digits) : 2;
  return n / Math.pow(10, d);
}
function side(v) {
  const s = String(v).toUpperCase();
  return (s === '1' || s === 'BUY') ? 'LONG' : 'SHORT';
}

// ── A single JSON-WebSocket session against one cTrader host ──────────────
class CtSession {
  constructor(env) {
    this.env = env;
    this.ws = null;
    this.waiters = []; // { types:[], resolve, reject, timer }
    this.seq = 0;
  }
  open(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint(this.env));
      this.ws = ws;
      const t = setTimeout(() => { try { ws.terminate(); } catch (e) {} reject(new Error('Could not reach cTrader Open API.')); }, timeoutMs);
      ws.on('open', () => { clearTimeout(t); resolve(); });
      ws.on('error', (e) => { clearTimeout(t); reject(new Error('cTrader WebSocket connection failed: ' + (e && e.message || e))); });
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', () => {
        for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('cTrader socket closed.')); }
      });
    });
  }
  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (msg.payloadType === PT.ERROR_RES) {
      const p = msg.payload || {};
      const err = new Error((p.errorCode || 'CTRADER_ERROR') + (p.description ? ': ' + p.description : ''));
      const w = this.waiters.shift();
      if (w) { clearTimeout(w.timer); w.reject(err); }
      return;
    }
    const idx = this.waiters.findIndex((w) => w.types.includes(msg.payloadType));
    if (idx >= 0) { const w = this.waiters.splice(idx, 1)[0]; clearTimeout(w.timer); w.resolve(msg); }
  }
  send(payloadType, payload) {
    const clientMsgId = 'ct_' + (++this.seq) + '_' + Math.random().toString(36).slice(2);
    this.ws.send(JSON.stringify({ clientMsgId, payloadType, payload: payload || {} }));
    return clientMsgId;
  }
  wait(types, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('cTrader timed out waiting for response.'));
      }, timeoutMs);
      const waiter = { types: [].concat(types), resolve, reject, timer };
      this.waiters.push(waiter);
    });
  }
  async request(reqType, resType, payload, timeoutMs) {
    this.send(reqType, payload);
    const res = await this.wait(resType, timeoutMs);
    return res.payload || {};
  }
  async appAuth(clientId, clientSecret) {
    this.send(PT.APP_AUTH_REQ, { clientId, clientSecret });
    await this.wait(PT.APP_AUTH_RES);
  }
  close() { try { if (this.ws) this.ws.close(); } catch (e) {} }
}

// Discover every ctidTraderAccount linked to this access token (isLive flag included).
async function discoverAccounts({ clientId, clientSecret, accessToken }) {
  // Account list is token-scoped and returned on either host once the app is authed.
  for (const env of ['live', 'demo']) {
    const s = new CtSession(env);
    try {
      await s.open();
      await s.appAuth(clientId, clientSecret);
      const res = await s.request(PT.GET_ACCOUNTS_REQ, PT.GET_ACCOUNTS_RES, { accessToken });
      const accounts = res.ctidTraderAccount || [];
      s.close();
      if (accounts.length) return accounts;
    } catch (e) {
      s.close();
      // try the other host before giving up
    }
  }
  return [];
}

// Map one closed cTrader deal into the shared Firestore "trades" schema.
function mapDeal(d, { uid, accountId, symbolMap, accountLabel }) {
  const close = d.closePositionDetail || {};
  const moneyDigits = close.moneyDigits != null ? close.moneyDigits : (d.moneyDigits != null ? d.moneyDigits : 2);
  const pnl = money((close.grossProfit || 0) + (close.swap || 0) + (close.commission || 0), moneyDigits);
  const swap = money(close.swap || 0, moneyDigits);
  const commission = money(close.commission || 0, moneyDigits);
  const tradeData = d.tradeData || {};
  const symbolName = (symbolMap && symbolMap[String(d.symbolId)]) || tradeData.symbolName || ('Symbol #' + d.symbolId);
  const openMs = Number(d.executionTimestamp || d.createTimestamp || Date.now());
  const lot = Number(d.filledVolume || d.volume || 0) / 100;
  const p = r2(pnl);
  return {
    uid,
    pair: symbolName,
    direction: side(d.tradeSide || tradeData.tradeSide),
    entry: close.entryPrice != null ? String(close.entryPrice) : '',
    closePrice: d.executionPrice != null ? String(d.executionPrice) : '',
    sl: '', tp: '',
    lot: String(r2(lot)),
    pnl: p,
    result: p > 0 ? 'WIN' : p < 0 ? 'LOSS' : 'BREAKEVEN',
    tradeDate: openMs,
    closeTime: new Date(openMs).toISOString(),
    swap: r2(swap),
    commission: r2(commission),
    session: getSessionFromTime(openMs),
    ticket: String(d.dealId != null ? d.dealId : (d.orderId || d.positionId || openMs)),
    source: 'ctrader_open_api',
    rr: '', notes: '', rules: '', psychology: '', model: '',
    accountId: String(accountId || ''),
    brokerName: 'cTrader',
    brokerAccount: accountLabel || String(accountId || ''),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// Pull closed deals for a single account within [from, to], paging by maxRows.
async function fetchAccountDeals(session, account, { uid, from, to }) {
  const ctid = Number(account.ctidTraderAccountId);
  session.send(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: ctid, accessToken: account._accessToken });
  await session.wait(PT.ACCOUNT_AUTH_RES);

  // symbolId -> name map
  const symbolMap = {};
  try {
    const sym = await session.request(PT.SYMBOLS_LIST_REQ, PT.SYMBOLS_LIST_RES, { ctidTraderAccountId: ctid, includeArchivedSymbols: true });
    (sym.symbol || sym.lightSymbol || []).forEach((s) => {
      symbolMap[String(s.symbolId)] = s.symbolName || s.name || s.displayName || String(s.symbolId);
    });
  } catch (e) { /* names fall back to "Symbol #id" */ }

  const accountLabel = (account.brokerTitleShort ? account.brokerTitleShort + ' ' : '') + (account.traderLogin || ctid);
  const MAX_ROWS = 500;
  const MAX_PAGES = 40;
  const out = [];
  let cursor = from;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await session.request(PT.DEAL_LIST_REQ, PT.DEAL_LIST_RES, {
      ctidTraderAccountId: ctid, fromTimestamp: cursor, toTimestamp: to, maxRows: MAX_ROWS,
    });
    const deals = (res.deal || []).filter((d) => d.closePositionDetail);
    for (const d of deals) out.push(mapDeal(d, { uid, accountId: ctid, symbolMap, accountLabel }));
    const all = res.deal || [];
    if (all.length < MAX_ROWS) break; // last page
    const maxTs = all.reduce((m, d) => Math.max(m, Number(d.executionTimestamp || d.createTimestamp || 0)), cursor);
    if (maxTs <= cursor) break; // no progress guard
    cursor = maxTs + 1;
  }
  return { trades: out, accountLabel, ctid, isLive: !!account.isLive };
}

// Top-level: discover accounts, then pull deals per account grouped by env host.
// Returns { accounts:[{accountId,label,live}], trades:[...] }.
async function fetchClosedTrades({ uid, clientId, clientSecret, accessToken, from, to }) {
  const accounts = await discoverAccounts({ clientId, clientSecret, accessToken });
  if (!accounts.length) return { accounts: [], trades: [] };
  accounts.forEach((a) => { a._accessToken = accessToken; });

  const byEnv = { live: [], demo: [] };
  for (const a of accounts) (a.isLive ? byEnv.live : byEnv.demo).push(a);

  const allTrades = [];
  const accountMeta = [];
  for (const env of ['live', 'demo']) {
    if (!byEnv[env].length) continue;
    const session = new CtSession(env);
    try {
      await session.open();
      await session.appAuth(clientId, clientSecret);
      for (const acc of byEnv[env]) {
        try {
          const r = await fetchAccountDeals(session, acc, { uid, from, to });
          allTrades.push(...r.trades);
          accountMeta.push({ accountId: String(r.ctid), label: r.accountLabel, live: r.isLive });
        } catch (e) {
          console.error('ctrader account sync failed', acc.ctidTraderAccountId, '-', e.message);
        }
      }
    } catch (e) {
      console.error('ctrader ' + env + ' session failed:', e.message);
    } finally {
      session.close();
    }
  }
  allTrades.sort((a, b) => a.tradeDate - b.tradeDate);
  return { accounts: accountMeta, trades: allTrades };
}

module.exports = { fetchClosedTrades, discoverAccounts, mapDeal, PT };
