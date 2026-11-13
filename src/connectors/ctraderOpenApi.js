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
  ORDER_LIST_REQ: 2175, ORDER_LIST_RES: 2176,
  RECONCILE_REQ: 2124, RECONCILE_RES: 2125,
  UNREALIZED_PNL_REQ: 2187, UNREALIZED_PNL_RES: 2188,
  ORDER_LIST_BY_POSITION_ID_REQ: 2183, ORDER_LIST_BY_POSITION_ID_RES: 2184,
  TRENDBARS_REQ: 2137, TRENDBARS_RES: 2138,
  ERROR_RES: 2142, GET_ACCOUNTS_REQ: 2149, GET_ACCOUNTS_RES: 2150,
  CASH_FLOW_REQ: 2143, CASH_FLOW_RES: 2144,
  TRADER_REQ: 2121, TRADER_RES: 2122,
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
function throttledDealList(session, payload, reqType, resType) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await session.request(reqType || PT.DEAL_LIST_REQ, resType || PT.DEAL_LIST_RES, payload, 25000); }
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

// ── The SL / TP the trader actually placed ─────────────────────────────────
// Deal records carry no SL/TP. The ORDER history does:
//   • the order that opened the position carries the stopLoss / takeProfit set
//     with it (absolute, or relative to the fill in 1/100000 of a price unit);
//   • if the position was closed by its protection, the closing order is a
//     STOP_LOSS_TAKE_PROFIT order carrying the levels in force at that moment —
//     so an SL moved to breakeven or trailed is recorded where it really was.
// Closing-order levels win over opening-order levels; nothing is invented.
const OT_SLTP = 4;
function num(v) { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; }
function levelsFromOrders(orders, deal, direction, entry) {
  if (!Array.isArray(orders)) return null;          // never looked up → caller falls back
  const list = orders.filter(Boolean);
  if (!list.length) return { sl: null, tp: null, closedBy: '', trailing: false, seen: true };   // looked up: none placed
  const long = direction === 'LONG';
  const closing = list.find((o) => deal.orderId != null && String(o.orderId) === String(deal.orderId))
    || list.filter((o) => o.closingOrder).sort((a, b) => Number(b.utcLastUpdateTimestamp || 0) - Number(a.utcLastUpdateTimestamp || 0))[0] || null;
  const opening = list.filter((o) => !o.closingOrder && Number(o.orderType) !== OT_SLTP)
    .sort((a, b) => Number(a.utcLastUpdateTimestamp || a.tradeData && a.tradeData.openTimestamp || 0) - Number(b.utcLastUpdateTimestamp || b.tradeData && b.tradeData.openTimestamp || 0))[0] || null;
  // Every SL/TP order the position ever had (they are amended in place, so the
  // newest by update time is the level in force last).
  const sltp = list.filter((o) => Number(o.orderType) === OT_SLTP)
    .sort((a, b) => Number(b.utcLastUpdateTimestamp || 0) - Number(a.utcLastUpdateTimestamp || 0));
  const fill = num(opening && opening.executionPrice) || num(entry);
  const rel = (o, k, sign) => { const r = num(o && o[k]); return r && fill ? fill + sign * r / 100000 : null; };
  let sl = null, tp = null, closedBy = '';
  if (closing && Number(closing.orderType) === OT_SLTP) {
    // A protection order fills at its stop (SL) or its limit (TP).
    sl = num(closing.stopLoss) || num(closing.stopPrice);
    tp = num(closing.takeProfit) || num(closing.limitPrice);
    closedBy = closing.isStopOut ? 'stop_out' : '';
  }
  for (const o of sltp) { if (sl == null) sl = num(o.stopLoss) || num(o.stopPrice); if (tp == null) tp = num(o.takeProfit) || num(o.limitPrice); }
  if (opening) {
    if (sl == null) sl = num(opening.stopLoss) || rel(opening, 'relativeStopLoss', long ? -1 : 1);
    if (tp == null) tp = num(opening.takeProfit) || rel(opening, 'relativeTakeProfit', long ? 1 : -1);
  }
  // A take-profit can only sit on the profit side of the entry.
  if (tp != null && fill && (long ? tp <= fill : tp >= fill)) tp = null;
  return { sl, tp, closedBy, trailing: !!((opening && opening.trailingStopLoss) || (closing && closing.trailingStopLoss)), seen: true };
}
function fmtPrice(n, ref) {
  if (n == null) return '';
  const d = String(ref || '').includes('.') ? String(ref).split('.')[1].length : 5;
  return String(Number(n.toFixed(Math.max(2, Math.min(6, d + 1)))));
}

// When the position behind a closing deal was opened. Sources, best first:
//   1. the opening deal (a deal of the same position with no closePositionDetail);
//   2. the order that opened it (a filled market order's open time / its fill update);
//   3. the closing deal's own tradeData.openTimestamp, if the API sent one.
// Anything at or after the close is rejected, so the open time is never the close time.
function positionOpenMs(d, openTsByPos, ordersByPos, closeMs) {
  const pid = d.positionId != null ? String(d.positionId) : '';
  const ok = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < closeMs ? n : 0; };
  let t = ok(pid && openTsByPos && openTsByPos[pid]);
  if (!t && pid && ordersByPos && Array.isArray(ordersByPos[pid])) {
    const opens = ordersByPos[pid].filter((o) => o && !o.closingOrder && Number(o.orderType) !== OT_SLTP)
      .map((o) => {
        const td = o.tradeData || {};
        // MARKET (1) fills when placed; a pending order fills at its last update.
        return Number(o.orderType) === 1 ? (ok(td.openTimestamp) || ok(o.utcLastUpdateTimestamp)) : (ok(o.utcLastUpdateTimestamp) || ok(td.openTimestamp));
      })
      .filter(Boolean);
    if (opens.length) t = Math.min(...opens);
  }
  if (!t) t = ok(d.tradeData && d.tradeData.openTimestamp);
  return t || 0;
}

// Map one closed cTrader deal into the shared Firestore "trades" schema.
function mapDeal(d, { uid, accountId, symbolMap, lotSizeMap, accountLabel, openTsByPos, ordersByPos, isLive }) {
  const close = d.closePositionDetail || {};
  const moneyDigits = close.moneyDigits != null ? close.moneyDigits : (d.moneyDigits != null ? d.moneyDigits : 2);
  const pnl = money((close.grossProfit || 0) + (close.swap || 0) + (close.commission || 0), moneyDigits);
  const swap = money(close.swap || 0, moneyDigits);
  const commission = money(close.commission || 0, moneyDigits);
  const tradeData = d.tradeData || {};
  const symbolName = (symbolMap && symbolMap[String(d.symbolId)]) || tradeData.symbolName || ('Symbol #' + d.symbolId);
  // The deal we import is the CLOSING deal, so its executionTimestamp is the exit
  // time (kept in tradeDate, which the app reads as the close time for cTrader).
  const openMs = Number(d.executionTimestamp || d.createTimestamp || Date.now());
  const closeMs = openMs;
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
  const exitPrice = d.executionPrice != null ? String(d.executionPrice) : '';
  const entryStr = close.entryPrice != null ? String(close.entryPrice) : '';
  // Real SL / TP from the order history (see levelsFromOrders). If the order
  // history could not be read at all (ordersByPos === null) we fall back to the
  // old behaviour — exit price as TP on a win / SL on a loss — so a temporary
  // API failure never wipes levels; with order data, blanks mean "none placed".
  const lv = ordersByPos ? levelsFromOrders(ordersByPos[String(d.positionId)], d, positionDir, entryStr) : null;
  const entryMs = positionOpenMs(d, openTsByPos, ordersByPos, closeMs);
  const slOut = lv ? fmtPrice(lv.sl, entryStr) : (result === 'LOSS' ? exitPrice : '');
  const tpOut = lv ? fmtPrice(lv.tp, entryStr) : (result === 'WIN' ? exitPrice : '');
  return {
    uid,
    pair: symbolName,
    direction: positionDir,
    entry: entryStr,
    closePrice: exitPrice,
    sl: slOut,
    tp: tpOut,
    // Where SL/TP came from: 'broker_orders' = read from cTrader's order history.
    slTpSource: lv ? 'broker_orders' : 'exit_price',
    ...(lv && lv.trailing ? { trailingStop: true } : {}),
    lot: String(r2(lot)),
    pnl: p,
    result,
    tradeDate: openMs,
    // Position open time (from the deal's tradeData) — used by Trade Replay to place
    // the entry marker; the closing deal's executionTimestamp is the exit time.
    // Real position open time: the opening deal, else the order that opened it.
    // Blank (never the close time) when neither could be found.
    openTime: entryMs ? new Date(entryMs).toISOString() : '',
    closeTime: new Date(closeMs).toISOString(),
    ...(entryMs ? { holdMinutes: Math.max(0, Math.round((closeMs - entryMs) / 60000)) } : {}),
    swap: r2(swap),
    commission: r2(commission),
    session: getSessionFromTime(entryMs || closeMs),
    ticket: String(d.dealId != null ? d.dealId : (d.orderId || d.positionId || openMs)),
    positionId: d.positionId != null ? String(d.positionId) : '',
    source: 'ctrader_open_api',
    rr: '', notes: '', rules: '', psychology: '', model: '',
    accountId: String(accountId || ''),
    // cTrader's own isLive flag for the account this deal came from (the deal was
    // also pulled over the live / demo host to match). The Verified Track Record
    // only counts live ones — see ctProof in ../connectors/ctrader.js.
    ctid: String(accountId || ''),
    brokerLive: !!isLive,
    brokerEnv: isLive ? 'live' : 'demo',
    brokerName: 'cTrader',
    brokerAccount: accountLabel || String(accountId || ''),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// Order history for the positions closed in [from, to], grouped by positionId.
// Walks the span in sub-1-week windows (same cap as deals), then asks per
// position for anything still missing (a position opened before the window).
// Returns null if the order history could not be read at all.
async function fetchOrdersByPosition(session, ctid, closingDeals, { from, to }) {
  const byPos = {};
  const checked = new Set();
  const want = new Set(closingDeals.map((d) => String(d.positionId || '')).filter(Boolean));
  const add = (o) => { const pid = String(o && o.positionId || ''); if (!pid || !want.has(pid)) return; (byPos[pid] = byPos[pid] || []).push(o); };
  const WINDOW = 7 * 24 * 60 * 60 * 1000 - 3600000;
  let anyOk = false;
  try {
    // A position closed in the window may have been opened up to ~2 weeks before it.
    const start = Math.max(0, from - 14 * 86400000);
    for (let winStart = start; winStart < to; ) {
      const winEnd = Math.min(winStart + WINDOW, to);
      let cursor = winStart;
      for (let page = 0; page < 20; page++) {
        const res = await throttledDealList(session, { ctidTraderAccountId: ctid, fromTimestamp: cursor, toTimestamp: winEnd },
          PT.ORDER_LIST_REQ, PT.ORDER_LIST_RES);
        anyOk = true;
        const list = res.order || [];
        list.forEach(add);
        if (!res.hasMore || !list.length) break;
        const maxTs = list.reduce((m, o) => Math.max(m, Number(o.utcLastUpdateTimestamp || 0)), cursor);
        if (maxTs <= cursor) break;
        cursor = maxTs + 1;
      }
      winStart = winEnd;
    }
  } catch (e) {
    console.warn('[ctrader] order history (range) failed for', ctid, '-', e.message);
  }
  // Fill gaps position by position (bounded so one sync can't stall).
  const missing = [...want].filter((pid) => !(byPos[pid] || []).some((o) => !o.closingOrder));
  for (const pid of missing.slice(0, 150)) {
    try {
      const res = await throttledDealList(session, { ctidTraderAccountId: ctid, positionId: Number(pid) },
        PT.ORDER_LIST_BY_POSITION_ID_REQ, PT.ORDER_LIST_BY_POSITION_ID_RES);
      anyOk = true;
      const seenIds = new Set((byPos[pid] || []).map((o) => String(o.orderId)));
      (res.order || []).forEach((o) => { if (!seenIds.has(String(o.orderId))) { o.positionId = o.positionId || Number(pid); add(o); } });
      checked.add(pid);
    } catch (e) { /* that position keeps whatever the range pass found */ }
  }
  if (!anyOk) return null;
  // Positions we looked up but which truly have no orders get an empty list,
  // which mapDeal reads as "no SL/TP placed" rather than "unknown".
  want.forEach((pid) => { if (!byPos[pid] && checked.has(pid)) byPos[pid] = []; });
  return byPos;
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
  // Who the account belongs to (the broker / prop firm's own whitelabel name) —
  // the track record uses it to tell a prop firm account from a plain demo.
  let trader = {};
  try { trader = ((await session.request(PT.TRADER_REQ, PT.TRADER_RES, { ctidTraderAccountId: ctid }, 12000)) || {}).trader || {}; }
  catch (e) { console.warn('[ctrader] trader details failed for', ctid, '-', e.message); }
  logAccountFields(account, trader);
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
      for (const d of all) raw.push(d);
      if (all.length < MAX_ROWS) break;
      const maxTs = all.reduce((m, d) => Math.max(m, Number(d.executionTimestamp || d.createTimestamp || 0)), cursor);
      if (maxTs <= cursor) break;
      cursor = maxTs + 1;
    }
    winStart = winEnd;
  }
  // True position open time = the earliest deal execution per positionId (the opening
  // deal). We now keep ALL deals (not just closing ones) so this can be derived even
  // when the closing deal's tradeData.openTimestamp is absent.
  // Only OPENING deals count — a closing deal (closePositionDetail) is the exit, and
  // counting it made openTime equal the close time whenever the opening deal fell
  // outside the window.
  const openTsByPos = {};
  raw.forEach((d) => { if (d.closePositionDetail) return; const pid = String(d.positionId || ''); if (!pid) return; const ts = Number(d.executionTimestamp || d.createTimestamp || 0); if (ts && (openTsByPos[pid] == null || ts < openTsByPos[pid])) openTsByPos[pid] = ts; });
  const closingDeals = raw.filter((d) => d.closePositionDetail);
  // Resolve each traded symbol's lotSize (needed to convert volume → real lots).
  const lotSizeMap = await ensureLotSizes(session, ctid, closingDeals.map((d) => d.symbolId));
  const ordersByPos = closingDeals.length ? await fetchOrdersByPosition(session, ctid, closingDeals, { from, to }) : {};
  const out = closingDeals.map((d) => mapDeal(d, { uid, accountId: ctid, symbolMap, lotSizeMap, accountLabel, openTsByPos, ordersByPos, isLive: !!account.isLive }));
  console.log('[ctrader] account', ctid, '(' + accountLabel + '):', seen, 'deals seen,', out.length, 'closed trades mapped');
  return { trades: out, accountLabel, ctid, isLive: !!account.isLive,
    brokerName: String(trader.brokerName || ''), brokerTitle: String(account.brokerTitleShort || ''),
    registeredAt: Number(trader.registrationTimestamp || 0) || null };
}

// cTrader marks its free prop trial / competition accounts with a "FREE" flag in
// its own apps, but the Open API does not document one. Log what the API does
// send for every demo-environment account (once per account per process, no
// balances or tokens) so a real trial account shows how to tell it apart.
const _fieldsLogged = new Set();
function logAccountFields(account, trader) {
  const id = String(account.ctidTraderAccountId);
  if (account.isLive || _fieldsLogged.has(id)) return;
  _fieldsLogged.add(id);
  const skip = /balance|bonus|token|password/i, pick = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !skip.test(k)));
  try { console.log('[ctrader] demo-env account fields', id, JSON.stringify({ account: pick(account), trader: pick(trader) })); } catch (e) {}
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
          accountMeta.push({ accountId: String(r.ctid), label: r.accountLabel, live: r.isLive, brokerName: r.brokerName, brokerTitle: r.brokerTitle, registeredAt: r.registeredAt });
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

// ── Broker-native candles (trendbars) for Trade Replay / Backtesting ──────────
// cTrader trendbars encode prices as deltas from `low`, all scaled ×10^5, and the
// bar's open time as utcTimestampInMinutes. We divide by 10^5 so candles line up
// with the deal (entry/exit) prices, which are already in real units.
const TB_PERIOD = { '1':1, '2':2, '3':3, '4':4, '5':5, '10':6, '15':7, '30':8, '60':9, '240':10, '720':11, 'D':12, 'W':13, 'M':14 };
async function resolveSymbolId(session, ctid, symbolName) {
  const res = await session.request(PT.SYMBOLS_LIST_REQ, PT.SYMBOLS_LIST_RES, { ctidTraderAccountId: ctid, includeArchivedSymbols: true });
  const want = String(symbolName || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const list = res.symbol || res.lightSymbol || [];
  let exact = null, partial = null;
  for (const s of list) {
    const nm = String(s.symbolName || s.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (nm === want) { exact = s; break; }
    if (!partial && nm && want && (nm.indexOf(want) >= 0 || want.indexOf(nm) >= 0)) partial = s;
  }
  const hit = exact || partial;
  return hit ? Number(hit.symbolId) : null;
}
async function fetchTrendbars({ clientId, clientSecret, accessToken, ctid, env, symbolName, tf, from, to }) {
  const period = TB_PERIOD[String(tf)] || TB_PERIOD['15'];
  const session = new CtSession(env);
  try {
    await session.open();
    await session.appAuth(clientId, clientSecret);
    session.send(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: Number(ctid), accessToken });
    await session.wait(PT.ACCOUNT_AUTH_RES);
    const symbolId = await resolveSymbolId(session, Number(ctid), symbolName);
    if (!symbolId) throw new Error('Symbol not found on cTrader account: ' + symbolName);
    const res = await session.request(PT.TRENDBARS_REQ, PT.TRENDBARS_RES, {
      ctidTraderAccountId: Number(ctid), symbolId, period,
      fromTimestamp: Number(from), toTimestamp: Number(to),
    }, 25000);
    const bars = res.trendbar || [];
    return bars.map((b) => {
      const low = Number(b.low || 0);
      const t = Number(b.utcTimestampInMinutes || 0) * 60;
      return {
        time: t,
        open: (low + Number(b.deltaOpen || 0)) / 1e5,
        high: (low + Number(b.deltaHigh || 0)) / 1e5,
        low: low / 1e5,
        close: (low + Number(b.deltaClose || 0)) / 1e5,
        volume: Number(b.volume || 0),
      };
    }).filter((c) => c.time > 0).sort((a, b) => a.time - b.time);
  } finally { session.close(); }
}


// ── Live open positions (dashboard → Recent activity → Open positions) ─────
// Reconcile gives every open position (entry, SL/TP, volume, side, open time);
// ProtoOAGetPositionUnrealizedPnLReq gives its floating P&L. Read-only.
async function fetchOpenPositions({ clientId, clientSecret, accessToken }) {
  const accounts = await discoverAccounts({ clientId, clientSecret, accessToken });
  const out = [];
  const failed = [];
  const byEnv = { live: [], demo: [] };
  accounts.forEach((a) => (a.isLive ? byEnv.live : byEnv.demo).push(a));
  for (const env of ['live', 'demo']) {
    if (!byEnv[env].length) continue;
    const session = new CtSession(env);
    try {
      await session.open();
      await session.appAuth(clientId, clientSecret);
      for (const acc of byEnv[env]) {
        const ctid = Number(acc.ctidTraderAccountId);
        try {
          session.send(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: ctid, accessToken });
          await session.wait(PT.ACCOUNT_AUTH_RES);
          const rec = await session.request(PT.RECONCILE_REQ, PT.RECONCILE_RES, { ctidTraderAccountId: ctid }, 15000);
          const pos = rec.position || [];
          if (!pos.length) continue;
          let symbolMap = (SYMBOL_CACHE[ctid] && SYMBOL_CACHE[ctid].map) || null;
          if (!symbolMap) {
            symbolMap = {};
            try {
              const sym = await session.request(PT.SYMBOLS_LIST_REQ, PT.SYMBOLS_LIST_RES, { ctidTraderAccountId: ctid, includeArchivedSymbols: false });
              (sym.symbol || sym.lightSymbol || []).forEach((x) => { symbolMap[String(x.symbolId)] = x.symbolName || x.name || String(x.symbolId); });
              SYMBOL_CACHE[ctid] = { map: symbolMap, ts: Date.now() };
            } catch (e) {}
          }
          const lotMap = await ensureLotSizes(session, ctid, pos.map((p) => (p.tradeData || {}).symbolId));
          const upnl = {};
          try {
            const u = await session.request(PT.UNREALIZED_PNL_REQ, PT.UNREALIZED_PNL_RES, { ctidTraderAccountId: ctid }, 12000);
            const md = u.moneyDigits != null ? u.moneyDigits : 2;
            (u.positionUnrealizedPnL || []).forEach((x) => { upnl[String(x.positionId)] = money(x.netUnrealizedPnL, md); });
          } catch (e) { /* older servers: P&L stays unknown */ }
          const label = (acc.brokerTitleShort ? acc.brokerTitleShort + ' ' : '') + (acc.traderLogin || ctid);
          pos.forEach((p) => {
            const td = p.tradeData || {}, md = p.moneyDigits != null ? p.moneyDigits : 2;
            const ls = Number(lotMap[String(td.symbolId)]);
            const vol = Number(td.volume || 0);
            out.push({
              id: String(p.positionId), ctid: String(ctid), broker: 'cTrader', account: label, live: !!acc.isLive,
              pair: symbolMap[String(td.symbolId)] || ('Symbol #' + td.symbolId),
              dir: side(td.tradeSide), lots: r2(ls > 0 ? vol / ls : vol / 100),
              entry: Number(p.price || 0), sl: Number(p.stopLoss || 0), tp: Number(p.takeProfit || 0),
              pnl: upnl[String(p.positionId)] != null ? r2(upnl[String(p.positionId)]) : null,
              swap: r2(money(p.swap || 0, md)),
              openTime: td.openTimestamp ? new Date(Number(td.openTimestamp)).toISOString() : '',
            });
          });
        } catch (e) { failed.push(String(ctid)); console.warn('[ctrader] positions failed for', ctid, '-', e.message); }
      }
    } catch (e) { byEnv[env].forEach((a) => failed.push(String(a.ctidTraderAccountId))); console.warn('[ctrader] positions session', env, '-', e.message); }
    finally { session.close(); }
  }
  // Accounts that could not be read this time. An empty list then means "unknown",
  // not "nothing open" — the caller keeps their last known positions.
  out.failedAccounts = failed;
  return out;
}

// ── Deposits / withdrawals (balance history) ───────────────────────────────
// ProtoOACashFlowHistoryListReq, like the deal list, takes at most one week per
// request, so [from,to] is walked in weekly windows through the same app-wide
// throttle. Returns raw operations; src/cashflows.js classifies them.
async function fetchCashFlows({ clientId, clientSecret, accessToken, from, to }) {
  const accounts = await discoverAccounts({ clientId, clientSecret, accessToken });
  if (!accounts.length) return { ok: false, items: [], accounts: [] };
  const byEnv = { live: [], demo: [] };
  for (const a of accounts) (a.isLive ? byEnv.live : byEnv.demo).push(a);
  const items = [], meta = [];
  let ok = true;
  const WINDOW = 7 * 24 * 60 * 60 * 1000 - 3600000;
  for (const env of ['live', 'demo']) {
    if (!byEnv[env].length) continue;
    const session = new CtSession(env);
    try {
      await session.open();
      await session.appAuth(clientId, clientSecret);
      for (const acc of byEnv[env]) {
        const ctid = Number(acc.ctidTraderAccountId);
        const label = (acc.brokerTitleShort ? acc.brokerTitleShort + ' ' : '') + (acc.traderLogin || ctid);
        try {
          session.send(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: ctid, accessToken });
          await session.wait(PT.ACCOUNT_AUTH_RES);
          let balanceNow = null, digits = 2;
          try {
            const tr = await session.request(PT.TRADER_REQ, PT.TRADER_RES, { ctidTraderAccountId: ctid }, 12000);
            const t = (tr && tr.trader) || {};
            digits = t.moneyDigits != null ? Number(t.moneyDigits) : 2;
            if (t.balance != null) balanceNow = money(t.balance, digits);
          } catch (e) { /* balance is optional */ }
          for (let ws = from; ws < to; ) {
            const we = Math.min(ws + WINDOW, to);
            const res = await throttledDealList(session, { ctidTraderAccountId: ctid, fromTimestamp: ws, toTimestamp: we }, PT.CASH_FLOW_REQ, PT.CASH_FLOW_RES);
            (res.depositWithdraw || []).forEach((d) => {
              const md = d.moneyDigits != null ? Number(d.moneyDigits) : digits;
              items.push({
                ctid: String(ctid), label, live: !!acc.isLive,
                id: String(d.balanceHistoryId), op: Number(d.operationType),
                delta: money(d.delta, md), balance: d.balance != null ? money(d.balance, md) : null,
                ts: Number(d.changeBalanceTimestamp || 0), note: d.externalNote || '',
              });
            });
            ws = we;
          }
          meta.push({ ctid: String(ctid), label, live: !!acc.isLive, balance: balanceNow });
        } catch (e) { ok = false; console.warn('[ctrader] cash flow failed for', ctid, '-', e.message); }
      }
    } catch (e) { ok = false; console.warn('[ctrader] cash flow session', env, '-', e.message); }
    finally { session.close(); }
  }
  return { ok, items, accounts: meta };
}

module.exports = { fetchClosedTrades, discoverAccounts, mapDeal, fetchTrendbars, levelsFromOrders, fetchOpenPositions, fetchCashFlows, PT };
