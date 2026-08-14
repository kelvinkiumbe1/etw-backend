// ── ETW AI Guard: server-side risk interventions ───────────────────────────
//
// The browser already warns a trader when they breach their own limits, but it
// can only do so while the tab is open — and traders execute in MT5, not in the
// journal. This module runs the same checks HERE, the moment broker-synced
// trades land in Firestore, and pushes the warning to their phone.
//
// Design notes:
//   • Triggers mirror the browser ladder in journal.html (etwAiMonitor) and are
//     ordered most-urgent-first; the first match wins. Keep the two in step.
//   • Wording is static, not AI-generated. A push has to be instant, must work
//     when the AI quota is spent, and costs nothing this way. The notification
//     opens the journal, where the full assistant is available to talk it
//     through with real context.
//   • Deduped per user in users/{uid}.aiGuard so a trader is not pushed twice
//     for the same state; it re-arms as soon as another trade closes.
//
// Wire-up: store.writeTrades() calls onTradesWritten(), so every connector
// (MT5 EA, cTrader, DXtrade, TradeLocker) is covered without touching each one.

const { admin } = require('./firebaseAdmin');

let db = null;
const SITE = (process.env.ETW_SITE_URL || 'https://etwiz.space').replace(/\/$/, '');

// Same defaults as the browser. The browser additionally learns per-trader
// thresholds from history; the server deliberately stays on the conservative
// defaults so a push is never a surprise the trader has not already seen.
const DD_LIMIT_AT = 0.8;   // fraction of a self-set loss limit that warns
const REVENGE_MIN = 15;    // minutes after a loss that counts as revenge
const SIZE_MULT   = 2.5;   // lot size vs recent median that counts as a spike
const OVERTRADE_X = 2;     // today's count vs a typical day

function init(_db) { db = _db; }

const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const money = (v) => (v >= 0 ? '+$' : '-$') + Math.abs(Number(v) || 0).toFixed(2);

function tradeMs(t) {
  const raw = t.tradeDate != null ? t.tradeDate : t.createdAt;
  const n = Number(raw);
  if (isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n;
  const p = Date.parse(t.closeTime || t.openTime || '');
  return isFinite(p) ? p : 0;
}
function result(t) {
  const r = String(t.result || '').toUpperCase();
  if (r.includes('WIN')) return 'WIN';
  if (r.includes('LOSS')) return 'LOSS';
  const p = num(t.pnl);
  return p > 0 ? 'WIN' : p < 0 ? 'LOSS' : 'OPEN';
}
const ymd = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

// ── push ──────────────────────────────────────────────────────────────────
async function pushTo(uid, title, body) {
  if (!uid) return false;
  try {
    const snap = await db.collection('pushTokens').doc(uid).get();
    const token = snap.exists && snap.data().token;
    if (!token) return false;
    await admin.messaging().send({
      token,
      notification: { title, body },
      webpush: {
        fcmOptions: { link: SITE + '/journal.html' },
        notification: { icon: SITE + '/etw-logo-192.png', requireInteraction: true, tag: 'etw-ai-guard' },
      },
    });
    return true;
  } catch (e) {
    if (e && (e.code === 'messaging/registration-token-not-registered'
           || e.code === 'messaging/invalid-argument')) {
      db.collection('pushTokens').doc(uid).delete().catch(() => {});
    } else console.warn('[aiGuard] push:', e.message);
    return false;
  }
}

// ── data ──────────────────────────────────────────────────────────────────
async function loadTrades(uid) {
  const snap = await db.collection('trades').where('uid', '==', uid).get();
  const out = [];
  snap.forEach((d) => {
    const t = d.data();
    // Closed trades only — an open position has nothing to judge yet.
    if (!(String(t.result || '').trim() || num(t.pnl) !== 0)) return;
    out.push(t);
  });
  return out.sort((a, b) => tradeMs(a) - tradeMs(b));
}

async function loadLimits(uid) {
  try {
    const snap = await db.collection('presence').doc(uid).get();   // where the journal saves them
    const l = (snap.exists && snap.data().drawdownLimits) || {};
    return {
      daily: Math.abs(num(l.daily)),
      weekly: Math.abs(num(l.weekly)),
      monthly: Math.abs(num(l.monthly)),
    };
  } catch (e) { return { daily: 0, weekly: 0, monthly: 0 }; }
}

// Period P&L in UTC. The browser uses local time, so a warning can differ by a
// few hours around midnight; the browser copy is authoritative when open.
function periodStart(period) {
  const now = new Date();
  if (period === 'daily') return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (period === 'weekly') {
    const dow = (now.getUTCDay() + 6) % 7;
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - dow * 86400000;
  }
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function drawdownStatus(trades, limits) {
  return ['daily', 'weekly', 'monthly'].map((period) => {
    const from = periodStart(period);
    const pnl = trades.filter((t) => tradeMs(t) >= from).reduce((s, t) => s + num(t.pnl), 0);
    const limit = limits[period] || 0;
    const used = pnl < 0 ? Math.abs(pnl) : 0;
    return { period, limit, used, reached: limit > 0 && pnl <= -limit };
  });
}

// ── the trigger ladder (mirrors journal.html verdict()) ────────────────────
function verdict(trades, limits) {
  if (!trades.length) return null;
  const last = trades[trades.length - 1];
  const prev = trades[trades.length - 2];

  let worst = null;
  for (const s of drawdownStatus(trades, limits)) {
    if (!(s.limit > 0)) continue;
    const frac = s.used / s.limit;
    if (!worst || frac > worst.frac) worst = Object.assign({ frac }, s);
  }
  if (worst && worst.frac >= DD_LIMIT_AT) {
    return worst.reached
      ? { kind: 'ddlimit', title: 'Stop trading now',
          body: `You have hit your ${worst.period} loss limit of $${worst.limit.toFixed(2)}. That was your own limit, not a suggestion.` }
      : { kind: 'ddlimit', title: 'Close to your limit',
          body: `You are $${(worst.limit - worst.used).toFixed(2)} from your ${worst.period} loss limit.` };
  }

  if (prev && result(prev) === 'LOSS') {
    const closedPrev = Date.parse(prev.closeTime || '') || tradeMs(prev);
    const openedLast = Date.parse(last.openTime || '') || tradeMs(last);
    const gap = (openedLast - closedPrev) / 60000;
    if (gap >= 0 && gap <= REVENGE_MIN) {
      return { kind: 'revenge', title: 'Slow down',
        body: `You re-entered ${Math.round(gap)} min after a ${money(num(prev.pnl))} loss. Step away before the next one.` };
    }
  }

  const recent = trades.slice(-20);
  const lots = recent.map((t) => num(t.lot)).filter((v) => v > 0).sort((a, b) => a - b);
  if (lots.length >= 5 && num(last.lot) > 0) {
    const med = lots[Math.floor(lots.length / 2)];
    if (med > 0 && num(last.lot) >= med * SIZE_MULT) {
      return { kind: 'sizespike', title: 'Size check',
        body: `That was ${num(last.lot)} lots against your usual ${med}. Cut back to normal risk.` };
    }
  }

  const today = ymd(Date.now());
  const perDay = {};
  trades.forEach((t) => { const d = ymd(tradeMs(t)); if (d) perDay[d] = (perDay[d] || 0) + 1; });
  const todayCount = perDay[today] || 0;
  const others = Object.keys(perDay).filter((d) => d !== today).map((d) => perDay[d]).sort((a, b) => a - b);
  const medDay = others.length ? others[Math.floor(others.length / 2)] : 0;
  if (medDay >= 2 && todayCount >= medDay * OVERTRADE_X && todayCount >= 4) {
    return { kind: 'overtrade', title: 'Too many today',
      body: `${todayCount} trades today against a typical day of ${medDay}. Stop adding positions.` };
  }

  let lossStreak = 0;
  for (let i = trades.length - 1; i >= 0; i--) { if (result(trades[i]) === 'LOSS') lossStreak++; else break; }
  if (lossStreak >= 3) {
    return { kind: 'drawdown', title: 'Heads up',
      body: `${lossStreak} losses in a row. Consider cutting size or stopping for the day.` };
  }
  return null;
}

// ── dedupe ────────────────────────────────────────────────────────────────
async function alreadySent(uid, kind, count) {
  try {
    const snap = await db.collection('users').doc(uid).get();
    const g = (snap.exists && snap.data().aiGuard) || null;
    return !!(g && g.kind === kind && g.count === count);
  } catch (e) { return false; }
}
async function remember(uid, kind, count) {
  try {
    await db.collection('users').doc(uid).set({ aiGuard: { kind, count, at: Date.now() } }, { merge: true });
  } catch (e) { /* a failed memo just risks one duplicate push */ }
}

// ── entry point ───────────────────────────────────────────────────────────
async function evaluate(uid) {
  if (!db || !uid) return null;
  const trades = await loadTrades(uid);
  if (!trades.length) return null;
  const limits = await loadLimits(uid);
  const v = verdict(trades, limits);
  if (!v) return null;
  if (await alreadySent(uid, v.kind, trades.length)) return null;
  await remember(uid, v.kind, trades.length);
  const sent = await pushTo(uid, 'ETW AI · ' + v.title, v.body);
  return Object.assign({ sent }, v);
}

// Called by store.writeTrades once fresh broker trades have landed. Never
// throws into the sync path — a failed warning must not fail an import.
function onTradesWritten(trades) {
  try {
    const uids = [...new Set((trades || []).map((t) => t && t.uid).filter(Boolean))];
    uids.forEach((uid) => {
      evaluate(uid).catch((e) => console.warn('[aiGuard] evaluate:', e && e.message));
    });
  } catch (e) { console.warn('[aiGuard] onTradesWritten:', e && e.message); }
}

module.exports = { init, evaluate, onTradesWritten, verdict, _internals: { drawdownStatus, result, tradeMs } };
