// Gumroad — hosted checkout + memberships. Replaces Pesapal/IntaSend entirely.
//
// Configure with:
//   GUMROAD_ACCESS_TOKEN       OAuth application access token (Gumroad → Settings
//                              → Advanced → Applications → Generate access token)
//   GUMROAD_PRODUCT_ESSENTIAL  the Essential membership product — permalink,
//                              product id, or the full product URL; all accepted
//   GUMROAD_PRODUCT_PRO        same, for the Pro membership product
//
// There is no server-side order creation: the pricing page links straight to the
// Gumroad product with ?uid=<firebase uid> attached, Gumroad runs the checkout,
// and its ping webhook hits /api/gumroad/ping. The ping itself is unauthenticated,
// so nothing in it is trusted — the sale is always re-fetched here with our
// access token, and only that verified copy decides who gets access to what.
const API = 'https://api.gumroad.com/v2';

function configured() {
  return !!(process.env.GUMROAD_ACCESS_TOKEN
    && process.env.GUMROAD_PRODUCT_ESSENTIAL
    && process.env.GUMROAD_PRODUCT_PRO);
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
const PRODUCTS = [
  { env: 'GUMROAD_PRODUCT_ESSENTIAL_YEARLY', plan: 'essential', cycle: 'yearly' },
  { env: 'GUMROAD_PRODUCT_PRO_YEARLY',       plan: 'pro',       cycle: 'yearly' },
  { env: 'GUMROAD_PRODUCT_ESSENTIAL',        plan: 'essential', cycle: null },
  { env: 'GUMROAD_PRODUCT_PRO',              plan: 'pro',       cycle: null },
];

// Which plan/cycle does a verified sale belong to? Matched against BOTH the
// product id and the permalink, so either works in the env var. The cycle comes
// from the product itself when pinned (yearly products), otherwise from the
// VERIFIED sale's recurrence — a spoofed ping must not be able to stretch a
// monthly payment into a year of access. null = not one of ours.
function matchSale(sale) {
  const keys = [sale.product_id, sale.product_permalink, sale.permalink]
    .filter(Boolean).map(normalizeKey);
  for (const p of PRODUCTS) {
    const want = normalizeKey(process.env[p.env]);
    if (!want || !keys.includes(want)) continue;
    const r = String(sale.subscription_duration || sale.recurrence || '').toLowerCase();
    return { plan: p.plan, cycle: p.cycle || (r === 'yearly' ? 'yearly' : 'monthly') };
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

// Refund/dispute notifications are NOT covered by the Settings → Ping URL
// (that only fires on sales); they arrive via the Resource Subscriptions API,
// registered programmatically. Called once at boot — idempotent: an existing
// registration for the same resource + post_url is left alone.
async function ensureResourceSubscriptions(postUrl) {
  const token = process.env.GUMROAD_ACCESS_TOKEN;
  const out = {};
  for (const name of ['refund', 'dispute']) {
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

module.exports = { configured, matchSale, getSale, normalizeKey, ensureResourceSubscriptions };
