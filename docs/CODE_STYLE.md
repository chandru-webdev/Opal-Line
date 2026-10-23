# CODE_STYLE.md — Coding Conventions & Standards

## Language & Runtime

| Aspect | Convention |
|---|---|
| **Primary language** | TypeScript (backend: CommonJS, frontend: ES module-compatible TS) |
| **Target** | ES2022 (backend); React 19 + TypeScript 7 (frontend) |
| **Module system** | Backend: `module: preserve` + `moduleResolution: bundler` (tsconfig.json) — enables esbuild bundling for Electron |
| | Frontend: Vite bundler with `moduleResolution: bundler` |
| **Strict mode** | `strict: true` in all tsconfigs; no `any` unless explicitly typed |
| **Nullish coalescing** | Prefer `??` over `||` for null/undefined distinction |

## File & Folder Naming

| Element | Convention | Example |
|---|---|---|
| **Files** | `kebab-case` for new files; existing files use established names | `user-permissions.ts`, `silver-rate-scheduler.ts` |
| **Folders** | `kebab-case` or `snake_case`; `@/` alias for `./src/` | `backend/src/routes/`, `frontend/src/components/` |
| **Test files** | `.test.ts` suffix; Vitest/Vitest-style or Jest-style | `auth.test.ts`, `silver-rate.test.ts` |
| **Migration files** | `YYYY_MM_DD_description.ts` | `2024_03_15_add_silver_rate_table.ts` |
| **Env files** | `.env.example` (committed), `.env` (gitignored) | `backend/.env.example`, `frontend/.env.example` |
| **Hooks path** | `.githooks/` at repo root; `core.hooksPath` set once per clone | `.githooks/pre-commit` |

## Component, Function, Class & Variable Naming

| Category | Convention | Pattern |
|---|---|---|
| **TypeScript interfaces** | PascalCase, descriptive of shape | `interface UserSession { id: string; permissions: Permissions }` |
| **Type aliases** | PascalCase | `type PermissionMap = Record<string, ModulePermission>` |
| **Functions** | `camelCase`; verb-noun when action-oriented | `computeUserPermissions()`, `verifyArgon2()`, `routeParam()` |
| **Component components** | `PascalCase`; file name matches export | `AppShell.tsx` → `export default function AppShell() {}` |
| **Hooks** | `use` prefix + `camelCase` | `useShopifyResource()`, `useAuth()`, `useSilverRate()` |
| **Constants** | UPPER_SNAKE_CASE (exported const) or PascalCase (interface) | `CONSTANTS` object, `MAX_LOGIN_ATTEMPTS = 5` |
| **Variables** | `camelCase`; avoid single-char except loops | `dbStats`, `csrfToken`, `silverRate` |
| **Database tables** | `snake_case` (SQL) | `users`, `roles`, `silver_rate`, `login_attempts` |
| **Enum-style strings** | SCREAMING_SNAKE_CASE as values | `STATUS_ACTIVE`, `STATUS_ARCHIVED` |
| **Error types** | PascalCase extending Error | `class ValidationError extends Error {}` |

### Naming Conventions in Practice (from codebase)

```typescript
// Good — from backend/src/constants.ts
export const CONSTANTS = {
  LOGIN_LOCKOUT_THRESHOLD: 5,
  LOGIN_LOCKOUT_DURATION_MINUTES: 15,
  CSRF_TOKEN_NAME: 'XSRF-TOKEN',
  SESSION_COOKIE_NAME: 'session',
}

// Good — from frontend/src/types/
export interface UserPermissions {
  view: string[];
  create: string[];
  edit: string[];
  delete: string[];
}

// Good — from backend/src/routes/auth.ts
app.post('/login', async (req, res) => { ... })
app.post('/logout', async (req, res) => { ... })

// Good — from frontend/src/lib/api.ts
export const api = fetch as typeof fetch & { ... }
```

## TypeScript / JavaScript Conventions

### Type Preferences

- **Prefer interfaces over type aliases** for object shapes (easier merging)
- **Use `import type`** for type-only imports to avoid runtime impact
- **Avoid `any`** — use specific types; if truly needed, annotate with `// eslint-disable-line`
- **Defensive types** — assume runtime values may differ; validate with Zod before use

### Import Organization

```typescript
// 1. Node.js built-in modules (always first, alphabetical)
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 2. Third-party packages (alphabetical, separate value/type)
import express from 'express'
import helmet from 'helmet'
import { db, schema } from 'drizzle-orm'
import { z } from 'zod'

// 3. Internal project imports (alphabetical by path, @/ preferred)
import { db } from '@/db/client'
import { authRouter } from '@/routes/auth'
import type { User } from '@/types'

// Good — separate default + type imports
import express, { type Router } from 'express'
import { db } from 'drizzle-orm'        // value import
import type { Profile } from 'drizzle-orm/types'  // type only

// Avoid — mixed default+value from same module without type clarity
import { db } from 'drizzle-orm'  // only if you need the value, otherwise use import type
```

### Code Formatting

- **Prettier** configured via `.prettierrc` or `package.json` settings
- **oxlint** for frontend (faster than ESLint); backend uses `oxlint` too
- **Line width**: 100 characters (configurable via oxlint/prettier)
- **Semicolons**: Auto-semicolon insertion enabled; explicit `;` preferred
- **Quotes**: Double quotes (`"`) for strings; single quotes for char literals
- **Trailing commas**: Last in multi-line lists/esmports

## Component & Service Structure

### Frontend Components

| Layer | Location | Convention |
|---|---|---|
| **Layout** | `frontend/src/components/layout/` | `AppShell.tsx` — header + sidebar + main + footer |
| **UI primitives** | `frontend/src/components/ui/` | Radix-powered: `Dialog`, `DropdownMenu`, `Table`, `Input`, `Button` |
| **Page components** | `frontend/src/pages/` | Lazy-loaded; each file = one route |
| **Feature components** | `frontend/src/components/` | `RequirePermission.tsx`, `sales-follow-ups-card.tsx` |
| **Dialog host** | `frontend/src/components/ui/confirm-hosts.tsx` | `DialogHost` + `ToastHost` shared across app |

### Backend Services / Libs

| Service | File | Purpose |
|---|---|---|
| **DB client** | `backend/src/db/client.ts` | Drizzle instance; `db`, `schema`, `checkDbHealth()`, `getDbStats()` |
| **RBAC** | `backend/src/rbac.ts` | `computeUserPermissions(userId)`, `enforceRbac()`, `requirePermission()` |
| **Sessions** | `backend/src/sessions.ts` | `createSession()`, `destroySession()`, `verifySession()` |
| **Argon2 hashing** | `backend/src/lib/argon2*` | Wraps `node-argon2`; `hashPassword()`, `verifyPassword()` |
| **Validation** | `backend/src/validation.ts` | Zod schemas: `loginSchema`, `registerSchema`, `invoiceSchema`, etc. |
| **Rate limiting** | `backend/src/pgRateLimitStore.ts` | PostgreSQL-persisted rate limit store; `PgRateLimitStore`, `pruneExpiredRateLimits()` |
| **CSRF** | `backend/src/sessions.csrf*` | Double-token: `generateCsrfToken()`, `verifyCsrfToken()` |
| **Shopify API** | `backend/src/shopify.ts` | 30+ export functions: `runSync()`, `testShopifyConnection()`, `pushProductsToShopify()` |
| **Silver rate** | `backend/src/silverRateScheduler.ts` | Scheduler, auto-fetch, queued changes, `startSilverRateScheduler()`, `applyRateSchedule()` |

### API Response & Error-Handling Conventions

#### Successful Responses

| Status | Format | Example |
|---|---|---|
| `200` | `{ success: true, data: T }` | `{ success: true, data: { rate: 72.5 } }` |
| `201` | `{ success: true, data: T, id: string }` | `{ success: true, data: { id: "inv-123" }, total: 1250.00 }` |
| `200` (no content) | `{ success: true }` | `{ success: true }` |

#### Error Responses

| Status | Format | Example |
|---|---|---|
| `400` | `{ error: "Validation failed", details: ZodError Issues }` | `{ error: "Validation failed", details: [...] }` |
| `401` | `{ error: "Unauthorized", code: "SESSION_EXPIRED" }` | `{ error: "Unauthorized", code: "SESSION_EXPIRED" }` |
| `403` | `{ error: "Forbidden", code: "INSUFFICIENT_PERMISSIONS" }` | `{ error: "Forbidden", code: "INSUFFICIENT_PERMISSIONS" }` |
| `422` | `{ error: "Unprocessable Entity", code: "VALIDATION" }` | — |
| `429` | `{ error: "Too Many Requests", code: "RATE_LIMITED" }` | — |
| `500` | `{ error: "Internal Server Error", code: "UNEXPECTED", requestId: "uuid" }` | — |

#### Error-Handling in Route Handlers

```typescript
// Pattern from backend/src/routes/silver.ts
app.post('/update', requireAuth, enforceRbac('silver-rate', 'edit'), async (req, res) => {
  try {
    const { rate, note } = req.body
    // Zod validation
    const result = silverRateUpdateSchema.parse({ rate, note })
    // Business logic
    await addScheduledRateChange(result.rate, result.note, req.user!.id)
    res.json({ success: true, message: 'Rate change queued' })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.issues })
    }
    // Log and return 500
    logger.error('Silver rate update error', { err, userId: req.user?.id })
    res.status(500).json({ error: 'Internal server error', code: 'UNEXPECTED' })
  }
})
```

### Validation & Database-Access Patterns

#### Zod Validation Schemas (backend/src/validation.ts)

```typescript
// Pattern: export each schema, use .parse() in route handlers
export const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(8).max(100),
  xCsrfToken: z.string().min(1)
})

export const silverRateUpdateSchema = z.object({
  rate: z.number().positive(),
  note: z.string().optional()
})
```

#### Database Query Patterns

```typescript
// Good — from backend/src/db/queries*.ts (if exists) or inline in routes
import { db, schema } from '@/db/client'
import { and, eq, sql } from 'drizzle-orm'
import { users } from '@/db/schema'

// Select with specific columns
const user = await db.query.users.findFirst({
  where: (users, { eq }) => eq(users.email, email),
  columns: { id: true, name: true, email: true, role: true }
})

// Insert with returning
const [newInvoice] = await db.insert(salesInvoices).values({
  userId: userId,
  customerName: name,
  total: total,
  gst: gstAmount
}).returning({ id: salesInvoices.id })

// Transaction with multiple queries
await db.transaction(async (tx) => {
  // ... multiple operations in single tx
})

// Aggregation
const stats = await db.select({
  total: sql<number>`COALESCE(SUM(${salesInvoices.total}), 0)`,
  count: countDistinct(salesInvoices.id)
}).from(salesInvoices)
.where(eq(salesInvoices.createdAt, sql`CURRENT_DATE`))
```

### Formatting, Linting & Code-Quality Tools

| Tool | Purpose | Config |
|---|---|---|
| **oxlint** | Frontend + backend linting (fast, Rust-based) | `.oxlintrc.json` — project-specific rules |
| **prettier** | Code formatting | `package.json` → `"prettier"` settings; `.prettierrc` |
| **oxc-toplice** | Type checking (oxlint companion) | Integrated into oxconfig |
| **typescript** | `tsc --noEmit` (backend) | `npm run typecheck` → `tsc --noEmit` using backend tsconfig |
| **vitest** (or jest) | Unit tests (backend) | `backend/` test config; `npm test` runs `tsx` on `.test.ts` files |
| **oxlint** rules | Custom rules for this repo | See `.oxlintrc.json` — enables `unused-imports`, `no-unused-vars`, `sort-keys` |

### Existing Inconsistencies & Recommended Standards

| Issue | Current | Recommended |
|---|---|---|
| **Import style** | Mixed: some use `import X from 'y'`, some `import { X } from 'y'` | Standardize: use `import X from 'y'` for defaults; `import { X } from 'y'` for named; use `import type` for types |
| **Wildcard routes** | Migrated from `app.get('*')` to `app.get('/{*splat}')` | Keep `/{*splat}`; use `routeParam()` from `backend/src/lib/routeParams.ts` |
| **Dark mode** | `darkMode: ['class']` + `@custom-variant dark (&:where(.dark, .dark *))` | Keep current Tailwind v4 config; adding new tokens check `--primary`, `--radius`, `.dark` block |
| **TypeResolution** | `moduleResolution: bundler` + `module: preserve` | Do not change; required for esbuild desktop/CI builds |
| **CSRF token name** | `XSRF-TOKEN` cookie + `x-csrf-token` header | Keep double-submit pattern; enforce on all POST/PUT/DELETE `/api/v1/*` |
| **Env var naming** | UPPER_SNAKE_CASE | Maintain; add new vars to `backend/.env.example` |
| **Error response format** | `{ error, code, details? }` | Keep consistent; add `requestId` for 500s via middleware |
| **Session cookie** | HttpOnly, signed, regenerated on privilege change | Keep; document in AGENTS.md and SECURITY.md |
| **Argon2 params** | memory=65536, timeCost=3, parallelism=4 | Keep; documented in AGENTS.md and CONFIGURATION.md |