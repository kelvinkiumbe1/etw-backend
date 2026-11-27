// ════════════════════════════════════════════════════════════════════════════
//  ETW Journal — OAuth 2.1 for the MCP connector
//
//  Lets Claude (and any MCP client that speaks the MCP authorization spec)
//  connect with a "Connect → sign in → Allow" flow instead of a pasted
//  connector key. Connector keys keep working exactly as before.
//
//  Flow
//    1. The client calls POST /mcp without a token and gets 401 with
//       WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"
//    2. It reads that document and /.well-known/oauth-authorization-server.
//    3. It registers itself at POST /oauth/register (dynamic client registration).
//    4. It opens GET /oauth/authorize (PKCE S256 required). We park the request
//       and send the browser to the app's consent page (etwiz.space/authorize).
//    5. The consent page signs the trader in with Firebase (as the app does) and
//       calls GET /api/oauth/request and POST /api/oauth/decision with the
//       trader's ID token. Allow → a one-time code goes back to the client.
//    6. The client swaps the code at POST /oauth/token for an access token
//       (1 hour) and a refresh token (60 days, rotated on every use).
//
//  Storage (Firestore, server-only — the rules' catch-all deny covers them).
//  Only SHA-256 hashes of codes and tokens are stored, never the values.
//    mcpOAuthClients/{client_id}   registered apps
//    mcpOAuthRequests/{id}         authorize requests waiting for the trader (15 min)
//    mcpOAuthCodes/{sha(code)}     one-time codes (5 min)
//    mcpOAuthTokens/{sha(token)}   access + refresh tokens
//    mcpOAuthGrants/{id}           one per trader + app: what was allowed. Deleting
//                                  it (Settings › Connected apps) cuts the app off.
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

const S = (v) => (v == null ? '' : String(v));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (n) => crypto.randomBytes(n || 32).toString('base64url');
const same = (a, b) => { const x = Buffer.from(S(a)), y = Buffer.from(S(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const clip = (s, n) => S(s).slice(0, n);

const SCOPE_READ = 'journal:read';
const SCOPE_WRITE = 'journal:write';
const SCOPES = [SCOPE_READ, SCOPE_WRITE];
const ACCESS_TTL = 60 * 60 * 1000;               // 1 hour
const REFRESH_TTL = 60 * 24 * 60 * 60 * 1000;    // 60 days, rotated on every use
const CODE_TTL = 5 * 60 * 1000;
const REQUEST_TTL = 15 * 60 * 1000;
const PREFIX = { client: 'etwc_', code: 'etwac_', access: 'etwa_', refresh: 'etwr_' };

class OAuthError extends Error {
  constructor(error, description, status) { super(description || error); this.error = error; this.description = description || ''; this.status = status || 400; }
}

function parseScope(raw) {
  const asked = S(raw).split(/[\s,]+/).filter(Boolean);
  const known = asked.filter((s) => SCOPES.includes(s));
  // Clients that ask for nothing, or only for scopes we don't define (openid,
  // offline_access…), get the full set; the trader still decides on the consent page.
  return known.length ? [...new Set([SCOPE_READ, ...known])] : SCOPES.slice();
}
const scopeStr = (arr) => SCOPES.filter((s) => arr.includes(s)).join(' ');

// Redirect URIs: https anywhere, http only on this machine (desktop / CLI
// clients), or a private app scheme (cursor://, vscode://…).
function redirectOk(u) {
  let x; try { x = new URL(S(u)); } catch (e) { return false; }
  if (S(u).length > 500 || x.hash) return false;
  if (x.protocol === 'https:') return true;
  if (x.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(x.protocol) && !['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'about:', 'ftp:', 'ws:', 'wss:'].includes(x.protocol);
}
function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

function mount(app, opts) {
  const { db, admin, requireAuth, planOf, limiter } = opts;
  const col = (n) => db.collection(n);
  const CLIENTS = 'mcpOAuthClients', REQS = 'mcpOAuthRequests', CODES = 'mcpOAuthCodes', TOKENS = 'mcpOAuthTokens', GRANTS = 'mcpOAuthGrants';
  const CONSENT_URL = S(process.env.OAUTH_CONSENT_URL || 'https://etwiz.space/authorize');
  const DOCS_URL = S(process.env.MCP_DOCS_URL || 'https://etwjournal.space');
  const regLimit = limiter(60 * 60 * 1000, 30, 'Too many client registrations from this address.');
  const tokenLimit = limiter(60 * 1000, 120, 'Too many token requests.');
  const pageLimit = limiter(60 * 1000, 60, 'Too many requests.');

  // The issuer is the address the client used, so metadata fetched from the
  // onrender.com host and from a custom domain are each self-consistent.
  function baseOf(req) {
    const host = S(req.get('host')).toLowerCase();
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return S(process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || 'https://etwappmeta5-2.onrender.com').replace(/\/+$/, '');
    return (req.protocol === 'http' ? 'http' : 'https') + '://' + host;
  }
  function ourHosts(req) {
    const set = new Set([S(req.get('host')).toLowerCase()]);
    for (const v of [process.env.PUBLIC_API_URL, process.env.RENDER_EXTERNAL_URL, 'https://etwappmeta5-2.onrender.com']) {
      try { if (v) set.add(new URL(v).host.toLowerCase()); } catch (e) {}
    }
    S(process.env.MCP_EXTRA_HOSTS).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).forEach((h) => set.add(h));
    return set;
  }
  // RFC 8707 resource indicator: must name this server's MCP endpoint.
  function resourceOk(req, r) {
    if (!r) return true;
    let u; try { u = new URL(r); } catch (e) { return false; }
    return ourHosts(req).has(u.host.toLowerCase()) && ['/mcp', '/mcp/', '/', ''].includes(u.pathname);
  }

  function sendErr(res, e) {
    if (!(e instanceof OAuthError)) { console.error('[oauth]', e && e.message); e = new OAuthError('server_error', 'ETW Journal could not finish this request. Please try again.', 500); }
    if (e.status === 401) res.set('WWW-Authenticate', 'Basic realm="ETW Journal"');
    res.set('Cache-Control', 'no-store').status(e.status).json({ error: e.error, error_description: e.description });
  }

  // ════════════════════════ discovery ════════════════════════
  function protectedResource(req, res) {
    const base = baseOf(req);
    res.set('Cache-Control', 'public, max-age=3600').json({
      resource: base + '/mcp',
      authorization_servers: [base],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'ETW Journal',
      resource_documentation: DOCS_URL,
    });
  }
  function authServer(req, res) {
    const base = baseOf(req);
    res.set('Cache-Control', 'public, max-age=3600').json({
      issuer: base,
      authorization_endpoint: base + '/oauth/authorize',
      token_endpoint: base + '/oauth/token',
      registration_endpoint: base + '/oauth/register',
      revocation_endpoint: base + '/oauth/revoke',
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: SCOPES,
      service_documentation: DOCS_URL,
    });
  }
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], protectedResource);
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'], authServer);

  // ════════════════════════ clients ════════════════════════
  const _clients = new Map();
  async function getClient(id) {
    id = S(id);
    if (!id.startsWith(PREFIX.client) || id.length > 64) return null;
    const c = _clients.get(id); if (c && c.exp > Date.now()) return c.rec;
    const snap = await col(CLIENTS).doc(id).get();
    const rec = snap.exists ? Object.assign({ client_id: id }, snap.data()) : null;
    _clients.set(id, { rec, exp: Date.now() + 5 * 60e3 });
    if (_clients.size > 2000) _clients.delete(_clients.keys().next().value);
    return rec;
  }
  async function authClient(req) {
    const b = req.body || {};
    let id = S(b.client_id), secret = S(b.client_secret);
    const m = /^Basic\s+(.+)$/i.exec(S(req.get('authorization')));
    if (m) {
      const raw = Buffer.from(m[1], 'base64').toString('utf8'), i = raw.indexOf(':');
      if (i < 0) throw new OAuthError('invalid_client', 'Malformed client credentials.', 401);
      try { id = decodeURIComponent(raw.slice(0, i)); secret = decodeURIComponent(raw.slice(i + 1)); } catch (e) { throw new OAuthError('invalid_client', 'Malformed client credentials.', 401); }
    }
    const c = await getClient(id);
    if (!c) throw new OAuthError('invalid_client', 'Unknown client. Register it again at /oauth/register.', 401);
    if (c.secretHash && !(secret && same(sha(secret), c.secretHash))) throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    return c;
  }

  // RFC 7591 dynamic client registration.
  app.post('/oauth/register', regLimit, async (req, res) => {
    try {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(S) : [];
      if (!uris.length || uris.length > 10) throw new OAuthError('invalid_redirect_uri', 'Send 1 to 10 redirect_uris.');
      const bad = uris.find((u) => !redirectOk(u));
      if (bad) throw new OAuthError('invalid_redirect_uri', 'Redirect URI not allowed: ' + clip(bad, 120) + ' (use https, a localhost http address, or a private app scheme).');
      const method = S(b.token_endpoint_auth_method || 'none');
      if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) throw new OAuthError('invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.');
      const grants = Array.isArray(b.grant_types) && b.grant_types.length ? b.grant_types.map(S) : ['authorization_code', 'refresh_token'];
      if (grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) throw new OAuthError('invalid_client_metadata', 'Only the authorization_code and refresh_token grant types are supported.');
      if (Array.isArray(b.response_types) && b.response_types.some((r) => S(r) !== 'code')) throw new OAuthError('invalid_client_metadata', 'Only the "code" response type is supported.');
      const name = clip(S(b.client_name).replace(/[<>\u0000-\u001f]/g, '').trim(), 80) || 'AI app';
      const client_id = PREFIX.client + rand(18);
      const secret = method === 'none' ? null : rand(32);
      const now = Date.now();
      await col(CLIENTS).doc(client_id).set({
        client_name: name, redirect_uris: uris, token_endpoint_auth_method: method, grant_types: grants,
        secretHash: secret ? sha(secret) : null, client_uri: redirectOk(b.client_uri) && /^https:/.test(S(b.client_uri)) ? clip(b.client_uri, 300) : null,
        createdAt: now, registeredFrom: clip(S(req.get('user-agent')), 120),
      });
      res.status(201).set('Cache-Control', 'no-store').json(Object.assign({
        client_id, client_id_issued_at: Math.floor(now / 1000), client_name: name, redirect_uris: uris,
        token_endpoint_auth_method: method, grant_types: grants, response_types: ['code'], scope: SCOPES.join(' '),
      }, secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}));
    } catch (e) { sendErr(res, e); }
  });

  // ════════════════════════ authorize ════════════════════════
  function errorPage(res, status, msg) {
    const esc = (s) => S(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    res.status(status).set('Cache-Control', 'no-store').type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETW Journal</title>'
      + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#140A24;color:#eeecf7;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:20px">'
      + '<div style="max-width:420px;text-align:center"><h2 style="margin:0 0 10px">Can’t connect to ETW Journal</h2><p style="color:#a7a1bf;line-height:1.55">' + esc(msg) + '</p></div></body>');
  }

  app.get('/oauth/authorize', pageLimit, async (req, res) => {
    const q = req.query || {};
    let client;
    try { client = await getClient(q.client_id); } catch (e) { console.error('[oauth] client lookup', e.message); return errorPage(res, 503, 'ETW Journal is busy. Please try again in a moment.'); }
    if (!client) return errorPage(res, 400, 'This app is not registered with ETW Journal. Remove the connector in your AI app and add it again.');
    let redirect = S(q.redirect_uri);
    if (!redirect && client.redirect_uris.length === 1) redirect = client.redirect_uris[0];
    if (!client.redirect_uris.includes(redirect)) return errorPage(res, 400, 'The return address this app sent does not match the one it registered. Remove the connector and add it again.');
    // From here on, problems go back to the app as OAuth errors.
    const back = (error, description) => res.redirect(302, withParams(redirect, { error, error_description: description, state: S(q.state) }));
    if (S(q.response_type) !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(S(q.code_challenge)) || S(q.code_challenge_method) !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    if (!resourceOk(req, S(q.resource))) return back('invalid_target', 'The resource must be this server\'s /mcp endpoint.');
    try {
      const id = rand(24);
      await col(REQS).doc(id).set({
        client_id: client.client_id, redirect_uri: redirect, state: clip(q.state, 500), code_challenge: S(q.code_challenge),
        scope: parseScope(q.scope), resource: clip(q.resource, 300), issuer: baseOf(req), exp: Date.now() + REQUEST_TTL,
        expireAt: new Date(Date.now() + REQUEST_TTL),
      });
      res.set('Cache-Control', 'no-store').redirect(302, CONSENT_URL + (CONSENT_URL.includes('?') ? '&' : '?') + 'req=' + id);
    } catch (e) { console.error('[oauth] park request', e.message); errorPage(res, 503, 'ETW Journal is busy. Please try again in a moment.'); }
  });

  async function loadRequest(id) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(S(id))) return null;
    const snap = await col(REQS).doc(S(id)).get();
    if (!snap.exists) return null;
    const r = snap.data();
    return r.exp > Date.now() ? Object.assign({ id: S(id) }, r) : null;
  }
  const hostOf = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.host : x.protocol.replace(/:$/, ''); } catch (e) { return ''; } };
  const planOk = (p) => p === 'pro' || p === 'ultra';

  // Consent page → what is being asked, and whether this trader can allow it.
  app.get('/api/oauth/request', pageLimit, requireAuth, async (req, res) => {
    try {
      const r = await loadRequest(req.query.req);
      if (!r) return res.status(404).json({ error: 'This sign-in link has expired. Go back to your AI app and connect again.', code: 'expired' });
      const c = await getClient(r.client_id);
      if (!c) return res.status(404).json({ error: 'This app is no longer registered. Go back to your AI app and connect again.', code: 'expired' });
      const plan = await planOf(req.uid).catch(() => undefined);
      res.set('Cache-Control', 'no-store').json({
        ok: true, client_name: c.client_name, redirect_host: hostOf(r.redirect_uri),
        scopes: r.scope, write_requested: r.scope.includes(SCOPE_WRITE),
        plan: plan || null, allowed: planOk(plan), plan_unknown: plan === undefined,
      });
    } catch (e) { console.error('[oauth] request', e.message); res.status(500).json({ error: 'Could not load this request. Please try again.' }); }
  });

  // Consent page → Allow / Deny. Answers with the address to send the browser to.
  app.post('/api/oauth/decision', pageLimit, requireAuth, async (req, res) => {
    const b = req.body || {};
    try {
      const r = await loadRequest(b.req);
      if (!r) return res.status(404).json({ error: 'This sign-in link has expired. Go back to your AI app and connect again.', code: 'expired' });
      const c = await getClient(r.client_id);
      if (!c) return res.status(404).json({ error: 'This app is no longer registered. Go back to your AI app and connect again.', code: 'expired' });
      if (b.approve !== true) {
        await col(REQS).doc(r.id).delete().catch(() => {});
        return res.json({ ok: true, redirect: withParams(r.redirect_uri, { error: 'access_denied', error_description: 'The trader did not allow access.', state: r.state }) });
      }
      const plan = await planOf(req.uid).catch(() => undefined);
      if (plan === undefined) return res.status(503).json({ error: 'Could not check your plan just now. Please try again.' });
      if (!planOk(plan)) return res.status(402).json({ error: 'AI connectors are on the Pro and Ultra plans. Upgrade in ETW Journal, then connect again.', code: 'pro_required' });

      const scope = [SCOPE_READ].concat(b.write === true && r.scope.includes(SCOPE_WRITE) ? [SCOPE_WRITE] : []);
      const grantId = sha(req.uid + '|' + c.client_id).slice(0, 32);
      const code = PREFIX.code + rand(32);
      const now = Date.now();
      const user = await admin.auth().getUser(req.uid).catch(() => null);
      // Single use: the parked request is consumed in the same transaction that issues the code.
      await db.runTransaction(async (tx) => {
        const ref = col(REQS).doc(r.id);
        const cur = await tx.get(ref);
        if (!cur.exists) throw new OAuthError('expired', 'This sign-in link was already used. Go back to your AI app and connect again.', 409);
        tx.delete(ref);
        tx.set(col(GRANTS).doc(grantId), {
          uid: req.uid, client_id: c.client_id, client_name: c.client_name, scope: scopeStr(scope),
          redirect_host: hostOf(r.redirect_uri), createdAt: now, updatedAt: now, email: (user && user.email) || null,
        }, { merge: true });
        tx.set(col(CODES).doc(sha(code)), {
          client_id: c.client_id, redirect_uri: r.redirect_uri, uid: req.uid, grantId, scope: scopeStr(scope),
          code_challenge: r.code_challenge, resource: r.resource || '', exp: now + CODE_TTL, expireAt: new Date(now + CODE_TTL), used: false,
        });
      });
      _grants.delete(grantId);
      console.log('[oauth] granted', c.client_name, scopeStr(scope), 'for', req.uid);
      res.json({ ok: true, redirect: withParams(r.redirect_uri, { code, state: r.state, iss: r.issuer }) });
    } catch (e) {
      if (e instanceof OAuthError) return res.status(e.status).json({ error: e.description, code: e.error });
      console.error('[oauth] decision', e.message); res.status(500).json({ error: 'Could not finish connecting. Please try again.' });
    }
  });

  // ════════════════════════ tokens ════════════════════════
  async function issue(tx, { uid, client_id, grantId, scope, resource }) {
    const now = Date.now();
    const access = PREFIX.access + rand(32), refresh = PREFIX.refresh + rand(32);
    const base = { uid, client_id, grantId, scope, resource: resource || '', createdAt: now };
    tx.set(col(TOKENS).doc(sha(access)), Object.assign({ kind: 'access', exp: now + ACCESS_TTL, expireAt: new Date(now + ACCESS_TTL) }, base));
    tx.set(col(TOKENS).doc(sha(refresh)), Object.assign({ kind: 'refresh', exp: now + REFRESH_TTL, expireAt: new Date(now + REFRESH_TTL) }, base));
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL / 1000), refresh_token: refresh, scope };
  }
  const pkceOk = (verifier, challenge) => /^[A-Za-z0-9\-._~]{43,128}$/.test(S(verifier))
    && same(crypto.createHash('sha256').update(S(verifier)).digest('base64url'), challenge);

  app.post('/oauth/token', tokenLimit, async (req, res) => {
    try {
      const b = req.body || {};
      const c = await authClient(req);
      const gt = S(b.grant_type);
      let out;
      if (gt === 'authorization_code') {
        const code = S(b.code);
        if (!code.startsWith(PREFIX.code)) throw new OAuthError('invalid_grant', 'Invalid authorization code.');
        out = await db.runTransaction(async (tx) => {
          const ref = col(CODES).doc(sha(code));
          const snap = await tx.get(ref);
          const d = snap.exists ? snap.data() : null;
          if (!d || d.used || d.exp < Date.now()) throw new OAuthError('invalid_grant', 'The authorization code is invalid, expired or already used.');
          if (d.client_id !== c.client_id) throw new OAuthError('invalid_grant', 'The code was issued to another client.');
          if (S(b.redirect_uri) && S(b.redirect_uri) !== d.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
          if (!pkceOk(b.code_verifier, d.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed.');
          if (S(b.resource) && !resourceOk(req, S(b.resource))) throw new OAuthError('invalid_target', 'The resource must be this server\'s /mcp endpoint.');
          tx.update(ref, { used: true, usedAt: Date.now() });
          return issue(tx, { uid: d.uid, client_id: c.client_id, grantId: d.grantId, scope: d.scope, resource: d.resource });
        });
      } else if (gt === 'refresh_token') {
        const rt = S(b.refresh_token);
        if (!rt.startsWith(PREFIX.refresh)) throw new OAuthError('invalid_grant', 'Invalid refresh token.');
        out = await db.runTransaction(async (tx) => {
          const ref = col(TOKENS).doc(sha(rt));
          const snap = await tx.get(ref);
          const d = snap.exists ? snap.data() : null;
          if (!d || d.kind !== 'refresh' || d.exp < Date.now()) throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired. Connect again.');
          if (d.client_id !== c.client_id) throw new OAuthError('invalid_grant', 'The refresh token was issued to another client.');
          const g = await tx.get(col(GRANTS).doc(d.grantId));
          if (!g.exists) throw new OAuthError('invalid_grant', 'Access was removed in ETW Journal. Connect again.');
          let scope = d.scope;
          if (S(b.scope)) {   // a client may narrow, never widen
            const want = S(b.scope).split(/\s+/).filter(Boolean);
            if (want.some((s) => !d.scope.split(' ').includes(s))) throw new OAuthError('invalid_scope', 'A refresh cannot add scopes.');
            scope = scopeStr([SCOPE_READ].concat(want));
          }
          tx.delete(ref);   // rotation: each refresh token works once
          return issue(tx, { uid: d.uid, client_id: c.client_id, grantId: d.grantId, scope, resource: d.resource });
        });
      } else {
        throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
      }
      res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json(out);
    } catch (e) { sendErr(res, e); }
  });

  // RFC 7009: always 200, whether or not the token existed.
  app.post('/oauth/revoke', tokenLimit, async (req, res) => {
    try {
      const c = await authClient(req);
      const t = S((req.body || {}).token);
      if (t.startsWith(PREFIX.access) || t.startsWith(PREFIX.refresh)) {
        const ref = col(TOKENS).doc(sha(t));
        const snap = await ref.get();
        if (snap.exists && snap.data().client_id === c.client_id) { await ref.delete(); _tokens.delete(sha(t)); }
      }
      res.set('Cache-Control', 'no-store').status(200).json({});
    } catch (e) { sendErr(res, e); }
  });

  // ════════════════════════ used by the MCP endpoint ════════════════════════
  const _tokens = new Map(), _grants = new Map();
  async function grantLive(id) {
    const c = _grants.get(id); if (c && c.exp > Date.now()) return c.ok;
    const ok = (await col(GRANTS).doc(id).get()).exists;
    _grants.set(id, { ok, exp: Date.now() + 60e3 });
    if (_grants.size > 5000) _grants.delete(_grants.keys().next().value);
    return ok;
  }
  // → { uid, scope: 'read'|'write', hash, kind:'oauth', grantId } or null
  async function resolve(token) {
    token = S(token);
    if (!token.startsWith(PREFIX.access) || token.length > 100) return null;
    const h = sha(token);
    let c = _tokens.get(h), d;
    if (c && c.exp > Date.now()) d = c.d;
    else {
      const snap = await col(TOKENS).doc(h).get();
      d = snap.exists && snap.data().kind === 'access' ? snap.data() : null;
      _tokens.set(h, { d, exp: Date.now() + 60e3 });
      if (_tokens.size > 5000) _tokens.delete(_tokens.keys().next().value);
    }
    if (!d || d.exp < Date.now()) return null;
    if (!(await grantLive(d.grantId))) return null;
    return { uid: d.uid, scope: S(d.scope).split(' ').includes(SCOPE_WRITE) ? 'write' : 'read', hash: 'oauth:' + d.grantId, kind: 'oauth', grantId: d.grantId, client_id: d.client_id };
  }
  const _touched = new Map();
  function touch(rec, clientName) {
    const last = _touched.get(rec.grantId) || 0; if (Date.now() - last < 5 * 60e3) return;
    _touched.set(rec.grantId, Date.now());
    const patch = { lastUsedAt: Date.now(), uses: admin.firestore.FieldValue.increment(1) };
    if (clientName) patch.lastClient = clip(clientName, 60);
    col(GRANTS).doc(rec.grantId).update(patch).catch(() => {});
  }
  const challenge = (req, error) => 'Bearer resource_metadata="' + baseOf(req) + '/.well-known/oauth-protected-resource"'
    + (error ? ', error="' + error + '"' : '') + ', scope="' + SCOPES.join(' ') + '"';

  // ════════════════════════ Settings › Connected apps ════════════════════════
  app.get('/api/oauth/grants', requireAuth, async (req, res) => {
    try {
      const snap = await col(GRANTS).where('uid', '==', req.uid).get();
      const apps = snap.docs.map((d) => { const x = d.data() || {}; return { id: d.id, name: x.client_name || 'AI app', scope: S(x.scope).includes(SCOPE_WRITE) ? 'write' : 'read', site: x.redirect_host || '', createdAt: x.createdAt || 0, lastUsedAt: x.lastUsedAt || 0 }; })
        .sort((a, b) => (b.lastUsedAt || b.createdAt) - (a.lastUsedAt || a.createdAt));
      res.set('Cache-Control', 'no-store').json({ ok: true, apps });
    } catch (e) { console.error('[oauth] list grants', e.message); res.status(500).json({ error: 'Could not load your connected apps.' }); }
  });
  app.delete('/api/oauth/grants/:id', requireAuth, async (req, res) => {
    try {
      const id = S(req.params.id); if (!/^[a-f0-9]{32}$/.test(id)) return res.status(400).json({ error: 'Invalid app.' });
      const ref = col(GRANTS).doc(id);
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== req.uid) return res.status(404).json({ error: 'That app is no longer connected.' });
      await ref.delete();   // tokens stop working at once: every use checks the grant
      _grants.delete(id);
      const toks = await col(TOKENS).where('grantId', '==', id).get().catch(() => null);
      if (toks) for (let i = 0; i < toks.docs.length; i += 400) { const batch = db.batch(); toks.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref)); await batch.commit(); }
      res.json({ ok: true });
    } catch (e) { console.error('[oauth] revoke grant', e.message); res.status(500).json({ error: 'Could not disconnect the app.' }); }
  });

  return { resolve, touch, challenge };
}

module.exports = { mount, SCOPES, _test: { parseScope, redirectOk, withParams } };
