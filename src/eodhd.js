// EOD Historical Data (eodhd.com) — used for instruments Twelve Data doesn't
// carry, principally the US indices. Their catalogue has no Dow / S&P 500 /
// Nasdaq 100 at all, so those previously had to be charted via ETF proxies.
//
// Configure with EODHD_API_KEY. Until it is set, configured() is false and
// callers fall back to whatever they used before.
//
// Two endpoints are involved:
//   intraday  /api/intraday/{SYM}?interval=1m|5m|1h&from=<unix>&to=<unix>
//   daily     /api/eod/{SYM}?period=d&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// EODHD only serves 1m, 5m and 1h intraday. 15m and 4h are therefore aggregated
// here from 5m and 1h rather than being silently unavailable.
const BASE = 'https://eodhd.com/api';

function configured() {
  return !!process.env.EODHD_API_KEY;
}

// What we ask EODHD for, and how many of those bars make one output bar.
const PLAN = {
  '1m':  { native: '1m', group: 1 },
  '5m':  { native: '5m', group: 1 },
  '15m': { native: '5m', group: 3 },
  '30m': { native: '5m', group: 6 },
  '1h':  { native: '1h', group: 1 },
  '2h':  { native: '1h', group: 2 },
  '4h':  { native: '1h', group: 4 },
  '1d':  { native: '1d', group: 1 },
};

const SECONDS = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400,
};

function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Calendar-aligned OHLCV rollup: bucket by floor(time / step) so a 4h bar always
// starts on a 4h boundary rather than wherever the response happened to begin.
function aggregate(bars, stepSec) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.time / stepSec) * stepSec;
    if (!cur || cur.time !== bucket) {
      if (cur) out.push(cur);
      cur = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
    } else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume += (b.volume || 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// Rows with a null OHLC are holidays/halts in EODHD's daily series — dropping
// them keeps the chart from showing flat-zero candles.
function normalise(rows, isDaily) {
  const out = [];
  for (const r of (rows || [])) {
    const o = num(r.open), h = num(r.high), l = num(r.low), c = num(r.close);
    if (o == null || h == null || l == null || c == null) continue;
    let t;
    if (isDaily) {
      t = Math.floor(Date.parse(String(r.date) + 'T00:00:00Z') / 1000);
    } else {
      t = num(r.timestamp);
      if (t == null && r.datetime) t = Math.floor(Date.parse(String(r.datetime).replace(' ', 'T') + 'Z') / 1000);
    }
    if (t == null || !isFinite(t)) continue;
    out.push({ time: t, open: o, high: h, low: l, close: c, volume: num(r.volume) || 0 });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// Throws an Error carrying EODHD's own status and body, so a bad symbol or an
// out-of-plan interval is reported rather than swallowed.
// A free EODHD plan rejects every intraday request with 403 'Only EOD data
// allowed'. Without this, each chart load pays a doomed round-trip before falling
// back. Remembering the refusal for a while skips that, and because it expires the
// moment the window passes, upgrading the plan starts working on its own.
let _noIntradayUntil = 0;
const NO_INTRADAY_MS = 6 * 3600 * 1000;

async function getCandles({ symbol, interval, from, to }) {
  if (!configured()) throw Object.assign(new Error('EODHD_API_KEY is not set'), { status: 503 });
  const sym = String(symbol || '').trim();
  if (!sym) throw Object.assign(new Error('symbol is required'), { status: 400 });

  const plan = PLAN[interval];
  if (!plan) {
    throw Object.assign(new Error('unsupported interval "' + interval + '" (use ' + Object.keys(PLAN).join(', ') + ')'), { status: 400 });
  }

  const key = process.env.EODHD_API_KEY;
  const isDaily = plan.native === '1d';
  if (!isDaily && Date.now() < _noIntradayUntil) {
    throw Object.assign(new Error('EODHD plan is end-of-day only (intraday refused recently)'), { status: 403 });
  }
  let url;
  if (isDaily) {
    url = BASE + '/eod/' + encodeURIComponent(sym) + '?period=d&fmt=json&api_token=' + encodeURIComponent(key);
    if (from) url += '&from=' + ymd(Number(from));
    if (to) url += '&to=' + ymd(Number(to));
  } else {
    url = BASE + '/intraday/' + encodeURIComponent(sym) + '?interval=' + plan.native + '&fmt=json&api_token=' + encodeURIComponent(key);
    if (from) url += '&from=' + Math.floor(Number(from) / 1000);
    if (to) url += '&to=' + Math.floor(Number(to) / 1000);
  }

  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) {
    // Never echo the URL back — it carries the API key.
    if (r.status === 403 && !isDaily && /only eod/i.test(text)) {
      _noIntradayUntil = Date.now() + NO_INTRADAY_MS;
      console.warn('[eodhd] plan is EOD-only; skipping intraday requests for 6h');
    }
    throw Object.assign(new Error('EODHD ' + r.status + ': ' + text.slice(0, 200)), { status: r.status === 403 || r.status === 404 ? r.status : 502 });
  }
  let rows;
  try { rows = JSON.parse(text); }
  catch (e) { throw Object.assign(new Error('EODHD returned non-JSON: ' + text.slice(0, 200)), { status: 502 }); }
  if (!Array.isArray(rows)) {
    throw Object.assign(new Error('EODHD returned ' + JSON.stringify(rows).slice(0, 200)), { status: 502 });
  }

  let candles = normalise(rows, isDaily);
  if (plan.group > 1) candles = aggregate(candles, SECONDS[interval]);

  return {
    candles,
    meta: {
      symbol: sym,
      interval,
      nativeInterval: plan.native,
      aggregatedFrom: plan.group > 1 ? plan.native : null,
      count: candles.length,
    },
  };
}

// Symbol lookup, so index codes can be confirmed without guessing.
async function search(q) {
  if (!configured()) throw Object.assign(new Error('EODHD_API_KEY is not set'), { status: 503 });
  const url = BASE + '/search/' + encodeURIComponent(String(q || '').trim())
    + '?fmt=json&limit=30&api_token=' + encodeURIComponent(process.env.EODHD_API_KEY);
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error('EODHD ' + r.status + ': ' + text.slice(0, 200)), { status: 502 });
  try { return JSON.parse(text); }
  catch (e) { throw Object.assign(new Error('EODHD returned non-JSON: ' + text.slice(0, 200)), { status: 502 }); }
}

// True while this plan has recently refused intraday. Charts use it to avoid
// serving daily EODHD bars for an instrument whose intraday bars come from a
// different source — one session must have one price scale, or drawings and
// saved entry prices stop matching the chart.
function intradayBlocked() { return Date.now() < _noIntradayUntil; }

module.exports = { configured, getCandles, search, PLAN, intradayBlocked };
