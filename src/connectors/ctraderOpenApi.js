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
  SYMBOL_BY_ID_REQ: 2116, SYMBOL_BY_ID_RES: 2117,
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// App-wide throttle for ProtoOADealListReq. cTrader rate-limits historical
// requests ("BLOCKED_PAYLOAD_TYPE: You are being rate limited"), and with many
// users + the 90-day backfill firing ~13 requests each, bursts get blocked.
// Serialize ALL deal-list calls across users with a ~300ms gap, and retry with
// backoff on a rate-limit error so the backfill completes instead of failing.
let _dlGate = Promise.resolve();
function throttledDealList(session, payload) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await session.request(PT.DEAL_LIST_REQ, PT.DEAL_LIST_RES, payload, 25000); }
      catch (e) {
        const m = (e && e.message) || '';
        if (/rate limit|BLOCKED_PAYLOAD_TYPE|too many/i.test(m) && attempt < 6) { await sleep(2000 * (attempt + 1)); continue; }
        throw e;
      }
    }
  };
  const result = _dlGate.then(run, run); // run after the previous call settles (ok or error)
  _dlGate = result.catch(() => {}).then(() => sleep(300)); // ~3 requests/sec app-wide
  return result;
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
      ws.on('open', () => { clearTimeout(t); this._startHeartbeat(); resolve(); });
      ws.on('error', (e) => { clearTimeout(t); reject(new Error('cTrader WebSocket connection failed: ' + (e && e.message || e))); });
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', () => {
        this._stopHeartbeat();
        for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('cTrader socket closed.')); }
      });
    });
  }
  _startHeartbeat() {
    this._stopHeartbeat();
    // cTrader drops idle sockets (~10s) — keep it alive across the backfill.
    this.hb = setInterval(() => {
      try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ clientMsgId: 'hb', payloadType: PT.HEARTBEAT, payload: {} })); } catch (e) {}
    }, 10000);
  }
  _stopHeartbeat() { if (this.hb) { clearInterval(this.hb); this.hb = null; } }
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
  close() { this._stopHeartbeat(); try { if (this.ws) this.ws.close(); } catch (e) {} }
}

// Per-account symbol-name cache so we don't re-download the full symbol list on
// every 3-min poll (it's a large payload). { ctid: { map, ts } }.
const SYMBOL_CACHE = {};
const SYMBOL_TTL = 24 * 60 * 60 * 1000;

// Per-account symbolId -> lotSize cache. The light SYMBOLS_LIST payload has names
// but not lotSize, so we fetch full symbol details (ProtoOASymbolByIdReq) for the
// symbols that actually appear in the deals, and cache them 24h.
const LOTSIZE_CACHE = {};
async function ensureLotSizes(session, ctid, symbolIds) {
  const cached = LOTSIZE_CACHE[ctid];
  const map = (cached && (Date.now() - cached.ts) < SYMBOL_TTL) ? { ...cached.map } : {};
  const need = [...new Set(symbolIds.map(String))].filter((id) => id && id !== 'undefined' && map[id] == null);
  if (need.length) {
    try {
      const res = await session.request(
        PT.SYMBOL_BY_ID_REQ, PT.SYMBOL_BY_ID_RES,
        { ctidTraderAccountId: ctid, symbolId: need.map(Number) }, 20000);
      (res.symbol || []).forEach((s) => {
        if (s && s.lotSize != null) map[String(s.symbolId)] = Number(s.lotSize);
      });
      LOTSIZE_CACHE[ctid] = { map, ts: Date.now() };
    } catch (e) {
      console.warn('[ctrader] lotSize fetch failed for', ctid, '- lots may be off:', e.message);
    }
  }
  return map;
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
      console.log('[ctrader] ' + env + ' host: app auth OK,', accounts.length, 'account(s) on token');
      if (accounts.length) return accounts;
    } catch (e) {
      s.close();
      console.warn('[ctrader] ' + env + ' host discovery failed:', e.message);
      // try the other host before giving up
    }
  }
  return [];
}

// Map one closed cTrader deal into the shared Firestore "trades" schema.
function mapDeal(d, { uid, accountId, symbolMap, lotSizeMap, accountLabel }) {
  const close = d.closePositionDetail || {};
  const moneyDigits = close.moneyDigits != null ? close.moneyDigits : (d.moneyDigits != null ? d.moneyDigits : 2);
  const pnl = money((close.grossProfit || 0) + (close.swap || 0) + (close.commission || 0), moneyDigits);
  const swap = money(close.swap || 0, moneyDigits);
  const commission = money(close.commission || 0, moneyDigits);
  const tradeData = d.tradeData || {};
  const symbolName = (symbolMap && symbolMap[String(d.symbolId)]) || tradeData.symbolName || ('Symbol #' + d.symbolId);
  const openMs = Number(d.executionTimestamp || d.createTimestamp || Date.now());
  // Volume→lots: cTrader reports volume in the symbol's own units; the real lot
  // count is filledVolume / symbol.lotSize (lotSize varies per instrument, e.g.
  // FX=10,000,000 but others differ). Falls back to the legacy /100 only if the
  // symbol's lotSize couldn't be resolved.
  const rawVol = Number(d.filledVolume || d.volume || 0);
  const lotSize = lotSizeMap && Number(lotSizeMap[String(d.symbolId)]);
  const lot = lotSize > 0 ? rawVol / lotSize : rawVol / 100;
  const p = r2(pnl);
  // We import the CLOSING deal; its side is opposite the position's direction
  // (a long is closed by a SELL, a short by a BUY) — so invert it.
  const positionDir = side(d.tradeSide || tradeData.tradeSide) === 'LONG' ? 'SHORT' : 'LONG';
  const result = p > 0 ? 'WIN' : p < 0 ? 'LOSS' : 'BREAKEVEN';
  // The closing deal's execution price is the realized exit. Record it as the
  // take-profit on a win and the stop-loss on a loss; a breakeven keeps only the
  // entry (both blank). cTrader's deal history does not carry the originally-set
  // SL/TP order levels, so this reflects the actual price the position closed at.
  const exitPrice = d.executionPrice != null ? String(d.executionPrice) : '';
  return {
    uid,
    pair: symbolName,
    direction: positionDir,
    entry: close.entryPrice != null ? String(close.entryPrice) : '',
    closePrice: exitPrice,
    sl: result === 'LOSS' ? exitPrice : '',
    tp: result === 'WIN' ? exitPrice : '',
    lot: String(r2(lot)),
    pnl: p,
    result,
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

  // symbolId -> name map (cached 24h per account to avoid re-downloading the full
  // symbol list on every poll — the biggest per-sync cost).
  let symbolMap;
  const cached = SYMBOL_CACHE[ctid];
  if (cached && (Date.now() - cached.ts) < SYMBOL_TTL && Object.keys(cached.map).length) {
    symbolMap = cached.map;
  } else {
    symbolMap = {};
    try {
      const sym = await session.request(PT.SYMBOLS_LIST_REQ, PT.SYMBOLS_LIST_RES, { ctidTraderAccountId: ctid, includeArchivedSymbols: true });
      (sym.symbol || sym.lightSymbol || []).forEach((s) => {
        symbolMap[String(s.symbolId)] = s.symbolName || s.name || s.displayName || String(s.symbolId);
      });
      SYMBOL_CACHE[ctid] = { map: symbolMap, ts: Date.now() };
    } catch (e) { /* names fall back to "Symbol #id" */ }
  }

  const accountLabel = (account.brokerTitleShort ? account.brokerTitleShort + ' ' : '') + (account.traderLogin || ctid);
  const MAX_ROWS = 1000;
  // cTrader caps ProtoOADealListReq to a 1-week range per request — so walk the
  // full [from,to] span in sub-1-week windows, paging within each window.
  const WINDOW = 7 * 24 * 60 * 60 * 1000 - 3600000;
  const raw = [];
  let seen = 0;
  for (let winStart = from; winStart < to; ) {
    const winEnd = Math.min(winStart + WINDOW, to);
    let cursor = winStart;
    for (let page = 0; page < 20; page++) {
      const res = await throttledDealList(session, {
        ctidTraderAccountId: ctid, fromTimestamp: cursor, toTimestamp: winEnd, maxRows: MAX_ROWS,
      });
      const all = res.deal || [];
      seen += all.length;
      for (const d of all) if (d.closePositionDetail) raw.push(d);
      if (all.length < MAX_ROWS) break;
      const maxTs = all.reduce((m, d) => Math.max(m, Number(d.executionTimestamp || d.createTimestamp || 0)), cursor);
      if (maxTs <= cursor) break;
      cursor = maxTs + 1;
    }
    winStart = winEnd;
  }
  // Resolve each traded symbol's lotSize (needed to convert volume → real lots).
  const lotSizeMap = await ensureLotSizes(session, ctid, raw.map((d) => d.symbolId));
  const out = raw.map((d) => mapDeal(d, { uid, accountId: ctid, symbolMap, lotSizeMap, accountLabel }));
  console.log('[ctrader] account', ctid, '(' + accountLabel + '):', seen, 'deals seen,', out.length, 'closed trades mapped');
  return { trades: out, accountLabel, ctid, isLive: !!account.isLive };
}

// Top-level: discover accounts, then pull deals per account grouped by env host.
// Returns { accounts:[{accountId,label,live}], trades:[...] }.
async function fetchClosedTrades({ uid, clientId, clientSecret, accessToken, from, to }) {
  const t0 = Date.now();
  let ok = true; // false if any account/window failed — caller must NOT advance the sync cursor
  const accounts = await discoverAccounts({ clientId, clientSecret, accessToken });
  if (!accounts.length) { console.warn('[ctrader] no accounts found on token — nothing to sync (will retry)'); return { accounts: [], trades: [], ok: false }; }
  accounts.forEach((a) => { a._accessToken = accessToken; });
  console.log('[ctrader] syncing', accounts.length, 'account(s), window', new Date(from).toISOString(), '->', new Date(to).toISOString());

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
          ok = false;
          console.error('ctrader account sync failed', acc.ctidTraderAccountId, '-', e.message);
        }
      }
    } catch (e) {
      ok = false;
      console.error('ctrader ' + env + ' session failed:', e.message);
    } finally {
      session.close();
    }
  }
  allTrades.sort((a, b) => a.tradeDate - b.tradeDate);
  console.log('[ctrader] total closed trades fetched across accounts:', allTrades.length, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's', ok ? '(complete)' : '(INCOMPLETE — will retry)');
  return { accounts: accountMeta, trades: allTrades, ok };
}

module.exports = { fetchClosedTrades, discoverAccounts, mapDeal, PT };
