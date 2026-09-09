# ETW MT5 Direct-Connect Backend

Logs into a user's MetaTrader 5 account (via **MetaApi.cloud**), imports their full
trade history once, then streams every new **closed** trade into your Firebase
**Firestore `trades`** collection — the same collection the ETW journal already reads.
No Expert Advisor required; the user just enters login / investor password / server.

It exposes exactly what the ETW frontend already calls:

| Method | Path | Body | Auth |
|---|---|---|---|
| `GET`  | `/` | — | none (health check) |
| `POST` | `/api/mt5-direct/connect` | `{ login, password, server, journalAccountId }` | `Authorization: Bearer <Firebase idToken>` |
| `POST` | `/api/mt5-direct/disconnect` | `{ forget }` | same |

Status + counters are written to `users/{uid}.mt5Direct` and per-account records in
`users/{uid}.mt5DirectAccounts` (`status`, `historyImported`, `lastSyncAt`,
`metaApiAccountId`, `error`) which the frontend watches live. MT5 Direct is included
with active plans: Essential users may link one account and Pro users may link three.
It does not consume sync tokens or require a separate MT5 payment.
Each Essential subscription period permits one distinct linked account and each
Pro period permits three. Disconnecting an account does not restore that
period's slot; the allowance resets when the subscription period changes.

---

## What you need first

1. **A MetaApi.cloud account + API token** — https://app.metaapi.cloud → *Token management*.
   MetaApi is the paid gateway that actually connects to MT5. (If signup is blocked with
   an "IP restricted" message, turn off any VPN and sign up from a home/mobile connection.)
2. **The client's Firebase service-account key** — Firebase console → *Project settings*
   → *Service accounts* → **Generate new private key** (downloads a JSON file).

---

## Run it locally (to test)

```bash
cd mt5-direct-backend
npm install
cp .env.example .env      # then edit .env and fill in the 2 secrets
npm start                 # -> http://localhost:8080/  should return {"ok":true,...}
```

Put the whole Firebase JSON on one line in `FIREBASE_SERVICE_ACCOUNT`, **or** base64-encode
it first (`base64 -w0 service-account.json`) and paste that — the code accepts either.

---

## Deploy to Render

1. Push this folder to a GitHub repo.
2. Render → **New → Web Service** → pick the repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: **Starter (paid)** is strongly recommended — the **Free** plan sleeps after
     ~15 min of no traffic, which stops live streaming. (Free is fine only for a quick test.)
3. Add environment variables (same names as `.env.example`):
   `METAAPI_TOKEN`, `FIREBASE_SERVICE_ACCOUNT`, and optionally `METAAPI_REGION`.
4. Deploy. Your URL will look like `https://YOUR-SERVICE.onrender.com`.

---

## Point the frontend at YOUR backend

The frontend defaults to the old URL. Override it to your new one. Easiest: in
`journal.html` find

```js
window.MT5_DIRECT_API_BASE = window.MT5_DIRECT_API_BASE || 'https://etwappmeta5-2.onrender.com';
```

and change the fallback URL to your Render URL, e.g.

```js
window.MT5_DIRECT_API_BASE = window.MT5_DIRECT_API_BASE || 'https://YOUR-SERVICE.onrender.com';
```

(No trailing slash — the code appends `/api/mt5-direct/connect` itself.)

---

## Test end-to-end

1. Start the backend (local or Render) with both secrets set.
2. Open the ETW app, **sign in**, go to **Import MT5 → Direct Connect**.
3. Enter MT5 **login**, **investor password** (read-only is enough), and the exact
   **server** name from your terminal (e.g. `ICMarketsSC-MT5`). Click **Connect**.
4. Watch: the on-screen message, the backend logs, and in Firebase the doc
   `users/{yourUid}.mt5Direct` — status goes `connecting → connected`, and your
   trades appear in the `trades` collection tagged `source: "mt5-direct"`.

---

## Notes / gotchas

- **Investor password** works and is safer (read-only). The main password also works.
- The **server name** must match your broker exactly — that's the #1 cause of failures.
- Trades are **deduped by MT5 position id** (`ticket`), so reconnecting or restarting
  never creates duplicates.
- The engine keeps connections **in memory** and re-attaches to previously-connected
  users on startup (`resumeAll`). For true 24/7 sync use a paid Render plan (no sleep).
- `metaapi.cloud-sdk` is pinned to **v27**. If a MetaApi method name errors, check the
  MetaApi docs for your installed version and adjust the 2–3 calls marked `SDK:` in
  `src/mt5sync.js`.
