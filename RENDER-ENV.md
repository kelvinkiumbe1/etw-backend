# Render env vars — new service `etwappmeta5-2`

Render's Environment tab has a bulk editor that accepts `KEY=VALUE` lines. Paste the
block below, then fill every `<...>` placeholder.

**Get the secret values from the OLD service's Environment tab** — Render lets you reveal
them. Don't go re-generating keys you already have; that only creates more work (and a
rotated Firebase key breaks the old service while you're mid-migration).

---

## Paste this

```
# ── Required: nothing works without these ──────────────────────────
METAAPI_TOKEN=<copy from old service>
FIREBASE_SERVICE_ACCOUNT=<copy from old service — the whole JSON on one line>
GUMROAD_ACCESS_TOKEN=<copy from old service>

# ── Must change for the new URL ────────────────────────────────────
PUBLIC_BACKEND_URL=https://etwappmeta5-2.onrender.com
CTRADER_REDIRECT_URI=https://etwappmeta5-2.onrender.com/api/ctrader/callback

# ── Gumroad products (not secret — these values are correct as-is) ─
GUMROAD_PRODUCT_ESSENTIAL=zsjehf
GUMROAD_PRODUCT_PRO=zmoivqx
GUMROAD_PRODUCT_ESSENTIAL_YEARLY=sjeull
GUMROAD_PRODUCT_PRO_YEARLY=gngojz
GUMROAD_PRODUCT_ESSENTIAL_QUARTERLY=wskfqc
GUMROAD_PRODUCT_PRO_QUARTERLY=tphmr

# ── Selar / Auto-Sync tokens (new) ─────────────────────────────────
SELAR_HOOK_SECRET=<the admin's secret key>
SELAR_TOKEN_PRODUCTS=<dailyProductId>:2500,<liveProductId>:6500
SELAR_DEBUG=1

# ── Token rates (verified against MetaApi's published prices) ──────
SYNC_TOKENS_PER_HOUR=8
SYNC_TOKENS_PER_CONNECT=800
SYNC_TOKENS_PER_PULL=48
SYNC_PULL_EVERY_HOURS=24
SYNC_METER_MINUTES=15
SYNC_PRUNE_AFTER_DAYS=90

# ── cTrader ────────────────────────────────────────────────────────
CTRADER_CLIENT_ID=<copy from old service>
CTRADER_CLIENT_SECRET=<copy from old service>

# ── Market data + AI ───────────────────────────────────────────────
GROQ_API_KEY=<copy from old service>
TWELVE_DATA_KEY=<copy from old service>
EODHD_API_KEY=<copy from old service>

# ── Email (Brevo) ──────────────────────────────────────────────────
BREVO_API_KEY=<copy from old service>
BREVO_SENDER=<copy from old service>
BREVO_SENDER_NAME=<copy from old service>
BREVO_LIST_ID=<copy from old service>

# ── Admin / ops ────────────────────────────────────────────────────
ADMIN_SECRET=<copy from old service>
CRON_SECRET=<copy from old service>
MENTOR_EMAILS=<copy from old service>
ETW_SITE_URL=https://etwiz.space
APP_URL=https://etwiz.space
```

---

## Do NOT set these

| Var | Why |
|---|---|
| `PORT` | Render assigns it. Setting it manually can stop the service binding. |
| `RENDER_EXTERNAL_URL` | Render provides it automatically. |
| `CORS_ORIGINS` | Only needed for extra domains. `etwiz.space`, `www.etwiz.space` and localhost are already allowed in code. |
| `APPCHECK_ENFORCE` | Leave unset (off). Only turn on after App Check is fully configured, or every request gets rejected. |
| `COMP_EMAILS` | Has a working default in `src/access.js`. Only set to change the free-forever list. |
| `METAAPI_REGION` / `METAAPI_ACCOUNT_TYPE` / `METAAPI_RELIABILITY` | Leave unset. Defaults are `cloud-g1` + `regular`, the cheap pair. Setting `high` roughly doubles your per-account cost for no benefit here. |
| `SELAR_API_KEY` | Optional, and currently unused — `verifyRemote()` in `src/selar.js` is a deliberate no-op until Selar's API is confirmed. |

---

## After deploying, off-server settings

These live on other people's dashboards and still point at the old URL:

1. **Gumroad** → Settings → Advanced → Ping URL:
   `https://etwappmeta5-2.onrender.com/api/gumroad/ping`
2. **Selar** → webhook destination:
   `https://etwappmeta5-2.onrender.com/api/selar/webhook`
   plus the custom header `X-ETW-Hook-Secret` = the same value as `SELAR_HOOK_SECRET`
3. **cTrader app** (openapi.ctrader.com) → Redirect URI:
   `https://etwappmeta5-2.onrender.com/api/ctrader/callback`
4. **Firestore rules** → publish `firestore.rules`, then confirm in the Rules Playground
   that a client write to `users/{uid}.syncTokens` is **denied**

## Turn SELAR_DEBUG back off

It's set to `1` above so the first real purchase logs its raw webhook body — that's how
`parse()` in `src/selar.js` gets corrected to Selar's actual field names. Remove it once
you've captured one, because the body contains buyer PII.

## Sanity check

`GET https://etwappmeta5-2.onrender.com/` returns a JSON status object listing which
integrations it thinks are configured. Check that first — it'll tell you what's missing
before any user does.
