// Server-enforced backtest session creation quota.
//
// Mirrors the client-side logic that already lived in bt-sessions.html
// (localStorage-only), but the counter now lives in Firestore under
// users/{uid}.btQuota and is only ever mutated here via the Admin SDK — a
// user can no longer reset it by clearing browser storage.
//
// Reuses access.accessFor() so plan/expiresAt/active resolve exactly the
// same way they do for every other gated route (requireSub, requirePro,
// /api/subscribe/me) — no second source of truth for subscription state.
//
// Mount from server.js, same style as mentorship:
//   require('./src/backtestQuota').mount(app, requireAuth, db, access);

const PLAN_LIMITS = { essential: 3, pro: 10 };

// Billing-cycle key, anchored to the day-of-month the plan's expiresAt
// falls on (so paid-on-the-15th resets on the 15th, not the calendar
// month boundary). expiresAt is the same ms-epoch number used everywhere
// else in this codebase (custom claims, subscription.expiresAt) — never a
// Firestore Timestamp — so no .toDate() conversion is needed.
function cycleKeyFor(uid, expiresAt) {
  const now = new Date();
  let cycleMonth, cycleYear;

  if (expiresAt) {
    const exp = new Date(Number(expiresAt));
    const cycleStart = new Date(exp.getTime() - 30 * 24 * 3600 * 1000);
    const anchorDay = cycleStart.getDate();

    if (now.getDate() >= anchorDay) {
      cycleMonth = now.getMonth();
      cycleYear = now.getFullYear();
    } else {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      cycleMonth = prev.getMonth();
      cycleYear = prev.getFullYear();
    }
  } else {
    cycleMonth = now.getMonth();
    cycleYear = now.getFullYear();
  }

  return `${uid}:${cycleYear}:${cycleMonth}`;
}

function resetLabelFor(expiresAt) {
  const now = new Date();
  if (!expiresAt) {
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return next.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  return new Date(Number(expiresAt)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function mount(app, requireAuth, db, access) {
  // GET /api/backtest/quota — read-only status, for painting the badge
  // without spending a create attempt.
  app.get('/api/backtest/quota', requireAuth, async (req, res) => {
    try {
      const a = await access.accessFor(req.uid, req.token);
      if (!a.active) return res.status(402).json({ error: 'A subscription is required to use backtesting.', code: 'subscription_required' });

      const plan = access.isPro(a) ? 'pro' : 'essential';
      const limit = PLAN_LIMITS[plan];
      const ck = cycleKeyFor(req.uid, a.expiresAt);

      const snap = await db.collection('users').doc(req.uid).get();
      const quota = (snap.exists && snap.data().btQuota) || {};
      const used = quota.cycleKey === ck ? (quota.used || 0) : 0;

      res.json({
        ok: true, plan, limit, used,
        remaining: Math.max(0, limit - used),
        resetLabel: resetLabelFor(a.expiresAt),
      });
    } catch (e) {
      console.error('backtest/quota:', e.message);
      res.status(500).json({ ok: false, error: 'Quota lookup failed.' });
    }
  });

  // POST /api/backtest/session — atomic check-and-increment. The frontend
  // calls this BEFORE creating the session locally, and only proceeds if
  // it comes back { ok: true }. Deletes never decrement — the slot is
  // consumed for the cycle the moment it's created, same rule the client
  // version already enforced.
  app.post('/api/backtest/session', requireAuth, async (req, res) => {
    const uid = req.uid;
    const userRef = db.collection('users').doc(uid);

    try {
      const a = await access.accessFor(uid, req.token);
      if (!a.active) return res.status(402).json({ error: 'A subscription is required to use backtesting.', code: 'subscription_required' });

      const plan = access.isPro(a) ? 'pro' : 'essential';
      const limit = PLAN_LIMITS[plan];
      const ck = cycleKeyFor(uid, a.expiresAt);

      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const quota = (snap.exists && snap.data().btQuota) || {};
        const used = quota.cycleKey === ck ? (quota.used || 0) : 0;

        if (used >= limit) return { allowed: false, used };

        tx.set(userRef, { btQuota: { cycleKey: ck, used: used + 1 } }, { merge: true });
        return { allowed: true, used: used + 1 };
      });

      const resetLabel = resetLabelFor(a.expiresAt);

      if (!result.allowed) {
        return res.status(403).json({
          ok: false, error: 'quota_exceeded',
          plan, limit, used: result.used, resetLabel,
        });
      }

      res.json({
        ok: true, plan, limit, used: result.used,
        remaining: Math.max(0, limit - result.used), resetLabel,
      });
    } catch (e) {
      console.error('backtest/session:', e.message);
      res.status(500).json({ ok: false, error: 'Quota check failed.' });
    }
  });
}

module.exports = { mount };
