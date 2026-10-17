# Opal Line Billing ERP

A jewellery-billing ERP for silver retailers: point-of-sale billing, Shopify
two-way sync, fulfilment and supply-chain control — desktop app (Electron) or
self-hosted web stack.

**Frontend** React 19 + Vite + Tailwind · **Backend** Express + Drizzle +
PostgreSQL (postgres.js) · **Desktop** Electron (Windows NSIS installer, signed)

---

## What it does

| Area | Highlights |
|---|---|
| **Billing** | Silver-rate priced invoices ((rate + making charge) × weight + GST), quotations with validity terms, credit notes/returns, HSN & GST reports, TDS register, double-entry accounting (trial balance, P&L, balance sheet, journal) |
| **Shopify sync** | Two-way product sync (incl. collections, descriptions with sanitised HTML, images policy), order import with PII recovery, customer sync, inventory push, price push, webhook + email-ingest redaction workarounds |
| **Supply chain** | Order pipeline (drag or bulk-move stages), bulk packing slips & pick lists with product photos, dispatch/shipments, bookings, purchase orders & supplier dues, scan stock counts with Shopify round-trip |
| **Printing** | Print Designer (5 doc types: invoice, quotation, order, packing slip, pick list), saved templates with defaults, design import/export (`.opal-print.json`), auto UPI QR on invoices |
| **Ops & security** | RBAC (per-user permissions), audit + activity logs, encrypted backups with auto-email & off-site push (S3-compatible), session controls (log out other devices), rate limiting persisted in Postgres, webhook replay protection, magic-byte upload validation |

## Screenshots

| | |
|---|---|
| **Dashboard** — KPIs, silver rate, low-stock alerts | **Sales orders** — bulk packing slips / pick lists with product thumbnails |
| ![Dashboard](docs/screenshots/dashboard.png) | ![Sales orders](docs/screenshots/sales-orders.png) |
| **Invoices** — GST billing with UPI QR | **Invoice detail** — print / PDF with product images |
| ![Invoices](docs/screenshots/sales-invoices.png) | ![Invoice detail](docs/screenshots/invoice-detail.png) |
| **Quotations** — validity terms, one-click print | **Products** — catalogue with Shopify sync status |
| ![Quotations](docs/screenshots/quotations.png) | ![Products](docs/screenshots/products.png) |

## Ports

Opal Line reserves the dedicated port block **47191–47198** so the dev stack,
the installed desktop app and a Docker deployment can coexist on one machine.

| Port | Used by |
|---|---|
| **5432** | PostgreSQL (standard port) — the dev database (`DATABASE_URL` in `backend/.env`) |
| **47191** | Backend API in development (`npm run dev:server`) |
| **47192** | Backend API of the installed desktop app (bundled runtime) |
| **47193** | PostgreSQL of the installed desktop app (portable, `%APPDATA%\Opal Line Billing\pgdata`). The desktop app owns the `opal_line` database; dev uses its own `opal_line_dev` database in the same cluster, so dev seeding/wipes can never touch the app's data |
| **47195** | Vite dev server (UI in development) |
| **47196** | Backend in Docker (`docker-compose.yml`, container listens on 4000) |
| **47197** | Frontend in Docker (nginx) |
| **47198** | PostgreSQL in Docker (container listens on 5432) |

In Docker the backend reaches the database over the compose network
(`DATABASE_URL=...@db:5432`), so 47198 is only for host-side tools. Dev vs
desktop never collide: dev uses 47191/47195 + external PG on 5432, the desktop
app uses its own 47192/47193 pair and refuses to start with a clear message if
those are taken.

## Repository layout

```
frontend/           React + Vite + Tailwind UI (billing software)
backend/            Express + Drizzle + PostgreSQL API, Shopify sync, pricing
electron/           Electron main/preload + electron-builder config
e2e/                Playwright end-to-end tests (53)
docs/               Guides (Flow webhook, release notes draft)
scripts/            Build, desktop packaging and maintenance utilities
```

## Quick start (development)

Prerequisites: **Node.js 20 LTS+**, npm 9+, and **PostgreSQL 14+** (or a
portable server placed in `backend/pgsql`).

```bash
npm install              # installs both workspaces (hoisted to root)
npm run dev              # first run provisions the local PostgreSQL (port 47193),
                         # writes backend/.env, then starts backend 47191 + UI 47195
```

On first run the backend also bootstraps the schema and the admin user in
dev's own database `opal_line_dev` (same local cluster and data directory as
the desktop app, but never the app's `opal_line` database — so dev work and
seeding can't touch installed-app data). Prefer your own server or a cloud database
(Neon/Supabase)? Create `backend/.env` from `backend/.env.example` with your
`DATABASE_URL` first — `npm run dev` then leaves it alone. Add Shopify creds
there too, or set them later in the UI.

Default seeded login: **admin / Opal@2026** (change it in Users & Roles).

💡 Dev-mode DB check: after `npm run db:seed`, run `curl http://127.0.0.1:47191/api/v1/health` — it should return `"database":{"healthy":true,...}` confirming the API can reach PostgreSQL.

Run pieces separately: `npm run dev:server` (backend only) or `npm run dev:web`
(frontend only). All configuration — env vars, in-app settings, Shopify,
integrations — is documented step-by-step in
**[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**.

## Common tasks

```bash
npm run build          # typecheck + build the frontend
npm run lint           # lint the frontend
npm run typecheck      # typecheck the backend
npm run start:server   # run the backend without watch mode
npm test               # backend unit tests (run inside backend/)
npx playwright test    # full e2e suite (needs the dev stack running)
```

## Install the desktop app (Windows installer)

The installer is fully self-contained: **no Node.js, no PostgreSQL, no admin
rights needed** on the target machine. Download
`Opal-Line-Billing-Setup-<version>.exe` from the
[GitHub Releases](https://github.com/kumarboobesh765-code/Opal-Line/releases)
page, or build it yourself (last subsection).

### Install steps

1. Run `Opal-Line-Billing-Setup-<version>.exe`. It is code-signed — SmartScreen
   shows **Opal Line Jewels LLP** as the verified publisher, and no UAC prompt
   appears.
2. On **Choose Installation Options**, pick "Anyone who uses this computer"
   or "Only for me" — either way no admin rights are needed. Click *Next*.

   ![Installation options](docs/screenshots/installer/installer-step1-options.png)

3. The wizard copies the app, the bundled backend and PostgreSQL
   (~145 MB, about half a minute).

   ![Installing](docs/screenshots/installer/installer-step2-installing.png)

4. Click *Finish* on the completion page. **Run Opal Line Billing** is ticked
   by default — leave it to launch straight away. First launch automatically:
   - initializes the bundled PostgreSQL 16.4 into
     `%APPDATA%\Opal Line Billing\pgdata` (port **47193**),
   - starts the backend API (port **47192**) and applies the schema + seed
     roles, then shows a one-time dialog with the generated **admin**
     password (store it — it is displayed only once).

   ![Finish](docs/screenshots/installer/installer-step3-finish.png)

5. Log in as **admin** with the generated password and change it in
   *System → Users & Roles*.

### What's inside

| Component | Detail |
|---|---|
| Backend API | Express, runs via Electron's Node (`ELECTRON_RUN_AS_NODE`) — port **47192** |
| Database | Portable PostgreSQL 16.4, data in `%APPDATA%\Opal Line Billing\pgdata` — port **47193** |
| UI | Built React app served by the backend from `resources/frontend/dist` |
| App files | `%LOCALAPPDATA%\Programs\Opal Line Billing` |
| User data | `%APPDATA%\Opal Line Billing` (pgdata, logs, backups) |

Nothing is installed machine-wide. Uninstalling keeps your data
(`deleteAppDataOnUninstall: false`) — back up via *System → Backup & Restore*;
delete `%APPDATA%\Opal Line Billing` afterwards only if you want a clean wipe.

### Verify after install

- *System → Status* in the app shows **Database: healthy** with live pool stats.
- Or probe the API: `curl http://127.0.0.1:47192/api/v1/health` →
  `"database":{"healthy":true,...}`.
- Connect Shopify under *System → Connections*, then check the sync as
  described in [Verify database & Shopify sync](#verify-database--shopify-sync).

### Repeatable installer smoke test

A committed script silently installs the built installer, verifies the
extracted tree (app.asar, backend bundle, frontend, PostgreSQL incl. timezone
data and VC++ runtime), checks the Authenticode signature and uninstall entry,
boots the app and probes ports 47192/47193:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test-install.ps1 -StopAtEnd
```

The full Playwright suite can also run against the **installed app** (it must
be running). Pass its port and the generated admin password (shown once on
first launch):

```bash
E2E_BASE_URL=http://127.0.0.1:47192 E2E_PASSWORD=<generated-password> npx playwright test
# 52 pass, 1 skips — the repaired-demo-order test needs dev-store data
```

CI runs the whole flow on every push (`desktop-e2e` job in
`.github/workflows/ci.yml`, Windows): build the signed installer → silent
smoke install → full Playwright suite against the **installed** app, logging
in with the generated first-run admin credentials.

The first-run bootstrap is verified on a **clean machine**: with the install
directory, `%APPDATA%\Opal Line Billing` and the uninstall registry entries
wiped beforehand, the bundled PostgreSQL initializes on 47193, the backend
bootstraps the schema (45 tables), the generated admin logs in, and
`/api/v1/db/stats` returns fresh data. No Node.js, PostgreSQL or other
dependency is needed on the target machine.

Note: NSIS remembers the last chosen install directory (e.g. from a previous
/`allusers` test run) and a silent install will reuse it — if the script fails
on path checks, uninstall via the existing *Uninstall Opal Line Billing*
entry first, then re-run.



### Build the installer yourself

```bash
npm run electron:build   # signed NSIS installer → dist-electron/
```

Requires Node.js 20+; downloads portable PostgreSQL 16.4 on first run. Bundles
the frontend dist, esbuild-bundled backend and native deps. Code-signing
requires a certificate whose subject contains **Opal Line Billing** (see
`.github/workflows/release.yml`) — a missing/mismatched cert fails the build
instead of shipping unsigned.

## Shopify integration

1. Create a **Custom App** in Shopify Admin → Settings → Apps → Develop apps.
2. Grant `read/write` on products, orders, customers, inventory.
3. Paste the **store URL + Admin API token** in the ERP: *System → Connections*
   (stored encrypted in the database) or via env vars.
4. For dev stores (PII redacted on the API): set up the **Flow webhook** and/or
   **order email ingestion** so customer name/address auto-fills — see
   [docs/shopify-flow-webhook.md](docs/shopify-flow-webhook.md).

Sync runs from the ERP: *Shopify → Orders / Products / Customers / Inventory /
Price*, plus push tools (products, prices, inventory) and the stock-count
round-trip. Collections attach to products as pipe-separated titles
(`Rings | Home page`). Images pushed to Shopify are strictly the ones you
uploaded or linked — Shopify round-trip URLs are never re-sent.

### Verify database & Shopify sync

```bash
# 1. Database health (also visible in-app: System → Status)
curl http://127.0.0.1:47191/api/v1/health
# → "database":{"configured":true,"healthy":true,"latencyMs":1,...}

# 2. Shopify connection + per-resource totals
curl -b cookies.txt http://127.0.0.1:47191/api/v1/shopify/status
# → {"configured":true,"store":"...","totals":{"orders":43,...}}

# 3. Run a sync (auth + CSRF required; from the UI: Shopify → Sync)
curl -b cookies.txt -X POST http://127.0.0.1:47191/api/v1/shopify/sync \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
  -d '{"resources":["orders","products","customers","inventory"]}'
# → {"ok":true,"results":{...},"db":{"orders":"43 updated",...}}
```

For each resource the sync response reports `ok` and the imported/updated
count, and the `db` block summarises what was written. On a dev/trial Shopify
store the **price** resource can report `ok: false` when no products carry an
active price on the store — that is a store-plan limitation, not a sync
failure. If a sync errors, check *System → Status* logs and the webhook/email
ingest fallbacks in [docs/shopify-flow-webhook.md](docs/shopify-flow-webhook.md).

## Documentation

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — every config knob: env
  vars with examples, in-app settings, Shopify, email/WhatsApp/Razorpay,
  backups, logging, tunnels, desktop build
- [docs/shopify-flow-webhook.md](docs/shopify-flow-webhook.md) — auto-fill
  customer PII on new orders via Shopify Flow
- [DEPLOYMENT.md](DEPLOYMENT.md) — production deployment guide
- [ROADMAP.md](ROADMAP.md) — planned work

## License

Private — © Opal Line Jewels LLP. All rights reserved.
