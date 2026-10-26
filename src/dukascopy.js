// Dukascopy historical candles — used for NDX100 (Nasdaq 100 CFD) in
// Backtesting and Trade Replay. Free and keyless, minute data back to ~2013,
// and it is the CFD price brokers quote, so trades line up with the chart.
// (Owner decision 2026-10-26; their terms are written for personal use, so
// this module is the one place to swap the source if that ever matters.)
//
// Dukascopy serves LZMA-compressed binary files of fixed 24-byte records
// (int32 time offset in seconds, open, close, low, high as int32 price x scale,
// float32 volume), one file per period, from three granularities:
//   minute  {CODE}/{YYYY}/{MM}/{DD}/BID_candles_min_1.bi5   (offsets from the day)
//   hour    {CODE}/{YYYY}/{MM}/BID_candles_hour_1.bi5       (offsets from the month)
//   day     {CODE}/{YYYY}/BID_candles_day_1.bi5             (offsets from the year)
// MM is zero-based (January = 00). A finished period never changes, so parsed
// files are cached for a long time; the current one only briefly.
const LZMA = require('lzma-purejs-requirejs');

const BASE = 'https://datafeed.dukascopy.com/datafeed';

// Our symbol names -> Dukascopy instrument. Prices are int32 x scale.
const NDX = { code: 'USATECHIDXUSD', scale: 1000, name: 'Nasdaq 100 CFD' };
const INSTRUMENTS = {
  NDX, NDX100: NDX, NAS100: NDX, US100: NDX, USTEC: NDX, NAS: NDX, NASDAQ: NDX, NASDAQ100: NDX, USTECH: NDX,
};

function instrumentFor(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return INSTRUMENTS[s] || null;
}

// interval -> which files to read, the output bar size, and the most history
// one request may cover (keeps a response to roughly 20k bars).
const DAY = 86400;
const PLAN = {
  '1m':  { file: 'minute', step: 60,        maxDays: 14 },
  '5m':  { file: 'minute', step: 300,       maxDays: 62 },
  '15m': { file: 'minute', step: 900,       maxDays: 186 },
  '30m': { file: 'minute', step: 1800,      maxDays: 366 },
  '1h':  { file: 'hour',   step: 3600,      maxDays: 3 * 366 },
  '4h':  { file: 'hour',   step: 4 * 3600,  maxDays: 10 * 366 },
  '1d':  { file: 'day',    step: DAY,       maxDays: 40 * 366 },
  '1w':  { file: 'day',    step: 7 * DAY,   maxDays: 40 * 366 },
};

// ── File cache ─────────────────────────────────────────────────────────────
const cache = new Map();                 // url -> { bars, until }
const MAX_FILES = 400;                   // a minute file is ~1440 bars
function cacheGet(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (hit.until < Date.now()) { cache.delete(url); return null; }
  cache.delete(url); cache.set(url, hit); // most recently used last
  return hit.bars;
}
function cacheSet(url, bars, ttlMs) {
  cache.set(url, { bars, until: Date.now() + ttlMs });
  while (cache.size > MAX_FILES) cache.delete(cache.keys().next().value);
}

async function fetchFile(url) {
  // Dukascopy's CDN times out now and then, and answers 503 when asked for
  // many files at once; a retry after a pause almost always works.
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (ETW Journal)' } });
      if (r.status === 404) return null;                    // no data for that period
      if (!r.ok) throw new Error('Dukascopy HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length ? buf : null;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function parse(buf, baseSec, scale) {
  const raw = Buffer.from(LZMA.decompressFile(buf));
  const bars = [];
  for (let i = 0; i + 24 <= raw.length; i += 24) {
    const volume = raw.readFloatBE(i + 20);
    if (!(volume > 0)) continue;                           // market closed: flat filler bar
    bars.push({
      time: baseSec + raw.readInt32BE(i),
      open: raw.readInt32BE(i + 4) / scale,
      close: raw.readInt32BE(i + 8) / scale,
      low: raw.readInt32BE(i + 12) / scale,
      high: raw.readInt32BE(i + 16) / scale,
      volume,
    });
  }
  return bars;
}

// The files covering [fromSec, toSec] at one granularity, with each file's
// start time and whether that period is already over.
function filesFor(kind, code, fromSec, toSec) {
  const out = [];
  const pad = (n) => String(n).padStart(2, '0');
  const now = Date.now() / 1000;
  let d = new Date(fromSec * 1000);
  if (kind === 'minute') d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (kind === 'hour') d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (kind === 'day') d = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  while (d.getTime() / 1000 <= toSec) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    let next, path;
    if (kind === 'minute') {
      next = new Date(Date.UTC(y, m, d.getUTCDate() + 1));
      path = `${y}/${pad(m)}/${pad(d.getUTCDate())}/BID_candles_min_1.bi5`;
    } else if (kind === 'hour') {
      next = new Date(Date.UTC(y, m + 1, 1));
      path = `${y}/${pad(m)}/BID_candles_hour_1.bi5`;
    } else {
      next = new Date(Date.UTC(y + 1, 0, 1));
      path = `${y}/BID_candles_day_1.bi5`;
    }
    const start = d.getTime() / 1000, end = next.getTime() / 1000;
    if (start <= now) out.push({ url: `${BASE}/${code}/${path}`, kind, start, end, done: end <= now - 3600 });
    d = next;
  }
  return out;
}

// Calendar-aligned rollup (weeks start on Monday, like most charting tools).
function aggregate(bars, step) {
  if (step === 60 || !bars.length) return bars;
  const WEEK_OFFSET = 4 * DAY;                             // 1970-01-01 was a Thursday
  const out = [];
  let cur = null;
  for (const b of bars) {
    const bucket = step === 7 * DAY
      ? Math.floor((b.time - WEEK_OFFSET) / step) * step + WEEK_OFFSET
      : Math.floor(b.time / step) * step;
    if (!cur || cur.time !== bucket) {
      if (cur) out.push(cur);
      cur = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// from / to in milliseconds. Returns { candles, meta }; candles have time in
// seconds (UTC), like the other market sources.
async function getCandles({ symbol, interval, from, to }) {
  const inst = instrumentFor(symbol);
  if (!inst) { const e = new Error('No Dukascopy data for ' + symbol); e.status = 404; throw e; }
  const plan = PLAN[interval];
  if (!plan) { const e = new Error('Unsupported interval ' + interval + ' (use ' + Object.keys(PLAN).join(', ') + ')'); e.status = 400; throw e; }
  let toSec = Math.floor((Number(to) || Date.now()) / 1000);
  let fromSec = Math.floor((Number(from) || 0) / 1000) || toSec - 30 * DAY;
  if (fromSec > toSec) { const e = new Error('from is after to'); e.status = 400; throw e; }
  let truncated = false;
  if (toSec - fromSec > plan.maxDays * DAY) { toSec = fromSec + plan.maxDays * DAY; truncated = true; }

  // A month or year that isn't over yet may have no hour/day file: build it
  // from the next finer files instead (the current day's minutes appear once
  // Dukascopy publishes them, usually after the day closes).
  let files = filesFor(plan.file, inst.code, fromSec, toSec);
  for (let round = 0; round < 2; round++) {
    files = [].concat(...files.map((f) => {
      if (f.done || f.kind === 'minute') return [f];
      const finer = f.kind === 'day' ? 'hour' : 'minute';
      return filesFor(finer, inst.code, Math.max(fromSec, f.start), Math.min(toSec, f.end - 1));
    }));
  }
  let missing = 0, lastErr = null;
  const parts = await mapLimit(files, 3, async (f) => {
    const hit = cacheGet(f.url);
    if (hit) return hit;
    try {
      const buf = await fetchFile(f.url);
      const bars = buf ? parse(buf, f.start, inst.scale) : [];
      cacheSet(f.url, bars, f.done ? 30 * DAY * 1000 : 60 * 1000);
      return bars;
    } catch (e) {
      missing++; lastErr = e;                              // not cached: the next request retries it
      return [];
    }
  });
  // A gap or two is better than no chart, but not most of it.
  if (missing && missing > Math.max(1, files.length * 0.2)) {
    const e = new Error('Dukascopy is not responding (' + missing + ' of ' + files.length + ' files failed: ' + (lastErr && lastErr.message) + ')');
    e.status = 502; throw e;
  }
  const bars = [].concat(...parts).filter((b) => b.time >= fromSec && b.time <= toSec);
  return {
    candles: aggregate(bars, plan.step),
    meta: { source: 'dukascopy', instrument: inst.code, name: inst.name, interval, side: 'bid', truncated, to: toSec * 1000, missingFiles: missing },
  };
}

module.exports = { getCandles, instrumentFor, PLAN };
