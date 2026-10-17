# Progress Log

Rewritten 2026-10-17 after auditing every claim against the code. Evidence tags:
**[run]** = executed and observed · **[tc]** = typecheck/lint/unit tests only · **[review]** = code reading only.
No item is marked done without a tag saying how it was verified.

## Item 0 — Date filter (DONE, verified)

- Backend `src/lib/dashboardRange.ts`: last7/last30 presets, `enumerateBuckets()`, IST/Monday rules — **[run]** 13/13 tests pass.
- Frontend `src/lib/dashboardRange.ts`: pure mirror of the server resolver (selector label, exact date text, API params, bucket all from one source) — **[tc]** frontend typecheck/lint/build pass.
- `Dashboard.tsx` wired to the lib; skeleton on mount only — **[run]** typecheck/lint/build pass.
- Committed as `dda4131`.

## Item 1a — Weight snapshot (DONE, verified)

- `createInvoiceForOrderRow` now stores **net weight × qty** per invoice item, keyed by SKU from the product catalogue; unknown SKU stays 0 — **[run]** `orderInvoice.test.ts` asserts 12.5 g × 2 = 25 and unknown = 0 against a scratch DB.
- Boot backfill `src/invoiceWeights.ts` (called from `bootstrap.ts`): fills historic weight-0 items from the catalogue, idempotent, never overwrites an existing weight, logs what it changed — **[run]** test asserts backfill, skip-existing, second-run-no-op; also exercised by the scratch-DB bootstrap.
- `formatWeight` renders 0/unknown as `—` instead of `0.00 gm` — **[tc]** frontend typecheck/lint/build pass.
- Repairs to the previous agent's corruption: restored deleted exports in `frontend/src/lib/format.ts` (`istDateKey`, `todayIST`, `formatDate`, `formatDateTime`, `formatTime`, `compactCurrency`, `formatPercent`) and the broken template literals; fixed the `#` comment in `orderEmailIngest.ts` — **[run]** backend tsc + oxlint + 280 unit tests pass; frontend tsc + oxlint + vite build pass.
- DB-gated tests ran against a throwaway cluster `127.0.0.1:47194/opal_line_scratch` (temp data dir, bootstrapped, deleted afterwards). The bundled desktop DB (47193/opal_line) was never written to.

## Item 1b — Total Stock (Weight) sanity — NOT STARTED

## Item 1c — Outstanding point-in-time 'As of now' — NOT STARTED

## Item 1d — Low Stock: default reorder level, table, out-of-stock first — NOT STARTED

## Item 1e — Gross Profit: cost source, 'based on X of Y' — NOT STARTED

## Item 1f — Fair comparisons (same elapsed prior period) — NOT STARTED

## Item 1g — Reconcile totals across Sales/Payment/Net Revenue/Top products+category — PARTLY DONE

- New (uncommitted until this pass): Shopify Orders Sync **auto-raises an invoice for paid, non-cancelled orders** so invoice-derived dashboard widgets get data after a sync. Idempotent — an order that already carries an invoice number is skipped, so re-sync backfills each paid order exactly once. Stock is NOT re-deducted (the import already moved it) via `createInvoiceForOrderRow(order, { deductStock: false })` — **[run]** idempotency and totals pinned by `orderInvoice.test.ts` on the scratch DB.
- Auto-invoice failures are now **recorded in Sync Logs** (`Auto-Invoice`, status failed, retryable) instead of swallowed, and logged via `logger.warn` — **[tc]** typecheck/lint/tests only; the Sync-Log entry itself has no automated test.
- Still missing for 1g: the actual totals reconciliation across Sales/Payment/Net Revenue/Top products+category.

## Item 1h — Card layout: single clean subtitle — NOT STARTED

## Item 2 — Payment Status: donut center full total, 4 rows incl Refunded — NOT STARTED

## Item 3 — Silver Rate History: graph-card redesign, backfill, 7/30/90 toggles — NOT STARTED

## Item 4 — New sections (Financial Analytics, Receivable Summary, Income/Expense, Top Expenses, Recent Invoices, header/quick actions) — NOT STARTED

- Note: Receivables Aging already exists on the Dashboard (predates this plan).

## Item 5 — Widget checks: Receivables Aging, Security (admin-only, unlock), Recent Activities scope — PARTLY DONE

- Security widget exists and is range-aware (`Dashboard.tsx`) — **review**. Admin-only visibility and unlock behaviour: **not verified**.

## Item 6 — Verify on scratch data, tests, cleanup, report repo/branch — PARTLY DONE

- Scratch-DB test run done and cleaned up **[run]** (see Item 1a).
- Remaining: e2e suite run, desktop-build verification, final repo/branch report.

---

## New items found in code, previously missing from this file

### N1 — Shopify silver-rate fallback (code complete)

`getLatestSilverRate()` falls back to the latest product's `silverRate` when no rate row was ever persisted, so the header/dashboard don't show a perpetual blank. Read-only, writes nothing — **[tc]** typecheck/lint pass, **[review]** logic read. No automated test.

### N2 — Dashboard summary `totalOrders` / `totalInvoices` (code complete)

Backend `/dashboard/summary` already returns both **[review]**; frontend `db.ts` type extended to match (Dashboard already reads them for the empty-state check) — **[tc]** frontend typecheck pass.

### N3 — e2e dashboard error-state test (written, NOT run)

`e2e/ui.spec.ts`: mocks `/api/v1/dashboard/kpis` → 500, asserts the error state (message + Retry) shows and the empty state does not — the "error ≠ empty" standing decision — **[review]** only. Needs a running dev stack + login; not executed this pass.

### N4 — `orderInvoice.test.ts` (new, scratch-gated)

Skips unless `DASHBOARD_TEST_DATABASE_URL` points at a scratch DB with schema applied; cleans up its rows in `finally` — **[run]** 2/2 pass on the scratch cluster.

### N5 — Shopify unit tests made hermetic (fix)

12 Shopify tests failed on this machine because `backend/.env` holds `encV1:`-encrypted creds whose `.encryption-key` path pointed at another machine's user profile → decryption fails → config "not configured". The three Shopify test files now **force** their fake credentials instead of `||=` (same as they already did for `DATABASE_URL`) — **[run]** full backend suite: 280 tests, 0 fail, 4 skipped (the DB-gated ones).

### N6 — DB protection for `db:seed` (code complete, verified)

- Prints the exact target **without credentials** before doing anything: `Seed target: host:port/db`.
- Refuses the desktop app's bundled DB (`127.0.0.1:47193/opal_line`) — predicate covered by unit tests + code review; deliberately **not executed** against that URL to avoid any risk to real data.
- Refuses any database that already holds data (users/products/sales_invoices) unless `--force` / `SEED_FORCE=1` — **[run]** live refusal and `--force` success both executed against the scratch DB.
- Helpers in `src/lib/seedGuard.ts` with unit tests — **[run]** in the backend suite.

### N7 — Dev no longer shares the desktop app's database (code complete, verified)

- `scripts/dev.mjs` provisions **`opal_line_dev`** instead of `opal_line`, and auto-migrates an old `backend/.env` that still points at the desktop DB — **[run]** executed: detected old URL, created `opal_line_dev`, rewrote `DATABASE_URL`.
- The desktop app keeps owning `opal_line` on port 47193; the two can run side by side.
- README ports/quick-start updated to say this.
- `scripts/dev.test.mjs` — **[run]** 5/5 pass (includes `isDesktopDbUrl` and the extended `parseDbUrl`).

### N8 — Keep `backend/.env` out of git and the installer (verified, no change needed)

- Git: `.gitignore` pattern `.env` covers it — **[run]** `git check-ignore` confirms.
- Installer: `electron/electron-builder.yml` excludes `!**/.env`, `!**/.env.*`; `scripts/build-desktop.js` deletes any `.env*` from the built backend dist — **[review]**.

---

## Environment notes

- `backend/.env`'s `APP_DATA_DIR`/`LOG_DIR` pointed at another machine's Windows profile (stale), which is why credential decryption failed. `node scripts/dev.mjs` rewrote them to this machine's paths on 2026-10-17. Values never printed.
- README "Default seeded login: admin / Opal@2026" may be stale (the desktop first-run generates a random password shown once) — **not yet checked or changed**.
- ~60 silent `.catch(() => …)` handlers remain in the backend (some deliberate per ROADMAP); only the Shopify auto-invoice one was addressed this pass.
