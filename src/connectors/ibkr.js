// Interactive Brokers connector (Flex Web Service v3, per-user read-only token).
//
// The trader enables the Flex Web Service in IBKR Client Portal, generates a
// token, and creates an Activity Flex Query with the Trades section. They paste
// the token + Query ID into the Brokers page. The Flex Web Service is report
// download only: it cannot place, change or cancel orders, or move money.
//
// We check the token and query with SendRequest before answering, store both
// encrypted (AES-256-GCM via hostedSync.encrypt, key in MT5_CRED_KEY) in the
// server-only `ibkrLinks` collection, import the report, then re-fetch it every
// few hours. Activity statements only update once a day after the close, and IB
// says the service is not for active polling, so polling faster gains nothing.
//
// Flex trade rows are executions. We group executions by order, pair opening
// and closing fills first-in-first-out per contract, and write one ETW trade per
// closing order. P&L is IB's own FIFO realized P&L (already net of commissions),
// converted to the account's base currency.
const store = require('../store');
const access = require('../access');
const { encrypt, decrypt } = require('../hostedSync');
const { getSessionFromTime } = require('../tradeMapper');

const STATUS_KEY = 'ibkr';
const SOURCE = 'ibkr';
const COL = 'ibkrLinks';
const POLL_MS = 4 * 3600 * 1000;
const HOSTS = [
  'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService',
  'https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService',
];
const UA = 'ETW-Journal/1.0';
const active = new Map(); // duid -> { timer, stopped }

const setStatus = (uid, patch) => store.setStatus(uid, STATUS_KEY, patch);
const ref = (uid) => store.db.collection(COL).doc(uid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tiny XML helpers (Flex XML is flat: data lives in attributes) ─────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]);
function attrs(s) {
  const o = {}; const re = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g; let m;
  while ((m = re.exec(s))) o[m[1]] = unesc(m[2]);
  return o;
}
function elements(xml, name) {
  const out = []; const re = new RegExp('<' + name + '\\b([^>]*?)/?>', 'g'); let m;
  while ((m = re.exec(xml))) out.push(attrs(m[1]));
  return out;
}
const tag = (xml, name) => { const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml); return m ? unesc(m[1].trim()) : ''; };

function flexError(code, msg) { const e = new Error(msg || ('IBKR error ' + code)); e.flexCode = Number(code) || 0; return e; }
const RETRY = new Set([1001, 1004, 1005, 1006, 1007, 1008, 1009, 1018, 1019, 1021]);

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/xml,text/xml,*/*' }, signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return text;
}

// Step 1: ask IB to build the report. Returns { ref, url }. Throws flexError on Fail.
async function sendRequest(creds) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const xml = await get(host + '/SendRequest?t=' + encodeURIComponent(creds.token) + '&q=' + encodeURIComponent(creds.queryId) + '&v=3');
      if (/<Status>\s*Success\s*<\/Status>/i.test(xml)) return { ref: tag(xml, 'ReferenceCode'), url: tag(xml, 'Url') || (host + '/GetStatement') };
      throw flexError(tag(xml, 'ErrorCode'), tag(xml, 'ErrorMessage'));
    } catch (e) {
      if (e.flexCode) throw e;          // IB answered: no point asking the other host
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not reach Interactive Brokers.');
}

// Step 2: download it, waiting while IB is still generating (max ~3 minutes).
async function fetchStatement(creds) {
  let sr;
  for (let i = 0; i < 4; i++) {
    try { sr = await sendRequest(creds); break; }
    catch (e) { if (!RETRY.has(e.flexCode) || i === 3) throw e; await sleep(15000); }
  }
  for (let i = 0; i < 18; i++) {
    await sleep(i ? 10000 : 4000);
    const xml = await get(sr.url + '?t=' + encodeURIComponent(creds.token) + '&q=' + encodeURIComponent(sr.ref) + '&v=3');
    if (/<FlexQueryResponse\b/.test(xml)) return xml;
    const code = Number(tag(xml, 'ErrorCode'));
    if (!RETRY.has(code)) throw flexError(code, tag(xml, 'ErrorMessage'));
  }
  throw flexError(1019, 'Interactive Brokers is still generating the report. It will be tried again later.');
}

// ── Time: Flex dates come as yyyyMMdd;HHmmss (or with dashes/colons), in US Eastern time ──
function nyOffsetMin(utcMs) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; f.formatToParts(new Date(utcMs)).forEach((x) => { p[x.type] = x.value; });
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs) / 60000;
}
function parseFlexTime(s, fallbackDate) {
  const str = String(s || '').trim() || String(fallbackDate || '').trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[;,\sT]+(\d{2}):?(\d{2}):?(\d{2})?)?/.exec(str);
  if (!m) return 0;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  let ms = naive - nyOffsetMin(naive) * 60000;
  ms = naive - nyOffsetMin(ms) * 60000;                    // second pass settles DST edges
  return ms;
}

// ── Normalise ────────────────────────────────────────────────────────────────
const r2 = (n) => Math.round(((+n || 0) + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };

// One row per order: Flex may list executions, orders, or both (levelOfDetail).
function orderRows(rows) {
  const ex = rows.filter((r) => String(r.levelOfDetail || '').toUpperCase() === 'EXECUTION');
  const use = ex.length ? ex : rows.filter((r) => !/CLOSED_LOT|SYMBOL_SUMMARY|ASSET_SUMMARY/i.test(String(r.levelOfDetail || '')));
  const groups = new Map();
  for (const r of use) {
    const qty = num(r.quantity); if (!qty) continue;
    const t = parseFlexTime(r.dateTime, r.tradeDate); if (!t) continue;
    const key = (r.accountId || '') + '|' + (r.ibOrderID || r.orderID || r.tradeID || r.transactionID || (r.conid + '@' + r.dateTime));
    let g = groups.get(key);
    if (!g) { g = { key, acct: r.accountId || '', conid: r.conid || r.symbol, symbol: r.symbol || '', desc: r.description || '', asset: r.assetCategory || '', currency: r.currency || '', fx: num(r.fxRateToBase) || 1, mult: num(r.multiplier) || 1, qty: 0, notional: 0, comm: 0, pnl: 0, t, tFirst: t, oc: '', orderId: r.ibOrderID || r.orderID || r.tradeID || r.transactionID || '' }; groups.set(key, g); }
    g.qty += qty; g.notional += qty * num(r.tradePrice);
    g.comm += num(r.ibCommission); g.pnl += num(r.fifoPnlRealized);
    g.t = Math.max(g.t, t); g.tFirst = Math.min(g.tFirst, t);
    g.oc += String(r.openCloseIndicator || '');
  }
  return [...groups.values()].sort((a, b) => a.tFirst - b.tFirst || a.t - b.t);
}

// FIFO pairing per contract: closing orders take the oldest open lots, which
// gives each closed trade its entry price and open time.
function toTrades(rows, { uid, accountId }) {
  const book = new Map(); // acct|conid -> [{ qty (signed), price, t }]
  const out = [];
  for (const g of orderRows(rows)) {
    const price = g.qty ? g.notional / g.qty : 0;
    const k = g.acct + '|' + g.conid;
    const lots = book.get(k) || []; book.set(k, lots);
    let left = g.qty, closed = 0, entryCost = 0, openT = 0;
    while (left && lots.length && Math.sign(lots[0].qty) !== Math.sign(left)) {
      const lot = lots[0], take = Math.min(Math.abs(left), Math.abs(lot.qty));
      closed += take; entryCost += take * lot.price; openT = openT ? Math.min(openT, lot.t) : lot.t;
      lot.qty += Math.sign(left) * take; left -= Math.sign(left) * take;
      if (Math.abs(lot.qty) < 1e-9) lots.shift();
    }
    // A pure close ('C') with nothing left to match was opened before the report
    // window: count it as closed instead of opening a phantom lot the other way.
    const ocC = /C/.test(g.oc), ocO = /O/.test(g.oc);
    let unmatched = 0;
    if (left && ocC && !ocO) { unmatched = Math.abs(left); left = 0; }
    if (left) lots.push({ qty: left, price, t: g.tFirst });
    if (!closed && !unmatched) continue;
    const size = closed + unmatched;
    // Entry: average of the matched open lots; when part of it opened before the
    // window, work it back from IB's realized P&L (net of commission) instead.
    let entry = closed && !unmatched ? entryCost / closed : 0;
    if (!entry && size && g.mult && g.pnl) entry = price + (g.qty < 0 ? -1 : 1) * (g.pnl - g.comm) / (size * g.mult);
    if (!entry && closed) entry = entryCost / closed;
    const fx = g.fx || 1;
    const p = r2(g.pnl * fx);
    const closeMs = g.t, openMs = openT || closeMs;
    const dec = price >= 100 ? 2 : price >= 1 ? 4 : 6;
    out.push({
      uid, pair: g.symbol || String(g.conid),
      direction: g.qty < 0 ? 'LONG' : 'SHORT',          // a sell closes a long
      entry: entry ? entry.toFixed(dec) : '', closePrice: price ? price.toFixed(dec) : '',
      sl: '', tp: '', lot: String(+size.toFixed(6)),
      pnl: p, result: p > 0 ? 'WIN' : p < 0 ? 'LOSS' : 'BREAKEVEN',
      tradeDate: closeMs, openTime: new Date(openMs).toISOString(), closeTime: new Date(closeMs).toISOString(),
      swap: 0, commission: r2(g.comm * fx),
      session: getSessionFromTime(openMs), ticket: 'ib-' + (g.orderId || g.key),
      assetClass: g.asset, instrument: g.desc, currency: g.currency, ibkrAccount: g.acct,
      source: SOURCE, brokerName: 'Interactive Brokers', rr: '', notes: '', rules: '', psychology: '', model: '',
      accountId: accountId || '', createdAt: Date.now(), updatedAt: Date.now(),
    });
  }
  return out;
}

function readStatement(xml) {
  if (!/<FlexQueryResponse\b/.test(xml)) throw flexError(1020, 'Unexpected reply from Interactive Brokers.');
  const head = /<FlexQueryResponse\b([^>]*)>/.exec(xml);
  const type = head ? attrs(head[1]).type : '';
  const rows = elements(xml, 'Trade');
  if (!rows.length && (type === 'TCF' || /<TradeConfirm\b/.test(xml))) {
    const e = new Error('This is a Trade Confirmation query. Create an Activity Flex Query instead (it includes realized P&L).'); e.code = 'wrong_query'; throw e;
  }
  if (!rows.length && !/<Trades\b/.test(xml)) {
    const e = new Error('Your Flex Query has no Trades section. Edit the query in IBKR, tick Trades, and save.'); e.code = 'no_trades_section'; throw e;
  }
  const missing = ['fifoPnlRealized', 'quantity', 'tradePrice', 'dateTime'].filter((f) => rows.length && rows[0][f] === undefined && !(f === 'dateTime' && rows[0].tradeDate !== undefined));
  if (missing.length) { const e = new Error('Your Flex Query is missing these Trades fields: ' + missing.join(', ') + '. Edit the query in IBKR and tick them (or choose Select All).'); e.code = 'missing_fields'; throw e; }
  return rows;
}

async function importOnce(ctx) {
  const xml = await fetchStatement(ctx.creds);
  const rows = readStatement(xml);
  const fresh = toTrades(rows, ctx).filter((t) => !ctx.written.has(t.ticket));
  if (fresh.length) { await store.writeTrades(fresh); fresh.forEach((t) => ctx.written.add(t.ticket)); }
  return fresh.length;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (e && ['wrong_query', 'no_trades_section', 'missing_fields'].includes(e.code)) return m;
  const c = e && e.flexCode;
  if (c === 1012) return 'Your Flex Web Service token has expired. Generate a new one in IBKR and reconnect.';
  if (c === 1015) return 'Interactive Brokers rejected this token. Check you copied the whole Current Token.';
  if (c === 1014) return 'Interactive Brokers says this Query ID is invalid. Copy the number shown next to your Activity Flex Query.';
  if (c === 1013) return 'Your Flex Web Service token is restricted to certain IP addresses. Remove the IP restriction in IBKR and try again.';
  if (c === 1011 || c === 1016) return 'Interactive Brokers says the account is inactive or invalid for this token.';
  if (c === 1010) return 'That is a legacy Flex Query. Create a new Activity Flex Query and use its ID.';
  if (c === 1018) return 'Too many requests to Interactive Brokers with this token. Wait a minute and try again.';
  if (c && RETRY.has(c)) return 'Interactive Brokers is busy preparing your report. It will be tried again automatically.';
  return 'Interactive Brokers sync failed: ' + m;
}
const isAuthError = (e) => [1010, 1011, 1012, 1013, 1014, 1015, 1016].includes(e && e.flexCode) || ['wrong_query', 'no_trades_section', 'missing_fields'].includes(e && e.code);

async function run(uid, link, creds) {
  await stopSync(uid);
  const state = { timer: null, stopped: false };
  active.set(uid, state);
  const ctx = { uid, accountId: link.journalAccountId || '', creds, written: await store.existingTickets(uid, SOURCE, link.journalAccountId || '') };
  const tick = async (first) => {
    if (state.stopped) return;
    try {
      if (first) await setStatus(uid, { status: 'connecting', error: null, note: 'Fetching your report from Interactive Brokers. This can take a minute or two.' });
      await importOnce(ctx);
      const t = Date.now();
      await ref(uid).set({ lastSyncAt: t }, { merge: true });
      await setStatus(uid, { status: 'connected', historyImported: ctx.written.size, lastSyncAt: t, error: null,
        note: 'Connected. IBKR updates these reports once a day after the market closes, so new trades show up the next day.' });
    } catch (e) {
      console.error('ibkr sync', uid, e.flexCode || '', e.message);
      if (isAuthError(e)) { await stopSync(uid); await setStatus(uid, { status: 'error', error: friendlyError(e) }).catch(() => {}); return; }
      if (first) await setStatus(uid, { status: 'connected', historyImported: ctx.written.size, error: null, note: friendlyError(e) }).catch(() => {});
    }
    if (!state.stopped) state.timer = setTimeout(() => tick(false), first && ctx.written.size === 0 ? 20 * 60 * 1000 : POLL_MS);
  };
  await tick(true);
}

// Called from the route: checks token + query with IB, stores encrypted, then imports in the background.
async function connect(uid, { token, queryId, journalAccountId }) {
  const creds = { token: String(token).trim(), queryId: String(queryId).trim() };
  try { await sendRequest(creds); }                           // throws for bad token / query
  catch (e) { if (!RETRY.has(e.flexCode)) throw e; }          // IB busy: the token may still be fine
  const link = { uid, journalAccountId: journalAccountId || '', queryId: creds.queryId,
    tokenHint: creds.token.slice(0, 3) + '…' + creds.token.slice(-3),
    cred: encrypt(JSON.stringify(creds), uid), createdAt: Date.now(), lastSyncAt: null };
  await ref(uid).set(link);
  await setStatus(uid, { status: 'connecting', queryId: creds.queryId, tokenHint: link.tokenHint, error: null, historyImported: 0 });
  // Leave a gap after the check: IB allows one request a second, ten a minute.
  setTimeout(() => run(uid, link, creds).catch(async (e) => {
    console.error('ibkr:', e.message);
    await setStatus(uid, { status: 'error', error: friendlyError(e) }).catch(() => {});
  }), 3000);
}

async function stopSync(uid) {
  const s = active.get(uid);
  if (s) { s.stopped = true; if (s.timer) clearTimeout(s.timer); }
  active.delete(uid);
}

async function disconnect(uid) {
  await stopSync(uid);
  await ref(uid).delete().catch(() => {});
}

// Boot: restart every stored link whose owner still has a subscription.
async function resumeAll() {
  let snap;
  try { snap = await store.db.collection(COL).get(); } catch (e) { console.warn('[ibkr] resume failed:', e.message); return; }
  let i = 0;
  for (const doc of snap.docs) {
    const uid = doc.id, link = doc.data();
    setTimeout(async () => {
      try {
        await access.assertAccess(uid);
        await run(uid, link, JSON.parse(decrypt(link.cred, uid)));
      } catch (e) {
        if (e.status === 402) { await setStatus(uid, { status: 'error', error: 'Your subscription has ended. Renew to resume Interactive Brokers sync.' }).catch(() => {}); return; }
        console.error('[ibkr] resume', uid, e.message);
        await setStatus(uid, { status: 'error', error: friendlyError(e) }).catch(() => {});
      }
    }, 5000 + (i++) * 4000);                                   // stagger: tokens share no limit, but IB's servers do
  }
  if (snap.size) console.log('[ibkr] resuming', snap.size, 'link(s)');
}

module.exports = { connect, disconnect, stopSync, resumeAll, friendlyError, _toTrades: toTrades, _readStatement: readStatement, _parseFlexTime: parseFlexTime, _fetchStatement: fetchStatement };
