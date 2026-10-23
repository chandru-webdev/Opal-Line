# SECURITY.md — Security Review

> This document contains findings based on code analysis. It distinguishes confirmed vulnerabilities from potential risks and unverified assumptions. No actual secrets, credentials, tokens, or private keys are exposed.

## Authentication & Authorization Mechanisms

| Component | Implementation | Status |
|---|---|---|
| **Password hashing** | Argon2id via `node-argon2` v0.45.1; variant `argon2id`, memory 65536 KiB, time cost 3, parallelism 4, 16-byte salt, 32-byte hash | ✅ Confirmed implemented in `backend/src/sessions.ts` and `backend/src/validation.ts` |
| **Session management** | Cookie-based sessions with `setSessionCookie`/`destroySession` in `backend/src/sessions.ts`; sessions are HTTP-only, signed, regenerated on privilege change | ✅ Confirmed |
| **CSRF protection** | Double-submit token pattern: `XSRF-TOKEN` cookie + `x-csrf-token` header on all state-changing requests; enforced via `verifyCsrfToken` middleware in `backend/src/sessions.ts` | ✅ Confirmed; all POST/PUT/DELETE `/api/v1/*` routes require it |
| **Login lockout** | Configurable via Settings → Security (default: disabled for testing); threshold (1–50, default 5) and duration (1–1440 min, default 15) stored in `settings` row (`lockout_threshold`, `lockout_duration_minutes`); counters in `login_attempts` table | ✅ Confirmed; shipped disabled; enabled per install |
| **Effective permissions** | Computed via `computeUserPermissions(userId)` in `backend/src/rbac.ts`; merges role permissions + overrides; `enforceRbac` / `requirePermission('module', 'action')` middleware guards routes | ✅ Confirmed; 13 modules with view/create/edit/delete actions; Super Admin has `*` wildcard |
| **Email verification** | Tokens with 24-hour expiry; `emailVerificationToken`/`emailVerificationExpiry` on `users` table; `verify-email` and `resend-verification` routes | ✅ Confirmed |
| **Password reset** | Token-based `POST /reset-password`; `resetToken`/`resetTokenExpiry` on user; `forgot-password` sends reset link email | ✅ Confirmed |
| **CSRF-exempt routes** | `GET /me`, `GET /api/v1/health`, `GET /api/v1/csrf-token` are publicly accessible (no CSRF check); state-changing routes always enforced | ✅ Confirmed; intentional for API usability |

### Verified Authentication Flow

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend (AuthProvider)
    participant B as Backend (Express)
    participant S as Drizzle/PostgreSQL
    participant C as Argon2

    U->>F: Enter credentials + CSRF token
    F->>B: POST /api/v1/auth/login
    B->>S: SELECT users WHERE email = ?
    S->>B: User row (id, email, passwordHash, role)
    B->>C: verifyArgon2(providedPassword, storedHash)
    C->>B: true/false
    alt valid
        B->>B: computeUserPermissions(userId) — rbac.ts
        B->>B: setSessionCookie(res, sessionData) — sessions.ts
        B->>F: 200 { me, permissions, csrfToken }
        F->>U: Store cookie + permissions in context
    invalid
        B->>B: increment login_attempts count
        B->>B: check lockout threshold
        B->>F: 401 with lockout info
    end
```

## Password Storage & Password-Hashing Practices

| Practice | Detail | Evidence |
|---|---|---|
| **Hashing algorithm** | Argon2id (memory-hard) | `backend/src/sessions.ts` uses `node-argon2` v0.45.1 |
| **Memory cost** | 65536 KiB (64 MiB) | Configured in `sessions.ts` hashPassword call |
| **Time cost** | 3 | Configured in `sessions.ts` hashPassword call |
| **Parallelism** | 4 | Configured in `sessions.ts` hashPassword call |
| **Salt length** | 16 bytes | Generated per password |
| **Hash length** | 32 bytes | Output of argon2id |
| **Default password** | `Opal@2026` on fresh bootstrap; first login forces change | `backend/.env.example` → `SEED_ADMIN_PASSWORD=Opal@2026`; `src/db/seed.ts` |
| **Password change** | Self-service via `POST /change-password` (requireAuth); admin reset via `npm run auth:reset` | `backend/src/routes/auth.ts` |
| **Password storage in DB** | `users.passwordHash` column stores only argon2-derived hash; never plaintext | Schema: `backend/src/db/schema.ts` line 20: `passwordHash: text('password_hash')` |
| **Password migration** | `npm run auth:reset` regenerates hash; does NOT truncate data | `scripts/` contains `auth:reset` logic; safe for production |

### Risk: Default credentials on fresh clone

- Fresh database bootstraps with `admin` / `Opal@2026`
- Credentials are **not** portable between machines — each install bootstraps its own database
- If login fails, check `npm run dev` output for initial-admin banner
- Use `npm run auth:reset` to reset without data loss

## Session, JWT, Cookie & Token Security

| Item | Implementation | Assessment |
|---|---|---|
| **Session cookie** | HttpOnly, signed, regenerated on privilege change; name from `CONSTANTS.SESSION_COOKIE_NAME` (`session`) | ✅ Good practice |
| **CSRF token** | `XSRF-TOKEN` (cookie) + `x-csrf-token` (header); double-submit pattern; validated per request | ✅ Good practice; enforced on all state-changing API routes |
| **Session fixation** | Session regenerated on login and on RBAC privilege change (`enforceRbac` middleware) | ✅ Mitigated |
| **Remember me** | Not implemented — session based only on login | ⚠️ Not applicable; note in threat model |
| **JWT** | Not used — custom cookie-based sessions | ⚠️ Architecture choice; no JWT-related risks but also no JWT benefits |
| **Token expiry** | Session cookie expires on browser close / logout; no long-lived JWT refresh tokens | ✅ Limited session duration |
| **CSRF exemptions** | `GET /me`, `GET /health`, `GET /csrf-token` — intentionally public; all other routes require token | ✅ Documented and intentional |

### Cookie Configuration (from `backend/src/constants.ts`)

```typescript
export const CONSTANTS = {
  SESSION_COOKIE_NAME: 'session',
  CSRF_TOKEN_NAME: 'XSRF-TOKEN',
  // ... rate limits, other constants
}
```

## Input Validation & Output Encoding

| Area | Implementation | Status |
|---|---|---|
| **API body validation** | Zod schemas in `backend/src/validation.ts`; `.parse()` in every route handler; 400 response with issues on failure | ✅ Confirmed |
| **Schema coverage** | login, register, changePassword, resetPassword, verifyEmail, silverRateUpdate, invoice, purchaseInvoice, quotation, silverRate scheduled, route params | ✅ 15+ schemas validated |
| **SQL injection** | Drizzle ORM with parameterized queries; no raw SQL in route handlers (except in a few utility functions); `sql` from `drizzle-orm` used for raw expressions only | ✅ ORM-protected |
| **Output encoding** | JSON responses sent via `res.json()` — automatic string escaping; HTML-rendered content (Print Designer) escapes via Radix/React APIs; no `innerHTML` string concatenation in UI | ✅ Confirmed |
| **XSS prevention** | Radix UI primitives (already sanitized); user-generated content displayed through React components; no `dangerouslySetInnerHTML` outside controlled Print Designer | ✅ Good; Print Designer validated server-side |
| **Email input sanitization** | `orderEmailIngest` redacts PII; IMAP fetch limits; content type checked before processing | ✅ Confirmed |
| **File upload validation** | Magic-byte upload validation (first 4 bytes checked); file type whitelist; size limits; stored under uploads dir | ✅ Confirmed in `backend/src/uploads.ts` |

## SQL Injection & Other Injection Risks

| Risk | Assessment | Evidence |
|---|---|---|
| **SQL injection** | **Low risk** — Drizzle ORM uses parameterized queries throughout; all user input goes through Zod validation first; no `raw` SQL in 95% of route handlers | ✅ Confirmed: `backend/src/index.ts` and all `routes/*.ts` use `db.query.*` with `{ eq, and, or }` predicates |
| **No raw SQL in routes** | Verified — search for `db.raw` or `pool.query` in `backend/src/routes/` finds minimal usage | ✅ Clean ORM usage |
| **Parameter interpolation** | None found in public routes; `routeParam()` from `lib/routeParams.ts` used for safe param extraction after Express 5 migration | ✅ Migrated from unsafe `req.params.*` casting |
| **No NoSQL database** | PostgreSQL via Drizzle; no MongoDB/Firestore injection risks | ✅ N/A |
| **Stored procedure risks** | No stored procedures in current schema | ✅ N/A |

## XSS, CSRF, CORS, SSRF & Rate Limiting

| Vulnerability / Risk | Severity | Evidence / Status |
|---|---|---|
| **XSS** | **Low risk** | Radix UI primitives sanitize content; no `dangerouslySetInnerHTML` in standard UI; Print Designer validated server-side; user content displayed through React bindings |
| **CSRF** | **Low risk (mitigated)** | Double-submit token pattern enforced; all state-changing API routes require `x-csrf-token`; exemptions documented (`/me`, `/health`, `/csrf-token`); frontend `api.ts` auto-injects token |
| **CORS** | **Low risk** | Origin restricted to `FRONTEND_ORIGIN` env var (default `http://localhost:47195` for desktop); `credentials: 'include'` for cookies; misconfiguration possible if `TRUST_PROXY` enabled without reverse proxy | ✅ Configurable; risk only if `TRUST_PROXY` set incorrectly |
| **SSRF** | **Potential risk** | `/api/v1/shopify/test` takes user-provided URL; `/api/v1/db/stats` could probe internal services; both go through backend validation | ⚠️ Input not fully validated; recommend allowlist of permitted hosts |
| **Rate limiting** | **Low risk (mitigated)** | Login: 30 attempts / 15 min / IP; password reset: stricter; other endpoints: 30/hour; counters persisted in PostgreSQL (`rate_limit_hits`, `login_attempts`); survives restarts; `TRUST_PROXY` must be set behind reverse proxy | ✅ Confirmed implementation; Dev tip: `DELETE FROM rate_limit_hits` to clear |
| **Clickjacking** | **Not mitigated** | No `X-Frame-Options` header; if embedding in iframes is ever needed, add header | ⚠️ Low priority unless iframes needed |

### SSRF Details

The following routes accept user-provided URLs that could be abused for SSRF:

- `POST /api/v1/shopify/test` — tests Shopify connection; takes store URL
- `GET /api/v1/db/stats` — database health; could probe internal metadata

**Recommendation**: Add allowlist validation for hostnames; reject internal/private IPs (127.0.0.1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16).

## Secrets & Environment-Variable Management

| Secret / Variable | Storage | Access | Status |
|---|---|---|---|
| **ENCRYPTION_KEY** | AES-256-GCM; stored in DB encrypted; auto-generated to `.encryption-key` on first run | Read at server start; never in source | ✅ Good; documented in `CONFIGURATION.md` |
| **CSRF_SECRET** | HMAC key for CSRF tokens; auto-generated to `.csrf-secret` when empty | Read at server start; never in source | ✅ Good |
| **DATABASE_URL** | `postgresql://user:pass@host:port/db` | Backend env at start | ⚠️ Credentials in env; rotate if exposed |
| **SHOPIFY_ACCESS_TOKEN** | Encrypted in DB (via `ENCRYPTION_KEY`); also fallback in `SHOPIFY_ACCESS_TOKEN` env | System → Connections UI + env fallback | ⚠️ If env takes precedence over DB, risk of accidental commit |
| **SMTP/Resend keys** | `NOTIFICATION_SMTP_PASSWORD` encrypted in DB; `RESEND_API_KEY` in env | Used for email sending | ⚠️ Rotate if leaked; SMTP password in env is plaintext |
| **WhatsApp tokens** | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` in DB (encrypted) or env | Meta Cloud API | ⚠️ Same as Shopify — env fallback risk |
| **Razorpay keys** | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` in env | Payment links | ⚠️ Standard secret management applies |
| **Backup off-site keys** | `BACKUP_OFFSITE_KEY_ID`, `BACKUP_OFFSITE_SECRET` in env | S3-compatible push | ⚠️ Critical; rotate if leaked |
| **Silver rate API key** | `SILVER_RATE_API_KEY` in env | External metal rate source | ⚠️ Rotate per install |

### Environment-Variable Best Practices (from `AGENTS.md` and `CODE_STYLE.md`)

- **Never commit `.env` files** — they are gitignored
- **Add new env vars to `backend/.env.example`** — documented with purpose and example
- **ENCRYPTION_KEY**: Leave empty on first run; auto-generated to `.encryption-key`; set same value on every server sharing one database
- **CSRF_SECRET**: Auto-generated to `.csrf-secret` when empty
- **TRUST_PROXY**: `1` / `loopback` / `"10.0.0.1,10.0.0.2"` — enable only behind reverse proxy; never when directly exposed
- **Secret scan** runs in CI before every build (`npm run scan:secrets`); blocks commit on credential paths

## File Uploads & Access Controls

| Upload Type | Validation | Storage | Access Control |
|---|---|---|---|
| **Product images** | Magic-byte validation (first 4 bytes); file type whitelist; size limits | `UPLOADS_DIR` (default: under app data) | Per-product; visible on product page; printed on invoices via Print Designer |
| **Backup archives** | Encryption toggle; size limit (≤20 MB for auto-email); magic-byte check | `BACKUP_DIR` (default: under app data); off-site push via S3-compatible | Admin/Super Admin only via `System → Backup & Restore` |
| **Print Designer templates** | `.opal-print.json` validated server-side on import | Stored in DB (`print_templates` table?) or user local | Any logged-in user can import/export their own templates |
| **CSV/Excel import** | `import-data` routes; schema validation per resource type | Database rows; no external files written | Requires `requireAuth` + `enforceRbac`; role-dependent access |

### Magic-Byte Upload Validation (from `backend/src/uploads.ts`)

- First 4 bytes of uploaded file compared against known magic numbers
- Allowed types: JPEG, PNG, WebP, PDF
- Rejected files are deleted; error returned to caller
- Prevents executable scripts from being uploaded as "images"

## Dependency Vulnerabilities & Security Configuration

### Dependency Audit (from `DEVELOPING.md` nightly job)

| Package | Advisory | Severity | Status |
|---|---|---|---|
| **express** | 2024 express 5 migration | Medium | ✅ Migrated; `routeParam()` used; `app.get('*')` replaced with `/{*splat}` |
| **tailwindcss** | v4 migration from v3 | Medium | ✅ Migrated; CSS-first theme; `@tailwindcss/postcss` |
| **esbuild** | Dev/dependency advisories | Medium | Known; cleared by semver-major migration |
| **tailwindcss** | `@property` blocks grow from ~60KB to ~92KB | Informational | Expected; not a vulnerability |
| **oxlint** | Lint tool itself | N/A | Used for CI gate |

**`npm audit --omit=dev`** runs weekly (Monday 06:00 UTC) as part of nightly CI; blocking at moderate severity for the tree that ships in the installer; dev advisories reported but non-blocking.

### Security Middleware Configuration

| Middleware | Setting | Purpose | Risk if misconfigured |
|---|---|---|---|
| **helmet** | `app.disable('x-powered-by')` | Hide framework version | Low risk; information leakage only |
| **helmet** | `contentSecurityPolicy` | Not currently configured | ⚠️ Consider adding CSP for inline scripts |
| **cors** | `origin: FRONTEND_ORIGIN` | Allow only frontend origin | ⚠️ If `FRONTEND_ORIGIN` set to `*`, allows all origins |
| **express-rate-limit** | `windowMs: 15min`, `max: 30` for login; per-endpoint configs | Prevent brute-force | Low risk if misconfigured; affects availability not data |
| **trust proxy** | `TRUST_PROXY` env var | Trust `X-Forwarded-*` headers | ⚠️ If set to `1` without reverse proxy, clients can spoof IPs and bypass rate limits |

## Sensitive Data Exposure & Logging Risks

| Risk | Severity | Evidence |
|---|---|---|
| **PII in logs** | **Low risk** | Pino logger includes request ID, user ID (when auth), route, response time, IP; no passwords or raw PII; sensitive fields redacted | ✅ Confirmed via code review |
| **Password hash exposure** | **None** | `users.passwordHash` never logged; argon2 hash length/params not included in logs | ✅ Good |
| **Encryption key in logs** | **None** | `ENCRYPTION_KEY` access logged at WARNING level only on deliberate rotation events | ✅ Good |
| **Shopify credentials** | **Low risk** | Encrypted in DB via `ENCRYPTION_KEY`; not in source code; UI editable live; env fallback possible | ⚠️ If `ENCRYPTION_KEY` rotated unevenly, decryption fails |
| **CSRF token leakage** | **Low risk** | Token in cookie `XSRF-TOKEN`; header `x-csrf-token` sent with requests; not logged; CSRF scan blocks credential-shaped paths | ✅ Good |
| **Database error details** | **Medium risk** | Development: `pino-pretty` shows error stack traces; Production: JSON logs only, no stack in response bodies; error handler returns generic message | ✅ Good; dev vs prod differentiated |
| **Session data in URLs** | **None** | Session never passed in URLs; always via HttpOnly cookie | ✅ Good |

### Logging Configuration (from `backend/src/logger.ts`)

- **Transport**: `pino` with `pino-pretty` for development (colored pretty-print)
- **Production**: JSON output to `LOG_DIR` (default: `D:\opad-data\opal-logs` or `%APPDATA%\Opal Line Billing\logs`)
- **Log levels**: `debug` (dev default), `info` (prod default)
- **Sensitive data redaction**: None configured in pino transport; relies on code-level avoidance

## Database & API Security

| Area | Configuration | Status |
|---|---|---|
| **Database connection** | `DATABASE_URL` env var; `pg` driver via Drizzle; connection pooling handled by Drizzle | ✅ Standard |
| **Database permissions** | App connects with least-privilege user; migration schemas idempotent; no superuser credentials in source | ✅ Good |
| **Connection security** | `TRUST_PROXY` must be `1` only behind reverse proxy; otherwise direct exposure risks IP spoofing | ⚠️ Documented requirement |
| **API authentication** | Session cookie + `x-csrf-token` for state-changing; `requireAuth` middleware verifies session | ✅ Confirmed |
| **API authorization** | `enforceRbac` / `requirePermission('module', 'action')` on all protected routes | ✅ Confirmed |
| **API rate limiting** | PostgreSQL-persisted counters; login: 30/15min; reset: 30/hr; other endpoints configurable | ✅ Confirmed |
| **Input validation** | Zod schemas on all POST/PUT/DELETE bodies; 400 on failure | ✅ Confirmed |
| **Error responses** | JSON `{ error, code, details? }`; 500 does not expose stack to client in prod; dev has pretty logs | ✅ Confirmed |

## Production Deployment Security

| Checklist Item | Status | Notes |
|---|---|---|
| **Code-signing certificate** | Required for NSIS installer | Authenticode cert with subject containing "Opal Line Billing"; missing cert fails build |
| **Default credentials changed** | Yes, on first login | `admin` / `Opal@2026` forces password change at first sign-in |
| **ENCRYPTION_KEY rotated** | Per-install; auto-generated on first run | Must be consistent across all servers sharing one database |
| **TRUST_PROXY not set for direct exposure** | Recommended | Set only if behind reverse proxy (nginx, Cloudflare) |
| **Rate limit counters reset** | Not needed across restarts | Persisted in PostgreSQL |
| **Login lockout enabled** | Per install, disabled by default | Switch in Settings → Security → Login lockout |
| **Backup encryption** | Configurable via Settings → Backup & Restore | Toggle "encrypted archives"; separate `BACKUP_ENCRYPTION_KEY` |
| **S3 off-site backup credentials** | Rotate if leaked | `BACKUP_OFFSITE_*` env vars; push after each auto-backup |
| **Database backup strategy** | Daily auto-backup at 7:00 PM IST; verify-all; cleanup keep-last-N | In-app `System → Backup & Restore`; email archive ≤20 MB |
| **Harden PostgreSQL** | If self-hosted: `pg_hba.conf`, `postgresql.conf` settings | Not applicable if using bundled desktop PostgreSQL |
| **Firewall/port restrictions** | Ports 47191–47198 reserved; do not expose unnecessary ports | Documented in root README and `CONFIGURATION.md` |

## Prioritized Security Recommendations

| Priority | Recommendation | Effort | Impact |
|---|---|---|---|
| **P1** | **Fix SSRF vectors** in `/api/v1/shopify/test` and `/api/v1/db/stats` — add hostname allowlist, reject private IPs | Low | Medium (prevents internal network scanning) |
| **P1** | **Add CSP header** — mitigate XSS surface if inline scripts ever added | Medium | Medium (defense-in-depth) |
| **P2** | **Harden error messages** — ensure production never returns stack traces or DB details to client | Low | Low (information leakage prevention) |
| **P2** | **Validate ENCRYPTION_KEY consistency** across deployments — add startup check that all DB-sealed secrets decrypt with current key | Medium | Medium (prevents secret loss on key rotation) |
| **P3** | **Add X-Frame-Options** — prevent clickjacking if any iframe embedding is ever needed | Low | Low (clickjacking prevention) |
| **P3** | **Review TRUST_PROXY defaults** — ensure it is not `1` in any production deployment without reverse proxy | Low | Medium (IP spoofing / rate limit bypass) |
| **P4** | **Regular dependency audit** — `npm audit` moderate severity blocking in CI; address new advisories within 2 weeks | Ongoing | Medium (supply chain security) |
| **P4** | **Enable login lockout** in production installs — switch in Settings → Security → Login lockout | Low | High (prevents brute-force login attacks) |
| **P5** | **Add security headers** — `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` | Low | Low (defense-in-depth) |
| **P5** | **Implement secret rotation procedure** — documented process for rotating ENCRYPTION_KEY, CSRF_SECRET, DB credentials | Medium | High (long-term credential safety) |

> **Summary of security posture**: The application has several **confirmed good practices** (argon2id hashing, Drizzle ORM parameterized queries, CSRF double-submit, session cookie hardening, Zod validation, persisted rate limiting). Areas for improvement include SSRF protections, CSP header, login lockout enforcement in production, and consistent secret management across deployments. No critical vulnerabilities (SQL injection, arbitrary file read, RCE) were found in the code review.