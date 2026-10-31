// ETW AI market pulse: what is happening in the markets right now.
//
//   • NEWS       — newest headlines from several market news RSS feeds
//                  (FXStreet, investingLive, Investing.com, CNBC, CoinDesk, Kitco)
//   • TECHNICALS — TradingView's technical ratings (the same "Strong buy … Strong
//                  sell" summary its Technicals tab shows) for a broad watchlist and
//                  the trader's own instruments, on 1H, 4H and 1D, plus price,
//                  daily change, RSI and ADX
//   • CROWD      — what traders are saying: Reddit trading communities (hot post
//                  titles) and StockTwits bull/bear split on major symbols
//
// Every source is optional: one failing never breaks the others. Results are
// cached in memory (news 4 min, technicals 3 min, crowd 10 min) so a busy app
// costs a handful of outside requests a minute at most.
//
// Mount from server.js:
//   require('./src/marketPulse').mount(app, { requireAuth, requireSub, limiter: marketLimiter });
const UA = 'Mozilla/5.0 (compatible; ETWJournal/1.0; +https://etwiz.space)';
const NEWS_FEEDS = [
  ['FXStreet', 'https://www.fxstreet.com/rss/news'],
  ['investingLive', 'https://investinglive.com/feed/news'],
  ['Investing.com', 'https://www.investing.com/rss/news_1.rss'],
  ['Investing.com', 'https://www.investing.com/rss/news_11.rss'],
  ['CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'],
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Kitco', 'https://www.kitco.com/rss/KitcoNews.xml'],
];
const SUBREDDITS = ['Forex', 'Daytrading', 'Gold', 'CryptoCurrency', 'StockMarket'];
const STOCKTWITS = ['SPY', 'QQQ', 'BTC.X', 'ETH.X', 'GLD', 'UUP'];
// Broad watchlist (always rated) — the trader's own instruments are added per request.
const WATCH = ['DXY', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'XAUUSD', 'XAGUSD', 'US100', 'US30', 'US500', 'GER40', 'USOIL', 'BTCUSD', 'ETHUSD'];

const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v;
  if (hit && hit.p) return hit.p;
  const p = fn().then((v) => { cache.set(key, { at: Date.now(), v }); return v; })
    .catch((e) => { cache.delete(key); if (hit) return hit.v; throw e; });
  cache.set(key, Object.assign({}, hit || {}, { p }));
  return p;
}
async function get(url, opts = {}, ms = 9000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, Object.assign({ headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctl.signal }, opts));
    if (!r.ok) throw new Error(url.split('/')[2] + ' ' + r.status);
    return r;
  } finally { clearTimeout(t); }
}

/* ── news ── */
function decodeXml(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function parseRss(xml, source) {
  const out = [];
  const items = String(xml).match(/<item[\s>][\s\S]*?<\/item>/gi) || String(xml).match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  items.slice(0, 40).forEach((it) => {
    const tag = (n) => { const m = new RegExp('<' + n + '[^>]*>([\\s\\S]*?)<\\/' + n + '>', 'i').exec(it); return m ? decodeXml(m[1]) : ''; };
    const title = tag('title'); if (!title) return;
    const when = Date.parse(tag('pubDate') || tag('dc:date') || tag('published') || tag('updated')) || 0;
    let link = tag('link'); if (!link) { const m = /<link[^>]*href="([^"]+)"/i.exec(it); link = m ? m[1] : ''; }
    out.push({ title: title.slice(0, 220), source, at: when, link: /^https?:\/\//.test(link) ? link.slice(0, 400) : '', summary: tag('description').slice(0, 260) });
  });
  return out;
}
async function news() {
  return cached('news', 4 * 60 * 1000, async () => {
    const res = await Promise.allSettled(NEWS_FEEDS.map(([src, url]) => get(url).then((r) => r.text()).then((x) => parseRss(x, src))));
    const all = [], seen = new Set();
    res.forEach((r) => { if (r.status === 'fulfilled') r.value.forEach((n) => { const k = n.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 70); if (!seen.has(k)) { seen.add(k); all.push(n); } }); });
    const cutoff = Date.now() - 36 * 3600 * 1000;
    return all.filter((n) => !n.at || n.at > cutoff).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 40);
  });
}

/* ── TradingView technicals ── */
const TV_MAP = {
  DXY: 'TVC:DXY', XAUUSD: 'OANDA:XAUUSD', XAGUSD: 'OANDA:XAGUSD', US100: 'OANDA:NAS100USD', NAS100: 'OANDA:NAS100USD', USTEC: 'OANDA:NAS100USD',
  US30: 'OANDA:US30USD', DJ30: 'OANDA:US30USD', US500: 'OANDA:SPX500USD', SPX500: 'OANDA:SPX500USD', SP500: 'OANDA:SPX500USD',
  GER40: 'OANDA:DE30EUR', DE40: 'OANDA:DE30EUR', UK100: 'OANDA:UK100GBP', JP225: 'OANDA:JP225USD', USOIL: 'TVC:USOIL', WTI: 'TVC:USOIL', UKOIL: 'TVC:UKOIL',
  BTCUSD: 'BINANCE:BTCUSDT', BTCUSDT: 'BINANCE:BTCUSDT', ETHUSD: 'BINANCE:ETHUSDT', ETHUSDT: 'BINANCE:ETHUSDT', SOLUSD: 'BINANCE:SOLUSDT', XRPUSD: 'BINANCE:XRPUSDT',
};
function tvTicker(sym) {
  const s = String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(M|PRO|RAW|ECN|PLUS|MICRO)$/, '');
  if (TV_MAP[s]) return TV_MAP[s];
  if (/^[A-Z]{6}$/.test(s) && /(USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF)/.test(s)) return 'FX:' + s;
  if (/USDT$/.test(s)) return 'BINANCE:' + s;
  return null;
}
function marketOf(t) { return /^BINANCE:/.test(t) ? 'crypto' : /^FX:/.test(t) ? 'forex' : 'cfd'; }
function rating(v) { if (v == null || !isFinite(v)) return null; return v > 0.5 ? 'Strong buy' : v > 0.1 ? 'Buy' : v < -0.5 ? 'Strong sell' : v < -0.1 ? 'Sell' : 'Neutral'; }
const TV_COLS = ['close', 'change', 'Recommend.All|60', 'Recommend.All|240', 'Recommend.All', 'RSI', 'ADX', 'Perf.W'];
async function technicals(symbols) {
  const want = [...new Set(WATCH.concat(symbols || []).map((s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))].slice(0, 40);
  const pairs = want.map((s) => [s, tvTicker(s)]).filter((x) => x[1]);
  const key = 'tv:' + pairs.map((x) => x[1]).sort().join(',');
  return cached(key, 3 * 60 * 1000, async () => {
    const groups = {};
    pairs.forEach(([, t]) => { const m = marketOf(t); (groups[m] = groups[m] || new Set()).add(t); });
    const out = {};
    await Promise.allSettled(Object.keys(groups).map(async (m) => {
      const r = await get('https://scanner.tradingview.com/' + m + '/scan', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/' }, body: JSON.stringify({ symbols: { tickers: [...groups[m]], query: { types: [] } }, columns: TV_COLS }) });
      const j = await r.json();
      (j.data || []).forEach((row) => {
        const d = row.d || [];
        out[row.s] = { price: d[0], change: d[1], h1: rating(d[2]), h4: rating(d[3]), d1: rating(d[4]), score: d[4], rsi: d[5], adx: d[6], week: d[7] };
      });
    }));
    return pairs.map(([s, t]) => out[t] ? Object.assign({ symbol: s, tv: t }, out[t]) : null).filter(Boolean);
  });
}

/* ── crowd: Reddit + StockTwits ── */
async function crowd() {
  return cached('crowd', 10 * 60 * 1000, async () => {
    const reddit = [];
    const rr = await Promise.allSettled(SUBREDDITS.map((sr) => get('https://www.reddit.com/r/' + sr + '/hot.json?limit=12&raw_json=1', { headers: { 'User-Agent': UA + ' market-pulse', Accept: 'application/json' } }, 7000).then((r) => r.json()).then((j) => ({ sr, j }))));
    rr.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      ((r.value.j.data || {}).children || []).forEach((c) => {
        const d = c.data || {}; if (d.stickied || !d.title) return;
        if (Date.now() / 1000 - (d.created_utc || 0) > 48 * 3600) return;
        reddit.push({ sub: r.value.sr, title: String(d.title).slice(0, 200), score: d.score || 0, comments: d.num_comments || 0, at: (d.created_utc || 0) * 1000 });
      });
    });
    reddit.sort((a, b) => (b.score + b.comments * 2) - (a.score + a.comments * 2));
    const sentiment = [];
    const st = await Promise.allSettled(STOCKTWITS.map((s) => get('https://api.stocktwits.com/api/2/streams/symbol/' + s + '.json', { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 7000).then((r) => r.json()).then((j) => ({ s, j }))));
    st.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      const msgs = r.value.j.messages || []; let bull = 0, bear = 0;
      msgs.forEach((m) => { const v = m.entities && m.entities.sentiment && m.entities.sentiment.basic; if (v === 'Bullish') bull++; else if (v === 'Bearish') bear++; });
      if (bull + bear >= 5) sentiment.push({ symbol: r.value.s.replace('.X', ''), bullish: Math.round(bull / (bull + bear) * 100), sample: bull + bear });
    });
    return { reddit: reddit.slice(0, 14), sentiment };
  });
}

async function pulse(symbols) {
  const [n, t, c] = await Promise.allSettled([news(), technicals(symbols), crowd()]);
  return {
    ok: true, at: Date.now(),
    news: n.status === 'fulfilled' ? n.value : [],
    technicals: t.status === 'fulfilled' ? t.value : [],
    crowd: c.status === 'fulfilled' ? c.value : { reddit: [], sentiment: [] },
    sources: { news: n.status === 'fulfilled' && n.value.length > 0, technicals: t.status === 'fulfilled' && t.value.length > 0, crowd: c.status === 'fulfilled' && (c.value.reddit.length + c.value.sentiment.length) > 0 },
  };
}

function mount(app, { requireAuth, requireSub, limiter }) {
  app.get('/api/market/pulse', limiter, requireAuth, requireSub, async (req, res) => {
    try {
      const syms = String((req.query && req.query.symbols) || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
      const p = await pulse(syms);
      res.set('Cache-Control', 'private, max-age=60');
      res.json(p);
    } catch (e) {
      console.error('market/pulse:', e.message);
      res.status(502).json({ ok: false, error: 'Live market data is unavailable right now.' });
    }
  });
}

module.exports = { mount, pulse, news, technicals, crowd, tvTicker, parseRss };
