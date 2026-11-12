// ════════════════════════════════════════════════════════════════════════════
//  ETW Journal — Verified Track Record
//
//  Proof of performance built ONLY from data this backend (or the app's own
//  broker sync) pulled straight from a broker or prop firm. The whole check
//  runs here on the server with the Admin SDK, so nothing in the app can set,
//  fake or widen a verification.
//
//  What counts as verified
//    · the account is connected by autosync (ETW EA, hosted worker, MetaApi
//      direct, cTrader Open API) — never by upload
//    · the connection is real money: a live broker server or a paid prop firm
//      account (demo / trial / practice / contest servers are rejected)
//    · the trade itself carries an autosync source tag and still matches the
//      broker's own values (stats are computed from the synced docs, so user
//      edits to notes etc. don't change the numbers that matter)
//
//  What is always excluded
//    · demo accounts and prop firm free trials
//    · manually added trades (and AI-logged ones), even in a verified account
//    · file imports: MT5 HTML reports, CSV / Notion imports
//
//  GET  /api/track-record           → every journal account, each with a
//                                     verification status, broker identity,
//                                     verified-only stats and equity curve,
//                                     plus the owner's public-share state.
//  POST /api/track-record/share     → { enabled } turn the public report link
//                                     on / off (token lives only on the server).
//  GET  /api/track-record/public/:token → the report for anyone with the link:
//                                     recomputed live, balances and raw
//                                     server names left out, no auth.
//  Share docs: trackRecordShares/{token} { uid, enabled, createdAt, views } —
//  Admin SDK only (the catch-all Firestore rule denies clients).
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

const S = (v) => (v == null ? '' : String(v));
const low = (v) => S(v).trim().toLowerCase();
const num = (v) => { if (typeof v === 'number') return isFinite(v) ? v : 0; const n = parseFloat(S(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (v) => Math.round((+v || 0) * 100) / 100;
const iso = (ms) => { try { return ms ? new Date(ms).toISOString() : null; } catch (e) { return null; } };
const day = (ms) => (iso(ms) || '').slice(0, 10);

const SEP = '__';
// Autosync source tags the app and this backend stamp on broker-pulled trades.
const SYNCED = /^(mt[45](-ea|-direct|-live)?|ctrader_open_api)$/;
// File-based imports are editable before upload, so they never verify.
const FILEISH = /^(mt5-report|file-import|csv|notion)$/;
// Server names that mean "not real money" at every broker / prop firm.
const DEMO_RE = /demo|trial|practice|contest|tryout|paper/i;
const STALE_MS = 7 * 86400000;        // older than this → "verified up to <date>"

function mask(login) { const s = S(login).replace(/\s+/g, ''); return s ? '••' + s.slice(-4) : ''; }
function brandOf(name) {
  let t = S(name).trim().split(/[\s]/)[0].split(/[-_.]/)[0];
  t = t.replace(/(server|live|real|mt[45])\d*$/i, '').replace(/\d+$/, '');
  return t || S(name).trim().slice(0, 24);
}

function stats(list) {
  const n = list.length;
  if (!n) return { trades: 0 };
  let wins = 0, losses = 0, be = 0, gw = 0, gl = 0, net = 0, peak = 0, eq = 0, mdd = 0, curW = 0, curL = 0, maxW = 0, maxL = 0, best = null, worst = null;
  const days = new Map();
  for (const t of list) {
    const p = t.pnl; net += p; eq += p; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq);
    if (t.result === 'WIN') { wins++; curW++; curL = 0; } else if (t.result === 'LOSS') { losses++; curL++; curW = 0; } else be++;
    maxW = Math.max(maxW, curW); maxL = Math.max(maxL, curL);
    if (p > 0) gw += p; else if (p < 0) gl += -p;
    if (!best || p > best.pnl) best = t; if (!worst || p < worst.pnl) worst = t;
    const k = day(t.ts); days.set(k, (days.get(k) || 0) + p);
  }
  const dec = wins + losses;
  return {
    trades: n, wins, losses, breakeven: be,
    winRate: dec ? r2(wins / dec * 100) : null,
    netPnl: r2(net), grossProfit: r2(gw), grossLoss: r2(-gl),
    profitFactor: gl ? r2(gw / gl) : (gw ? 'no losses' : 0),
    avgWin: wins ? r2(gw / wins) : null, avgLoss: losses ? r2(-gl / losses) : null,
    expectancyPerTrade: r2(net / n), maxDrawdown: r2(-mdd),
    longestWinStreak: maxW, longestLossStreak: maxL,
    bestTrade: best ? { pnl: r2(best.pnl), symbol: best.symbol, date: day(best.ts) } : null,
    worstTrade: worst ? { pnl: r2(worst.pnl), symbol: worst.symbol, date: day(worst.ts) } : null,
    tradingDays: days.size,
    greenDays: [...days.values()].filter((v) => v > 0).length,
    redDays: [...days.values()].filter((v) => v < 0).length,
    from: day(list[0].ts), to: day(list[n - 1].ts),
  };
}
function curveOf(list) {
  const b = new Map();
  for (const t of list) { const k = day(t.ts); const x = b.get(k) || { pnl: 0, trades: 0 }; x.pnl += t.pnl; x.trades++; b.set(k, x); }
  let cum = 0;
  const pts = [...b.entries()].sort((a, c) => a[0].localeCompare(c[0]))
    .map(([k, x]) => { cum += x.pnl; return { d: k, pnl: r2(x.pnl), cum: r2(cum), trades: x.trades }; });
  return pts.length > 366 ? pts.slice(-366) : pts;
}

function mount(app, opts) {
  const { db, requireAuth, getUser } = opts;
  const publicBase = () => S(process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || 'https://etwappmeta5-2.onrender.com').replace(/\/+$/, '');

  const _cache = new Map();
  const cached = async (key, ttl, fn) => {
    const hit = _cache.get(key); if (hit && hit.exp > Date.now()) return hit.val;
    const val = await fn(); _cache.set(key, { val, exp: Date.now() + ttl });
    if (_cache.size > 300) _cache.delete(_cache.keys().next().value);
    return val;
  };

  async function accountsOf(uid) {
    let docs = [];
    try { const s = await db.collection('users').doc(uid).collection('accounts').orderBy('created', 'asc').get(); docs = s.docs.map((d) => Object.assign({ id: d.id }, d.data() || {})); } catch (e) {}
    if (!docs.length) return [{ id: 'main', name: 'Main journal', du: uid }];
    return docs.map((d, i) => ({ id: d.id, name: S(d.name || (i === 0 ? 'Main journal' : 'Account ' + (i + 1))), du: i === 0 ? uid : uid + SEP + d.id }));
  }

  // ── every autosync connection of one journal account, with live / demo decided here ──
  async function connectionsOf(du) {
    const out = [];
    try {
      const [bp, u] = await Promise.all([db.collection('brokerPositions').doc(du).get(), db.collection('users').doc(du).get()]);
      const d = bp.exists ? (bp.data() || {}) : {};
      const seen = new Set();
      [['mt5', d.mt5 || {}, null], ['mt5api', d.mt5api || {}, 'MetaApi direct']].forEach(([k, m, viaFix]) => Object.keys(m).forEach((slot) => {
        const x = m[slot] || {}; if (!x.login && !x.server) return;
        const key = S(x.login) + '|' + S(x.server); if (seen.has(key)) return; seen.add(key);
        const server = S(x.server);
        out.push({
          kind: 'MT5', via: viaFix || (x.hosted ? 'Hosted sync' : 'ETW EA'),
          server, login: S(x.login), loginMasked: mask(x.login), label: (server + ' ' + S(x.login)).trim(),
          brand: brandOf(server) || 'MT5', live: !DEMO_RE.test(server), demoReason: DEMO_RE.test(server) ? 'The broker server "' + server + '" is a demo / trial server.' : '',
          lastSync: +x.at || 0, balance: x.balance != null ? r2(num(x.balance)) : undefined, currency: S(x.currency) || undefined,
        });
      }));
      const ct = (u.exists && (u.data() || {}).ctrader) || {};
      if (ct.status === 'connected') {
        const cb = ct.cashBalances || {};
        Object.keys(cb).forEach((id) => {
          const b = cb[id] || {};
          const label = S(b.label || ('cTrader ' + id));
          out.push({
            kind: 'cTrader', via: 'cTrader Open API',
            server: '', login: S(id), loginMasked: mask(id), label,
            brand: brandOf(label) || 'cTrader', live: !!b.live && !DEMO_RE.test(label), demoReason: !b.live ? 'cTrader reports this as a demo environment account.' : (DEMO_RE.test(label) ? 'The account label "' + label + '" marks it as demo / trial.' : ''),
            lastSync: +b.at || 0, balance: b.balance != null ? r2(num(b.balance)) : undefined,
          });
        });
      }
    } catch (e) {}
    return out;
  }

  // ── trades of one journal account, classified by provenance ──
  async function tradesOf(du) {
    const s = await db.collection('trades').where('uid', '==', du).get();
    const rows = s.docs.map((d) => Object.assign({ id: d.id }, d.data() || {}))
      .filter((t) => t && S(t.result).toUpperCase() !== 'OPEN' && !t.loadingPlaceholder && !S(t.id).startsWith('demo-'));
    const groups = new Map(), flat = [];
    for (const t of rows) { if (t.mergeGroup) { const g = groups.get(t.mergeGroup) || []; g.push(t); groups.set(t.mergeGroup, g); } else flat.push([t, null]); }
    for (const g of groups.values()) flat.push([g.find((x) => x.mergePrimary) || g[0], g]);
    return flat.map(([t, g]) => {
      const pnl = g ? g.reduce((sum, x) => sum + num(x.pnl), 0) : num(t.pnl);
      const c = Date.parse(t.closeTime || '');
      const ts = isFinite(c) ? c : (num(t.tradeDate) || Date.parse(t.tradeDate || '') || num(t.createdAt) || 0);
      const res = S(t.result).toUpperCase();
      return {
        id: t.id, ts, pnl: r2(pnl),
        result: (res === 'WIN' || res === 'LOSS') ? res : (res === 'BREAKEVEN' || res === 'BE') ? 'BREAKEVEN' : (pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAKEVEN'),
        symbol: S(t.pair || t.symbol).toUpperCase(), direction: S(t.direction).toUpperCase(),
        source: low(t.source), execSource: low(t.execSource),
        vVoid: !!(t.vVoid || (g && g.some((x) => x.vVoid))),
        vPnl: g ? null : (t.vPnl != null && isFinite(num(t.vPnl)) ? r2(num(t.vPnl)) : null),
        rawResult: res, merged: !!g,
        hay: low([t.brokerAccount, t.mt5AccountKey, t.extId, t.sourceTradeId, t.brokerName].map(S).join(' ')),
      };
    }).sort((a, b) => a.ts - b.ts);
  }

  function classify(t) {
    if (t.source === 'demo') return 'demo';
    if (SYNCED.test(t.source)) return 'synced';
    if (FILEISH.test(t.execSource) || FILEISH.test(t.source)) return 'fileImport';
    return 'manual';                                   // hand-entered, AI-logged, everything else
  }

  async function buildAccount(acc) {
    const [conns, trades] = await Promise.all([connectionsOf(acc.du), tradesOf(acc.du)]);
    const liveConns = conns.filter((c) => c.live), demoConns = conns.filter((c) => !c.live);
    const excluded = { manual: 0, fileImport: 0, demo: 0, edited: 0, unattributed: 0 };
    const included = [];
    for (const t of trades) {
      const kind = classify(t);
      if (kind === 'manual') { excluded.manual++; continue; }
      if (kind === 'fileImport') { excluded.fileImport++; continue; }
      if (kind === 'demo') { excluded.demo++; continue; }
      // null and void: the trader edited the Result or Net P&L of a synced trade.
      // vVoid is stamped by the app's edit form; vPnl is the broker's own figure
      // stamped at sync time, so a P&L that no longer matches it is an edit even
      // if the stamp was dodged; a WIN with a negative P&L (or the reverse) is an
      // edited Result for the same reason.
      if (t.vVoid) { excluded.edited++; continue; }
      if (t.vPnl != null && Math.abs(t.vPnl - t.pnl) > 0.01) { excluded.edited++; continue; }
      if (!t.merged && ((t.rawResult === 'WIN' && t.pnl < -0.009) || (t.rawResult === 'LOSS' && t.pnl > 0.009))) { excluded.edited++; continue; }
      // synced: make sure it did not come from a demo connection of this account
      if (DEMO_RE.test(t.hay)) { excluded.demo++; continue; }
      const hitsDemo = demoConns.some((c) => (c.login && t.hay.includes(low(c.login))) || (c.label && t.hay.includes(low(c.label))) || (c.server && t.hay.includes(low(c.server))));
      if (hitsDemo) { excluded.demo++; continue; }
      if (demoConns.length) {
        const hitsLive = liveConns.some((c) => (c.login && t.hay.includes(low(c.login))) || (c.label && t.hay.includes(low(c.label))) || (c.server && t.hay.includes(low(c.server))));
        if (!hitsLive) { excluded.unattributed++; continue; }   // demo is attached and this trade can't prove it's from a live login
      }
      included.push(t);
    }
    const lastSync = liveConns.reduce((m, c) => Math.max(m, c.lastSync || 0), 0);
    let status, asOf = null; const reasons = [];
    if (!conns.length && !included.length) {
      status = 'not_connected';
      reasons.push('No broker or prop firm autosync is connected to this account.');
      if (excluded.manual) reasons.push(excluded.manual + ' manually added trade' + (excluded.manual === 1 ? '' : 's') + ' can\'t be verified.');
      if (excluded.edited) reasons.push(excluded.edited + ' synced trade' + (excluded.edited === 1 ? ' was' : 's were') + ' voided because the Result or Net P&L was edited.');
      if (excluded.fileImport) reasons.push(excluded.fileImport + ' file-imported trade' + (excluded.fileImport === 1 ? '' : 's') + ' (reports / CSV / Notion) can\'t be verified.');
    } else if (!liveConns.length && demoConns.length) {
      status = 'demo';
      demoConns.forEach((c) => { if (c.demoReason) reasons.push(c.demoReason); });
      reasons.push('Demo accounts and prop firm free trials never verify.');
    } else if (!included.length && liveConns.length) {
      status = 'no_synced_trades';
      reasons.push('The live connection is verified, but no broker-synced closed trades have arrived yet.');
      if (excluded.manual) reasons.push(excluded.manual + ' manually added trade' + (excluded.manual === 1 ? '' : 's') + ' stay' + (excluded.manual === 1 ? 's' : '') + ' outside the record.');
    } else if (!conns.length && included.length) {
      status = 'verified_up_to'; asOf = included[included.length - 1].ts;
      reasons.push('The broker connection is gone, so the record is frozen at the last synced trade.');
    } else {
      const stale = lastSync && (Date.now() - lastSync > STALE_MS);
      status = stale ? 'verified_up_to' : 'verified';
      if (stale) { asOf = lastSync; reasons.push('The sync has not reported for more than 7 days.'); }
    }
    const verified = status === 'verified' || status === 'verified_up_to';
    return {
      id: acc.id, name: acc.name, status, verified, asOf: asOf ? iso(asOf) : null, reasons,
      connections: conns.map((c) => ({ kind: c.kind, via: c.via, brand: c.brand, label: c.label, server: c.server || undefined, loginMasked: c.loginMasked, live: c.live, lastSync: c.lastSync ? iso(c.lastSync) : null, balance: c.balance, currency: c.currency })),
      stats: verified ? stats(included) : { trades: 0 },
      curve: verified ? curveOf(included) : [],
      trades: verified ? included.slice(-400).reverse().map((t) => ({ id: t.id, date: iso(t.ts), symbol: t.symbol, direction: t.direction || undefined, result: t.result, pnl: t.pnl, merged: t.merged || undefined })) : [],
      tradesTruncated: verified && included.length > 400 ? included.length : undefined,
      excluded,
      _included: included,
    };
  }

  // ── public share link ──
  const shares = () => db.collection('trackRecordShares');
  const APP_URL = () => S(process.env.PUBLIC_APP_URL || 'https://etwiz.space').replace(/\/+$/, '');
  const b62 = (buf) => { const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; let o = ''; for (const b of buf) o += A[b % 62]; return o; };
  async function shareOf(uid) {
    const snap = await shares().where('uid', '==', uid).limit(1).get();
    if (snap.empty) return null;
    const d = snap.docs[0]; return Object.assign({ token: d.id }, d.data() || {});
  }
  function shareView(sh) {
    return sh ? { enabled: !!sh.enabled, token: sh.enabled ? sh.token : undefined, url: sh.enabled ? APP_URL() + '/track/' + sh.token : undefined, views: sh.views || 0, createdAt: iso(sh.createdAt) } : { enabled: false, views: 0 };
  }
  const _hits = new Map();
  function limited(id, max, windowMs) {
    const now = Date.now(), k = id + ':' + Math.floor(now / windowMs);
    const n = (_hits.get(k) || 0) + 1; _hits.set(k, n);
    if (_hits.size > 5000) { for (const kk of _hits.keys()) if (!kk.endsWith(':' + Math.floor(now / windowMs))) _hits.delete(kk); }
    return n > max;
  }
  // The trader's name and profile picture, exactly as set in the app
  // (Settings › Profile): users/{uid}/profile/avatar first, then the sign-in profile.
  const okPhoto = (p) => (/^https:\/\/[^\s"'<>]{8,2000}$/.test(p) || (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(p) && p.length < 600000)) ? p : '';
  async function traderOf(uid) {
    let name = '', photo = '';
    try { const a = await db.collection('users').doc(uid).collection('profile').doc('avatar').get(); if (a.exists) photo = okPhoto(S((a.data() || {}).photoURL)); } catch (e) {}
    try { const u = await db.collection('users').doc(uid).get(); const d = u.exists ? (u.data() || {}) : {}; name = S(d.displayName || d.name || d.fullName || (d.profile && d.profile.name)); if (!photo) photo = okPhoto(S(d.photoURL || (d.profile && d.profile.photoURL))); } catch (e) {}
    if ((!name || !photo) && typeof getUser === 'function') { try { const r = await getUser(uid); if (!name) name = S(r && r.displayName); if (!photo) photo = okPhoto(S(r && r.photoURL)); } catch (e) {} }
    if (!name) { try { const l = await db.collection('leaderboardProfiles').doc(uid).get(); if (l.exists) name = S((l.data() || {}).displayName); } catch (e) {} }
    return { name: name.trim().slice(0, 60) || 'ETW Journal trader', photo };
  }
  async function buildAll(uid) {
    const accounts = [];
    for (const acc of await accountsOf(uid)) accounts.push(await buildAccount(acc));
    const verified = accounts.filter((a) => a.verified);
    const all = verified.reduce((arr, a) => arr.concat(a._included), []).sort((a, b) => a.ts - b.ts);
    return {
      overall: {
        status: verified.length ? (verified.some((a) => a.status === 'verified') ? 'verified' : 'verified_up_to') : 'not_verified',
        verifiedAccounts: verified.length, totalAccounts: accounts.length,
        stats: stats(all), curve: curveOf(all),
      },
      accounts: accounts.map((a) => { const x = Object.assign({}, a); delete x._included; return x; }),
    };
  }

  app.post('/api/track-record/share', requireAuth, async (req, res) => {
    try {
      const enable = !!(req.body && req.body.enabled);
      let sh = await shareOf(req.uid);
      if (enable && !sh) {
        const token = b62(crypto.randomBytes(18));
        await shares().doc(token).set({ uid: req.uid, enabled: true, createdAt: Date.now(), views: 0 });
        sh = { token, uid: req.uid, enabled: true, createdAt: Date.now(), views: 0 };
      } else if (sh && sh.enabled !== enable) {
        await shares().doc(sh.token).set({ enabled: enable, updatedAt: Date.now() }, { merge: true });
        sh.enabled = enable;
      }
      _cache.delete('tr:' + req.uid);
      res.json(Object.assign({ ok: true }, shareView(sh)));
    } catch (e) { console.error('[track-record] share', e.message); res.status(500).json({ error: 'Could not update the public link.' }); }
  });

  app.get('/api/track-record/public/:token', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const token = S(req.params.token);
      if (!/^[A-Za-z0-9]{12,40}$/.test(token)) return res.status(404).json({ error: 'This track record link is not valid.' });
      if (limited('pub:' + (req.ip || 'x'), 60, 60e3)) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
      const snap = await shares().doc(token).get();
      const sh = snap.exists ? (snap.data() || {}) : null;
      if (!sh || !sh.enabled) return res.status(404).json({ error: 'This track record is not shared (the trader may have turned the link off).' });
      const data = await cached('pub:' + sh.uid, 60e3, async () => {
        const [b, trader] = await Promise.all([buildAll(sh.uid), traderOf(sh.uid)]);
        return {
          ok: true, generatedAt: new Date().toISOString(), verifiedBy: 'ETW Journal', trader,
          policy: 'Built only from live, autosynced broker and prop firm data. Demo accounts, free trials, manual entries and file imports are never included. Computed on the ETW Journal server from the broker\'s own values.',
          overall: b.overall,
          accounts: b.accounts.map((a) => ({
            id: a.id, name: a.name, status: a.status, verified: a.verified, asOf: a.asOf, reasons: a.reasons,
            connections: (a.connections || []).map((c) => ({ kind: c.kind, via: c.via, brand: c.brand, live: c.live, loginMasked: c.loginMasked, lastSync: c.lastSync })),
            stats: a.stats, curve: a.curve, excluded: a.excluded,   // no trade list on the public JSON — summary only
          })),
        };
      });
      shares().doc(token).set({ views: (sh.views || 0) + 1, lastViewAt: Date.now() }, { merge: true }).catch(() => {});
      res.json(data);
    } catch (e) { console.error('[track-record] public', e.message); res.status(500).json({ error: 'Could not load this track record right now.' }); }
  });

  app.get('/api/track-record', requireAuth, async (req, res) => {
    try {
      const data = await cached('tr:' + req.uid, 60e3, async () => {
        const [b, sh, trader] = await Promise.all([buildAll(req.uid), shareOf(req.uid), traderOf(req.uid)]);
        return {
          ok: true, requestedAt: new Date().toISOString(), trader,
          policy: 'Live autosynced broker and prop firm data only. Demo accounts, free trials, manual entries and file imports are never included, and a synced trade whose Result or Net P&L was edited is void. Computed server-side from the broker\'s own synced values.',
          overall: b.overall, accounts: b.accounts, share: shareView(sh),
        };
      });
      res.set('Cache-Control', 'no-store');
      res.json(data);
    } catch (e) {
      console.error('[track-record]', e.message);
      res.status(500).json({ error: 'Could not build the track record right now. Please try again.' });
    }
  });

  // ══ public report page renderer ════════════════════════════════════════
  const esc = (v) => S(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function svgCurve(curve) {
    if (!curve || curve.length < 2) return '';
    const W = 1040, H = 260, P = 10;
    const vals = curve.map((p) => +p.cum || 0);
    const min = Math.min(0, ...vals), max = Math.max(0, ...vals), span = (max - min) || 1;
    const x = (i) => P + i * (W - 2 * P) / (curve.length - 1);
    const y = (v) => P + (H - 2 * P) * (1 - (v - min) / span);
    const pts = vals.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const up = vals[vals.length - 1] >= 0, col = up ? '#22C55E' : '#EF4444';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:230px;display:block">'
      + '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + col + '" stop-opacity=".25"/><stop offset="1" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>'
      + '<polygon points="' + P + ',' + y(Math.max(min, 0)) + ' ' + pts + ' ' + x(curve.length - 1).toFixed(1) + ',' + (H - P) + ' ' + P + ',' + (H - P) + '" fill="url(#g)"/>'
      + '<polyline points="' + pts + '" fill="none" stroke="' + col + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }
  const fmt$ = (v) => { if (v == null || !isFinite(+v)) return '—'; const n = Math.round(+v); return (n < 0 ? '-$' : '+$') + Math.abs(n).toLocaleString('en-US'); };
  const fmtD = (d) => { try { return d ? new Date(d.length > 10 ? d : d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; } catch (e) { return S(d); } };
  // broker / prop firm logo for the public page: favicon of the brand's own site (same map the app uses)
  const BROKER_SITES = { pepperstone:'pepperstone.com', icmarkets:'icmarkets.com', ictrading:'ictrading.com', ftmo:'ftmo.com', fundednext:'fundednext.com', the5ers:'the5ers.com', fivepercent:'the5ers.com', fundingpips:'fundingpips.com', e8markets:'e8markets.com', e8funding:'e8markets.com', alphacapital:'alphacapitalgroup.uk', fxify:'fxify.com', fundedtradingplus:'fundedtradingplus.com', blueberry:'blueberrymarkets.com', exness:'exness.com', xmglobal:'xm.com', xmtrading:'xm.com', fpmarkets:'fpmarkets.com', vantage:'vantagemarkets.com', tickmill:'tickmill.com', roboforex:'roboforex.com', octafx:'octafx.com', octa:'octa.com', hfmarkets:'hfm.com', hotforex:'hfm.com', hfm:'hfm.com', deriv:'deriv.com', oanda:'oanda.com', admiral:'admiralmarkets.com', fxpro:'fxpro.com', thinkmarkets:'thinkmarkets.com', axi:'axi.com', eightcap:'eightcap.com', forextime:'forextime.com', fxtm:'forextime.com', avatrade:'avatrade.com', fusionmarkets:'fusionmarkets.com', spotware:'spotware.com', skilling:'skilling.com', fxopen:'fxopen.com', justmarkets:'justmarkets.com', instaforex:'instaforex.com', startrader:'startrader.com', puprime:'puprime.com', ftuk:'ftuk.com', goatfunded:'goatfundedtrader.com', aquafunded:'aquafunded.com', instantfunding:'instantfunding.com', fundingtraders:'fundingtraders.com', maven:'maventrading.com', blueguardian:'blueguardian.com', audacity:'audacitycapital.co.uk', scopemarkets:'scopemarkets.com', equiti:'equiti.com', windsor:'windsorbrokers.com', fxpesa:'fxpesa.com', egmsecurities:'fxpesa.com', ebc:'ebc.com', atfx:'atfx.com', ironfx:'ironfx.com', mexatlantic:'mexatlantic.com', multibank:'multibankfx.com', capital:'capital.com', plus500:'plus500.com', fxcm:'fxcm.com', ig:'ig.com', cmc:'cmcmarkets.com', darwinex:'darwinex.com', fundedpeaks:'fundedpeaks.com', fintokei:'fintokei.com', breakout:'breakoutprop.com', topstep:'topstep.com', apex:'apextraderfunding.com', cityindex:'cityindex.com', interactivebrokers:'interactivebrokers.com', swissquote:'swissquote.com', trading212:'trading212.com', libertex:'libertex.com', weltrade:'weltrade.com', headway:'hw.site', lirunex:'lirunex.com' };
  function brokerLogo(brand, label) {
    const txt = low(S(brand) + ' ' + S(label)).replace(/[^a-z0-9]/g, '');
    const keys = Object.keys(BROKER_SITES).sort((a, b) => b.length - a.length);
    for (const k of keys) { if (k.length < 3) continue; if (txt.indexOf(k) === 0 || (k.length >= 5 && txt.indexOf(k) >= 0)) return 'https://www.google.com/s2/favicons?domain=' + BROKER_SITES[k] + '&sz=128'; }
    return '';
  }
  function badgeHtml(status, asOf) {
    if (status === 'verified') return '<span class="bd ok">✓ VERIFIED</span>';
    if (status === 'verified_up_to') return '<span class="bd up">VERIFIED UP TO ' + esc(fmtD(asOf)) + '</span>';
    return '<span class="bd no">NOT VERIFIED</span>';
  }
  function sharePage(doc) {
    const sn = doc.snapshot || {}, o = sn.overall || {}, st = o.stats || {};
    const kpi = (l, v, cls) => '<div class="k"><span>' + l + '</span><b class="' + (cls || '') + '">' + v + '</b></div>';
    const accRows = (sn.accounts || []).map((a) => {
      const c = (a.connections || [])[0] || {}; const as = a.stats || {};
      return '<div class="acc">'
        + '<div class="at"><i>' + (brokerLogo(c.brand, c.label) ? '<img src="' + esc(brokerLogo(c.brand, c.label)) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">' : '') + esc((c.brand || a.name || 'E').slice(0, 2).toUpperCase()) + '</i>'
        + '<div class="an"><b>' + esc(c.brand || a.name) + '</b><span>' + esc(a.name) + (c.server ? ' · ' + esc(c.server) : c.label ? ' · ' + esc(c.label) : '') + (c.loginMasked ? ' ' + esc(c.loginMasked) : '') + '</span></div>'
        + (c.kind ? '<em class="tag ' + (c.live ? 'lv' : 'dm') + '">' + (c.live ? 'LIVE' : 'DEMO') + '</em><em class="tag">' + esc(c.kind === 'cTrader' ? 'cTrader' : 'MT5') + '</em>' : '')
        + badgeHtml(a.status, a.asOf) + '</div>'
        + (a.verified && as.trades
          ? '<div class="am">' + kpi('Trades', as.trades) + kpi('Win rate', as.winRate == null ? '—' : as.winRate + '%') + kpi('Net P&L', fmt$(as.netPnl), as.netPnl >= 0 ? 'g' : 'r') + kpi('Profit factor', esc(S(as.profitFactor))) + kpi('Max DD', fmt$(as.maxDrawdown), 'r') + kpi('Period', esc(fmtD(as.from)) + ' – ' + esc(fmtD(as.to))) + '</div>'
          : '<div class="why">' + (a.reasons || []).map((r) => '<p>• ' + esc(r) + '</p>').join('') + '</div>')
        + '</div>';
    }).join('');
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
      + '<title>' + esc(doc.name) + ' — Verified Track Record · ETW Journal</title><style>'
      + ':root{color-scheme:dark}*{box-sizing:border-box;margin:0}body{font-family:Inter,system-ui,-apple-system,sans-serif;background:#0b0c12;color:#f3f4f8;padding:28px 16px 48px}'
      + '.w{max-width:960px;margin:0 auto}.hd{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}'
      + '.lg{width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,#16a34a,#0ea5e9);display:grid;place-items:center;font-weight:900;font-size:15px;color:#fff}'
      + '.hd h1{font-size:19px;letter-spacing:-.01em}.hd p{font-size:12px;color:#8b8e98}.hd .sp{margin-left:auto;display:flex;gap:8px;align-items:center}'
      + '.btn{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#f3f4f8;border-radius:9px;padding:8px 14px;font:700 12px Inter;cursor:pointer}'
      + '.card{background:#15161c;border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:20px;margin-bottom:14px}'
      + '.bd{display:inline-block;padding:6px 12px;border-radius:999px;font:800 11px Inter;letter-spacing:.08em}'
      + '.bd.ok{background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff}.bd.up{background:linear-gradient(135deg,#f59e0b,#fbbf24);color:#1f1300}.bd.no{background:rgba(255,255,255,.07);color:#9a9da8;border:1px solid rgba(255,255,255,.14)}'
      + '.top{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px}.top h2{font-size:17px;margin:8px 0 3px}.top p{font-size:12px;color:#8b8e98}'
      + '.net{margin-left:auto;text-align:right}.net span{font:800 10px Inter;letter-spacing:.12em;color:#8b8e98}.net b{display:block;font-size:28px;font-variant-numeric:tabular-nums}'
      + '.ks{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.09);border-radius:13px;overflow:hidden;margin-bottom:16px}'
      + '.k{background:#15161c;padding:11px 13px;min-width:0}.k span{display:block;font:700 9px Inter;letter-spacing:.1em;color:#8b8e98;text-transform:uppercase;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.k b{font-size:15px;font-variant-numeric:tabular-nums;white-space:nowrap}.k b.g{color:#22C55E}.k b.r{color:#EF4444}'
      + '.ch{background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);border-radius:13px;padding:10px}'
      + '.acc{border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:14px;margin-bottom:10px;background:#15161c}'
      + '.at{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.at i{width:38px;height:38px;border-radius:10px;background:rgba(255,255,255,.08);display:grid;place-items:center;font:800 13px Inter;font-style:normal}'
      + '.at i{position:relative;overflow:hidden}.at i img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:5px;background:#fff;box-sizing:border-box}.an{flex:1 1 150px;min-width:150px}.an b{display:block;font-size:14px}.an span{font-size:11px;color:#8b8e98}'
      + '.tag{font:800 9px Inter;letter-spacing:.07em;border-radius:4px;padding:4px 7px;font-style:normal;background:rgba(255,255,255,.07);color:#c7c9d1}.tag.lv{background:#1f9d55;color:#fff}.tag.dm{background:#8a8f98;color:#fff}'
      + '.am{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.09);border-radius:11px;overflow:hidden;margin-top:11px}'
      + '.am .k b{font-size:13px}.why{margin-top:10px}.why p{font-size:12px;color:#9a9da8;line-height:1.6}'
      + '.ft{font-size:11px;color:#70737e;line-height:1.7;margin-top:18px}'
      + '@media(max-width:640px){.ks,.am{grid-template-columns:repeat(2,1fr)}.net b{font-size:22px}}'
      + '@media print{:root{color-scheme:light}body{background:#fff;color:#0f172a;padding:0}.card,.acc,.k,.am .k{background:#fff}.card,.acc,.ch{border-color:#d8dbe2}.k span,.hd p,.top p,.an span,.ft,.why p{color:#475267}.btn,.sp{display:none}.bd.no{color:#475267}}'
      + '</style></head><body><div class="w">'
      + '<div class="hd"><div class="lg">' + (doc.photo ? '<img src="' + esc(doc.photo) + '" alt="" referrerpolicy="no-referrer" style="width:42px;height:42px;border-radius:12px;display:block;object-fit:cover" onerror="this.remove()">' : '<img src="https://etwiz.space/etw-logo-192.png" alt="ETW" style="width:42px;height:42px;border-radius:12px;display:block" onerror="this.replaceWith(document.createTextNode(\'ETW\'))">') + '</div><div><h1>' + esc(doc.name) + ' — Verified Track Record</h1><p>ETW Journal · generated ' + esc(fmtD(new Date(doc.createdAt || Date.now()).toISOString())) + '</p></div>'
      + '<div class="sp"><button class="btn" onclick="window.print()">Download PDF</button></div></div>'
      + '<div class="card"><div class="top"><div>' + badgeHtml(o.status) + '<h2>Verified Track Record</h2><p>' + o.verifiedAccounts + ' of ' + o.totalAccounts + ' account' + (o.totalAccounts === 1 ? '' : 's') + ' verified · broker-reported data only</p></div>'
      + (st.trades ? '<div class="net"><span>VERIFIED NET P&L</span><b style="color:' + (st.netPnl >= 0 ? '#22C55E' : '#EF4444') + '">' + fmt$(st.netPnl) + '</b></div>' : '') + '</div>'
      + (st.trades ? '<div class="ks">'
        + kpi('Win rate', st.winRate == null ? '—' : st.winRate + '%') + kpi('Profit factor', esc(S(st.profitFactor))) + kpi('Trades', st.trades) + kpi('Max drawdown', fmt$(st.maxDrawdown), 'r')
        + kpi('Avg win', fmt$(st.avgWin), 'g') + kpi('Avg loss', fmt$(st.avgLoss), 'r') + kpi('Green days', st.greenDays + ' of ' + st.tradingDays) + kpi('Period', esc(fmtD(st.from)) + ' – ' + esc(fmtD(st.to)))
        + '</div><div class="ch">' + svgCurve(o.curve) + '</div>' : '') + '</div>'
      + accRows
      + '<p class="ft">This record was generated by ETW Journal from trades autosynced directly from the broker or prop firm. Demo accounts, free trials, manually added trades and file imports are never included, and the verification is computed server-side — the trader cannot edit these figures. Every journal account of this trader is listed above, including unverified ones. Logins are masked for privacy. etwiz.space</p>'
      + '</div><script>if(/[?&]print=1/.test(location.search))setTimeout(function(){window.print()},400);</scr' + 'ipt></body></html>';
  }
  // ── the public page (no auth): rebuilt live from the journal, print-ready for Save as PDF ──
  app.get('/tr/:token', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex');
      const token = S(req.params.token);
      if (!/^[A-Za-z0-9]{12,40}$/.test(token)) return res.status(404).send('Not found');
      if (limited('trpg:' + (req.ip || 'x'), 120, 60e3)) return res.status(429).send('Too many requests');
      const snap = await shares().doc(token).get();
      const sh = snap.exists ? (snap.data() || {}) : null;
      if (!sh || !sh.enabled) return res.status(404).set('Content-Type', 'text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Inter,system-ui,sans-serif;background:#0b0c12;color:#f3f4f8;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:20px"><div><h2 style="margin:0 0 8px">This track record is not shared</h2><p style="color:#8b8e98;margin:0">The trader may have turned the link off.</p></div>');
      const page = await cached('trpg:' + sh.uid, 60e3, async () => {
        const [b, trader] = await Promise.all([buildAll(sh.uid), traderOf(sh.uid)]);
        return sharePage({ name: trader.name, photo: trader.photo, createdAt: Date.now(), snapshot: b });
      });
      shares().doc(token).set({ views: (sh.views || 0) + 1, lastViewAt: Date.now() }, { merge: true }).catch(() => {});
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(page);
    } catch (e) { console.error('[track-record] page', e.message); res.status(500).send('Error'); }
  });
}

module.exports = { mount };
