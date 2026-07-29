// Single source of truth for "does this uid have paid access, and at what tier?"
//
// Access is decided ONLY by the Firebase custom claim written by
// grantSubscription() in server.js ({ subscribed, plan, expiresAt }). The client
// never gets a say — a pirated frontend can copy our HTML but it cannot mint a
// claim, so every gated route stays shut for it.
const { admin } = require('./firebaseAdmin');

// Free-forever accounts (owner / test). Override via env COMP_EMAILS=a@b,c@d.
const COMP_EMAILS = String(process.env.COMP_EMAILS || 'kelvinkiumbe589@gmail.com,ethereumwizard67@gmail.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isComp = (emailAddr) => !!emailAddr && COMP_EMAILS.includes(String(emailAddr).toLowerCase());

const claimActive = (c) => !!c && c.subscribed === true && (!c.expiresAt || Date.now() < Number(c.expiresAt));

// Resolve access for a uid. `tokenClaims` (the already-verified ID token) is the
// fast path — no extra Firebase round-trip. But an ID token can be up to an hour
// stale, so when it looks inactive we re-read the user record before rejecting:
// somebody who paid 30 seconds ago must not be bounced by their cached token.
async function accessFor(uid, tokenClaims) {
  if (claimActive(tokenClaims)) {
    return { active: true, plan: tokenClaims.plan || 'essential', expiresAt: tokenClaims.expiresAt || null };
  }
  const user = await admin.auth().getUser(uid);
  if (isComp(user.email)) return { active: true, plan: 'pro', comp: true };
  const c = user.customClaims || {};
  return { active: claimActive(c), plan: c.plan || null, expiresAt: c.expiresAt || null };
}

const isPro = (a) => !!a && a.active === true && a.plan === 'pro';

// Throwing variant for non-Express callers (e.g. the EA push path, which is
// authed by an X-ETW-Key header rather than a Firebase token).
async function assertAccess(uid, { pro = false } = {}) {
  const a = await accessFor(uid, null);
  if (!a.active) { const e = new Error('A subscription is required.'); e.status = 402; e.code = 'subscription_required'; throw e; }
  if (pro && !isPro(a)) { const e = new Error('This feature is on the Pro plan.'); e.status = 402; e.code = 'pro_required'; throw e; }
  return a;
}

module.exports = { accessFor, assertAccess, isComp, isPro, claimActive, COMP_EMAILS };
