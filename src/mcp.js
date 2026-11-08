// ════════════════════════════════════════════════════════════════════════════
//  ETW Journal — MCP server (Model Context Protocol)
//
//  Lets a trader connect their journal to Claude, ChatGPT, Cursor or any other
//  MCP client, so the AI can read their trades, stats, notes, playbooks, rules
//  and deposits/withdrawals (and, if they allow it, write notes back).
//
//  Transport: MCP "Streamable HTTP", stateless. Every request is a JSON-RPC
//  POST and gets a plain JSON reply (no SSE stream, no session state), which
//  works with Claude (custom connectors), ChatGPT (developer-mode apps),
//  Claude Code / Desktop, Cursor, VS Code and the MCP Inspector.
//
//  Auth: a personal connector key, created in Settings › AI Connectors. Only a
//  SHA-256 hash of it is stored (mcpKeys/{hash}). The key can travel either in
//  the URL  (https://<api>/mcp/<key>  — for apps that only take a URL) or as
//  "Authorization: Bearer <key>" against https://<api>/mcp. Revoking the key in
//  Settings cuts the AI off immediately. Pro / Ultra only, like ETW AI.
//
//  Data model it reads (same as the app):
//    trades            top-level, uid == data uid (one per independent account)
//    cashflows         top-level, uid == data uid
//    playbooks         top-level, uid == data uid
//    trading_rules     top-level, uid == data uid
//    users/{du}/notes, users/{du}/noteFolders
//    users/{uid}/accounts   the login's independent journals (oldest = main)
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

const SERVER_INFO = { name: 'etw-journal', title: 'ETW Journal', version: '1.0.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const KEY_PREFIX = 'etwk_';
const MAX_KEYS = 5;
const APP_URL = 'https://etwiz.space/journal.html';
const SEP = '__';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b62 = (buf) => { const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; let o = ''; for (const b of buf) o += A[b % 62]; return o; };
const num = (v) => { if (typeof v === 'number') return isFinite(v) ? v : 0; const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (v) => Math.round((+v || 0) * 100) / 100;
const S = (v) => (v == null ? '' : String(v));
const low = (v) => S(v).trim().toLowerCase();
const iso = (ms) => { try { return ms ? new Date(ms).toISOString() : null; } catch (e) { return null; } };
const stripHtml = (h) => S(h).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n').replace(/<(td|th)[^>]*>/gi, ' | ').replace(/<img[^>]*>/gi, '[image]').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
const clip = (s, n) => { s = S(s); return s.length > n ? s.slice(0, n) + '…' : s; };
const escHtml = (s) => S(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── tiny in-memory rate limiter (per key, not per IP: Claude/ChatGPT share IPs) ──
const _hits = new Map();
function limited(id, max, windowMs) {
  const now = Date.now(), k = id + ':' + Math.floor(now / windowMs);
  const n = (_hits.get(k) || 0) + 1; _hits.set(k, n);
  if (_hits.size > 5000) { for (const kk of _hits.keys()) { if (!kk.endsWith(':' + Math.floor(now / windowMs))) _hits.delete(kk); } }
  return n > max;
}

// ── short-lived read cache so a burst of tool calls doesn't re-read everything ──
const _cache = new Map();
async function cached(key, ttl, fn) {
  const hit = _cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  _cache.set(key, { val, exp: Date.now() + ttl });
  if (_cache.size > 400) { const first = _cache.keys().next().value; _cache.delete(first); }
  return val;
}
function bust(prefix) { for (const k of [..._cache.keys()]) if (k.startsWith(prefix)) _cache.delete(k); }

function mount(app, opts) {
  const { db, requireAuth, planOf, accountLimit } = opts;
  const publicBase = () => S(process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || 'https://etwappmeta5-2.onrender.com').replace(/\/+$/, '');

  // ════════════════════════ key management (from the app) ════════════════════════
  const keysCol = () => db.collection('mcpKeys');
  async function listKeys(uid) {
    const snap = await keysCol().where('uid', '==', uid).get();
    return snap.docs.map((d) => { const x = d.data() || {}; return { id: d.id.slice(0, 16), name: x.name || 'Connector', scope: x.scope === 'write' ? 'write' : 'read', hint: x.hint || '', createdAt: x.createdAt || 0, lastUsedAt: x.lastUsedAt || 0, uses: x.uses || 0, client: x.client || '' }; })
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async function planGate(uid) {
    const p = await planOf(uid).catch(() => undefined);
    return p === 'pro' || p === 'ultra' ? p : (p === undefined ? 'unknown' : null);
  }

  app.get('/api/mcp/keys', requireAuth, async (req, res) => {
    try {
      const plan = await planGate(req.uid);
      res.json({ ok: true, plan, allowed: plan === 'pro' || plan === 'ultra', endpoint: publicBase() + '/mcp', keys: await listKeys(req.uid), max: MAX_KEYS });
    } catch (e) { console.error('[mcp] list keys', e.message); res.status(500).json({ error: 'Could not load your connectors.' }); }
  });

  app.post('/api/mcp/keys', requireAuth, async (req, res) => {
    try {
      const plan = await planGate(req.uid);
      if (plan === 'unknown') return res.status(503).json({ error: 'Could not check your plan. Please try again.' });
      if (!plan) return res.status(402).json({ error: 'AI connectors are on the Pro and Ultra plans.', code: 'pro_required' });
      const existing = await listKeys(req.uid);
      if (existing.length >= MAX_KEYS) return res.status(400).json({ error: 'You can have up to ' + MAX_KEYS + ' connectors. Revoke one you no longer use first.' });
      const name = clip(S(req.body && req.body.name).replace(/[<>]/g, '').trim() || 'My AI connector', 60);
      const scope = req.body && req.body.scope === 'write' ? 'write' : 'read';
      const client = ['claude', 'chatgpt', 'cursor', 'other'].includes(S(req.body && req.body.client)) ? S(req.body.client) : 'other';
      const key = KEY_PREFIX + b62(crypto.randomBytes(32));
      const hash = sha(key);
      await keysCol().doc(hash).set({ uid: req.uid, name, scope, client, hint: key.slice(0, 9) + '…' + key.slice(-4), createdAt: Date.now(), lastUsedAt: 0, uses: 0 });
      const base = publicBase();
      res.json({ ok: true, id: hash.slice(0, 16), key, url: base + '/mcp/' + key, endpoint: base + '/mcp', name, scope });
    } catch (e) { console.error('[mcp] create key', e.message); res.status(500).json({ error: 'Could not create the connector.' }); }
  });

  app.delete('/api/mcp/keys/:id', requireAuth, async (req, res) => {
    try {
      const id = S(req.params.id); if (!/^[a-f0-9]{16}$/.test(id)) return res.status(400).json({ error: 'Invalid connector.' });
      const snap = await keysCol().where('uid', '==', req.uid).get();
      const d = snap.docs.find((x) => x.id.slice(0, 16) === id);
      if (!d) return res.status(404).json({ error: 'That connector no longer exists.' });
      await keysCol().doc(d.id).delete();
      _keyCache.delete(d.id);
      res.json({ ok: true });
    } catch (e) { console.error('[mcp] revoke key', e.message); res.status(500).json({ error: 'Could not revoke the connector.' }); }
  });

  // ════════════════════════ key → user ════════════════════════
  const _keyCache = new Map();   // hash -> { rec, exp }
  async function resolveKey(key) {
    if (!key || !key.startsWith(KEY_PREFIX) || key.length < 30 || key.length > 80) return null;
    const hash = sha(key);
    const c = _keyCache.get(hash);
    if (c && c.exp > Date.now()) return c.rec;
    const snap = await keysCol().doc(hash).get();
    const rec = snap.exists ? Object.assign({ hash }, snap.data()) : null;
    _keyCache.set(hash, { rec, exp: Date.now() + (rec ? 60e3 : 15e3) });
    return rec;
  }
  const _touch = new Map();
  function touch(rec, clientName) {
    const last = _touch.get(rec.hash) || 0; if (Date.now() - last < 5 * 60e3) return;
    _touch.set(rec.hash, Date.now());
    const patch = { lastUsedAt: Date.now(), uses: (rec.uses || 0) + 1 };
    if (clientName) patch.lastClient = clip(clientName, 60);
    keysCol().doc(rec.hash).set(patch, { merge: true }).catch(() => {});
    rec.uses = patch.uses;
  }

  // ════════════════════════ journal data ════════════════════════
  async function accountsOf(uid) {
    return cached('acc:' + uid, 60e3, async () => {
      let docs = [];
      try { const s = await db.collection('users').doc(uid).collection('accounts').orderBy('created', 'asc').get(); docs = s.docs.map((d) => Object.assign({ id: d.id }, d.data() || {})); } catch (e) { docs = []; }
      let allowed = Infinity; try { allowed = await accountLimit(uid); } catch (e) {}
      if (!docs.length) return [{ id: 'main', name: 'Main journal', du: uid, main: true, locked: false }];
      return docs.map((d, i) => ({ id: d.id, name: S(d.name || (i === 0 ? 'Main journal' : 'Account ' + (i + 1))), du: i === 0 ? uid : uid + SEP + d.id, main: i === 0, locked: i >= allowed }));
    });
  }
  async function pickAccounts(ctx, want) {
    const all = (await accountsOf(ctx.uid)).filter((a) => !a.locked);
    const w = low(want);
    if (!w || w === 'all') return all;
    if (w === 'main' || w === 'default') return all.filter((a) => a.main);
    const hit = all.filter((a) => low(a.id) === w || low(a.name) === w);
    if (hit.length) return hit;
    const part = all.filter((a) => low(a.name).includes(w));
    if (part.length) return part;
    throw toolErr('No account called "' + want + '". Use list_accounts to see the account names.');
  }
  async function rawTrades(du) {
    return cached('tr:' + du, 45e3, async () => {
      const s = await db.collection('trades').where('uid', '==', du).get();
      return s.docs.map((d) => Object.assign({ id: d.id }, d.data() || {}));
    });
  }
  function tms(t) { const c = Date.parse(t.closeTime || ''); if (isFinite(c)) return c; return num(t.tradeDate) || Date.parse(t.tradeDate || '') || num(t.createdAt) || 0; }
  function resultOf(t, pnl) {
    const r = S(t.result).toUpperCase();
    if (r === 'WIN' || r === 'LOSS' || r === 'BREAKEVEN' || r === 'BE') return r === 'BE' ? 'BREAKEVEN' : r;
    return pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAKEVEN';
  }
  // Closed trades of one account, merged partials combined into one trade (as the app shows them).
  async function tradesOf(acc) {
    const raw = (await rawTrades(acc.du)).filter((t) => t && S(t.result).toUpperCase() !== 'OPEN' && t.source !== 'demo' && !S(t.id).startsWith('demo-') && !t.loadingPlaceholder);
    const groups = new Map(), out = [];
    for (const t of raw) { if (t.mergeGroup) { const g = groups.get(t.mergeGroup) || []; g.push(t); groups.set(t.mergeGroup, g); } else out.push(norm(t, acc, null)); }
    for (const g of groups.values()) {
      const p = g.find((x) => x.mergePrimary) || g[0];
      out.push(norm(p, acc, g));
    }
    return out.sort((a, b) => a.ts - b.ts);
  }
  function norm(t, acc, group) {
    const pnl = group ? group.reduce((s, x) => s + num(x.pnl), 0) : num(t.pnl);
    const tags = Array.isArray(t.tags) ? t.tags.map(S).filter(Boolean) : S(t.tags).split(',').map((x) => x.trim()).filter(Boolean);
    const ts = tms(t);
    return {
      id: t.id, ts, account: acc.name, accountId: acc.id,
      symbol: S(t.pair || t.symbol).toUpperCase(), direction: S(t.direction).toUpperCase(), result: group ? resultOf({}, pnl) : resultOf(t, pnl),
      pnl: r2(pnl), rr: t.rr !== undefined && t.rr !== '' && isFinite(num(t.rr)) ? num(t.rr) : null,
      lot: S(t.lot || t.volume), entry: S(t.entry), exit: S(t.exit || t.exitPrice || t.closePrice), sl: S(t.sl), tp: S(t.tp),
      session: S(t.session), strategy: S(t.strategy || t.model || t.setup), emotion: S(t.emotion), tags,
      mistakes: S(t.mistakes), source: S(t.source), merged: group ? group.length : 0, _raw: t, _group: group,
    };
  }
  function brief(t) {
    const o = { id: t.id, date: iso(t.ts), account: t.account, symbol: t.symbol, direction: t.direction, result: t.result, pnl: t.pnl };
    if (t.rr != null) o.rr = t.rr; if (t.lot) o.lot = t.lot; if (t.session) o.session = t.session; if (t.strategy) o.strategy = t.strategy;
    if (t.emotion) o.emotion = t.emotion; if (t.tags.length) o.tags = t.tags; if (t.merged) o.mergedPartials = t.merged;
    const n = S(t._raw.notes); if (n) o.notePreview = clip(stripHtml(n), 140);
    return o;
  }
  function full(t) {
    const o = brief(t); delete o.notePreview;
    const r = t._raw, SKIP = { uid: 1, id: 1, pair: 1, symbol: 1, direction: 1, result: 1, pnl: 1, rr: 1, lot: 1, session: 1, strategy: 1, model: 1, emotion: 1, tags: 1, mergeGroup: 1, mergePrimary: 1, accountId: 1 };
    for (const k of Object.keys(r)) {
      if (SKIP[k]) continue;
      let v = r[k];
      if (v == null || v === '') continue;
      if (typeof v === 'string') { if (/^data:/.test(v)) continue; if (/notes|mistake|lesson|review|plan|comment/i.test(k) && /<[a-z]/i.test(v)) v = stripHtml(v); v = clip(v, 6000); }
      else if (typeof v === 'object') { try { const j = JSON.stringify(v); if (j.length > 6000 || /data:image/.test(j)) continue; } catch (e) { continue; } }
      if (/^(tradeDate|createdAt|updatedAt|openTimeMs|closeTimeMs|mergedAt)$/.test(k) && typeof v === 'number') v = iso(v);
      o[k] = v;
    }
    if (t._group) o.partials = t._group.map((x) => ({ id: x.id, pnl: r2(num(x.pnl)), lot: S(x.lot), entry: S(x.entry), exit: S(x.exit || x.exitPrice), date: iso(tms(x)) }));
    return o;
  }

  // ── filters ──
  function dayMs(s, end) {
    if (s == null || s === '') return null;
    if (typeof s === 'number') return s;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(S(s).trim());
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) + (end ? 86400000 - 1 : 0);
    const p = Date.parse(s); if (!isFinite(p)) throw toolErr('Could not read the date "' + s + '". Use YYYY-MM-DD.');
    return p;
  }
  function relRange(a) {
    const d = low(a.period); if (!d) return [dayMs(a.from), dayMs(a.to, true)];
    const now = Date.now(), D = 86400000, today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const t0 = today.getTime();
    if (d === 'today') return [t0, now];
    if (d === 'yesterday') return [t0 - D, t0 - 1];
    if (d === 'this_week') { const w = (today.getUTCDay() + 6) % 7; return [t0 - w * D, now]; }
    if (d === 'last_7_days') return [now - 7 * D, now];
    if (d === 'last_30_days') return [now - 30 * D, now];
    if (d === 'last_90_days') return [now - 90 * D, now];
    if (d === 'this_month') return [Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1), now];
    if (d === 'last_month') return [Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1), Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) - 1];
    if (d === 'this_year' || d === 'ytd') return [Date.UTC(today.getUTCFullYear(), 0, 1), now];
    if (d === 'all' || d === 'all_time') return [null, null];
    throw toolErr('Unknown period "' + a.period + '".');
  }
  const has = (v, w) => !w || low(v).includes(low(w));
  function filterTrades(list, a) {
    const [from, to] = relRange(a);
    return list.filter((t) => {
      if (from != null && t.ts < from) return false;
      if (to != null && t.ts > to) return false;
      if (a.symbol && low(t.symbol) !== low(a.symbol) && !low(t.symbol).includes(low(a.symbol))) return false;
      if (a.direction && low(t.direction) !== low(a.direction).replace('buy', 'long').replace('sell', 'short')) return false;
      if (a.result && low(t.result) !== low(a.result).replace(/^be$/, 'breakeven')) return false;
      if (!has(t.session, a.session) || !has(t.strategy, a.strategy) || !has(t.emotion, a.emotion)) return false;
      if (a.tag && !t.tags.some((x) => low(x) === low(a.tag) || low(x).includes(low(a.tag)))) return false;
      if (a.min_pnl != null && t.pnl < +a.min_pnl) return false;
      if (a.max_pnl != null && t.pnl > +a.max_pnl) return false;
      if (a.text) { const q = low(a.text); const hay = low([t.symbol, t.strategy, t.session, t.emotion, t.tags.join(' '), t.mistakes, stripHtml(t._raw.notes)].join(' ')); if (!hay.includes(q)) return false; }
      return true;
    });
  }
  async function tradesFor(ctx, a) {
    const accs = await pickAccounts(ctx, a.account);
    let all = [];
    for (const acc of accs) all = all.concat(await tradesOf(acc));
    return filterTrades(all.sort((x, y) => x.ts - y.ts), a);
  }

  // ── statistics ──
  function stats(list) {
    const n = list.length;
    const o = { trades: n };
    if (!n) return o;
    let wins = 0, losses = 0, be = 0, gw = 0, gl = 0, net = 0, peak = 0, eq = 0, mdd = 0, rrs = [], curW = 0, curL = 0, maxW = 0, maxL = 0, best = null, worst = null;
    const days = new Map();
    for (const t of list) {
      const p = t.pnl; net += p; eq += p; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq);
      if (t.result === 'WIN') { wins++; curW++; curL = 0; } else if (t.result === 'LOSS') { losses++; curL++; curW = 0; } else { be++; }
      maxW = Math.max(maxW, curW); maxL = Math.max(maxL, curL);
      if (p > 0) gw += p; else if (p < 0) gl += -p;
      if (t.rr != null) rrs.push(t.rr);
      if (!best || p > best.pnl) best = t; if (!worst || p < worst.pnl) worst = t;
      const dk = iso(t.ts) ? iso(t.ts).slice(0, 10) : '?'; days.set(dk, (days.get(dk) || 0) + p);
    }
    const decided = wins + losses;
    Object.assign(o, {
      wins, losses, breakeven: be, winRate: decided ? r2(wins / decided * 100) : null,
      netPnl: r2(net), grossProfit: r2(gw), grossLoss: r2(-gl), profitFactor: gl ? r2(gw / gl) : (gw ? null : 0),
      avgWin: wins ? r2(gw / wins) : null, avgLoss: losses ? r2(-gl / losses) : null,
      expectancyPerTrade: r2(net / n), avgRR: rrs.length ? r2(rrs.reduce((s, x) => s + x, 0) / rrs.length) : null,
      maxDrawdown: r2(-mdd), longestWinStreak: maxW, longestLossStreak: maxL,
      bestTrade: best ? { id: best.id, symbol: best.symbol, pnl: best.pnl, date: iso(best.ts) } : null,
      worstTrade: worst ? { id: worst.id, symbol: worst.symbol, pnl: worst.pnl, date: iso(worst.ts) } : null,
      tradingDays: days.size, greenDays: [...days.values()].filter((v) => v > 0).length, redDays: [...days.values()].filter((v) => v < 0).length,
      firstTrade: iso(list[0].ts), lastTrade: iso(list[n - 1].ts),
    });
    if (o.profitFactor === null) o.profitFactor = 'no losses';
    return o;
  }
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function zoned(ms, tz) {
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', weekday: 'long', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit' });
      const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
      return { weekday: p.weekday, hour: p.hour + ':00', month: p.year + '-' + p.month };
    } catch (e) { throw toolErr('Unknown time zone "' + tz + '". Use an IANA name such as Africa/Nairobi.'); }
  }
  function groupKeys(t, by, tz) {
    switch (by) {
      case 'symbol': return [t.symbol || '(none)'];
      case 'session': return [t.session || '(none)'];
      case 'strategy': return [t.strategy || '(none)'];
      case 'direction': return [t.direction || '(none)'];
      case 'emotion': return [t.emotion || '(none)'];
      case 'result': return [t.result];
      case 'account': return [t.account];
      case 'tag': return t.tags.length ? t.tags : ['(untagged)'];
      case 'weekday': return [zoned(t.ts, tz).weekday];
      case 'hour': return [zoned(t.ts, tz).hour];
      case 'month': return [zoned(t.ts, tz).month];
      default: throw toolErr('group_by must be one of symbol, session, strategy, direction, emotion, result, account, tag, weekday, hour, month.');
    }
  }

  // ── cash flows ──
  async function cashOf(acc) {
    return cached('cf:' + acc.du, 45e3, async () => {
      const s = await db.collection('cashflows').where('uid', '==', acc.du).get();
      return s.docs.map((d) => Object.assign({ id: d.id }, d.data() || {})).filter((c) => !c.hidden)
        .map((c) => ({ id: c.id, account: acc.name, date: iso(num(c.ts)), ts: num(c.ts), kind: c.kindOverride || c.kind || 'other', sub: S(c.sub), amount: r2(num(c.amount)), currency: S(c.currency), note: clip(S(c.userNote || c.note), 200), source: c.source === 'manual' ? 'manual' : /ctrader/i.test(S(c.source)) ? 'cTrader' : 'MT5', balanceAfter: c.balance != null ? r2(num(c.balance)) : undefined }))
        .sort((a, b) => b.ts - a.ts);
    });
  }

  // ── notes ──
  async function foldersOf(du) {
    return cached('nf:' + du, 60e3, async () => {
      const m = {}; try { const s = await db.collection('users').doc(du).collection('noteFolders').get(); s.docs.forEach((d) => { m[d.id] = S((d.data() || {}).name); }); } catch (e) {}
      return m;
    });
  }
  async function notesOf(acc) {
    return cached('nt:' + acc.du, 45e3, async () => {
      const [s, folders] = await Promise.all([db.collection('users').doc(acc.du).collection('notes').get(), foldersOf(acc.du)]);
      return s.docs.map((d) => Object.assign({ id: d.id }, d.data() || {})).filter((n) => !n.trashed)
        .map((n) => {
          const text = S(n.userBodyHtml != null ? stripHtml(n.userBodyHtml) : (n.body || stripHtml(n.bodyHtml)));
          return { ref: 'note:' + acc.id + ':' + n.id, id: n.id, account: acc.name, accountId: acc.id, title: S(n.title) || 'Untitled', folder: folders[n.folderId] || (n.dailyDate ? 'Daily notes' : n.prepDate ? 'Session prep' : ''), updated: num(n.updated) || num(n.created), created: num(n.created), tags: Array.isArray(n.tags) ? n.tags : [], dailyDate: n.dailyDate || n.prepDate || null, trade: n.tradeRef ? { pair: n.tradeRef.pair, date: n.tradeRef.date, result: n.tradeRef.result, pnl: n.tradeRef.pnl } : null, text };
        }).sort((a, b) => b.updated - a.updated);
    });
  }

  async function docsOf(col, du) {
    return cached(col + ':' + du, 60e3, async () => {
      const s = await db.collection(col).where('uid', '==', du).get();
      return s.docs.map((d) => { const x = Object.assign({ id: d.id }, d.data() || {}); delete x.uid; return scrub(x); });
    });
  }
  function scrub(v, depth) {
    depth = depth || 0;
    if (v == null) return v;
    if (typeof v === 'string') return /^data:/.test(v) ? '[image]' : clip(/<[a-z][^>]*>/i.test(v) ? stripHtml(v) : v, 4000);
    if (Array.isArray(v)) return depth > 4 ? '[…]' : v.slice(0, 200).map((x) => scrub(x, depth + 1));
    if (typeof v === 'object') { if (depth > 4) return '[…]'; const o = {}; for (const k of Object.keys(v)) o[k] = scrub(v[k], depth + 1); return o; }
    return v;
  }

  // ════════════════════════ tools ════════════════════════
  function toolErr(msg) { const e = new Error(msg); e.tool = true; return e; }
  const ACCOUNT = { type: 'string', description: 'Journal account name or id (see list_accounts). "all" (default) combines every account; "main" is the main journal.' };
  const DATE_FILTERS = {
    period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'last_7_days', 'last_30_days', 'last_90_days', 'this_month', 'last_month', 'this_year', 'all_time'], description: 'Quick date range (UTC). Overrides from/to.' },
    from: { type: 'string', description: 'Start date, YYYY-MM-DD (UTC), inclusive.' },
    to: { type: 'string', description: 'End date, YYYY-MM-DD (UTC), inclusive.' },
  };
  const TRADE_FILTERS = Object.assign({ account: ACCOUNT }, DATE_FILTERS, {
    symbol: { type: 'string', description: 'Instrument, e.g. XAUUSD, EURUSD, NAS100.' },
    direction: { type: 'string', enum: ['LONG', 'SHORT'], description: 'Trade direction.' },
    result: { type: 'string', enum: ['WIN', 'LOSS', 'BREAKEVEN'], description: 'Trade outcome.' },
    session: { type: 'string', description: 'Session, e.g. London, New York, Asian.' },
    strategy: { type: 'string', description: 'Strategy / model / setup name (partial match).' },
    tag: { type: 'string', description: 'A tag on the trade (partial match).' },
    emotion: { type: 'string', description: 'Logged emotion, e.g. Calm, FOMO.' },
    text: { type: 'string', description: 'Free text searched in notes, mistakes, tags, strategy.' },
    min_pnl: { type: 'number', description: 'Only trades with P&L ≥ this.' },
    max_pnl: { type: 'number', description: 'Only trades with P&L ≤ this.' },
  });
  const RO = { readOnlyHint: true, openWorldHint: false };

  const TOOLS = [
    {
      name: 'get_journal_overview', title: 'Journal overview',
      description: 'Start here. Summary of the trader\'s ETW Journal: accounts, all-time and last-30-day performance, deposits/withdrawals totals and the most recent trades. Use it to orient before deeper questions.',
      inputSchema: { type: 'object', properties: { account: ACCOUNT }, additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => {
        const accs = await pickAccounts(ctx, a.account);
        let trades = []; for (const acc of accs) trades = trades.concat(await tradesOf(acc));
        trades.sort((x, y) => x.ts - y.ts);
        const since = Date.now() - 30 * 86400000;
        let cash = []; for (const acc of accs) cash = cash.concat(await cashOf(acc));
        const dep = cash.filter((c) => c.kind === 'deposit').reduce((s, c) => s + Math.abs(c.amount), 0), wd = cash.filter((c) => c.kind === 'withdrawal').reduce((s, c) => s + Math.abs(c.amount), 0);
        const allPnl = trades.reduce((s, t) => s + t.pnl, 0), other = cash.filter((c) => c.kind === 'other').reduce((s, c) => s + c.amount, 0);
        return {
          plan: ctx.plan, accounts: (await accountsOf(ctx.uid)).map((x) => ({ id: x.id, name: x.name, main: x.main, locked: x.locked || undefined })),
          scope: accs.map((x) => x.name),
          allTime: stats(trades), last30Days: stats(trades.filter((t) => t.ts >= since)),
          money: cash.length ? { deposited: r2(dep), withdrawn: r2(wd), netDeposits: r2(dep - wd), otherBalanceChanges: r2(other), tradingPnl: r2(allPnl), returnOnDeposits: dep ? r2((allPnl + other) / dep * 100) + '%' : null } : 'No deposits or withdrawals recorded.',
          recentTrades: trades.slice(-8).reverse().map(brief),
          notes: 'P&L is in the account currency. Dates are ISO-8601 UTC.',
        };
      },
    },
    {
      name: 'list_accounts', title: 'List journal accounts',
      description: 'The trader\'s independent journal accounts (e.g. personal, prop firm challenge, funded). Each has its own trades, notes and broker connections.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO,
      run: async (ctx) => ({ accounts: (await accountsOf(ctx.uid)).map((x) => ({ id: x.id, name: x.name, main: x.main, locked: x.locked ? 'over the plan\'s account limit — not readable' : undefined })) }),
    },
    {
      name: 'search_trades', title: 'Search trades',
      description: 'List closed trades with filters (date range, symbol, direction, result, session, strategy, tag, emotion, text, P&L range). Newest first. Each trade has an id you can pass to get_trade for full details.',
      inputSchema: { type: 'object', properties: Object.assign({}, TRADE_FILTERS, {
        sort: { type: 'string', enum: ['newest', 'oldest', 'best', 'worst'], description: 'Order of results (default newest).' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max trades to return (default 50).' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many (for paging).' },
      }), additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => {
        let list = await tradesFor(ctx, a);
        const sort = a.sort || 'newest';
        list = sort === 'oldest' ? list : sort === 'best' ? list.slice().sort((x, y) => y.pnl - x.pnl) : sort === 'worst' ? list.slice().sort((x, y) => x.pnl - y.pnl) : list.slice().reverse();
        const off = Math.max(0, a.offset | 0), lim = Math.min(500, Math.max(1, a.limit || 50));
        return { total: list.length, returned: Math.max(0, Math.min(lim, list.length - off)), offset: off, trades: list.slice(off, off + lim).map(brief) };
      },
    },
    {
      name: 'get_trade', title: 'Get trade details',
      description: 'Everything journaled for one trade: prices, size, times, notes, mistakes, rule checklist, tags, screenshots (URLs) and merged partials.',
      inputSchema: { type: 'object', properties: { trade_id: { type: 'string', description: 'Trade id from search_trades.' } }, required: ['trade_id'], additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => {
        const id = S(a.trade_id).replace(/^trade:/, '');
        for (const acc of await pickAccounts(ctx, 'all')) {
          const t = (await tradesOf(acc)).find((x) => x.id === id || (x._group && x._group.some((g) => g.id === id)));
          if (t) return full(t);
        }
        throw toolErr('No trade with id ' + id + ' in this journal.');
      },
    },
    {
      name: 'get_performance_stats', title: 'Performance statistics',
      description: 'Performance metrics for any slice of the journal: win rate, net P&L, profit factor, average win/loss, expectancy, average R:R, max drawdown, streaks, best/worst trade, green/red days. Optionally broken down by symbol, session, strategy, direction, emotion, tag, weekday, hour, month, result or account.',
      inputSchema: { type: 'object', properties: Object.assign({}, TRADE_FILTERS, {
        group_by: { type: 'string', enum: ['symbol', 'session', 'strategy', 'direction', 'emotion', 'tag', 'weekday', 'hour', 'month', 'result', 'account'], description: 'Break the stats down by this field.' },
        timezone: { type: 'string', description: 'IANA time zone for weekday/hour/month grouping (default UTC), e.g. Africa/Nairobi, America/New_York.' },
      }), additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => {
        const list = await tradesFor(ctx, a);
        const out = { filters: Object.fromEntries(Object.entries(a).filter(([k, v]) => v != null && v !== '' && k !== 'group_by' && k !== 'timezone')), overall: stats(list) };
        if (a.group_by) {
          const g = new Map();
          for (const t of list) for (const k of groupKeys(t, a.group_by, a.timezone)) { const arr = g.get(k) || []; arr.push(t); g.set(k, arr); }
          const rows = [...g.entries()].map(([k, arr]) => { const s = stats(arr); return { [a.group_by]: k, trades: s.trades, winRate: s.winRate, netPnl: s.netPnl, profitFactor: s.profitFactor, avgWin: s.avgWin, avgLoss: s.avgLoss, expectancyPerTrade: s.expectancyPerTrade, avgRR: s.avgRR }; });
          const order = a.group_by === 'weekday' ? (r) => WD.indexOf(r.weekday) : (a.group_by === 'hour' || a.group_by === 'month') ? null : undefined;
          if (order) rows.sort((x, y) => order(x) - order(y)); else if (order === null) rows.sort((x, y) => S(x[a.group_by]).localeCompare(S(y[a.group_by]))); else rows.sort((x, y) => y.netPnl - x.netPnl);
          out.breakdown = rows;
          if (a.group_by === 'weekday' || a.group_by === 'hour' || a.group_by === 'month') out.timezone = a.timezone || 'UTC';
        }
        return out;
      },
    },
    {
      name: 'get_equity_curve', title: 'Equity curve',
      description: 'Cumulative P&L over time, one point per day (or week/month), for charting or spotting drawdowns.',
      inputSchema: { type: 'object', properties: Object.assign({ account: ACCOUNT }, DATE_FILTERS, { interval: { type: 'string', enum: ['day', 'week', 'month'], description: 'Bucket size (default day).' } }), additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => {
        const list = await tradesFor(ctx, { account: a.account, period: a.period, from: a.from, to: a.to });
        const iv = a.interval || 'day', b = new Map();
        for (const t of list) {
          const d = new Date(t.ts); let k;
          if (iv === 'month') k = d.toISOString().slice(0, 7);
          else if (iv === 'week') { const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))); k = m.toISOString().slice(0, 10); }
          else k = d.toISOString().slice(0, 10);
          const x = b.get(k) || { pnl: 0, trades: 0 }; x.pnl += t.pnl; x.trades++; b.set(k, x);
        }
        let cum = 0; const pts = [...b.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([k, x]) => { cum += x.pnl; return { [iv === 'week' ? 'weekOf' : iv]: k, pnl: r2(x.pnl), trades: x.trades, cumulative: r2(cum) }; });
        return { interval: iv, points: pts.slice(-400), truncated: pts.length > 400 || undefined };
      },
    },
    {
      name: 'get_cash_flows', title: 'Deposits & withdrawals',
      description: 'Deposits, withdrawals and other balance changes (bonuses, fees, credit) imported from MT5 / cTrader or added by hand, with totals and return on deposits. Withdrawals are not losses and deposits are not profit.',
      inputSchema: { type: 'object', properties: Object.assign({ account: ACCOUNT }, DATE_FILTERS, { limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max operations to list (default 100).' } }), additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => {
        const accs = await pickAccounts(ctx, a.account);
        const [from, to] = relRange(a);
        let all = []; for (const acc of accs) all = all.concat(await cashOf(acc));
        all.sort((x, y) => y.ts - x.ts);
        const inR = all.filter((c) => (from == null || c.ts >= from) && (to == null || c.ts <= to));
        const sum = (arr, k) => r2(arr.filter((c) => c.kind === k).reduce((s, c) => s + (k === 'other' ? c.amount : Math.abs(c.amount)), 0));
        let pnl = 0; for (const acc of accs) pnl += (await tradesOf(acc)).reduce((s, t) => s + t.pnl, 0);
        const dep = sum(all, 'deposit'), wd = sum(all, 'withdrawal'), oth = sum(all, 'other');
        return {
          allTime: { deposited: dep, withdrawn: wd, netDeposits: r2(dep - wd), otherBalanceChanges: oth, tradingPnl: r2(pnl), totalGain: r2(pnl + oth), returnOnDeposits: dep ? r2((pnl + oth) / dep * 100) + '%' : null, withdrawnShareOfDeposits: dep ? r2(wd / dep * 100) + '%' : null, ownCapitalStillAtRisk: r2(Math.max(0, dep - wd)) },
          inRange: (from != null || to != null) ? { deposited: sum(inR, 'deposit'), withdrawn: sum(inR, 'withdrawal'), other: sum(inR, 'other') } : undefined,
          operations: inR.slice(0, Math.min(500, a.limit || 100)).map((c) => { const o = Object.assign({}, c); delete o.ts; return o; }),
        };
      },
    },
    {
      name: 'list_notes', title: 'List notebook notes',
      description: 'Notebook notes (trading plans, daily notes, session prep, trade notes, lessons). Search by text or folder. Returns ids for get_note.',
      inputSchema: { type: 'object', properties: { account: ACCOUNT, query: { type: 'string', description: 'Text to look for in title or body.' }, folder: { type: 'string', description: 'Folder name (partial match).' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 30.' } }, additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => {
        let all = []; for (const acc of await pickAccounts(ctx, a.account)) all = all.concat(await notesOf(acc));
        all.sort((x, y) => y.updated - x.updated);
        const q = low(a.query);
        const hit = all.filter((n) => (!q || low(n.title + ' ' + n.text).includes(q)) && has(n.folder, a.folder));
        return { total: hit.length, notes: hit.slice(0, Math.min(200, a.limit || 30)).map((n) => ({ note_id: n.ref, title: n.title, account: n.account, folder: n.folder || undefined, updated: iso(n.updated), tags: n.tags.length ? n.tags : undefined, trade: n.trade || undefined, preview: clip(n.text.replace(/\s+/g, ' '), 180) })) };
      },
    },
    {
      name: 'get_note', title: 'Read a note',
      description: 'Full text of one notebook note (tables become " | " rows; images and drawings show as [image]).',
      inputSchema: { type: 'object', properties: { note_id: { type: 'string', description: 'note_id from list_notes.' } }, required: ['note_id'], additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => {
        const m = /^note:([^:]+):(.+)$/.exec(S(a.note_id));
        const accs = await pickAccounts(ctx, m ? m[1] : 'all'), id = m ? m[2] : S(a.note_id);
        for (const acc of accs) { const n = (await notesOf(acc)).find((x) => x.id === id); if (n) return { note_id: n.ref, title: n.title, account: n.account, folder: n.folder || undefined, created: iso(n.created), updated: iso(n.updated), tags: n.tags, trade: n.trade || undefined, text: clip(n.text, 60000) }; }
        throw toolErr('No note with id ' + a.note_id + '.');
      },
    },
    {
      name: 'get_playbooks', title: 'Playbooks',
      description: 'The trader\'s playbooks / setups: rules, criteria, entry models and checklists they wrote.',
      inputSchema: { type: 'object', properties: { account: ACCOUNT }, additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => { let out = []; for (const acc of await pickAccounts(ctx, a.account)) out = out.concat((await docsOf('playbooks', acc.du)).map((x) => Object.assign({ account: acc.name }, x))); return { playbooks: out }; },
    },
    {
      name: 'get_trading_rules', title: 'Trading rules',
      description: 'The trader\'s own trading rules (risk rules, checklist items). Compare them with trades\' rule checks to judge discipline.',
      inputSchema: { type: 'object', properties: { account: ACCOUNT }, additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => { let out = []; for (const acc of await pickAccounts(ctx, a.account)) out = out.concat((await docsOf('trading_rules', acc.du)).map((x) => Object.assign({ account: acc.name }, x))); return { rules: out }; },
    },
    {
      name: 'search_journal', title: 'Search the journal',
      description: 'Search trades and notes by keyword (symbol, strategy, tag, words in notes). Returns ids usable with fetch_journal_item.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for.' } }, required: ['query'], additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => {
        const q = low(a.query); if (!q) return { results: [] };
        const words = q.split(/\s+/).filter(Boolean), results = [];
        for (const acc of await pickAccounts(ctx, 'all')) {
          for (const t of (await tradesOf(acc)).slice().reverse()) {
            const hay = low([t.symbol, t.direction, t.result, t.session, t.strategy, t.emotion, t.tags.join(' '), t.mistakes, stripHtml(t._raw.notes), iso(t.ts)].join(' '));
            if (words.every((w) => hay.includes(w))) results.push({ id: 'trade:' + t.id, title: (iso(t.ts) || '').slice(0, 10) + ' ' + t.symbol + ' ' + t.direction + ' ' + t.result + ' ' + (t.pnl >= 0 ? '+' : '') + t.pnl + ' (' + acc.name + ')', url: APP_URL });
            if (results.length >= 40) break;
          }
          for (const n of await notesOf(acc)) {
            if (words.every((w) => low(n.title + ' ' + n.text).includes(w))) results.push({ id: n.ref, title: n.title + ' (' + acc.name + ' notebook)', url: APP_URL });
            if (results.length >= 60) break;
          }
        }
        return { results: results.slice(0, 60) };
      },
    },
    {
      name: 'fetch_journal_item', title: 'Fetch a journal item',
      description: 'Full content of a trade or note found with search_journal (id like "trade:…" or "note:…").',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'An id returned by search_journal.' } }, required: ['id'], additionalProperties: false }, annotations: RO,
      run: async (ctx, a) => {
        const id = S(a.id);
        if (id.startsWith('note:')) { const n = await TOOL.get_note.run(ctx, { note_id: id }); return { id, title: n.title, text: n.text, url: APP_URL, metadata: { account: n.account, folder: n.folder, updated: n.updated } }; }
        const t = await TOOL.get_trade.run(ctx, { trade_id: id });
        return { id: 'trade:' + t.id, title: t.date + ' ' + t.symbol + ' ' + t.direction + ' ' + t.result, text: JSON.stringify(t, null, 1), url: APP_URL, metadata: { account: t.account } };
      },
    },
    {
      name: 'create_note', title: 'Save a note to the notebook',
      description: 'Save a new note in the trader\'s ETW Journal notebook (e.g. a review, plan or analysis you wrote together). Only works if the trader allowed writing when creating this connector. Supports simple Markdown: # headings, - bullets, 1. lists, **bold**, *italic*, and | tables |.',
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Note title.' }, content: { type: 'string', description: 'Note body (Markdown).' }, account: { type: 'string', description: 'Account to save into (default: main journal).' } }, required: ['title', 'content'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      write: true,
      run: async (ctx, a) => {
        if (ctx.scope !== 'write') throw toolErr('This connector is read-only. The trader can create a connector with "Allow saving notes" in ETW Journal › Settings › AI Connectors.');
        const acc = (await pickAccounts(ctx, a.account || 'main'))[0];
        const title = clip(S(a.title).trim() || 'AI note', 140), md = clip(S(a.content), 60000);
        const now = Date.now();
        const ref = await db.collection('users').doc(acc.du).collection('notes').add({ uid: acc.du, title, body: md, bodyHtml: mdToHtml(md), images: [], folderId: '', created: now, updated: now, source: 'mcp', aiClient: clip(ctx.client || '', 40) });
        bust('nt:' + acc.du);
        return { saved: true, note_id: 'note:' + acc.id + ':' + ref.id, account: acc.name, title, message: 'Saved to the ' + acc.name + ' notebook in ETW Journal.' };
      },
    },
  ];
  const TOOL = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

  function mdInline(s) {
    return escHtml(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function mdToHtml(md) {
    const lines = S(md).replace(/\r/g, '').split('\n'), out = []; let list = null, tbl = null;
    const flushList = () => { if (list) { out.push('<' + list.t + '>' + list.items.map((x) => '<li>' + x + '</li>').join('') + '</' + list.t + '>'); list = null; } };
    const flushTbl = () => {
      if (!tbl) return;
      const rows = tbl.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => mdInline(c.trim()) || '<br>'));
      if (rows.length) {
        const head = rows[0], body = rows.slice(1);
        out.push('<div class="nb-tbl-wrap"><table class="nb-tbl"><thead><tr>' + head.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' + body.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      }
      tbl = null;
    };
    for (const ln of lines) {
      if (/^\s*\|.*\|\s*$/.test(ln)) { flushList(); (tbl = tbl || []).push(ln); continue; } else flushTbl();
      let m;
      if ((m = /^\s*[-*•]\s+(.*)$/.exec(ln))) { if (!list || list.t !== 'ul') { flushList(); list = { t: 'ul', items: [] }; } list.items.push(mdInline(m[1])); continue; }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(ln))) { if (!list || list.t !== 'ol') { flushList(); list = { t: 'ol', items: [] }; } list.items.push(mdInline(m[1])); continue; }
      flushList();
      if ((m = /^(#{1,3})\s+(.*)$/.exec(ln))) { out.push('<h' + (m[1].length + 1) + '>' + mdInline(m[2]) + '</h' + (m[1].length + 1) + '>'); continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) { out.push('<hr>'); continue; }
      out.push(ln.trim() ? '<p>' + mdInline(ln) + '</p>' : '<p><br></p>');
    }
    flushList(); flushTbl();
    return out.join('');
  }

  const INSTRUCTIONS = [
    'ETW Journal is a trading journal. These tools read the trader\'s own journal: closed trades, performance stats, notebook notes, playbooks, trading rules and deposits/withdrawals.',
    'Start with get_journal_overview. Use get_performance_stats with group_by to find edges and leaks (by symbol, session, strategy, weekday, hour, emotion, tag). Use search_trades then get_trade for specifics.',
    'P&L figures are in the account currency; dates are UTC ISO-8601. A trader can have several independent journal accounts (personal, prop challenge, funded) — "all" combines them, so say which account a finding comes from.',
    'Judge profitability on trading P&L versus deposits (get_cash_flows): withdrawals are not losses and deposits are not profit.',
    'Be a direct, data-driven trading coach: quote the numbers, point out patterns (overtrading, revenge trades after losses, rule breaks, weak sessions), and suggest concrete changes. This is not financial advice.',
    'create_note saves into the trader\'s notebook only if their connector allows it; ask before saving.',
  ].join('\n');

  // ════════════════════════ the MCP endpoint ════════════════════════
  function keyFrom(req) {
    const p = S(req.params && req.params.key);
    if (p) return p;
    const m = /^Bearer\s+(.+)$/i.exec(S(req.get('authorization')));
    if (m) return m[1].trim();
    return S(req.get('x-etw-key')).trim();
  }
  function rpcErr(id, code, message, data) { return { jsonrpc: '2.0', id: id === undefined ? null : id, error: Object.assign({ code, message }, data ? { data } : {}) }; }
  function text(obj) { const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1); return s.length > 240000 ? s.slice(0, 240000) + '\n…(truncated — narrow the filters or use a smaller limit)' : s; }
  const _planCache = new Map();
  async function planFast(uid) {
    const c = _planCache.get(uid); if (c && c.exp > Date.now()) return c.p;
    const p = await planGate(uid); _planCache.set(uid, { p, exp: Date.now() + (p === 'unknown' ? 15e3 : 5 * 60e3) }); return p;
  }

  async function handle(msg, ctx) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcErr(msg && msg.id, -32600, 'Invalid Request');
    const id = msg.id, isNote = !('id' in msg);
    const P = msg.params || {};
    try {
      switch (msg.method) {
        case 'initialize': {
          const want = S(P.protocolVersion);
          ctx.client = S(P.clientInfo && P.clientInfo.name);
          return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } };
        }
        case 'notifications/initialized': case 'notifications/cancelled': case 'notifications/progress': case 'notifications/roots/list_changed':
          return null;
        case 'ping': return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list': {
          const list = TOOLS.filter((t) => !t.write || ctx.scope === 'write').map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: Object.assign({ title: t.title }, t.annotations) }));
          return { jsonrpc: '2.0', id, result: { tools: list } };
        }
        case 'tools/call': {
          const t = TOOL[S(P.name)];
          if (!t || (t.write && ctx.scope !== 'write')) return rpcErr(id, -32602, 'Unknown tool: ' + S(P.name));
          const plan = await planFast(ctx.uid);
          if (plan === 'unknown') return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'ETW Journal could not check the subscription just now. Try again in a moment.' }] } };
          if (!plan) return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'This ETW Journal account is not on the Pro or Ultra plan, so AI connectors are paused. The trader can upgrade in the app to turn this connector back on.' }] } };
          ctx.plan = plan;
          if (limited('call:' + ctx.hash, 90, 60e3)) return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Too many requests in a minute. Wait a little and try again.' }] } };
          const args = (P.arguments && typeof P.arguments === 'object') ? P.arguments : {};
          try {
            const out = await t.run(ctx, args);
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text(out) }] } };
          } catch (e) {
            if (!e.tool) console.error('[mcp] tool', t.name, e && e.message);
            return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.tool ? e.message : 'ETW Journal hit an error reading that. Please try again.' }] } };
          }
        }
        case 'resources/list': return { jsonrpc: '2.0', id, result: { resources: [] } };
        case 'resources/templates/list': return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
        case 'prompts/list': return { jsonrpc: '2.0', id, result: { prompts: [] } };
        default:
          if (isNote || msg.method.startsWith('notifications/')) return null;
          return rpcErr(id, -32601, 'Method not found: ' + msg.method);
      }
    } catch (e) {
      console.error('[mcp]', msg.method, e && e.message);
      return rpcErr(id, -32603, 'Internal error');
    }
  }

  async function endpoint(req, res) {
    res.set('Cache-Control', 'no-store');
    const key = keyFrom(req);
    const unauthorized = (why) => res.status(401).json(rpcErr(null, -32001, why));
    if (!key) return unauthorized('Missing ETW Journal connector key. Create one in ETW Journal › Settings › AI Connectors and use the full connector URL.');
    if (limited('ip:' + sha(key).slice(0, 16), 240, 60e3)) return res.status(429).json(rpcErr(null, -32002, 'Too many requests. Slow down a little.'));
    let rec;
    try { rec = await resolveKey(key); } catch (e) { console.error('[mcp] key lookup', e.message); return res.status(503).json(rpcErr(null, -32603, 'ETW Journal is temporarily unavailable.')); }
    if (!rec) return unauthorized('This ETW Journal connector key is not valid or was revoked. Create a new one in Settings › AI Connectors.');
    const ctx = { uid: rec.uid, scope: rec.scope === 'write' ? 'write' : 'read', hash: rec.hash, client: S(req.get('user-agent')).slice(0, 60) };
    const body = req.body;
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];
    if (!msgs.length || msgs.length > 20) return res.status(400).json(rpcErr(null, -32600, 'Invalid Request'));
    const replies = [];
    for (const m of msgs) { const r = await handle(m, ctx); if (r) replies.push(r); }
    touch(rec, ctx.client);
    if (!replies.length) return res.status(202).end();
    res.set('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify(batch ? replies : replies[0]));
  }

  const paths = ['/mcp', '/mcp/:key'];
  app.post(paths, endpoint);
  // No server-initiated stream and no sessions: GET / DELETE are not used.
  app.get(paths, (req, res) => res.status(405).set('Allow', 'POST').json(rpcErr(null, -32000, 'Use POST. ETW Journal MCP endpoint (streamable HTTP, JSON responses).')));
  app.delete(paths, (req, res) => res.status(405).set('Allow', 'POST').end());
}

module.exports = { mount };
