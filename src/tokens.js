// Auto-Sync token ledger + hourly meter.
//
// Direct MT5 connect is metered, not subscribed: MetaApi bills us per account
// for as long as it stays deployed, and the first connect costs more again
// because the whole trade history is pulled down. So the user holds a prepaid
// token balance, this module debits it as the sync actually runs, and sync stops
// when it empties.
//
// EVERYTHING here writes via the Admin SDK, which bypasses Firestore rules. The
// balance is money — the client must never be able to write it. See
// firestore.rules: users/{uid} denies client writes to syncTokens/syncLedger.
const store = require('./store');

const HOUR_MS = 3600 * 1000;
// All injected by server.js so tokens.js never has to require mt5sync.js
// (which would be a cycle through store).
let onDeplete = null, onPause = null, onResume = null, onPull = null;

function init({ onDeplete: d, onPause: p, onResume: r, onPull: u } = {}) {
  onDeplete = d || null; onPause = p || null; onResume = r || null; onPull = u || null;
}

// Rates live in env so they can be retuned without a code change — the whole
// point of the token indirection is that an unknown MetaApi price is one
// constant, not an architecture. Defaults assume a $0.004 token (Standard pack:
// 2500 for $10), a $2.00 MetaApi first-sync and $0.03/hr, at a 1.5x margin.
// The hourly figure is a GUESS until measured — see MT5-SYNC-TOKENS-BACKEND.md.
// Defaults are computed from MetaApi's ACTUAL published rates for this account's
// configuration (cloud-g1, regular reliability, paid subscription) and the live
// Selar pack (KSh 1,250 / 2,500 tokens => KSh 0.50 ≈ $0.00388 per token), at a
// 1.5x margin:
//   deployed hosting        $0.019688 /account/hour
//   adding a unique account $2.10     once per calendar month
//   tokensPerHour    = ceil(0.019688 * 1.5 / 0.00388) = 8
//   tokensPerConnect = ceil(2.10     * 1.5 / 0.00388) = 812 -> 800
// Daily mode is billed PER PULL, not per hour, because that is how it costs us:
// one deployment ($0.118125) plus a few minutes of hosting, then undeployed at
// $0.00105/hr. Billing it hourly would misprice it in both directions.
//   tokensPerPull = ceil((0.118125 + 0.019688*0.25) * 1.5 / 0.00388) = 48
// 30 pulls + one connect fee = 1,440 + 800 = 2,240 tokens, so the KSh 1,250 pack
// (2,500 tokens) is very close to exactly one month of daily sync.
function rates() {
  return {
    tokensPerHour:    Math.max(0, Number(process.env.SYNC_TOKENS_PER_HOUR    || 8)),
    tokensPerConnect: Math.max(0, Number(process.env.SYNC_TOKENS_PER_CONNECT || 800)),
    tokensPerPull:    Math.max(0, Number(process.env.SYNC_TOKENS_PER_PULL    || 48)),
  };
}

// Forex is shut from Friday close to Sunday open. Deliberately conservative at
// both ends — pausing early or resuming late would drop trades, while a slightly
// short pause only costs a few tokens. Hours are UTC; the extra margin absorbs
// broker DST drift without needing a calendar.
function marketClosed(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay();          // 0 Sun … 6 Sat
  const h = d.getUTCHours();
  if (day === 6) return true;                    // all Saturday
  if (day === 5 && h >= 22) return true;         // Friday from 22:00 UTC
  if (day === 0 && h < 21) return true;          // Sunday until 21:00 UTC
  return false;
}

const userRef   = (uid) => store.db.collection('users').doc(uid);
const ledgerRef = (uid) => userRef(uid).collection('syncLedger').doc();

function insufficient(balance, needed) {
  const e = new Error('Not enough sync tokens.');
  e.status = 402; e.code = 'insufficient_tokens';
  e.balance = balance; e.needed = needed;
  return e;
}

// Read-only view for callers that just want to show or check a balance.
async function get(uid) {
  const snap = await userRef(uid).get();
  const cur = (snap.exists && snap.data().syncTokens) || {};
  const r = rates();
  return {
    balance: Number(cur.balance || 0),
    lifetimeSpent: Number(cur.lifetimeSpent || 0),
    lifetimePurchased: Number(cur.lifetimePurchased || 0),
    lastDebitAt: Number(cur.lastDebitAt || 0),
    tokensPerHour: r.tokensPerHour,
    tokensPerConnect: r.tokensPerConnect,
  };
}

// The single mutation primitive. `delta` is signed: negative debits (and is
// refused if the balance can't cover it), positive credits. Balance change and
// ledger entry are written in ONE transaction so the two can never disagree —
// with a balance system "where did my tokens go?" is an inevitable question and
// an unexplainable balance is worse than no balance.
async function move(uid, { delta, kind, ref = null, note = null, startMeter = false }) {
  const db = store.db;
  const r = rates();
  const uref = userRef(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(uref);
    const cur = (snap.exists && snap.data().syncTokens) || {};
    const balance = Number(cur.balance || 0);
    const amt = Math.trunc(delta);

    if (amt < 0 && balance < -amt) throw insufficient(balance, -amt);

    const after = balance + amt;
    const patch = {
      balance: after,
      // Echoed so the journal can translate tokens into "≈ N days left" using
      // the rate that will actually bill, never a stale copy in the frontend.
      tokensPerHour: r.tokensPerHour,
      tokensPerConnect: r.tokensPerConnect,
      lifetimeSpent:     Number(cur.lifetimeSpent || 0)     + (amt < 0 ? -amt : 0),
      lifetimePurchased: Number(cur.lifetimePurchased || 0) + (amt > 0 ?  amt : 0),
      updatedAt: Date.now(),
    };
    // Anchor the meter at connect time so the first hourly sweep bills from the
    // moment the account went live, not from whenever the cron happened to run.
    if (startMeter) patch.lastDebitAt = Date.now();

    tx.set(uref, { syncTokens: patch }, { merge: true });
    tx.set(ledgerRef(uid), { ts: Date.now(), delta: amt, kind, balanceAfter: after, ref, note });
    return after;
  });
}

const credit = (uid, tokens, opts = {}) =>
  move(uid, { delta: Math.abs(Math.trunc(tokens)), kind: opts.kind || 'purchase', ref: opts.ref, note: opts.note });

const charge = (uid, tokens, opts = {}) =>
  move(uid, { delta: -Math.abs(Math.trunc(tokens)), kind: opts.kind || 'adjust', ref: opts.ref, note: opts.note, startMeter: opts.startMeter });

const yearMonth = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);   // "2026-08"

// Charged up front by /api/mt5-direct/connect, BEFORE MetaApi is touched, and
// inside a transaction — two concurrent connects would otherwise both pass a
// bare `balance >= cost` check and only one would be paid for.
//
// ONCE PER CALENDAR MONTH per unique account, because that is exactly how
// MetaApi bills us: "Adding a trading account to MetaApi cloud — $2.10 per
// unique trading account [platform + server + login], charged once per month in
// case you repeatedly add the same trading account". So a user who disconnects
// and reconnects the same account in the same month costs us nothing extra and
// must not be charged again. Returns 0 when the fee is already covered.
//
// Still refunded by refundConnect() when startSync reports the account was
// already deployed — that covers a cross-month reconnect where no fresh import
// happened, so we never have to guess.
async function chargeConnect(uid, { accountKey, note }) {
  const { tokensPerConnect } = rates();
  if (tokensPerConnect <= 0) return 0;
  const db = store.db;
  const uref = userRef(uid);
  const ym = yearMonth();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(uref);
    const cur = (snap.exists && snap.data().syncTokens) || {};
    const last = cur.lastConnectCharge || null;

    // Already paid for this account this month — free reconnect.
    if (last && last.accountKey === accountKey && last.ym === ym) return 0;

    const balance = Number(cur.balance || 0);
    if (balance < tokensPerConnect) throw insufficient(balance, tokensPerConnect);
    const r = rates();
    const after = balance - tokensPerConnect;

    tx.set(uref, { syncTokens: {
      balance: after,
      tokensPerHour: r.tokensPerHour,
      tokensPerConnect: r.tokensPerConnect,
      lifetimeSpent: Number(cur.lifetimeSpent || 0) + tokensPerConnect,
      lastConnectCharge: { accountKey: accountKey || null, ym },
      lastDebitAt: Date.now(),          // anchor the hourly meter from go-live
      updatedAt: Date.now(),
    } }, { merge: true });
    tx.set(ledgerRef(uid), {
      ts: Date.now(), delta: -tokensPerConnect, kind: 'connect', balanceAfter: after,
      ref: accountKey || null, note: note || 'History import',
    });
    return tokensPerConnect;
  });
}

// A reconnect that costs nothing still has to restart the meter, or the next
// sweep would bill every hour since the previous session's last debit.
async function touchMeterAnchor(uid) {
  await userRef(uid).set({ syncTokens: { lastDebitAt: Date.now(), updatedAt: Date.now() } }, { merge: true });
}

// Refund or chargeback on a token pack. Takes back what it can WITHOUT going
// negative and without throwing — tokens already spent are gone, and we can't
// un-sync trades that were already imported. Returns how much was recovered so
// the caller can log the shortfall.
async function clawback(uid, tokens, opts = {}) {
  const want = Math.abs(Math.trunc(tokens));
  if (!want) return 0;
  const db = store.db;
  const uref = userRef(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(uref);
    const cur = (snap.exists && snap.data().syncTokens) || {};
    const balance = Number(cur.balance || 0);
    const take = Math.min(want, Math.max(0, balance));
    if (!take) return 0;
    const after = balance - take;
    tx.set(uref, { syncTokens: { balance: after, updatedAt: Date.now() } }, { merge: true });
    tx.set(ledgerRef(uid), {
      ts: Date.now(), delta: -take, kind: 'clawback', balanceAfter: after,
      ref: opts.ref || null,
      note: opts.note || ('Refunded' + (take < want ? ' (only ' + take + ' of ' + want + ' still unspent)' : '')),
    });
    return take;
  });
}

// Called after a dormant MetaApi account is deleted. Once it's gone, MetaApi
// will charge the $2.10 add fee again on their return — so the user's connect
// fee has to become chargeable again too, or we would eat it. (The monthly cap
// would expire on its own after 90 days of dormancy; clearing it explicitly
// keeps that correct even if the prune threshold is ever shortened.)
async function clearConnectCharge(uid) {
  await userRef(uid).set({ syncTokens: { lastConnectCharge: null, updatedAt: Date.now() } }, { merge: true });
}

async function refundConnect(uid, amount, { accountKey, note } = {}) {
  if (!amount) return;
  await move(uid, {
    delta: Math.abs(Math.trunc(amount)), kind: 'refund', ref: accountKey || null,
    note: note || 'Connect refunded',
  });
}

// ── The meter ──────────────────────────────────────────────────────────────
// Sweeps every connected account and bills the hours that have elapsed since
// the last debit.
//
// `lastDebitAt += elapsed * HOUR_MS` rather than `= now` is what makes this
// idempotent and self-healing: a sweep that gets skipped (cold Render dyno,
// deploy, outage) catches up on the next pass instead of losing the hours, and a
// sweep that fires twice inside one hour bills nothing the second time because
// elapsedHours floors to 0.
async function meterUser(uid) {
  const db = store.db;
  const uref = userRef(uid);
  const r = rates();
  if (r.tokensPerHour <= 0) return { skipped: 'rate_zero' };

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(uref);
    if (!snap.exists) return { skipped: 'no_user' };
    const d = snap.data();
    if (!d.mt5Direct || d.mt5Direct.status !== 'connected') return { skipped: 'not_connected' };
    // Only LIVE mode holds a deployed account, so only live mode accrues hours.
    // Daily mode is billed per pull in pullDue() instead.
    if ((d.mt5Direct.mode || 'live') !== 'live') return { skipped: 'not_live_mode' };

    const cur = d.syncTokens || {};
    const balance = Number(cur.balance || 0);
    const anchor = Number(cur.lastDebitAt || 0) || Date.now();
    const elapsedHours = Math.floor((Date.now() - anchor) / HOUR_MS);
    if (elapsedHours < 1) return { skipped: 'too_soon' };

    const want = elapsedHours * r.tokensPerHour;
    const debit = Math.min(want, balance);        // never let the balance go negative
    const after = balance - debit;
    const depleted = after <= 0 || debit < want;

    tx.set(uref, { syncTokens: {
      balance: after,
      tokensPerHour: r.tokensPerHour,
      tokensPerConnect: r.tokensPerConnect,
      lifetimeSpent: Number(cur.lifetimeSpent || 0) + debit,
      lastDebitAt: anchor + elapsedHours * HOUR_MS,
      updatedAt: Date.now(),
    } }, { merge: true });

    if (debit > 0) {
      tx.set(ledgerRef(uid), {
        ts: Date.now(), delta: -debit, kind: 'hourly', balanceAfter: after,
        ref: (d.mt5Direct && d.mt5Direct.metaApiAccountId) || null,
        note: elapsedHours + 'h connected',
      });
    }
    return { debited: debit, hours: elapsedHours, balance: after, depleted };
  });

  // Undeploying is the whole point of depletion. Leaving the MetaApi account
  // deployed means we keep paying for a user who has stopped paying us.
  if (outcome.depleted && onDeplete) {
    try { await onDeplete(uid); } catch (e) { console.error('[tokens] depletion stop failed for', uid, '-', e.message); }
  }
  return outcome;
}

// Daily mode: pull once per day. Direct MT5 sync is included with the
// subscription, so this scheduler must never debit sync tokens.
async function pullDue(uid, mt5, accountKey) {
  const last = Number(mt5.lastPullAt || 0);
  const everyMs = Math.max(1, Number(process.env.SYNC_PULL_EVERY_HOURS || 24)) * HOUR_MS;
  if (Date.now() - last < everyMs) return { skipped: 'too_soon' };

  if (onPull) {
    try { await onPull(uid, accountKey); }
    catch (e) {
      return { error: e.message };
    }
  }
  return { pulled: true };
}

async function meterTick() {
  if (!store.db) return { swept: 0 };
  const closed = marketClosed();
  let swept = 0, debited = 0, depleted = 0, paused = 0, resumed = 0, pulled = 0;

  try {
    // ── 1. Resume anyone paused for the weekend, now that it's over ────────
    if (!closed && onResume) {
      const psnap = await store.db.collection('users').where('mt5Direct.status', '==', 'paused').get();
      for (const doc of psnap.docs) {
        const d = doc.data().mt5Direct || {};
        if ((d.pausedReason || '') !== 'market_closed') continue;   // manual pause: leave alone
        if ((d.mode || 'live') !== 'live') continue;
        try {
          // Re-anchor BEFORE reconnecting so the paused hours are never billed.
          await touchMeterAnchor(doc.id);
          await onResume(doc.id);
          resumed++;
        } catch (e) { console.error('[tokens] resume failed for', doc.id, '-', e.message); }
      }
    }

    const snap = await store.db.collection('users').get();
    for (const doc of snap.docs) {
      const uid = doc.id;
      const data = doc.data();
      const accounts = Object.assign({}, data.mt5DirectAccounts || {});
      if (!Object.keys(accounts).length && data.mt5Direct) accounts.legacy = data.mt5Direct;
      for (const accountKey of Object.keys(accounts)) {
        const mt5 = accounts[accountKey] || {};
        if (mt5.status !== 'connected') continue;
      const mode = mt5.mode || 'daily';
      try {
        // ── 2. Daily mode: pull if due, regardless of market hours (a pull
        //      after the close still collects Friday's trades). ─────────────
        if (mode === 'daily') {
          const o = await pullDue(uid, mt5, accountKey);
          swept++;
          if (o.debited) debited += o.debited;
          if (o.pulled) pulled++;
          if (o.depleted) depleted++;
          continue;
        }

        // Live mode is retired; normalize legacy records to daily behavior.
        if (mode === 'live') {
          await store.db.collection('users').doc(uid).set({ mt5DirectAccounts: {
            [accountKey]: { mode: 'daily' }
          }}, { merge: true });
        }
      } catch (e) { console.error('[tokens] meter failed for', uid, '-', e.message); }
      }
    }
  } catch (e) { console.error('[tokens] meterTick:', e.message); }

  if (debited || depleted || paused || resumed || pulled) {
    console.log(`[tokens] meter: ${swept} active, -${debited} tokens`
      + (pulled ? `, ${pulled} pulled` : '') + (paused ? `, ${paused} paused` : '')
      + (resumed ? `, ${resumed} resumed` : '') + (depleted ? `, ${depleted} depleted` : ''));
  }
  return { swept, debited, depleted, paused, resumed, pulled, marketClosed: closed };
}

// Runs in-process on a 15-minute timer rather than hourly, so a restart never
// lands us more than 15 minutes away from an accurate anchor. Billing is still
// whole-hours-only, so the extra passes are almost all no-ops.
function startMeter() {
  const every = Math.max(1, Number(process.env.SYNC_METER_MINUTES || 15)) * 60 * 1000;
  setTimeout(() => { meterTick().catch(() => {}); }, 20 * 1000);   // let boot settle
  const t = setInterval(() => { meterTick().catch(() => {}); }, every);
  if (t.unref) t.unref();
  const r = rates();
  console.log(`[tokens] meter every ${every / 60000}min · live ${r.tokensPerHour}/hr · daily ${r.tokensPerPull}/pull · ${r.tokensPerConnect}/connect · market ${marketClosed() ? 'CLOSED' : 'open'}`);
  return t;
}

module.exports = {
  init, rates, marketClosed, get, credit, charge, chargeConnect, refundConnect,
  clawback, touchMeterAnchor, clearConnectCharge, meterUser, pullDue, meterTick, startMeter,
};
