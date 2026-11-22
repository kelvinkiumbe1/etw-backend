// Gumroad — hosted checkout + memberships. Replaces Pesapal/IntaSend entirely.
//
// Configure with:
//   GUMROAD_ACCESS_TOKEN       OAuth application access token (Gumroad → Settings
//                              → Advanced → Applications → Generate access token)
//   GUMROAD_PRODUCT_ESSENTIAL  the Essential membership product — permalink,
//                              product id, or the full product URL; all accepted
//   GUMROAD_PRODUCT_PRO        same, for the Pro membership product
//   GUMROAD_PRODUCT_ULTRA      same, for the Ultra membership product (optional;
//                              plus GUMROAD_PRODUCT_ULTRA_QUARTERLY / _YEARLY)
//
// There is no server-side order creation: the pricing page links straight to the
// Gumroad product with ?uid=<firebase uid> attached, Gumroad runs the checkout,
// and its ping webhook hits /api/gumroad/ping. The ping itself is unauthenticated,
// so nothing in it is trusted — the sale is always re-fetched here with our
// access token, and only that verified copy decides who gets access to what.
const API = 'https://api.gumroad.com/v2';

// The access token is the only hard requirement: the auto-renewing membership
// products are built in below, so plan sales match even before any
// GUMROAD_PRODUCT_* variable is set.
function configured() {
  return !!process.env.GUMROAD_ACCESS_TOKEN;
}

// Accept a permalink ('etw-pro'), a product id, or a pasted URL
// ('https://name.gumroad.com/l/etw-pro?x=1') and normalise to the permalink/id.
function normalizeKey(v) {
  const s = String(v || '').trim();
  const m = s.match(/\/l\/([^/?#]+)/);
  return (m ? m[1] : s).toLowerCase();
}

// Product → plan/cycle mapping. The two monthly products are required; the
// yearly ones are optional extras (they are SEPARATE Gumroad products, since
// one product can't sell two cadences at two prices).
//
// AUTO-RENEWING MEMBERSHIPS: each plan/cycle is a Gumroad membership product
// (built in below — their permalinks are public, not secrets). Gumroad charges
// the saved card every period and pings us with a NEW sale for each charge, so
// every renewal lands here like a purchase and pushes the access end date on.
// Each env var may hold several products, comma-separated; whatever is in it
// (e.g. the older one-off plan products) keeps matching too, so refunds and the
// reconcile sweep still recognise sales made before the switch.
const PRODUCTS = [
  { env: 'GUMROAD_PRODUCT_ULTRA_YEARLY',        plan: 'ultra',     cycle: 'yearly',    builtin: ['woyvhw'] },
  { env: 'GUMROAD_PRODUCT_ULTRA_QUARTERLY',     plan: 'ultra',     cycle: 'quarterly', builtin: ['bjzbo'] },
  { env: 'GUMROAD_PRODUCT_ULTRA',               plan: 'ultra',     cycle: null,        builtin: ['avzke'] },
  { env: 'GUMROAD_PRODUCT_ESSENTIAL_YEARLY',    plan: 'essential', cycle: 'yearly',    builtin: ['zyzcrs'] },
  { env: 'GUMROAD_PRODUCT_PRO_YEARLY',          plan: 'pro',       cycle: 'yearly',    builtin: ['jnjatl'] },
  { env: 'GUMROAD_PRODUCT_ESSENTIAL_QUARTERLY', plan: 'essential', cycle: 'quarterly', builtin: ['fgwpe'] },
  { env: 'GUMROAD_PRODUCT_PRO_QUARTERLY',       plan: 'pro',       cycle: 'quarterly', builtin: ['bjooc'] },
  { env: 'GUMROAD_PRODUCT_ESSENTIAL',           plan: 'essential', cycle: null,        builtin: ['lnwmoi'] },
  { env: 'GUMROAD_PRODUCT_PRO',                 plan: 'pro',       cycle: null,        builtin: ['hqreye'] },
];
// Every product key (permalink or id) that sells this plan/cycle.
function productKeys(p) {
  return String(process.env[p.env] || '').split(',').map(normalizeKey).filter(Boolean)
    .concat((p.builtin || []).map(normalizeKey));
}

// ── Auto-Sync token packs ──────────────────────────────────────────────────
// These are NOT subscriptions: they buy a prepaid token balance that the sync
// meter draws down (see src/tokens.js). Kept in a separate map from PRODUCTS so
// a token purchase can never be mistaken for a plan grant — buying sync credit
// must not unlock the journal.
//
// Configure as GUMROAD_TOKEN_PRODUCTS="permalink:tokens,permalink:tokens"
//   e.g. GUMROAD_TOKEN_PRODUCTS=odqsfy:2500,olaaoaq:6500
// The token count here is AUTHORITATIVE — never derive it from the amount paid.
// Gumroad settles in the buyer's currency, so the same pack arrives as a
// different number depending on where they are.
function tokenProductMap() {
  const out = {};
  String(process.env.GUMROAD_TOKEN_PRODUCTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .forEach((pair) => {
      const i = pair.lastIndexOf(':');
      if (i < 1) return;
      const key = normalizeKey(pair.slice(0, i));
      const n = Number(pair.slice(i + 1).trim());
      if (key && Number.isFinite(n) && n > 0) out[key] = Math.trunc(n);
    });
  return out;
}

// Is this verified sale a token pack? Same id/permalink matching as matchSale.
// Returns { tokens } or null.
function matchTokenSale(sale) {
  const map = tokenProductMap();
  if (!Object.keys(map).length) return null;
  const keys = [sale.product_id, sale.product_permalink, sale.permalink]
    .filter(Boolean).map(normalizeKey);
  for (const k of keys) if (map[k]) return { tokens: map[k] };
  return null;
}

// Which plan/cycle does a verified sale belong to? Matched against BOTH the
// product id and the permalink, so either works in the env var. The cycle comes
// from the product itself when pinned (yearly products), otherwise from the
// VERIFIED sale's recurrence — a spoofed ping must not be able to stretch a
// monthly payment into a year of access. null = not one of ours.
function matchSale(sale) {
  const keys = [sale.product_id, sale.product_permalink, sale.permalink]
    .filter(Boolean).map(normalizeKey);
  for (const p of PRODUCTS) {
    if (!productKeys(p).some((k) => keys.includes(k))) continue;
    const r = String(sale.subscription_duration || sale.recurrence || '').toLowerCase();
    return { plan: p.plan, cycle: p.cycle || (r === 'yearly' ? 'yearly' : (r === 'quarterly' || r === 'every_3_months') ? 'quarterly' : 'monthly') };
  }
  return null;
}

// Fetch + verify a sale by id. Resolving under OUR access token is the proof of
// authenticity: a sale id that isn't ours (or doesn't exist) comes back as an
// error, so a forged ping dies here.
async function getSale(saleId) {
  if (!configured()) throw Object.assign(new Error('Gumroad is not configured'), { status: 503 });
  const r = await fetch(API + '/sales/' + encodeURIComponent(saleId)
    + '?access_token=' + encodeURIComponent(process.env.GUMROAD_ACCESS_TOKEN));
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* keep raw text for the error */ }
  if (!r.ok || !json || json.success !== true || !json.sale) {
    throw Object.assign(new Error('Gumroad ' + r.status + ': ' + text.slice(0, 300)), {
      status: r.status === 401 || r.status === 403 || r.status === 404 ? r.status : 502,
      upstream: json || text.slice(0, 300),
    });
  }
  return json.sale;
}

// A membership as Gumroad sees it right now: status (alive, pending_cancellation,
// pending_failure, failed_payment, cancelled, fixed_subscription_period_ended),
// cancelled_at / ended_at / failed_at, recurrence. Fetched under OUR token, so
// it is the authentic state — the cancellation/ended posts themselves are
// unauthenticated and are only ever used as a cue to come and look here.
async function getSubscriber(subscriptionId) {
  if (!configured()) throw Object.assign(new Error('Gumroad is not configured'), { status: 503 });
  const r = await fetch(API + '/subscribers/' + encodeURIComponent(subscriptionId)
    + '?access_token=' + encodeURIComponent(process.env.GUMROAD_ACCESS_TOKEN));
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* keep raw text for the error */ }
  if (!r.ok || !json || json.success !== true || !json.subscriber) {
    throw Object.assign(new Error('Gumroad subscriber ' + r.status + ': ' + text.slice(0, 200)), { status: r.status || 502 });
  }
  return json.subscriber;
}

// Refunds, disputes and the membership lifecycle (cancelled, ended, restarted,
// tier/plan changed) are NOT covered by the Settings → Ping URL (that only
// fires on sales — including every automatic renewal charge); they arrive via
// the Resource Subscriptions API, registered programmatically. Called once at
// boot — idempotent: an existing registration for the same resource + post_url
// is left alone.
const RESOURCES = ['refund', 'dispute', 'cancellation', 'subscription_ended', 'subscription_restarted', 'subscription_updated'];
async function ensureResourceSubscriptions(postUrl) {
  const token = process.env.GUMROAD_ACCESS_TOKEN;
  const out = {};
  for (const name of RESOURCES) {
    try {
      const list = await fetch(API + '/resource_subscriptions?resource_name=' + name
        + '&access_token=' + encodeURIComponent(token));
      const lj = await list.json().catch(() => null);
      const subs = (lj && lj.resource_subscriptions) || [];
      if (subs.some((s) => s && s.post_url === postUrl)) { out[name] = 'exists'; continue; }
      const r = await fetch(API + '/resource_subscriptions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: token, resource_name: name, post_url: postUrl }),
      });
      const j = await r.json().catch(() => null);
      out[name] = (j && j.success === true) ? 'registered' : ('failed: ' + (r.status || '?'));
    } catch (e) { out[name] = 'failed: ' + e.message; }
  }
  return out;
}

// What refund/dispute hooks are actually registered on Gumroad's side right
// now. Diagnostic only — /api/admin/gumroad-probe surfaces this.
async function listResourceSubscriptions() {
  const token = process.env.GUMROAD_ACCESS_TOKEN;
  const out = {};
  for (const name of RESOURCES) {
    const r = await fetch(API + '/resource_subscriptions?resource_name=' + name
      + '&access_token=' + encodeURIComponent(token));
    const j = await r.json().catch(() => null);
    out[name] = ((j && j.resource_subscriptions) || []).map((s) => ({ id: s.id, post_url: s.post_url }));
  }
  return out;
}

// Sales from the last N days, for the reconciliation sweep. Pages through the
// Sales API (capped defensively — a sweep never needs more than a few pages).
async function recentSales(days) {
  const token = process.env.GUMROAD_ACCESS_TOKEN;
  const after = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let url = API + '/sales?after=' + after + '&access_token=' + encodeURIComponent(token);
  const sales = [];
  for (let page = 0; page < 10 && url; page++) {
    const r = await fetch(url);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.success !== true) break;
    sales.push(...(j.sales || []));
    url = j.next_page_url ? 'https://api.gumroad.com' + j.next_page_url : null;
    if (url && url.indexOf('access_token=') === -1) url += '&access_token=' + encodeURIComponent(token);
  }
  return sales;
}

module.exports = { configured, matchSale, matchTokenSale, tokenProductMap, getSale, getSubscriber, normalizeKey, ensureResourceSubscriptions, listResourceSubscriptions, recentSales };
