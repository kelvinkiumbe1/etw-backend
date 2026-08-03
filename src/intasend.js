// IntaSend — M-Pesa and cards, alongside Pesapal rather than replacing it.
//
// Configure with:
//   INTASEND_PUBLIC_KEY        publishable key
//   INTASEND_SECRET_KEY        secret key (server only)
//   INTASEND_ENV               'live' (default) or 'sandbox'
//   INTASEND_WEBHOOK_CHALLENGE the challenge string set on the dashboard webhook
//
// The flow deliberately matches Pesapal's so the app needs no new concepts:
//   createCheckout() -> hosted page URL -> user pays -> webhook + polling settle
//
// Field names follow IntaSend's documented Checkout and Status APIs. They are
// asserted here rather than verified, so every failure returns IntaSend's own
// response body — see /api/intasend/probe for a one-command check.
const LIVE = 'https://payment.intasend.com';
const SANDBOX = 'https://sandbox.intasend.com';

function env() {
  return String(process.env.INTASEND_ENV || 'live').toLowerCase() === 'sandbox' ? 'sandbox' : 'live';
}
function base() {
  return env() === 'sandbox' ? SANDBOX : LIVE;
}
function configured() {
  return !!(process.env.INTASEND_PUBLIC_KEY && process.env.INTASEND_SECRET_KEY);
}

// `auth` decides whether the secret key rides along as a Bearer token.
//
// The two endpoints authenticate DIFFERENTLY, and getting this wrong is not a
// silent no-op: /checkout/ is authenticated by the public_key in the body, and
// sending an Authorization header with it makes IntaSend answer
//   401 authentication_failed "Session expired"
// even though both keys are valid. /payment/status/ is the opposite — it needs
// the Bearer secret and ignores the body key.
async function call(path, body, auth) {
  if (!configured()) throw Object.assign(new Error('IntaSend is not configured'), { status: 503 });
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (auth) headers['Authorization'] = 'Bearer ' + process.env.INTASEND_SECRET_KEY;
  const r = await fetch(base() + path, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(Object.assign({ public_key: process.env.INTASEND_PUBLIC_KEY }, body)),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* keep the raw text for the error */ }
  if (!r.ok) {
    throw Object.assign(new Error('IntaSend ' + r.status + ': ' + text.slice(0, 300)), {
      status: r.status === 400 || r.status === 401 || r.status === 403 ? r.status : 502,
      upstream: json || text.slice(0, 300),
    });
  }
  if (!json) throw Object.assign(new Error('IntaSend returned non-JSON: ' + text.slice(0, 200)), { status: 502 });
  return json;
}

// Hosted checkout. `apiRef` is our own order id — it comes back on the webhook and
// on status lookups, which is how a payment is tied to a user.
async function createCheckout({ apiRef, amount, currency, email, firstName, lastName, phone, redirectUrl, comment }) {
  const out = await call('/api/v1/checkout/', {
    amount: Number(amount),
    currency: String(currency || 'KES').toUpperCase(),
    email: email || '',
    first_name: firstName || 'ETW',
    last_name: lastName || 'Trader',
    phone_number: phone || '',
    api_ref: apiRef,
    redirect_url: redirectUrl,
    comment: comment || '',
  }, false);   // public_key in the body is the credential here — no Bearer
  // IntaSend has used both `url` and `checkout_url` across versions; accept either
  // rather than breaking on a field rename.
  const url = out.url || out.checkout_url || null;
  const invoiceId = out.invoice_id || out.id || (out.invoice && out.invoice.invoice_id) || null;
  return { url, invoiceId, signature: out.signature || null, raw: out };
}

// COMPLETE is the only state that means paid. FAILED is terminal; PENDING,
// PROCESSING and RETRY all mean "not yet".
async function getStatus(invoiceId) {
  const out = await call('/api/v1/payment/status/', { invoice_id: invoiceId }, true);
  const inv = out.invoice || out;
  return {
    state: String(inv.state || inv.status || '').toUpperCase(),
    provider: inv.provider || null,
    value: inv.value != null ? Number(inv.value) : null,
    currency: inv.currency || null,
    apiRef: inv.api_ref || null,
    failedReason: inv.failed_reason || null,
    raw: out,
  };
}

function isPaid(state) {
  return String(state || '').toUpperCase() === 'COMPLETE';
}
function isFailed(state) {
  return String(state || '').toUpperCase() === 'FAILED';
}

// Dashboard webhooks carry the challenge string configured alongside them. Without
// a configured challenge we cannot authenticate the callback, so treat it as
// unverified and rely on the status lookup instead of trusting the payload.
function verifyChallenge(body) {
  const expected = process.env.INTASEND_WEBHOOK_CHALLENGE || '';
  if (!expected) return { ok: false, reason: 'no challenge configured' };
  const got = (body && (body.challenge || body.Challenge)) || '';
  return { ok: got === expected, reason: got ? 'mismatch' : 'missing' };
}

module.exports = { configured, env, base, createCheckout, getStatus, isPaid, isFailed, verifyChallenge };
