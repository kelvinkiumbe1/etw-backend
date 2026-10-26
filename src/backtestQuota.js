// Server-enforced backtesting allowance + Ultra cloud backup.
//
//   Essential : no backtesting
//   Pro       : 3 sessions created per billing cycle (deletes never give a slot back)
//   Ultra     : unlimited sessions, and the whole backtesting workspace is
//               backed up to the server so it survives cleared browsers,
//               new devices and reinstalls
//
// The counter lives in Firestore under users/{uid}.btQuota and is only ever
// mutated here via the Admin SDK — a user cannot reset it by clearing
// browser storage. The backup lives in btBackups/{uid} (+ /chunks), which
// the security rules do not expose to clients at all.
//
// Mount from server.js:
//   require('./src/backtestQuota').mount(app, requireAuth, db, access, planFor);
// planFor(req) -> 'essential' | 'pro' | 'ultra' | null (no active plan).
const zlib = require('zlib');

const PLAN_LIMITS = { essential: 0, pro: 3, ultra: Infinity };
const CHUNK = 900000;            // chars per Firestore doc (1 MiB hard limit)
const MAX_CHUNKS = 24;           // ~21 MB of compressed backup
const PLAN_NAME = { essential: 'Essential', pro: 'Pro', ultra: 'Ultra' };

// Billing-cycle key, anchored to the day-of-month the plan's expiresAt
// falls on (paid on the 15th → resets on the 15th).
function cycleKeyFor(uid, expiresAt) {
  const now = new Date();
  let cycleMonth, cycleYear;
  if (expiresAt) {
    const exp = new Date(Number(expiresAt));
    const anchorDay = new Date(exp.getTime() - 30 * 24 * 3600 * 1000).getDate();
    if (now.getDate() >= anchorDay) { cycleMonth = now.getMonth(); cycleYear = now.getFullYear(); }
    else { const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1); cycleMonth = prev.getMonth(); cycleYear = prev.getFullYear(); }
  } else { cycleMonth = now.getMonth(); cycleYear = now.getFullYear(); }
  return `${uid}:${cycleYear}:${cycleMonth}`;
}

function resetLabelFor(expiresAt) {
  const now = new Date();
  if (!expiresAt) return new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return new Date(Number(expiresAt)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function mount(app, requireAuth, db, access, planFor) {
  // Resolve the plan the same way every other gated route does.
  async function resolve(req) {
    const a = await access.accessFor(req.uid, req.token);
    let plan = planFor ? await planFor(req) : null;
    if (!plan) plan = a && a.active ? (String(a.plan || '').toLowerCase() === 'ultra' ? 'ultra' : access.isPro(a) ? 'pro' : 'essential') : null;
    return { a, plan, expiresAt: (a && a.expiresAt) || (req.token && req.token.expiresAt) || null };
  }
  function noAccess(res, plan) {
    if (!plan) return res.status(402).json({ ok: false, error: 'A subscription is required to use backtesting.', code: 'subscription_required' });
    return res.status(402).json({ ok: false, plan, code: 'pro_required',
      error: 'Backtesting is on the Pro plan (3 sessions a month) and unlimited on Ultra.' });
  }

  // GET /api/backtest/quota — read-only status for the badge.
  app.get('/api/backtest/quota', requireAuth, async (req, res) => {
    try {
      const { plan, expiresAt } = await resolve(req);
      if (!plan || plan === 'essential') return noAccess(res, plan);
      if (plan === 'ultra') return res.json({ ok: true, plan, unlimited: true, limit: null, used: 0, remaining: null, resetLabel: '', cloudBackup: true });
      const limit = PLAN_LIMITS[plan];
      const ck = cycleKeyFor(req.uid, expiresAt);
      const snap = await db.collection('users').doc(req.uid).get();
      const quota = (snap.exists && snap.data().btQuota) || {};
      const used = quota.cycleKey === ck ? (quota.used || 0) : 0;
      res.json({ ok: true, plan, limit, used, remaining: Math.max(0, limit - used), resetLabel: resetLabelFor(expiresAt) });
    } catch (e) {
      console.error('backtest/quota:', e.message);
      res.status(500).json({ ok: false, error: 'Quota lookup failed.' });
    }
  });

  // POST /api/backtest/session — atomic check-and-increment, called BEFORE
  // the session is created locally.
  app.post('/api/backtest/session', requireAuth, async (req, res) => {
    const uid = req.uid;
    try {
      const { plan, expiresAt } = await resolve(req);
      if (!plan || plan === 'essential') return noAccess(res, plan);
      if (plan === 'ultra') return res.json({ ok: true, plan, unlimited: true, limit: null, used: 0, remaining: null, resetLabel: '', cloudBackup: true });
      const limit = PLAN_LIMITS[plan];
      const ck = cycleKeyFor(uid, expiresAt);
      const userRef = db.collection('users').doc(uid);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const quota = (snap.exists && snap.data().btQuota) || {};
        const used = quota.cycleKey === ck ? (quota.used || 0) : 0;
        if (used >= limit) return { allowed: false, used };
        tx.set(userRef, { btQuota: { cycleKey: ck, used: used + 1 } }, { merge: true });
        return { allowed: true, used: used + 1 };
      });
      const resetLabel = resetLabelFor(expiresAt);
      if (!result.allowed) {
        return res.status(403).json({ ok: false, error: 'quota_exceeded', plan, limit, used: result.used, resetLabel,
          message: `Your ${PLAN_NAME[plan]} plan includes ${limit} backtesting sessions a month. Upgrade to Ultra for unlimited sessions.` });
      }
      res.json({ ok: true, plan, limit, used: result.used, remaining: Math.max(0, limit - result.used), resetLabel });
    } catch (e) {
      console.error('backtest/session:', e.message);
      res.status(500).json({ ok: false, error: 'Quota check failed.' });
    }
  });

  // ── Ultra: cloud backup of the backtesting workspace ─────────────────
  // The client sends { savedAt, hash, data: { <localStorage key>: <string> } }.
  // It is gzipped and split into chunks. Backtesting is shared by every
  // independent account of a login, so the backup is keyed by the login uid.
  const backupRef = (uid) => db.collection('btBackups').doc(uid);

  app.get('/api/backtest/backup', requireAuth, async (req, res) => {
    try {
      const { plan } = await resolve(req);
      if (plan !== 'ultra') return res.status(402).json({ ok: false, code: 'ultra_required', error: 'Cloud backup of backtesting sessions is part of Ultra.' });
      const head = await backupRef(req.uid).get();
      if (!head.exists) return res.json({ ok: true, empty: true });
      const h = head.data();
      if (req.query.meta === '1') return res.json({ ok: true, savedAt: h.savedAt, hash: h.hash, bytes: h.bytes, sessions: h.sessions });
      const chunks = await backupRef(req.uid).collection('chunks').get();
      const parts = chunks.docs.filter((d) => d.data().v === h.version).sort((x, y) => x.data().i - y.data().i).map((d) => d.data().s);
      if (parts.length !== h.chunks) return res.json({ ok: true, empty: true, partial: true });
      const json = zlib.gunzipSync(Buffer.from(parts.join(''), 'base64')).toString('utf8');
      res.json({ ok: true, savedAt: h.savedAt, hash: h.hash, data: JSON.parse(json) });
    } catch (e) {
      console.error('backtest/backup get:', e.message);
      res.status(500).json({ ok: false, error: 'Could not load the backup.' });
    }
  });

  app.put('/api/backtest/backup', requireAuth, async (req, res) => {
    try {
      const { plan } = await resolve(req);
      if (plan !== 'ultra') return res.status(402).json({ ok: false, code: 'ultra_required', error: 'Cloud backup of backtesting sessions is part of Ultra.' });
      const body = req.body || {};
      const data = body.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ ok: false, error: 'data required' });
      const clean = {};
      Object.keys(data).forEach((k) => { if (/^etw[-_]b(acktest|t)[-_a-z0-9:]*$/i.test(k) && typeof data[k] === 'string') clean[k] = data[k]; });
      const b64 = zlib.gzipSync(Buffer.from(JSON.stringify(clean), 'utf8'), { level: 9 }).toString('base64');
      const n = Math.ceil(b64.length / CHUNK);
      if (n > MAX_CHUNKS) return res.status(413).json({ ok: false, error: 'Your backtesting data is too large to back up.' });
      let sessions = 0;
      try { sessions = (JSON.parse(clean['etw-backtest-v2'] || '[]') || []).length; } catch (e) {}
      const version = Date.now().toString(36);
      const col = backupRef(req.uid).collection('chunks');
      // Write the new chunks first, then flip the head to them, then drop the
      // old ones — a crash part-way never leaves a half-written backup live.
      for (let i = 0; i < n; i++) await col.doc(version + '_' + i).set({ v: version, i, s: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
      const savedAt = Number(body.savedAt) || Date.now();
      await backupRef(req.uid).set({ version, chunks: n, savedAt, hash: String(body.hash || '').slice(0, 64), bytes: b64.length, sessions, updatedAt: Date.now() });
      const old = await col.get();
      await Promise.all(old.docs.filter((d) => d.data().v !== version).map((d) => d.ref.delete()));
      res.json({ ok: true, savedAt, sessions, bytes: b64.length });
    } catch (e) {
      console.error('backtest/backup put:', e.message);
      res.status(500).json({ ok: false, error: 'Backup failed.' });
    }
  });
}

module.exports = { mount, PLAN_LIMITS };
