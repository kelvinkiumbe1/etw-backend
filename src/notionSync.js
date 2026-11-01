// ── Notion Sync: import a trading journal kept in Notion ─────────────────────
// Lets a trader connect their Notion workspace and pull every trade of a
// Notion database (properties + the page's own notes and screenshots) into
// ETW Journal. The browser maps the Notion columns onto ETW's trade fields and
// writes the trades exactly like the app's other importers; this module only
// talks to Notion and re-hosts the screenshots.
//
// Two ways to connect:
//   1. OAuth (one click) — needs a PUBLIC Notion integration:
//        NOTION_CLIENT_ID, NOTION_CLIENT_SECRET,
//        NOTION_REDIRECT_URI = https://<this backend>/api/notion/callback
//   2. Internal integration token — the trader creates an integration at
//      notion.so/my-integrations, shares their journal database with it and
//      pastes the "Internal Integration Secret". Works with no server setup.
//
// The Notion token is stored server-side only (notionLinks/{uid}; no client
// rule exists for that collection, so the catch-all deny keeps it Admin-SDK
// only) and never sent back to the browser.
//
// Notion's file URLs (uploaded screenshots) expire after about an hour, so each
// image is copied to the app's Cloudinary account while the URL is fresh.
//   CLOUDINARY_CLOUD (default djhuavwfc), CLOUDINARY_UPLOAD_PRESET (default etwjournal_unsigned)
//
// Mount: require('./src/notionSync').mount(app, { requireAuth, requireSub, limiter, db, admin });

'use strict';
const crypto = require('crypto');

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const CLD_CLOUD = process.env.CLOUDINARY_CLOUD || 'djhuavwfc';
const CLD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || 'etwjournal_unsigned';

function oauthConfigured() {
  return !!(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET && process.env.NOTION_REDIRECT_URI);
}
function stateSecret() { return process.env.NOTION_STATE_SECRET || process.env.NOTION_CLIENT_SECRET || 'etw-notion'; }
function signState(uid) {
  const body = Buffer.from(JSON.stringify({ u: uid, t: Date.now(), n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  const mac = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return body + '.' + mac;
}
function readState(state) {
  const [body, mac] = String(state || '').split('.');
  if (!body || !mac) throw new Error('Invalid sign-in link.');
  const want = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) throw new Error('Invalid sign-in link.');
  const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!o.u || Date.now() - o.t > 30 * 60 * 1000) throw new Error('The sign-in link expired — start again from ETW Journal.');
  return o.u;
}

// ── Notion HTTP with retry on rate limits (3 requests/second per integration) ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function notion(token, path, opts = {}, tries = 0) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let r;
  try {
    r = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (tries < 2) { await sleep(800 * (tries + 1)); return notion(token, path, opts, tries + 1); }
    throw new Error('Notion did not answer in time.');
  }
  clearTimeout(timer);
  if ((r.status === 429 || r.status >= 500) && tries < 4) {
    const wait = Math.min(8000, (Number(r.headers.get('retry-after')) || 1) * 1000 + tries * 400);
    await sleep(wait);
    return notion(token, path, opts, tries + 1);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.message || ('Notion error ' + r.status));
    err.status = r.status; err.code = data.code;
    throw err;
  }
  return data;
}

// ── plain values out of Notion's rich structures ──
const rt = (arr) => (Array.isArray(arr) ? arr.map((x) => x.plain_text || '').join('') : '');
function fileUrl(f) { return f && (f.type === 'external' ? f.external && f.external.url : f.file && f.file.url) || ''; }
function propValue(p) {
  if (!p) return null;
  switch (p.type) {
    case 'title': return rt(p.title);
    case 'rich_text': return rt(p.rich_text);
    case 'number': return p.number;
    case 'select': return p.select ? p.select.name : '';
    case 'status': return p.status ? p.status.name : '';
    case 'multi_select': return (p.multi_select || []).map((x) => x.name);
    case 'date': return p.date ? { start: p.date.start, end: p.date.end || null } : null;
    case 'checkbox': return !!p.checkbox;
    case 'url': return p.url || '';
    case 'email': return p.email || '';
    case 'phone_number': return p.phone_number || '';
    case 'files': return (p.files || []).map((f) => ({ url: fileUrl(f), name: f.name || '', hosted: f.type === 'file' })).filter((f) => f.url);
    case 'created_time': return { start: p.created_time };
    case 'last_edited_time': return { start: p.last_edited_time };
    case 'formula': {
      const f = p.formula || {};
      if (f.type === 'date') return f.date ? { start: f.date.start, end: f.date.end || null } : null;
      return f[f.type] == null ? '' : f[f.type];
    }
    case 'rollup': {
      const r = p.rollup || {};
      if (r.type === 'number') return r.number;
      if (r.type === 'date') return r.date ? { start: r.date.start } : null;
      if (r.type === 'array') return (r.array || []).map((x) => { const v = propValue(x); return Array.isArray(v) ? v.join(', ') : (v && v.start) || v; }).filter((v) => v != null && v !== '').join(', ');
      return '';
    }
    case 'people': return (p.people || []).map((x) => x.name || '').filter(Boolean).join(', ');
    case 'relation': return (p.relation || []).length ? (p.relation.length + ' linked') : '';
    case 'unique_id': return p.unique_id ? ((p.unique_id.prefix ? p.unique_id.prefix + '-' : '') + p.unique_id.number) : '';
    default: return null;
  }
}

// The page body: text (kept in reading order) and every image, one level of
// nesting deep (toggles, columns, callouts) — where Notion journals usually keep
// their chart screenshots and write-ups.
const TEXT_BLOCKS = { paragraph: '', heading_1: '# ', heading_2: '## ', heading_3: '### ', bulleted_list_item: '• ', numbered_list_item: '- ', to_do: '', quote: '> ', callout: '', toggle: '' };
async function readBody(token, pageId) {
  const text = [], images = [];
  async function walk(id, depth) {
    let cursor, guard = 0;
    do {
      const d = await notion(token, '/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : ''));
      for (const b of d.results || []) {
        const t = b.type, v = b[t] || {};
        if (t === 'image') { const u = fileUrl(v); if (u) images.push({ url: u, hosted: v.type === 'file', caption: rt(v.caption) }); }
        else if (t === 'file' || t === 'pdf') { /* attachments other than images are not trade screenshots */ }
        else if (t in TEXT_BLOCKS) {
          const s = rt(v.rich_text);
          if (s.trim()) text.push((t === 'to_do' ? (v.checked ? '☑ ' : '☐ ') : TEXT_BLOCKS[t]) + s);
        } else if (t === 'code') { const s = rt(v.rich_text); if (s.trim()) text.push(s); }
        else if (t === 'divider') text.push('');
        if (b.has_children && depth < 2 && t !== 'child_page' && t !== 'child_database') await walk(b.id, depth + 1);
      }
      cursor = d.has_more ? d.next_cursor : null;
    } while (cursor && ++guard < 10);
  }
  await walk(pageId, 0);
  return { text: text.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000), images };
}

// Copy a (soon-to-expire) Notion image to Cloudinary. Permanent external links
// are copied too so every screenshot lives in the same place as the app's own.
async function rehost(url, uid) {
  try {
    const form = new URLSearchParams();
    form.set('file', url);
    form.set('upload_preset', CLD_PRESET);
    form.set('folder', 'etw/notion/' + String(uid).slice(0, 40));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch('https://api.cloudinary.com/v1_1/' + CLD_CLOUD + '/image/upload', { method: 'POST', body: form, signal: ctl.signal });
    clearTimeout(timer);
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.secure_url) return d.secure_url;
    console.warn('[notion] rehost failed:', (d.error && d.error.message) || r.status);
  } catch (e) { console.warn('[notion] rehost error:', e.message); }
  return '';
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

function dbTitle(d) { return rt(d.title) || 'Untitled database'; }
function dbIcon(d) { const i = d.icon; if (!i) return ''; if (i.type === 'emoji') return i.emoji; return fileUrl(i); }

function mount(app, { requireAuth, requireSub, limiter, db, admin }) {
  const linkRef = (uid) => db.collection('notionLinks').doc(uid);
  const pass = (req, res, next) => next();
  const lim = limiter || pass;
  async function tokenOf(uid) {
    const s = await linkRef(uid).get();
    const d = s.exists ? s.data() : null;
    if (!d || !d.token) { const e = new Error('Notion is not connected.'); e.status = 409; e.code = 'not_connected'; throw e; }
    return d.token;
  }
  function fail(res, e, what) {
    const status = e.status === 401 ? 409 : (e.status && e.status < 500 ? e.status : 502);
    if (e.status === 401) {
      return res.status(409).json({ error: 'Notion refused the connection — reconnect Notion and try again.', code: 'reconnect' });
    }
    if (e.code === 'object_not_found') return res.status(404).json({ error: 'ETW Journal cannot see that database. In Notion, open it → ••• → Connections → add your ETW integration.', code: 'not_shared' });
    console.error('[notion]', what, e.message);
    return res.status(status).json({ error: e.message || 'Notion request failed.', code: e.code || 'notion_error' });
  }

  app.get('/api/notion/status', requireAuth, async (req, res) => {
    try {
      const s = await linkRef(req.uid).get();
      const d = s.exists ? s.data() : null;
      res.json({ ok: true, oauth: oauthConfigured(), connected: !!(d && d.token), method: d && d.method || null,
        workspace: d && d.workspace || '', workspaceIcon: d && d.workspaceIcon || '', connectedAt: d && d.at || null, lastImport: d && d.lastImport || null });
    } catch (e) { res.status(500).json({ error: 'Could not read the Notion connection.' }); }
  });

  // ── OAuth ──
  app.get('/api/notion/auth', lim, requireAuth, requireSub, (req, res) => {
    if (!oauthConfigured()) return res.status(501).json({ error: 'One-click Notion sign-in is not set up yet — use an integration token instead.', code: 'oauth_off' });
    const u = new URL('https://api.notion.com/v1/oauth/authorize');
    u.searchParams.set('client_id', process.env.NOTION_CLIENT_ID);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('owner', 'user');
    u.searchParams.set('redirect_uri', process.env.NOTION_REDIRECT_URI);
    u.searchParams.set('state', signState(req.uid));
    res.json({ ok: true, url: u.toString() });
  });
  app.get('/api/notion/callback', async (req, res) => {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const page = (msg, ok) => res.send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#0b0b16;color:#e7ecff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;padding:24px"><div style="font-size:42px">' + (ok ? '✓' : '⚠') + '</div><h3>' + esc(msg) + '</h3><p style="opacity:.75">You can close this window and return to ETW Journal.</p><script>try{window.opener&&window.opener.postMessage({etwNotion:' + (ok ? 1 : 0) + '},"*")}catch(e){}setTimeout(function(){window.close()},1500)</script></div></body>');
    const { code, state, error } = req.query || {};
    if (error) return page('Notion connection was cancelled.', false);
    try {
      const uid = readState(state);
      const basic = Buffer.from(process.env.NOTION_CLIENT_ID + ':' + process.env.NOTION_CLIENT_SECRET).toString('base64');
      const r = await fetch(API + '/oauth/token', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/json', 'Notion-Version': VERSION },
        body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: process.env.NOTION_REDIRECT_URI }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.access_token) throw new Error(d.error_description || d.error || 'Notion did not return a token.');
      await linkRef(uid).set({ token: d.access_token, method: 'oauth', workspace: d.workspace_name || '', workspaceIcon: d.workspace_icon || '', botId: d.bot_id || '', at: Date.now() });
      page('Notion connected', true);
    } catch (e) { console.error('[notion] callback:', e.message); page('Notion connection failed: ' + e.message, false); }
  });

  // ── Internal integration token ──
  app.post('/api/notion/token', lim, requireAuth, requireSub, async (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    if (!/^(secret_|ntn_)[A-Za-z0-9]{20,}$/.test(token)) return res.status(400).json({ error: 'That does not look like a Notion integration secret — it starts with "ntn_" or "secret_".' });
    try {
      const me = await notion(token, '/users/me');
      const ws = (me.bot && me.bot.workspace_name) || '';
      await linkRef(req.uid).set({ token, method: 'token', workspace: ws, workspaceIcon: '', botId: me.id || '', at: Date.now() });
      res.json({ ok: true, workspace: ws });
    } catch (e) {
      if (e.status === 401) return res.status(400).json({ error: 'Notion rejected that secret. Copy it again from notion.so/my-integrations.' });
      return fail(res, e, 'token');
    }
  });
  app.post('/api/notion/disconnect', requireAuth, async (req, res) => {
    try { await linkRef(req.uid).delete(); } catch (e) {}
    res.json({ ok: true });
  });

  // ── databases the integration can see ──
  app.get('/api/notion/databases', lim, requireAuth, requireSub, async (req, res) => {
    try {
      const token = await tokenOf(req.uid);
      const out = []; let cursor = null, guard = 0;
      do {
        const d = await notion(token, '/search', { method: 'POST', body: { filter: { property: 'object', value: 'database' }, page_size: 100, start_cursor: cursor || undefined } });
        (d.results || []).forEach((x) => { if (!x.archived && !x.in_trash) out.push({ id: x.id, title: dbTitle(x), icon: dbIcon(x), url: x.url, props: Object.keys(x.properties || {}).length, edited: x.last_edited_time }); });
        cursor = d.has_more ? d.next_cursor : null;
      } while (cursor && ++guard < 5);
      out.sort((a, b) => String(b.edited).localeCompare(String(a.edited)));
      res.json({ ok: true, databases: out });
    } catch (e) { if (e.code === 'not_connected') return res.status(409).json({ error: e.message, code: e.code }); fail(res, e, 'databases'); }
  });

  // ── one database: its columns + how many rows ──
  app.get('/api/notion/databases/:id', lim, requireAuth, requireSub, async (req, res) => {
    try {
      const token = await tokenOf(req.uid);
      const id = String(req.params.id).replace(/[^a-f0-9-]/gi, '');
      const d = await notion(token, '/databases/' + id);
      const props = Object.keys(d.properties || {}).map((k) => {
        const p = d.properties[k];
        const o = { name: k, type: p.type };
        if (p.type === 'select' || p.type === 'status' || p.type === 'multi_select') o.options = ((p[p.type] || {}).options || []).map((x) => x.name).slice(0, 60);
        return o;
      });
      // count rows (cheap pass over ids only, capped)
      let n = 0, cursor = null, guard = 0;
      do {
        const q = await notion(token, '/databases/' + id + '/query', { method: 'POST', body: { page_size: 100, start_cursor: cursor || undefined } });
        n += (q.results || []).length;
        cursor = q.has_more ? q.next_cursor : null;
      } while (cursor && ++guard < 50);
      res.json({ ok: true, id: d.id, title: dbTitle(d), icon: dbIcon(d), url: d.url, props, count: n, more: !!cursor });
    } catch (e) { if (e.code === 'not_connected') return res.status(409).json({ error: e.message, code: e.code }); fail(res, e, 'database'); }
  });

  // ── a batch of rows, ready to become trades ──
  // body: { cursor, pageSize (≤25), body (read page content), images (re-host), skip: [pageIds already imported] }
  app.post('/api/notion/databases/:id/rows', lim, requireAuth, requireSub, async (req, res) => {
    try {
      const token = await tokenOf(req.uid);
      const id = String(req.params.id).replace(/[^a-f0-9-]/gi, '');
      const b = req.body || {};
      const size = Math.max(1, Math.min(25, Number(b.pageSize) || 15));
      const skip = new Set(Array.isArray(b.skip) ? b.skip.map(String) : []);
      const q = await notion(token, '/databases/' + id + '/query', { method: 'POST', body: {
        page_size: size, start_cursor: b.cursor || undefined,
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      } });
      const pages = (q.results || []).filter((p) => p.object === 'page' && !p.archived && !p.in_trash);
      const rows = await pool(pages, 3, async (p) => {
        const props = {};
        Object.keys(p.properties || {}).forEach((k) => { props[k] = { type: p.properties[k].type, value: propValue(p.properties[k]) }; });
        const row = { id: p.id, url: p.url, created: p.created_time, edited: p.last_edited_time, props, text: '', images: [], skipped: skip.has(p.id) };
        if (row.skipped) return row;
        let imgs = [];
        if (b.body !== false) {
          try { const body = await readBody(token, p.id); row.text = body.text; imgs = body.images; }
          catch (e) { row.bodyError = e.message; }
        }
        // screenshots attached in "Files & media" columns too
        Object.keys(props).forEach((k) => { if (props[k].type === 'files') (props[k].value || []).forEach((f) => imgs.push({ url: f.url, hosted: f.hosted, prop: k, name: f.name })); });
        imgs = imgs.filter((x) => x.url && !/\.(pdf|zip|csv|xlsx?|docx?)(\?|$)/i.test(x.name || x.url)).slice(0, 12);
        if (b.images !== false && imgs.length) {
          const hosted = await pool(imgs, 3, async (x) => (await rehost(x.url, req.uid)) || (x.hosted ? '' : x.url));
          row.images = imgs.map((x, i) => ({ url: hosted[i], prop: x.prop || '', caption: x.caption || '' })).filter((x) => x.url);
          // file columns now point at the permanent copies
          Object.keys(props).forEach((k) => { if (props[k].type === 'files') props[k].value = row.images.filter((x) => x.prop === k).map((x) => x.url); });
        } else {
          Object.keys(props).forEach((k) => { if (props[k].type === 'files') props[k].value = (props[k].value || []).filter((f) => !f.hosted).map((f) => f.url); });
          row.images = imgs.filter((x) => !x.hosted).map((x) => ({ url: x.url, prop: x.prop || '', caption: x.caption || '' }));
        }
        return row;
      });
      res.json({ ok: true, rows, next: q.has_more ? q.next_cursor : null });
    } catch (e) { if (e.code === 'not_connected') return res.status(409).json({ error: e.message, code: e.code }); fail(res, e, 'rows'); }
  });

  // remember the last import (shown on the Brokers card)
  app.post('/api/notion/imported', requireAuth, async (req, res) => {
    try {
      const b = req.body || {};
      await linkRef(req.uid).set({ lastImport: { at: Date.now(), added: Number(b.added) || 0, db: String(b.db || '').slice(0, 200), dbId: String(b.dbId || '').slice(0, 60) } }, { merge: true });
    } catch (e) {}
    res.json({ ok: true });
  });
}

module.exports = { mount, oauthConfigured, _test: { propValue, signState, readState } };
