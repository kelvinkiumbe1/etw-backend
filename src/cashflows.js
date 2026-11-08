// Deposits, withdrawals and other balance operations read from the broker side
// (MT5 via the ETW EA / hosted worker / MetaApi, cTrader via the Open API).
// One Firestore doc per broker operation in the top-level `cashflows` collection:
//   { uid, accountId, source, extId, kind, sub, amount (signed, account currency),
//     currency, ts, note, balance, brokerAccount, syncedAt }
// Doc ids are derived from the broker's own id, so re-syncing never duplicates.
// Fields the trader sets in the app (hidden, userNote, kindOverride) are never
// written here, so a re-sync keeps them.
const store = require('./store');

function clean(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n || 200); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(n) { return Math.round((num(n) + Number.EPSILON) * 100) / 100; }
function docId(uid, source, extId) { return (uid + '_' + source + '_' + String(extId)).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 300); }

// MT5 deal types (EnumToString names from the EA, or MetaApi's DEAL_TYPE_* strings).
function classifyMt5(type, amount) {
  const t = String(type || '').toUpperCase();
  const a = num(amount);
  if (/BALANCE$/.test(t)) return { kind: a >= 0 ? 'deposit' : 'withdrawal', sub: a >= 0 ? 'Deposit' : 'Withdrawal' };
  if (/CREDIT/.test(t)) return { kind: 'other', sub: a >= 0 ? 'Credit' : 'Credit removed' };
  if (/BONUS/.test(t)) return { kind: 'other', sub: 'Bonus' };
  if (/CHARGE/.test(t)) return { kind: 'other', sub: 'Charge' };
  if (/CORRECTION/.test(t)) return { kind: 'other', sub: 'Correction' };
  if (/COMMISSION/.test(t)) return { kind: 'other', sub: 'Commission' };
  if (/INTEREST/.test(t)) return { kind: 'other', sub: 'Interest' };
  if (/DIVIDEND/.test(t)) return { kind: 'other', sub: 'Dividend' };
  if (/TAX/.test(t)) return { kind: 'other', sub: 'Tax' };
  return null;   // trades, cancellations: not a cash operation
}

// cTrader ProtoOAChangeBalanceType.
const CT_TYPES = {
  0: ['deposit', 'Deposit'], 1: ['withdrawal', 'Withdrawal'],
  3: ['other', 'Strategy commission'], 4: ['other', 'Strategy commission'],
  5: ['other', 'IB commission'], 6: ['other', 'IB share'], 7: ['other', 'IB share'], 8: ['other', 'IB share'],
  9: ['other', 'Rebate'], 10: ['other', 'Rebate'], 11: ['other', 'Strategy commission'], 12: ['other', 'Strategy commission'],
  13: ['other', 'Bonus compensation'], 14: ['other', 'IB share'], 15: ['other', 'Dividend'], 16: ['other', 'Dividend'],
  17: ['other', 'Guaranteed stop fee'], 18: ['other', 'Rollover'], 19: ['other', 'Bonus'], 20: ['other', 'Bonus'],
  21: ['other', 'Swap'], 22: ['other', 'Swap'], 27: ['other', 'Management fee'], 28: ['other', 'Management fee'],
  29: ['other', 'Performance fee'], 30: ['withdrawal', 'Transfer to sub-account'], 31: ['deposit', 'Transfer to sub-account'],
  32: ['withdrawal', 'Transfer from sub-account'], 33: ['deposit', 'Transfer from sub-account'], 34: ['other', 'Copy fee'],
  35: ['other', 'Inactivity fee'], 36: ['deposit', 'Transfer in'], 37: ['withdrawal', 'Transfer out'],
  38: ['other', 'Converted bonus'], 39: ['other', 'Negative balance protection'],
};
// Withdrawal-type operations are always negative, deposit-type always positive,
// whatever sign the broker put on `delta`.
const CT_NEG = new Set([1, 4, 6, 10, 12, 13, 14, 16, 17, 18, 20, 22, 28, 30, 32, 34, 35, 37]);
function classifyCtrader(op, delta) {
  const o = Number(op);
  const m = CT_TYPES[o] || ['other', 'Balance change'];
  const abs = Math.abs(num(delta));
  const amount = CT_TYPES[o] ? (CT_NEG.has(o) ? -abs : abs) : num(delta);
  return { kind: m[0], sub: m[1], amount };
}

async function writeCash(list) {
  const docs = (list || []).filter((c) => c && c.uid && c.extId && Number.isFinite(c.ts) && c.ts > 0 && num(c.amount) !== 0);
  if (!docs.length) return 0;
  let batch = store.db.batch(), n = 0, inBatch = 0;
  for (const c of docs) {
    const ref = store.db.collection('cashflows').doc(docId(c.uid, c.source, c.extId));
    batch.set(ref, {
      uid: c.uid, accountId: c.accountId || '', source: c.source, extId: String(c.extId).slice(0, 80),
      kind: c.kind, sub: clean(c.sub, 60), amount: r2(c.amount), currency: clean(c.currency, 8),
      ts: Math.round(c.ts), note: clean(c.note, 300), balance: c.balance != null ? r2(c.balance) : null,
      brokerAccount: clean(c.brokerAccount, 80), syncedAt: Date.now(),
    }, { merge: true });
    n++; inBatch++;
    if (inBatch >= 400) { await batch.commit(); batch = store.db.batch(); inBatch = 0; }
  }
  if (inBatch) await batch.commit();
  return n;
}

// ── MT5 starting balance when the broker history has no deposit ──
// Prop-firm accounts (and some brokers) fund the account without a deposit deal,
// or the terminal's history doesn't reach back to it. When an MT5 account has no
// deposit at all, its starting balance is worked out from what we do know:
//   starting balance = current balance − closed-trade P&L (profit + swap + commission)
//                      − every other balance operation we have (withdrawals, fees…)
// and saved as one deposit row (source 'mt5-initial', marked as estimated). It is
// refreshed as trades arrive, and removed by itself as soon as a real deposit shows
// up (from the broker, or one the trader adds by hand). Hide / note set in the app
// are kept, like any other synced row.
const _initRun = new Map();
async function ensureMt5Initial(uid, slot, opts) {
  try {
    if (!uid || !slot || !(num(slot.balance) > 0)) return null;
    const login = clean(slot.login, 20);
    if (!login) return null;
    const every = (opts && opts.everyMs) || 0;
    const runKey = uid + '|' + login;
    if (every && Date.now() - (_initRun.get(runKey) || 0) < every) return null;
    _initRun.set(runKey, Date.now());
    if (_initRun.size > 20000) _initRun.clear();
    const acct = slot.accountId || '';
    const same = (a) => (a || '') === acct;
    const extId = 'mt5_' + login + '_initial';
    const ref = store.db.collection('cashflows').doc(docId(uid, 'mt5-initial', extId));
    const [cs, ts] = await Promise.all([
      store.db.collection('cashflows').where('uid', '==', uid).get(),
      store.db.collection('trades').where('uid', '==', uid).get(),
    ]);
    let hasDeposit = false, cashSum = 0, first = Infinity, existing = null;
    cs.docs.forEach((d) => {
      const c = d.data() || {};
      if (!same(c.accountId)) return;
      if (c.source === 'mt5-initial') { if (d.id === ref.id) existing = c; return; }
      if ((c.kindOverride || c.kind) === 'deposit') hasDeposit = true;
      cashSum += num(c.amount);
      if (num(c.ts) > 0) first = Math.min(first, num(c.ts));
    });
    if (hasDeposit) { if (existing) await ref.delete(); return null; }
    let pnl = 0, n = 0;
    ts.docs.forEach((d) => {
      const t = d.data() || {};
      if (!same(t.accountId) || !/^mt5/i.test(String(t.source || ''))) return;
      if (String(t.result || '').toUpperCase() === 'OPEN') return;
      pnl += num(parseFloat(t.pnl)) + num(parseFloat(t.swap)) + num(parseFloat(t.commission)); n++;
      const ms = num(t.tradeDate) || num(t.createdAt);
      if (ms > 0) first = Math.min(first, ms);
    });
    const initial = r2(num(slot.balance) - pnl - cashSum);
    if (!(initial > 0)) { if (existing) await ref.delete(); return null; }
    const at = Math.round(first < Infinity ? first - 60000 : (num(slot.at) || Date.now()));
    if (existing && Math.abs(num(existing.amount) - initial) < 1 && Math.abs(num(existing.ts) - at) < 86400000) return num(existing.amount);
    await writeCash([{ uid, accountId: acct, source: 'mt5-initial', extId, kind: 'deposit', sub: 'Starting balance', amount: initial,
      currency: slot.currency || '', ts: at, balance: null, brokerAccount: (clean(slot.server, 60) + ' ' + login).trim(),
      note: 'Estimated starting balance — no deposit was found in the broker history (common on prop firm accounts). Based on ' + n + ' synced trade' + (n === 1 ? '' : 's') + '.' }]);
    await ref.set({ estimated: true }, { merge: true });
    return initial;
  } catch (e) { console.warn('[cashflows] mt5 starting balance:', e.message); return null; }
}

module.exports = { writeCash, classifyMt5, classifyCtrader, docId, ensureMt5Initial };
