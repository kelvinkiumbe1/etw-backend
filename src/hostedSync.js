// Hosted MT5 sync: our own worker (MT5 under Wine, ~/Desktop/wine) in place of
// MetaApi. The user enters login + investor password + server once. We store
// the password encrypted, mint an EA key for the account, and the worker pulls
// jobs from /api/worker/jobs, logs MT5 in, lets the ETW EA post closed trades
// to /api/mt5/trades, and reports back to /api/worker/report.
//
// One doc per linked account in the backend-only `mt5Hosted` collection
// (doc id `${uid}_${accountKey}`; firestore.rules denies clients everything not
// listed). User-facing status lives where MT5 Direct always kept it:
// users/{uid}.mt5DirectAccounts[accountKey] (+ the mt5Direct mirror), with
// engine: 'hosted' so the MetaApi scheduler and Pro sweep leave it alone.
//
// Scheduling is a single `dueAt` per account. The worker claims the most
// overdue accounts, holds a short lease on each, and the report sets the next
// dueAt from how active the account is. "Sync now" sets dueAt to 0.
const crypto = require('crypto');
const store = require('./store');
const mt5 = require('./mt5sync');
const mt5ea = require('./connectors/mt5ea');
const access = require('./access');
const { marketClosed } = require('./tokens');

const COL = 'mt5Hosted';
const MIN = 60 * 1000;
const LEASE_MS = 8 * MIN;                 // worker's run timeout is 5 min
const ACTIVE_EVERY = 15 * MIN;            // trades in the last 24h, or positions open
const IDLE_EVERY = 60 * MIN;
const DORMANT_EVERY = 6 * 60 * MIN;       // nothing for 14 days
const RETRY_EVERY = 10 * MIN;             // worker-side failure (timeout, EA didn't start)
// HOSTED_SYNC_NOW_COOLDOWN_MIN on Render overrides the wait between "Sync now"
// presses (0 = none, e.g. while testing). Remove it to go back to 60.
const cooldownMin = String(process.env.HOSTED_SYNC_NOW_COOLDOWN_MIN || '').trim() === '' ? NaN : Number(process.env.HOSTED_SYNC_NOW_COOLDOWN_MIN);
const SYNC_NOW_COOLDOWN = (Number.isFinite(cooldownMin) && cooldownMin >= 0 ? cooldownMin : 60) * MIN;
const MAX_LOGIN_FAILS = 3;                // then stop until the user re-enters details

const ref = (id) => store.db.collection(COL).doc(id);
const docId = (uid, accountKey) => uid + '_' + accountKey;

// ── Credentials (AES-256-GCM, key in MT5_CRED_KEY) ─────────────────────────
// The doc id is bound in as associated data, so a ciphertext copied onto
// another account's doc fails to decrypt instead of logging in as the victim.
function credKey() {
  const raw = String(process.env.MT5_CRED_KEY || '').trim();
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    const e = new Error('MT5_CRED_KEY is not set (32 bytes, hex or base64).'); e.status = 503; throw e;
  }
  return buf;
}
const configured = () => { try { credKey(); return true; } catch (e) { return false; } };

function encrypt(text, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', credKey(), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(box, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', credKey(), Buffer.from(box.iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]).toString('utf8');
}

// ── User actions ───────────────────────────────────────────────────────────
// Re-linking the same account (new password, say) keeps its EA key, so the
// worker's on-disk sent-ticket list and the journal's dedup stay valid.
async function link(uid, { accountKey, login, password, server, platform, journalAccountId }) {
  const id = docId(uid, accountKey);
  const prev = await ref(id).get();
  const old = prev.exists ? prev.data() : null;
  const eaKey = (old && old.eaKey && (old.journalAccountId || '') === (journalAccountId || ''))
    ? old.eaKey
    : await mt5ea.registerHosted(uid, journalAccountId, accountKey);
  if (old && old.eaKey && old.eaKey !== eaKey) await mt5ea.revoke(old.eaKey).catch(() => {});
  await ref(id).set({
    uid, accountKey, login: String(login), server: String(server), platform: platform === 'mt4' ? 'mt4' : 'mt5',
    journalAccountId: journalAccountId || '', eaKey,
    cred: encrypt(password, id),
    dueAt: 0, leaseUntil: 0, leaseId: null, loginFails: 0, workerFails: 0,
    everSynced: !!(old && old.everSynced), lastActivityAt: (old && old.lastActivityAt) || 0,
    createdAt: (old && old.createdAt) || Date.now(), updatedAt: Date.now(),
  });
  await mt5.setStatus(uid, {
    status: 'connecting', engine: 'hosted', platform: platform === 'mt4' ? 'mt4' : 'mt5',
    login: String(login), server: String(server), journalAccountId: journalAccountId || '',
    error: null, queuedAt: Date.now(), metaApiAccountId: null,
  }, accountKey);
  return { ok: true };
}

// Deletes the stored password and the account's EA key. Trades stay.
async function unlink(uid, accountKey) {
  const snap = await ref(docId(uid, accountKey)).get();
  if (!snap.exists) return false;
  await mt5ea.revoke(snap.data().eaKey).catch(() => {});
  await ref(docId(uid, accountKey)).delete();
  return true;
}

async function syncNow(uid, accountKey) {
  return store.db.runTransaction(async (tx) => {
    const r = ref(docId(uid, accountKey));
    const snap = await tx.get(r);
    if (!snap.exists) { const e = new Error('This account is not linked.'); e.status = 404; throw e; }
    const d = snap.data();
    const wait = (d.syncNowAt || 0) + SYNC_NOW_COOLDOWN - Date.now();
    if (wait > 0) {
      const e = new Error('You can sync this account again in ' + Math.ceil(wait / MIN) + ' min.');
      e.status = 429; e.retryInMin = Math.ceil(wait / MIN); throw e;
    }
    if (d.loginFails >= MAX_LOGIN_FAILS) {
      const e = new Error('The broker rejected these details. Re-enter your login, investor password and server.');
      e.status = 409; throw e;
    }
    tx.update(r, { dueAt: 0, syncNowAt: Date.now() });
    return { ok: true };
  });
}

const isHosted = (status) => !!status && status.engine === 'hosted';

// After a plan change: put the user's held accounts back in the queue now
// rather than at the next daily re-check. claim() applies the new plan, so a
// downgrade holds the extra accounts on the same pass.
async function recheck(uid) {
  const snap = await store.db.collection(COL).where('uid', '==', uid).get();
  const now = Date.now();
  await Promise.all(snap.docs
    .filter((d) => (d.data().loginFails || 0) < MAX_LOGIN_FAILS && d.data().dueAt > now)
    .map((d) => d.ref.update({ dueAt: now })));
}

// ── Worker side ────────────────────────────────────────────────────────────
// Plan check per user, cached for one claim call. Essential syncs its oldest
// linked account; Pro syncs up to three. A lapsed plan holds every account
// (password kept) and re-checks once a day.
async function planFor(uid, cache) {
  if (cache.has(uid)) return cache.get(uid);
  let p;
  try {
    const a = await access.accessFor(uid, null);
    if (!a.active) p = { ok: false, reason: 'subscription_required' };
    else {
      const limit = access.isPro(a) ? 3 : 1;
      const mine = await store.db.collection(COL).where('uid', '==', uid).get();
      const allowed = mine.docs.map((d) => d.data())
        .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0))
        .slice(0, limit).map((d) => d.accountKey);
      p = { ok: true, allowed };
    }
  } catch (e) { p = { ok: false, reason: 'unknown' }; }
  cache.set(uid, p);
  return p;
}

const HOLD_MSG = {
  subscription_required: 'Sync is paused because your subscription is not active. It resumes automatically when you renew.',
  plan_limit: 'Your plan syncs 1 MT5 account. Upgrade to Pro to sync up to 3, or disconnect another account.',
};

// Claim up to `max` due accounts for this worker. Each is leased in its own
// transaction, so two workers polling at once never get the same account.
async function claim(workerId, max) {
  max = Math.min(Math.max(1, Number(max) || 1), 10);
  const now = Date.now();
  const snap = await store.db.collection(COL).where('dueAt', '<=', now).orderBy('dueAt').limit(max * 4).get();
  const plans = new Map();
  const jobs = [];
  for (const doc of snap.docs) {
    if (jobs.length >= max) break;
    const d = doc.data();
    if ((d.leaseUntil || 0) > now) continue;

    const plan = await planFor(d.uid, plans);
    if (plan.reason === 'unknown') continue;
    const hold = !plan.ok ? plan.reason : (!plan.allowed.includes(d.accountKey) ? 'plan_limit' : null);
    if (hold) {
      await doc.ref.update({ dueAt: now + 24 * 60 * MIN });
      await mt5.setStatus(d.uid, { status: 'paused', pausedReason: hold, error: HOLD_MSG[hold] }, d.accountKey).catch(() => {});
      continue;
    }

    const leaseId = crypto.randomBytes(8).toString('hex');
    const got = await store.db.runTransaction(async (tx) => {
      const s = await tx.get(doc.ref);
      if (!s.exists || (s.data().leaseUntil || 0) > Date.now() || s.data().dueAt > Date.now()) return false;
      tx.update(doc.ref, { leaseUntil: Date.now() + LEASE_MS, leaseId, leasedBy: String(workerId || '').slice(0, 64) });
      return true;
    });
    if (!got) continue;
    let password;
    try { password = decrypt(d.cred, doc.id); }
    catch (e) {
      console.error('[hosted] cannot decrypt', doc.id, '-', e.message);
      await doc.ref.update({ dueAt: now + 24 * 60 * MIN, leaseUntil: 0 });
      await mt5.setStatus(d.uid, { status: 'error', error: 'Please re-enter your investor password to resume sync.' }, d.accountKey).catch(() => {});
      continue;
    }
    jobs.push({
      jobId: doc.id, leaseId, login: d.login, server: d.server, platform: d.platform,
      password, syncKey: d.eaKey,
    });
    if (!d.everSynced) await mt5.setStatus(d.uid, { status: 'connecting', syncing: true }, d.accountKey).catch(() => {});
  }
  return jobs;
}

// ── Weekend traders ────────────────────────────────────────────────────────
// Crypto CFDs trade through the weekend, so an account that has closed a
// trade on a weekend recently keeps its normal schedule then. closeTime comes
// from the EA in broker server time ("2026.10.24 14:05:00", usually UTC+0..+3).
// Saturday always counts; Sunday only before 20:00, since on a UTC-clocked
// server forex trades can close from Sunday ~21:00 once the market reopens.
const WEEKEND_TRADER_FOR = 30 * 24 * 60 * MIN;

function weekendCloseAt(closeTime) {
  const m = /^(\d{4})[.-](\d{2})[.-](\d{2})[ T](\d{2})/.exec(String(closeTime || ''));
  if (!m) return 0;
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]);
  const day = new Date(at).getUTCDay();
  return (day === 6 || (day === 0 && +m[4] < 20)) ? at : 0;
}

// Called from the EA push path with the trades it just wrote for a hosted key.
async function noteWeekendTrades(uid, accountKey, trades) {
  const latest = Math.max(0, ...trades.map((t) => weekendCloseAt(t.closeTime)));
  if (!latest || latest < Date.now() - WEEKEND_TRADER_FOR) return;
  const r = ref(docId(uid, accountKey));
  await store.db.runTransaction(async (tx) => {
    const s = await tx.get(r);
    if (s.exists && (s.data().lastWeekendTradeAt || 0) < latest) tx.update(r, { lastWeekendTradeAt: latest });
  });
}

const tradesWeekends = (d, now) => (d.lastWeekendTradeAt || 0) > now - WEEKEND_TRADER_FOR;

function nextDue(d, now) {
  const quiet = now - (d.lastActivityAt || d.createdAt || now);
  let every = IDLE_EVERY;
  if (d.openPositions > 0 || quiet < 24 * 60 * MIN) every = ACTIVE_EVERY;
  else if (quiet > 14 * 24 * 60 * MIN) every = DORMANT_EVERY;
  let due = now + every;
  // Weekend: one run after the Friday close collects the last trades; then
  // nothing until the market reopens, unless the account trades weekends.
  if (marketClosed(now) && !tradesWeekends(d, now)) {
    due = now + 60 * MIN;
    while (marketClosed(due)) due += 60 * MIN;
  }
  return due;
}

const LOGIN_MSG = 'The broker rejected the login, investor password or server. Check them and connect again.';

// result: done | send_failed | not_connected | ea_failed | timeout
async function report(workerId, { jobId, leaseId, result, sent, failed, openPositions, durationMs, detail }) {
  const r = ref(String(jobId || ''));
  const snap = await r.get();
  if (!snap.exists) return { ok: true, gone: true };          // unlinked mid-run
  const d = snap.data();
  if (d.leaseId !== leaseId) { const e = new Error('Lease expired or not yours.'); e.status = 409; throw e; }
  const now = Date.now();
  sent = Math.max(0, Number(sent) || 0);
  const patch = { leaseUntil: 0, leaseId: null, lastRunAt: now, lastResult: String(result || ''), lastDurationMs: Number(durationMs) || null };
  let status = null;

  if (result === 'done') {
    patch.loginFails = 0; patch.workerFails = 0; patch.everSynced = true; patch.lastSyncAt = now;
    patch.openPositions = Math.max(0, Number(openPositions) || 0);
    if (sent > 0) patch.lastActivityAt = now;
    patch.dueAt = nextDue(Object.assign({}, d, patch), now);
    status = { status: 'connected', syncing: false, error: null, lastSyncAt: now, nextSyncAt: patch.dueAt, pausedReason: null };
  } else if (result === 'not_connected') {
    patch.loginFails = (d.loginFails || 0) + 1;
    // A broker that is briefly down looks the same as a wrong password. A
    // first-time link that fails is almost always the details, so say so at
    // once; an account that has synced before gets a few retries first.
    const giveUp = !d.everSynced || patch.loginFails >= MAX_LOGIN_FAILS;
    patch.dueAt = giveUp ? Number.MAX_SAFE_INTEGER : now + RETRY_EVERY * patch.loginFails;
    if (giveUp) { patch.loginFails = MAX_LOGIN_FAILS; status = { status: 'error', syncing: false, error: LOGIN_MSG }; }
  } else {
    // send_failed / ea_failed / timeout are on our side, not the user's.
    patch.workerFails = (d.workerFails || 0) + 1;
    patch.dueAt = now + RETRY_EVERY * Math.min(patch.workerFails, 6);
    console.warn('[hosted]', jobId, result, 'x' + patch.workerFails, String(detail || '').slice(0, 200));
    if (!d.everSynced && patch.workerFails >= 3) {
      status = { status: 'error', syncing: false, error: 'We could not sync this account yet. We will keep retrying — no action needed.' };
    }
  }
  await r.update(patch);
  if (status) await mt5.setStatus(d.uid, status, d.accountKey);
  console.log(`[hosted] ${workerId} ${jobId.slice(0, 8)}… ${result} +${sent}${failed ? ' failed ' + failed : ''} in ${Math.round((Number(durationMs) || 0) / 1000)}s`);
  return { ok: true, nextDueAt: patch.dueAt };
}

module.exports = { configured, link, unlink, syncNow, isHosted, recheck, claim, report, nextDue, noteWeekendTrades, weekendCloseAt, encrypt, decrypt, COL };
