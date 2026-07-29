// ── Pesapal API v3 client ──────────────────────────────────────────────
// Server-side only. This is the ONLY place a payment is verified, so the
// browser can never grant itself access. Reads credentials from env:
//   PESAPAL_CONSUMER_KEY, PESAPAL_CONSUMER_SECRET, PESAPAL_ENV (sandbox|live)

const BASES = {
  sandbox: 'https://cybqa.pesapal.com/pesapalv3',
  live:    'https://pay.pesapal.com/v3',
};

function baseUrl() {
  const env = String(process.env.PESAPAL_ENV || 'live').toLowerCase();
  return env === 'sandbox' ? BASES.sandbox : BASES.live;
}

function configured() {
  return !!(process.env.PESAPAL_CONSUMER_KEY && process.env.PESAPAL_CONSUMER_SECRET);
}

// Auth tokens are valid ~5 min; cache and refresh a little early.
let _token = { value: null, exp: 0 };
async function authToken() {
  if (_token.value && Date.now() < _token.exp) return _token.value;
  const r = await fetch(baseUrl() + '/api/Auth/RequestToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      consumer_key: process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.token) throw new Error('Pesapal auth failed: ' + ((d.error && d.error.message) || d.message || JSON.stringify(d)));
  _token = { value: d.token, exp: Date.now() + 4 * 60 * 1000 };
  return _token.value;
}

async function api(path, body, method = 'POST') {
  const token = await authToken();
  const r = await fetch(baseUrl() + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({}));
}

// Register an IPN URL once and cache its id in Firestore (config/pesapal).
// The cache is keyed by URL *and* by which merchant registered it: IPN ids are
// account-scoped, so after swapping PESAPAL_CONSUMER_KEY a cached id from the
// previous merchant would be silently reused and SubmitOrder would reject every
// order with an invalid notification_id. Fingerprint (not the key itself) so the
// credential never lands in Firestore.
function keyFingerprint() {
  return require('crypto').createHash('sha256')
    .update(String(process.env.PESAPAL_CONSUMER_KEY || '')).digest('hex').slice(0, 16);
}

async function ensureIpnId(db, ipnUrl) {
  const ref = db.collection('config').doc('pesapal');
  const snap = await ref.get();
  const saved = snap.exists ? snap.data() : {};
  const fp = keyFingerprint();
  const envName = String(process.env.PESAPAL_ENV || 'live').toLowerCase();
  if (saved.ipnId && saved.ipnUrl === ipnUrl && saved.keyFp === fp && saved.env === envName) return saved.ipnId;
  const d = await api('/api/URLSetup/RegisterIPN', { url: ipnUrl, ipn_notification_type: 'GET' });
  if (!d.ipn_id) throw new Error('Pesapal RegisterIPN failed: ' + JSON.stringify(d));
  await ref.set({ ipnId: d.ipn_id, ipnUrl, keyFp: fp, env: envName, registeredAt: Date.now() }, { merge: true });
  console.log('[pesapal] registered IPN', d.ipn_id, 'for', ipnUrl, '(' + envName + ')');
  return d.ipn_id;
}

// Returns { order_tracking_id, merchant_reference, redirect_url, error, status }
async function submitOrder({ id, amount, currency, description, callbackUrl, notificationId, email, firstName, lastName, phone }) {
  return api('/api/Transactions/SubmitOrderRequest', {
    id,
    currency,
    amount,
    description,
    callback_url: callbackUrl,
    notification_id: notificationId,
    billing_address: {
      email_address: email || '',
      phone_number: phone || '',
      first_name: firstName || '',
      last_name: lastName || '',
    },
  });
}

// Returns { payment_status_description, status_code, amount, currency, payment_method, ... }
//   status_code: 0 INVALID, 1 COMPLETED, 2 FAILED, 3 REVERSED
async function getStatus(orderTrackingId) {
  return api('/api/Transactions/GetTransactionStatus?orderTrackingId=' + encodeURIComponent(orderTrackingId), null, 'GET');
}

module.exports = { configured, baseUrl, ensureIpnId, submitOrder, getStatus };
