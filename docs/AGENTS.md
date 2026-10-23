# AGENTS.md — AI Coding Agent Instructions

This file provides project-specific instructions for AI coding agents working on the Opal Line Billing ERP.

## Repository Structure

```
Opal-Line/
├── docs/                     # This directory — documentation index + guides
├── frontend/                 # React + Vite + Tailwind CSS v4 SPA
│   ├── src/                  # TypeScript source (1278+ type defs)
│   │   ├── pages/            # 60+ page components (lazy-loaded)
│   │   ├── components/       # UI layout + primitives + RequirePermission
│   │   ├── auth/             # AuthProvider, AuthContext
│   │   ├── lib/              # API clients, theme, permissions, utils
│   │   ├── types/            # 1278+ TypeScript interfaces
│   │   ├── hooks/
│   │   └── config/
│   ├── vite.config.ts        # Vite dev server, /api → localhost:47191 proxy
│   ├── tsconfig*.json        # 4 TS project references; @/* → ./src/*
│   ├── .oxlintrc.json        # oxlint config
│   ├── postcss.config.js     # Tailwind CSS 4 + @theme CSS-first block
│   └── package.json
├── backend/                  # Express + Drizzle ORM + PostgreSQL (TS)
│   ├── src/                  # TypeScript source (~97 route + lib files)
│   │   ├── index.ts          # App entry (450+ lines, full route registration)
│   │   ├── routes/           # 24 route modules (auth, rbac, silver, shopify, etc.)
│   │   ├── db/               # Drizzle client, schema (100+ tables), migrations, seed
│   │   ├── types/
│   │   ├── lib/              # Utility libs (routeParams, crypto, pgRateLimitStore, etc.)
│   │   ├── validation/       # Zod validation schemas
│   │   ├── constants.ts      # Application constants (rate limits, cookie names)
│   │   ├── logger.ts         # Pino logger config
│   │   ├── sessions.ts       # Session management (create/destroy/verify)
│   │   ├── rbac.ts           # Role-based access control computation
│   │   ├── activity.ts       # Activity/audit logging
│   │   ├── lockout.ts        # Login lockout management
│   │   └── 97+ other feature files
│   ├── drizzle.config.ts     # Drizzle-kit migration config
│   ├── package.json          # Dependencies: argon2, drizzle-orm, express, helmet,
│   │                           express-rate-limit, postgres, qrcode, resend, pdfkit,
│   │                           zod, aws4fetch, cookie-parser, cors
│   ├── tsconfig.json         # module: preserve, moduleResolution: bundler, target ES2022
│   └── .env.example          # All environment variables with examples
├── electron/                 # Electron desktop app (v44.8.0, NSIS installer)
│   ├── dist-electron/        # Built installer resources
│   └── scripts/              # Build/packaging scripts
├── e2e/                      # Playwright end-to-end tests (53 tests)
├── scripts/                  # 50+ automation scripts
├── shopify-templates/        # Shopify liquid templates
└── .github/workflows/        # CI/CD configurations
```

## Coding Rules & Naming Conventions

| Category | Convention | Example |
|---|---|---|
| **TypeScript interfaces** | PascalCase interface name, prefixed if domain-specific | `interface UserSession { ... }` |
| **Functions** | camelCase, verb-noun order where applicable | `computeUserPermissions()` |
| **Components** | PascalCase, file name matches | `AppShell.tsx`, `RequirePermission.tsx` |
| **Route handlers** | camelCase, grouped by feature | `authRouter`, `silverRateRouter` |
| **Variables** | camelCase, descriptive | `DATABASE_URL`, `csrfToken` |
| **Constants** | UPPER_SNAKE_CASE (TS) or pascalCase (exported const) | `CONSTANTS` object, `MAX_LOGIN_ATTEMPTS` |
| **Database tables** | snake_case (SQL) | `users`, `roles`, `products` |
| **Migration files** | YYYY_MM_DD_description.ts | `2024_01_15_add_users_table.ts` |
| **Env variables** | UPPER_SNAKE_CASE | `DATABASE_URL`, `PORT`, `SEED_ADMIN_PASSWORD` |
| **Aliases/imports** | `@/` prefix resolves to `./src/` | `import { db } from '@/db/client'` |

### Import Organization (TypeScript)

1. Built-in Node.js modules (always first)
2. Third-party packages (alphabetical)
3. Internal project imports (alphabetical by path, `@/`-preferred)
4. Type imports separated from value imports when using `import type`

```typescript
// Good
import express from 'express'
import { db, schema } from '@/db/client'
import type { User } from '@/types'

// Avoid — mixed default+value from same module without type:
import { db } from '@/db/client'  // use import type for selectors only
```

## Commands

| Command | What it does | Location |
|---|---|---|
| `npm ci` | Installs both workspaces (root hoisted) | Root |
| `npm run dev` | Backend + frontend with hot reload (first run provisions PostgreSQL + `backend/.env`) | Root |
| `npm test` | Backend unit tests (237+ passing via `tsx`) | Root / backend/ |
| `npm run typecheck` | Backend `tsc --noEmit` | Root |
| `npm run lint` | Frontend oxlint | Root / frontend/ |
| `npm run build` | Frontend production build (`tsc -b && vite build`) | Root |
| `npm run electron:dev` | Desktop window (Electron) on dev stack | Root |
| `npm run electron:build` | NSIS installer → `dist-electron/` | Root |
| `npm run db:push` | Push schema to dev PostgreSQL (port 47194) | Root |
| `npm run db:generate` | Generate Drizzle migrations from schema | Root |
| `npm run scan:secrets` | Run secret-scan before every push | Root |
| `npm run test:e2e` | Playwright against running app | Root |
| `npm run auth:reset` | Reset admin password / lockout counters | Root |

### Development Workflow

1. `npm ci` — install dependencies (root-level hoisted workspace)
2. `npm run dev` — starts backend (`tsx watch src/index.ts` on port 47191) + frontend (`vite` on port 47195)
3. First run: `backend/.env` is written automatically; dev PostgreSQL on port 47194 is provisioned
4. Login: `admin` / `Opal@2026` (first login forces password change)
5. Run `npm run db:seed` for demo data (creates `arjun` user, sample roles, settings row)
6. Access UI at `http://127.0.0.1:47195`, API at `http://localhost:47191`

## Architecture Rules & Module Boundaries

| Boundary | Rule | Rationale |
|---|---|---|
| **Frontend ↔ Backend** | All API calls go through `frontend/src/lib/api.ts` — never direct fetch to backend port | Centralizes base URL, error handling, CSRF token injection |
| **Backend routes** | Each route file exports an Express router; register in `index.ts` via `app.use('/api/v1/<feature>', <router>)` | Ensures consistent `/api/v1/` prefix for all endpoints |
| **RBAC enforcement** | Use `requireAuth` middleware (session check) + `enforceRbac` / `requirePermission` (module/action check) on route handlers | `requirePermission('silver-rate', 'edit')` guards specific actions |
| **Database access** | All queries go through Drizzle ORM (`backend/src/db/client.ts`); raw SQL only in migrations | Type safety, migration-driven schema evolution |
| **Session storage** | Cookie-based sessions with `setSessionCookie`/`destroySession`; Argon2 password hashing | Persisted across requests, CSRF-protected, secure password storage |
| **CSRF protection** | Double-submit token: `XSRF-TOKEN` cookie + `x-csrf-token` header on state-changing requests | Prevents cross-site request forgery; enforced on all POST/PUT/DELETE `/api/v1/*` |

### Safe File-Editing Practices

- **Never edit `backend/.env`** after bootstrapping unless rotating secrets — each environment has its own database.
- **Never commit `.env` files** or any credential-shaped files. The `.githooks/pre-commit` hook blocks credential paths.
- **Always run `npm run typecheck`** after adding new routes or modifying schema types.
- **Always run `npm test`** after adding or modifying backend feature logic; 237+ unit tests must pass.
- **Never hardcode API base URLs** — use the proxy `/api` → `localhost:47191` in dev, or `VITE_API_PROXY` env var in production.
- **When adding new env vars**, add to `backend/.env.example` and document in `docs/CONFIGURATION.md`.
- **Database migrations**: run `npm run db:generate` to create migration file, then `npm run db:push` to apply. Never hand-write SQL outside migrations.

## Database Migration Rules

- **Generate**: `npm run db:generate` — creates migration file in `backend/drizzle/` (or `backend/src/db/migrations/`)
- **Push**: `npm run db:push` — applies migration to the active PostgreSQL instance
- **Never edit migration SQL files directly** after generation — use `npm run db:generate` for changes
- **Seed data**: `npm run db:seed` creates demo users, roles, and a settings row. Never run on production.
- **First-run bootstrap**: `npm run dev` provisions dev PostgreSQL (port 47194), writes `backend/.env`, runs `db:push` + `db:seed` automatically.
- **Migration idempotency**: Schema additions are idempotent and applied on every start (`purchase_invoice_items`, `purchase_order_items`, etc.)

## Security Requirements

- **Argon2id** password hashing: memory 65536 KiB, time cost 3, parallelism 4, 16-byte salt, 32-byte hash (`node-argon2` v0.45.1)
- **CSRF double-submit** on all state-changing API requests (`x-csrf-token` header + `XSRF-TOKEN` cookie)
- **Login lockout** configurable via Settings → Security (default: 5 attempts / 15 min, stored in `login_attempts` table)
- **Rate limiting** persisted in PostgreSQL (`rate_limit_hits`, `login_attempts`) — survives restarts
- **Session cookies** are HTTP-only, signed, and regenerated on login
- **ENCRYPTION_KEY** (64-char hex) AES-256-GCM for DB-sealed secrets (Shopify tokens, SMTP, WhatsApp)
- **Never store plaintext passwords** — `users.passwordHash` is always argon2-derived
- **Secrets never in source** — all credentials via `backend/.env` or database encryption
- **Secret scan** runs in CI before every build (`scripts/scan-secrets.mjs`); blocks commit on credential paths

## Rules Agents Must Follow Before Modifying Existing Features

1. **Run `npm run typecheck`** — ensure TypeScript compilation succeeds
2. **Run `npm test`** — ensure all 237+ existing unit tests still pass
3. **Check RBAC implications** — if adding a new module/action, update `rbac.ts` permission computation and ensure route guards are consistent
4. **Check CSRF requirements** — state-changing routes require `x-csrf-token` header; ensure frontend client sends it
5. **Check session/scope impact** — if modifying auth flow, verify `sessions.ts` and `auth-provider.tsx` changes are consistent
6. **Run `npm run scan:secrets`** — ensure no credentials are exposed in new code
7. **Update `docs/CONFIGURATION.md`** if adding new env vars
8. **Update `docs/AGENTS.md`** if coding rules change
9. **Never modify `backend/.env`** directly after bootstrap — use the bootstrap process or `npm run auth:reset` for password changes
10. **If adding a new API endpoint**, add route handler in `backend/src/routes/`, export router, and register in `index.ts` under `/api/v1/`