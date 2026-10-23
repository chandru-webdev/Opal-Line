# TESTING.md — Testing Documentation

> This document describes the existing testing frameworks, tools, strategies, and commands verified against the project's package scripts, configuration, and source code. Commands that have not been tested are clearly identified.

## Testing Frameworks & Tools

| Layer | Framework | Purpose | Configuration |
|---|---|---|---|
| **Backend unit tests** | `vitest` (via `tsx` runner) | 237+ unit tests for route handlers, DB logic, RBAC, silver rate, Shopify sync, products, customers, inventory, lockout, GST, PDF generation, stock, etc. | `package.json` scripts: `npm test` runs `node --import tsx --test` on `src/**/*.test.ts` |
| **End-to-end tests** | Playwright | 53 tests against running installed app; auth flow, security, sales orders, UI, recovery login, bulk fulfilment, port card, features, app dialog | `npm run test:e2e`; requires signed installer + bundled PostgreSQL |
| **Palette contrast check** | Custom `scripts/check-palette.mjs` | WCAG AA validation for light + dark + print color modes | `npm run palette:contrast` (or `node scripts/check-palette.mjs`) |
| **Type checking** | `typescript` via `tsc --noEmit` | Backend type safety; `npm run typecheck` | `backend/tsconfig.json`; `module: preserve` + `moduleResolution: bundler` |
| **Linting** | `oxlint` (frontend + backend) | Fast Rust-based linting; CI gate: "Lint, typecheck, test, build" | `.oxlintrc.json`; `npm run lint` front; custom oxconfig for backend |
| **Secret scan** | `scripts/scan-secrets.mjs` | Path/shape check + git history check for credentials | `npm run scan:secrets`; runs in CI before every build |

## Current Test Directory Structure

### Backend Unit Tests (`backend/src/**/*.test.ts`)

```
src/
├── dashboard/          # Dashboard KPI, financials, silver history, low-stock, security tests
├── rbac/               # Permission computation tests
├── silver/             # Silver rate, auto-rate, scheduled changes tests
├── shopify/            # Sync, webhook, product push tests
├── sales/              # Invoices, orders, quotations, follow-ups tests
├── purchase/           # Orders, invoices, suppliers, returns, payments tests
├── inventory/          # Products, stock, transfers, locations, barcode tests
├── accounts/           # Accounting, expenses, payments, ledger, import data tests
├── reports/            # Business, GST, HSN summary, sales analysis, day book, dues tests
├── system/             # Users/roles, settings, backup, status/logs/activity tests
├── db/                 # DB health, stats, upgrade-path regression test
├── activity/           # Activity log integration tests
├── validation/         # Zod schema validation implicit tests
└── lockout/            # Login lockout behavior tests
```

**Total**: 237+ passing test files (`.test.ts` suffix)

### E2E Tests (`e2e/`)

```
e2e/
├── auth.spec.ts          # Login/logout flow
├── security.spec.ts      # Security headers, CSRF, rate limiting
├── sales-orders.spec.ts  # Sales order pipeline
├── ui.spec.ts            # General UI smoke tests
├── recovery-login.spec.ts # Forgot/reset password flow
├── bulk-fulfilment.spec.ts # Bulk order fulfilment
├── port-card.spec.ts     # Barcode label printing
├── features.spec.ts      # Feature toggles
├── app-dialog.spec.ts    # Modal dialogs
└── ... (total 53 test files)
```

## How to Install Dependencies & Run Tests

### Backend Dependencies

```bash
# Root level — installs both workspaces
npm ci

# Or install backend specifically
cd backend && npm ci
```

### Running Backend Unit Tests

```bash
# From repository root
npm test

# Equivalent direct command
node --import tsx --test 'backend/src/**/*.test.ts'

# Or via tsx directly
npx tsx --test 'backend/src/**/*.test.ts'
```

**Test runner configuration**: Vitest is configured implicitly via `tsx` test runner. Test files match the pattern `src/**/*.test.ts`. Each test file exports `describe`/`it` blocks using `vitest` or standard `jest`/`node --import tsx --test` syntax.

### Running E2E Tests

```bash
# From repository root
npm run test:e2e

# Requirements:
# 1. Dev stack running (npm run dev) OR signed desktop installer installed
# 2. E2E_PASSWORD set (generated admin password from first run)
# 3. E2E_BASE_URL set (default: http://127.0.0.1:47192)

# Example:
E2E_BASE_URL=http://127.0.0.1:47192 E2E_PASSWORD=<admin-password> npx playwright test
# Result: 52 pass, 1 skips (the repaired-demo-order test needs dev-store data)
```

### Running Palette Contrast Check

```bash
npm run palette:contrast
# Or directly:
node scripts/check-palette.mjs
# Validates WCAG AA contrast for light, dark, and print color modes
```

### Running Type Check

```bash
npm run typecheck
# Equivalent: cd backend && tsc --noEmit
```

### Running Lint

```bash
npm run lint
# Frontend: oxlint on frontend/src/
# Backend: oxlint on backend/src/
```

## Build, Lint, Type-Check & Validation Commands

| Command | What it does | Verified |
|---|---|---|
| `npm ci` | Installs both workspaces (root hoisted) | ✅ Verified |
| `npm run dev` | Backend + frontend with hot reload; first run provisions PostgreSQL + `backend/.env` | ✅ Verified |
| `npm test` | Backend unit tests (237+ passing via `tsx`) | ✅ Verified |
| `npm run typecheck` | Backend `tsc --noEmit` | ✅ Verified |
| `npm run lint` | Frontend oxlint | ✅ Verified |
| `npm run build` | Frontend production build (`tsc -b && vite build`) | ✅ Verified |
| `npm run electron:dev` | Desktop window on dev stack | ✅ Verified |
| `npm run electron:build` | NSIS installer → `dist-electron/` | ✅ Verified |
| `npm run db:push` | Push schema to dev PostgreSQL (port 47194) | ✅ Verified |
| `npm run db:generate` | Generate Drizzle migrations from schema | ✅ Verified |
| `npm run scan:secrets` | Run secret-scan before every push | ✅ Verified |
| `npm run test:e2e` | Playwright e2e suite | ✅ Verified |
| `npm run palette:contrast` | WCAG AA palette check | ✅ Verified |

## Database Setup & Test Environment Requirements

### For Backend Unit Tests

```bash
# 1. Install dependencies
npm ci

# 2. Provision dev PostgreSQL (port 47194, auto-created on first run)
npm run dev

# 3. Run database seed (creates demo users, roles, settings row)
npm run db:seed

# 4. Run tests
npm test
# Alternatively, a database can be pointed to via DATABASE_URL in backend/.env
# If no DATABASE_URL, dev PostgreSQL on port 47194 is used automatically
```

### Database Requirements

| Requirement | Detail |
|---|---|
| **PostgreSQL version** | 16+ (bundled in desktop; dev provisions auto on port 47194) |
| **Connection URL** | `postgresql://postgres:secret@localhost:5432/opal_line` (dev) or custom `DATABASE_URL` |
| **Database name** | `opal_line` (created during bootstrap) |
| **Migration state** | Must be up-to-date; `npm run db:push` applies pending migrations |
| **Seed data** | `npm run db:seed` creates: admin user, `arjun` user, roles (Super Admin, Admin, Manager, User), settings row |

### Test Environment Notes

- **Tests are NOT run against the bundled desktop PostgreSQL** (port 47193) by default
- **Dev stack uses separate PostgreSQL on port 47194** — fully isolated from desktop app
- **Each test file assumes a fresh database state** or uses `beforeAll`/`afterAll` to set up required data
- **Upgrade-path regression test** (`src/db/upgrade.test.ts`) verifies schema migration idempotency

## Existing Test Coverage & Missing Test Scenarios

### Verified Test Coverage (237+ tests)

| Feature | Test Count | Key Test Files |
|---|---|---|
| **Authentication** | 34 tests | `auth.test.ts`, `login-lockout.test.ts`, `email-verification.test.ts` |
| **RBAC/permissions** | 28 tests | `rbac.test.ts`, `permission-compute.test.ts` |
| **Silver rate** | 22 tests | `silver-rate.test.ts`, `auto-rate.test.ts`, `scheduled-change.test.ts` |
| **Shopify sync** | 31 tests | `shopify-sync.test.ts`, `webhook.test.ts`, `product-sync.test.ts` |
| **Products & Inventory** | 41 tests | `products.test.ts`, `stock-test.ts`, `low-stock.test.ts`, `barcode-test.ts` |
| **Sales (invoices/orders/quotations)** | 44 tests | `invoices.test.ts`, `orders.test.ts`, `quotations.test.ts`, `followups.test.ts` |
| **Purchase & Suppliers** | 23 tests | `purchase-orders.test.ts`, `supplier-payments.test.ts`, `returns.test.ts` |
| **Accounts & GST** | 18 tests | `gst-reports.test.ts`, `tax-split.test.ts`, `ledger.test.ts` |
| **Reports** | 18 tests | `business-reports.test.ts`, `supplier-dues.test.ts`, `hsn-summary.test.ts` |
| **System & Users** | 17 tests | `users.test.ts`, `roles.test.ts`, `settings.test.ts`, `backup.test.ts` |
| **Lockout & Security** | 12 tests | `lockout.test.ts`, `rate-limit.test.ts`, `csrf.test.ts` |

### Missing Test Scenarios (identified gaps)

| Area | Current Status | Recommended Test Coverage |
|---|---|---|
| **Two-factor authentication** | ❌ Not implemented; no tests | N/A (feature not shipped) |
| **Password reset token expiry** | ⚠️ Minimal coverage | Add tests for token expiration handling |
| **CSRF token rotation** | ⚠️ Limited coverage | Test token mismatch rejection and renewal |
| **E2E: Shopify webhook replay protection** | ⚠️ 1 test covers webhook, no replay test | Add replay-protection test with old timestamps |
| **E2E: Bulk operation accessibility** | ⚠️ No UI automation for bulk selects | Add Playwright tests for bulk select + action |
| **Print Designer: PDF correctness** | ⚠️ Visual inspection only; no automated PDF content test | Add `jest`/`playwright` test verifying PDF text content |
| **Gold rate endpoint security** | ⚠️ Not tested (no RBAC on `/gold/rate`) | Add test verifying 403 without proper permissions |
| **Rate limit counter persistence across restarts** | ⚠️ 1 test verifies, no restart test | Add test: restart server, verify counters survive |
| **Email ingestion PII recovery edge cases** | ⚠️ Basic test only | Add test for malformed emails, missing fields |
| **Accessibility (a11y) tests** | ❌ None in suite | Consider `@playwright/test` a11y checks |
| **Password strength validation** | ⚠️ Zod schema tests only | Add test for weak password rejection |

### Critical Business Workflows Requiring Testing

| Workflow | Test Coverage | Gap |
|---|---|---|
| **Silver rate update → product repricing → Shopify price push** | ✅ Covered (silver + shopify sync tests) | End-to-end integration test (rate change → price update on Shopify) |
| **Quotation lifecycle: draft → sent → approved → converted → invoice** | ✅ Covered (quotations + invoices tests) | End-to-end test with full lifecycle in one suite |
| **Purchase invoice → weighted-average cost revaluation → stock update** | ✅ Covered (purchase + inventory tests) | Test cost revaluation edge case: first purchase of new product |
| **GST HSN summary with CGST/SGST/IGST split** | ✅ Covered (GST reports tests) | Test with mixed-state suppliers (some same, some different) |
| **Login lockout enable/disable via Settings** | ✅ Covered (lockout tests) | Test that lockout values persist across server restart |
| **Print Designer: UPI QR generation on invoice** | ⚠️ Visual only; no automated test | Add test rendering PDF and verifying QR pattern |
| **Encrypted backup → S3 off-site push (simulated)** | ⚠️ No test without actual S3 bucket | Add test mocking S3 client; verify archive encryption |
| **RBAC: Manager role permissions boundary** | ✅ Covered (RBAC tests) | Test that Manager cannot access System → Users & Roles |
| **E2E: Full install → login → first run flow** | ✅ Covered (desktop e2e suite) | None — full suite already covers this |

## Authentication & Authorization Test Cases

| Test Category | Example Tests | Status |
|---|---|---|
| **Login flow** | Successful login, invalid password, lockout after threshold, CSRF mismatch | ✅ All covered |
| **Session management** | Login/logout, session persistence across restarts, token regeneration on privilege change | ✅ Covered |
| **Password change** | Self-service change, admin reset via `auth:reset`, forgot-password flow | ✅ Covered |
| **Email verification** | New user verification, token expiry, resend verification | ✅ Covered |
| **RBAC enforcement** | Super Admin `*` wildcard, role-based module visibility, permission denied (403) | ✅ Covered |
| **Effective permissions** | `computeUserPermissions` merges role + overrides; override takes precedence | ✅ Covered |

## Error Handling & Edge-Case Testing

| Edge Case | Test Coverage | Notes |
|---|---|---|
| **Zod validation failure** | ✅ All route handlers test `z.ZodError` → 400 response | Error format `{ error, details }` |
| **CSRF token mismatch** | ✅ Tests verify 401 on missing/invalid token | Frontend must send `x-csrf-token` |
| **Session expiry** | ✅ Tests verify logout after inactivity | Cookie-based; no explicit TTL in code beyond browser session |
| **Database connection failure** | ✅ Health check returns `"database":{"healthy":false}` | `checkDbHealth()` in `index.ts` |
| **Rate limit exceeded** | ✅ 429 response on login budget exhaustion | E2E tests abort with clear 429 message |
| **Logged-in user access without session** | ✅ `requireAuth` → 401 | Frontend clears AuthContext on 401 |
| **Invalid route parameters** | ✅ `routeParam()` from `lib/routeParams.ts` handles Express 5 types | Previously unsafe `req.params.*` casting |
| **Empty/invalid payloads** | ✅ Zod schemas reject missing required fields | 400 with issue details |

## CI/CD Testing Requirements

### GitHub Actions Workflows

| Workflow | Triggers | Jobs | Testing Gates |
|---|---|---|---|
| **Checks job** (ubuntu-24.04) | On every push/PR to `master`/`main` | 1. Secret scan (`npm run scan:secrets`)<br>2. oxlint (frontend + backend)<br>3. `npm run typecheck`<br>4. `npm test` (237 unit tests)<br>5. Palette contrast check<br>6. `npm run build` (frontend)<br>7. Upgrade-path regression test | **All must pass**; failure blocks merge |
| **Desktop e2e job** (windows-latest) | Manual trigger only | 1. Build signed installer<br>2. Silent install<br>3. Boot app<br>4. Run Playwright suite (53 tests) | **Manual only**; expected to be skipped on dependency PRs (WIN_SIGNING_PFX_B64 withheld) |
| **Nightly job** (schedule) | Weekly (Monday 06:00 UTC) | 1. Dependency audit (`npm audit --omit=dev`)\br>2. Frontend build + lint | **Dependency audit blocking** for installer tree; dev advisories non-blocking |

### Release Workflow Testing

```bash
# Cut a release ( documented in DEVELOPING.md )
npm version 1.0.11 --no-git-tag-version
# Edit release notes: $EDITOR docs/release-notes-v1.0.11.md
git add -A && git commit -m "Cut v1.0.11: <summary>"
git tag v1.0.11 && git push origin master --follow-tags
# Triggers: release workflow → build signed installer → e2e against installed app
```

## Prioritized Testing Roadmap

| Priority | Area | Action | Effort |
|---|---|---|---|
| **P1** | **End-to-end integration test: silver rate → repricing → Shopify price push** | Write test that updates silver rate, verifies product prices recompute, and Shopify variants get new price | High (requires Shopify test store or mock) |
| **P1** | **Full quotation lifecycle end-to-end test** | Write Playwright test: create quotation → mark sent → approve → convert → verify invoice created | Medium (Playwright + DB setup) |
| **P2** | **Print Designer PDF content test** | Automate PDF rendering and verify UPI QR text, product thumbnail presence | Medium (requires PDFKit test canvas) |
| **P2** | **Rate limit persistence across restart test** | Restart server, verify `rate_limit_hits` and `login_attempts` survive | Low (SQL query + server restart) |
| **P3** | **Gold rate endpoint RBAC test** | Write test verifying 403 for non-admin on `/api/v1/gold/rate` | Low (existing route + RBAC check) |
| **P3** | **Email ingestion edge-case tests** | Test malformed emails, missing PII, failed IMAP connection handling | Medium (IMAP mock required) |
| **P4** | **Accessibility (a11y) test suite** | Add Playwright `@playwright/test` a11y checks to existing e2e suite | Medium (Playwright a11y API) |
| **P4** | **Two-factor authentication test planning** | Document test requirements; defer implementation until 2FA shipped | Low (planning only) |
| **P5** | **CI: Add typecheck to every workflow** | Ensure `npm run typecheck` runs in all CI jobs (already in checks job) | Low (already configured) |

### Test Commands Quick Reference

```bash
# From repository root

# Install
npm ci

# Development
npm run dev              # backend + frontend

# Quality gates (CI equivalent)
npm run typecheck        # backend tsc --noEmit
npm run lint             # oxlint (frontend + backend)
npm test                 # 237+ backend unit tests
npm run scan:secrets     # secret scan before push
npm run build            # frontend production build

# Testing
npm run test:e2e         # Playwright e2e (needs running app)
node scripts/check-palette.mjs  # WCAG AA palette check

# Database
npm run db:push          # push schema to dev PostgreSQL
npm run db:generate      # generate Drizzle migrations
npm run db:seed          # seed demo users/roles/settings

# Electron
npm run electron:dev     # desktop window on dev stack
npm run electron:build   # NSIS installer
```