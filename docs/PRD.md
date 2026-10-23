# PRD.md — Product Requirements Document

> This document distinguishes **verified existing functionality** (already implemented and shipped) from **proposed improvements** (planned but not yet implemented). Only verified functionality is marked as "Implemented"; everything else is noted as a future priority.

## Product Overview & Purpose

**Opal Line Billing ERP** is a jewellery-billing enterprise resource planning system designed for silver retailers. It operates as a desktop Electron application (Windows NSIS installer with bundled PostgreSQL) or as a self-hosted web stack (Node.js + Express + Drizzle ORM + PostgreSQL + React + Vite).

### Core Value Proposition

| Capability | Description |
|---|---|
| **Silver-rate priced invoicing** | Invoices priced at (rate + making charge) × weight + GST; auto-repricing when silver rate changes |
| **Shopify two-way sync** | Product, order, customer, and inventory synchronization between ERP and Shopify store; PII recovery from order emails |
| **Supply-chain management** | Order pipeline (draft → sent → approved → converted), bulk packing slips/pick lists, dispatch/shipments, bookings, purchase orders & supplier dues, scan stock counts |
| **Print Designer** | 5 document types (invoice, quotation, order, packing slip, pick list); saved templates; design import/export (.opal-print.json); auto UPI QR on invoices |
| **Double-entry accounting** | Trial balance, P&L, balance sheet, journal entries; GST compliance (CGST/SGST/IGST); TCS (194Q) for bullion buyers |
| **RBAC & security** | Per-user module/action permissions; login lockout; session controls (log out other devices); audit logs |
| **Reporting & compliance** | GST reports (HSN summary, input credit, TCS), sales analysis, day book, supplier dues, ageing reports |
| **Pricing & loyalty** | Silver rate scheduling; auto-update products; loyalty-points module (on/off toggle) |

## Problems the Product Solves

| Problem | How it's Solved |
|---|---|
| **Manual silver rate updates** | Rate change scheduler; when rate updates, all product selling prices recompute; Shopify variants get pushed new prices |
| **Disconnected Shopify ↔ ERP data** | Two-way sync: products (incl. collections, descriptions with sanitised HTML), orders (with PII recovery), customers, inventory; webhook + email ingestion fallbacks |
| **Inconsistent invoice formatting** | Print Designer: save templates with defaults; design import/export; all invoices print with product photo thumbnails when images exist |
| **Accounting errors from manual entry** | Double-entry accounting auto-generated from invoices/purchases; trial balance, P&L, balance sheet; TCS and GST split auto-calculated |
| **Poor supplier/ledger visibility** | Supplier dues report with aging buckets (0–30 / 31–60 / 60+ days); ledger shows open invoices + payment history; automated daily summary email |
| **Quotation lifecycle chaos** | Quotation lifecycle: draft → sent → approved → cancelled/expired; auto-expiry after Valid Until; reopen expired extends by 15 days; follow-ups collect what needs chasing |
| **Manual stock counting & valuation** | Weighted-average cost revaluation on purchase; stock movements audit trail (stock_transactions); low-stock alerts; barcode label printing |
| **Compliance reporting burden** | GST/HSN reports auto-group by HSN code; input credit pro-rata with invoice discounts; IRN generation (off/manual/automatic); TCS tracking |

## Target Users & User Roles

| Role | Permissions (modules/actions) | Typical Workflow |
|---|---|---|
| **Super Admin** | `*` wildcard → all modules, all actions | Full access: user management, system settings, all reports, backup management, role creation, silver rate immediate apply |
| **Admin** | All modules; `view/create/edit/delete` on most | Manage users/roles, configure settings, process invoices, run reports, approve silver rate changes |
| **Manager** | `view` on all; `create/edit` on sales/purchase/inventory; `view` on reports, system | Process incoming orders, approve quotations, manage inventory, view reports |
| **User/Sales** | `view` on dashboard, sales, inventory; `create/edit` on own quotations/invoices | Create quotations, process sales, view customer history, follow up on pending orders |
| **Accountant** | `view` on accounts, reports, system; `create` on expenses, payments | Record expenses, manage payments, run accounting reports, reconcile ledger |
| **Viewer** | `view` on dashboard, sales, products (read-only) | Monitor KPIs, view reports, no write access |

> **Note**: Permissions are module-based with 4 actions per module: `view`, `create`, `edit`, `delete`. The `computeUserPermissions(userId)` function in `backend/src/rbac.ts` merges role permissions + overrides. Module list: `dashboard`, `silver-rate`, `sales`, `purchase`, `inventory`, `accounts`, `reports`, `shopify`, `system`, plus `gold` implicitly available.

## Core Features & Business Workflows

### 1. Silver Rate Management

| Workflow | Details |
|---|---|
| **Update rate** | Admin/Super Admin can apply immediately; non-admin roles submit queued change (pending approval) |
| **Schedule auto-updates** | Editable per install from Silver Rate page: any subset of days + time in Asia/Kolkata; default every day at 09:00; weekend runs fetch last traded rate |
| **One-off scheduled changes** | Guided dialog: set rate with ±adjustments, product price-impact preview, pick date/time (quick picks: Tomorrow 9:00 AM, Saturday 10:00 AM, or custom instant); at most 20 queued; each can be edited/cancelled until it runs |
| **Auto-rate fetch** | `POST /api/v1/silver/auto-rate/fetch-now` applies live MCX spot rate; Admin/Super Admin only; writes to activity log |

### 2. Quotation Lifecycle

```mermaid
flowchart TD
    draft -->|mark sent| sent
    sent -->|mark approved| approved
    approved -->|convert| converted (terminal)
    sent -->|expire| expired (terminal)
    approved -->|cancel| cancelled (terminal)
    expired -->|reopen| draft (extends validity 15 days)
    cancelled -->|reopen| draft (extends validity 15 days)
```

| Action | Where | Notes |
|---|---|---|
| Mark as sent / approved / cancel | Quotations page, row actions | Invalid jumps rejected server-side |
| Email quotation | Row actions (✉) | Sends PDF attached; draft flips to `sent` automatically |
| WhatsApp quotation | Row actions (💬) | Needs `customerPhone`; degrades gracefully when WhatsApp not configured |
| Reopen expired | Row actions (↻) | Extends validity by 15 days, returns to `draft` |
| Auto-expiry | Daily sweep (10:05) | After `Valid Until` passes, becomes `expired`; can no longer be converted |

### 3. Order Pipeline

| Stage | Description |
|---|---|
| **draft** | Quotation not yet sent to customer |
| **sent** | Quotation emailed/ messaged to customer |
| **approved** | Customer confirmed order |
| **converted** | Quotation → Sales Invoice (terminal) |
| **cancelled** | Customer cancelled; terminal |
| **expired** | Valid Until passed; terminal (can be reopened → draft, +15 days) |

### 4. Purchase & Supplier Workflow

| Action | Effect on Stock |
|---|---|
| Record purchase invoice | `stock += qty` per line; cost price re-weighted via weighted average |
| Edit invoice lines | Old lines reversed, then new lines applied |
| Cancel invoice | Stock taken back out; lines kept (reversible) |
| Reinstate cancelled | Kept lines put stock back |
| Delete invoice | Removed for good; stock reversed |
| Receive purchase return | Stock moves out; pending/approved return is paperwork |

### 5. Inventory & Stock Management

| Feature | Detail |
|---|---|
| **Weighted-average cost** | `newCost = (stockOnHand × costOnHand + boughtQty × buyPrice) / newStock` |
| **Low-stock alerts** | Configurable reorder level; UI shows products below threshold |
| **Barcode labels** | `bwip-js` generated; printable thermal labels with product info |
| **Stock transfers** | Between branches; tracked in `stock_transactions` audit table |
| **Location tracking** | `stock_locations` table; products assigned to branches |

### 6. Accounting & GST Compliance

| Feature | Detail |
|---|---|
| **CGST/SGST/IGST split** | Compared supplier GSTIN first two digits vs business GSTIN (from System → Settings → Business) |
| **TCS (194Q)** | Set rate per invoice (usually 1, sometimes 0.25/0.5); 0 disables; computed on pre-tax value; shown on invoice; excluded from input credit |
| **HSN summary** | Groups month's issued invoices by HSN code; taxable value gets pro-rata discount share; blank customer state treated as intra-state (counter sales) |
| **GST e-invoicing (IRN)** | Modes: Off / Manual / Automatic; generated locally in mock mode; gateway round-trip when credentials set (`CLEARTAX_GSTIN`, `CLEARTAX_AUTH_TOKEN`) |
| **Input GST** | Purchase invoices store supplier GSTIN; split depends on state comparison |

### 7. Shopify Integration

| Resource | Sync Direction | Details |
|---|---|---|
| **Products** | Bidirectional | Two-way sync; collections attach as pipe-separated titles (`Rings | Home page`); images pushed are only uploaded/linked ones; round-trip URLs never re-sent |
| **Orders** | ERP → Shopify import | Import with PII redaction; order email ingestion polls Shopify's "New Order" notification email to recover customer name/phone/address |
| **Customers** | Bidirectional | Sync with PII recovery from order emails; Shopify stores redact customer PII on API |
| **Inventory** | ERP → Shopify | Push inventory levels; round-trip respects Shopify's inventory management |
| **Prices** | ERP → Shopify | Push new prices when silver rate changes or manual price sync applied |

### 8. Print Designer

| Feature | Detail |
|---|---|
| **5 document types** | Invoice, Quotation, Order, Packing slip, Pick list |
| **Design customization** | Header style, accent colours, fonts, page size, margins, zebra rows, logo, bank details, UPI QR, Packed-By/Checked-By signature lines |
| **Save & set default** | Applies to every future printout of that type |
| **Export/Import** | `.opal-print.json` files; validated server-side; share between machines |
| **Product thumbnails** | Print with photos when images exist on the product |
| **UPI QR auto-generation** | On invoices; QR links to UPI ID configured in business settings |

### 9. Loyalty Points (module toggle)

| Feature | Detail |
|---|---|
| **LOYALTY_ENABLED** | Configurable via Settings → Appearance or env var; turns the loyalty-points module on/off |
| **Earn points** | Per purchase/ sale; rate configurable |
| **Redeem points** | Per invoice; deduct from loyalty balance |

## Functional Requirements with Unique IDs

| Req ID | Requirement | Implemented |
|---|---|---|
| FR-001 | Silver rate update: Admin applies immediately; non-admin submits pending request | ✅ Implemented (backend: `silver.ts`; frontend: Silver Rate page) |
| FR-002 | Quotation lifecycle: draft → sent → approved → cancelled/expired with server-side validation | ✅ Implemented (backend: `sales.ts` routes; frontend: Quotations page) |
| FR-003 | Two-way Shopify sync: products, orders, customers, inventory | ✅ Implemented (backend: `shopify.ts`; frontend: `useShopifyResource.ts`) |
| FR-004 | Print Designer: 5 doc types, template save/export-import, UPI QR | ✅ Implemented (backend: printTemplates routes; UI: PrintDesigner page) |
| FR-005 | Double-entry accounting: trial balance, P&L, balance sheet, journal | ✅ Implemented (backend: `accounts.ts`; reports: `business`, `gst`) |
| FR-006 | GST compliance: HSN summary, CGST/SGST/IGST split, TCS tracking | ✅ Implemented (backend: `reports.ts`; schema: GST/TCS columns) |
| FR-007 | RBAC: module-based permissions (view/create/edit/delete per role) | ✅ Implemented (backend: `rbac.ts`; frontend: `RequirePermission` component) |
| FR-008 | Login lockout: configurable threshold/duration via Settings → Security | ✅ Implemented (backend: `lockout.ts`; frontend: Settings → Security) |
| FR-009 | Print thumbnails on invoices/quotations/orders when product images exist | ✅ Implemented (backend: PDF generation; frontend: image display) |
| FR-010 | Weighted-average cost revaluation on purchase | ✅ Implemented (backend: purchase invoice logic; schema: `products.cost_price`) |
| FR-011 | Two-factor authentication | ❌ Not implemented (no 2FA in auth flow) |
| FR-012 | Email-based password recovery / reset | ✅ Implemented (backend: `auth.ts` forgot/reset/verify flows; email tokens) |
| FR-013 | Role-based module visibility in sidebar/navigation | ✅ Implemented (frontend: `RequireModule` component + RBAC permissions) |
| FR-014 | Bulk operations: select multiple rows, mark sent/approved/cancel | ✅ Implemented (frontend: Quotations/Sales pages with bulk actions) |
| FR-015 | Audit log: all state changes written with actor name | ✅ Implemented (backend: `activity.ts`; UI: System → Status → Activity Log) |
| FR-016 | Encrypted backups with auto-email and off-site push (S3-compatible) | ✅ Implemented (backend: `autoBackup.ts`; env: `BACKUP_OFFSITE_*`) |
| FR-017 | Silver rate scheduler: auto-update on selected days/times | ✅ Implemented (backend: `silverRateScheduler.ts`; frontend: Silver Rate page) |
| FR-018 | Purchase return workflow: receive, undo receipt, delete | ✅ Implemented (backend: `purchase.ts`; frontend: Purchase Returns page) |
| FR-019 | Customer 360 view: order history, outstanding, contact info | ✅ Implemented (frontend: `Customer360Page`) |
| FR-020 | Gold rate mirroring (exposes `/api/v1/gold/rate` without RBAC) | ⚠️ Verified exists but noted as potential security concern (no RBAC on gold route) |

## Non-Functional Requirements

| Category | Requirement |
|---|---|
| **Performance** | API response < 200ms for common queries (health, me, silver rate); DB queries use Drizzle with proper indexing |
| **Reliability** | 99.9% uptime; session persistence via PostgreSQL-persisted rate limits and login attempts; graceful degradation if Shopify API unavailable |
| **Security** | Argon2id password hashing; CSRF double-submit; RBAC-enforced route guards; rate limiting persisted in Postgres; ENCRYPTION_KEY for DB-sealed secrets |
| **Scalability** | Single-process Express backend (Electron/self-hosted); connection pooling via `pg` driver; not designed for horizontal multi-instance |
| **Maintainability** | TypeScript throughout; Drizzle ORM for type-safe queries; migration-driven schema; documented in `docs/` |
| **Compatibility** | Electron 44.8.0 on Windows 10/11; Node.js 20 LTS+; Tailwind CSS v4; React 19; PostgreSQL 16+ |
| **Accessibility** | WCAG AA color contrast (verified via `scripts/check-palette.mjs`); keyboard-navigable Radix components; screen-reader-friendly DOM order |
| **Data integrity** | All state changes in transactions; audit log captures every mutation; idempotent migrations; schema upgrades on every start |

## User Stories & Acceptance Criteria

| User Story | Acceptance Criteria |
|---|---|
| **US-001** | As a silver retailer, I want to update the silver rate so that all product prices reflect the current market price. | Given I am logged in as Admin, when I submit a new rate, then all products are repriced and Shopify variants get the new price pushed within 5 minutes. |
| **US-002** | As a manager, I want to create quotations and convert them to invoices so that I can bill customers. | Given I have `create` permission on sales, when I create a quotation with validity dates, then I can convert it to an invoice only if it is in `sent` or `approved` state and within validity. |
| **US-003** | As a shopify store owner, I want my products sync to the ERP so that I can manage inventory from one system. | Given I have configured Shopify credentials, when I initiate product sync, then all products are imported and Shopify IDs are stored on each product. |
| **US-004** | As an accountant, I want GST reports with HSN breakdown so that I can file monthly returns. | Given I have invoices for the month, when I generate the HSN summary report, then it groups by HSN code, splits tax by CGST/SGST or IGST, and excludes TCS from input credit. |
| **US-005** | As a user, I want to see low-stock alerts so that I can reorder before running out. | Given products have reorder levels set, when stock falls below the threshold, then the product appears on the Low Stock page with a warning banner. |
| **US-006** | As a printer, I want invoices to print with product images and UPI QR so that customers can pay instantly. | Given a product has an image URL, when I print an invoice, then the PDF includes the product thumbnail and a valid UPI QR code linked to the business UPI ID. |
| **US-007** | As an admin, I want to log out all other device sessions so that I can secure the account after a suspected breach. | Given I have Super Admin or Admin role, when I click "Log out other devices" in Settings → Team, then all other active sessions are invalidated. |
| **US-008** | As a buyer, I want to record purchase invoices with weighted-average cost so that stock valuation is accurate. | Given I record a purchase invoice with line items, when the invoice is saved, then product `cost_price` is re-weighted and stock quantity increases. |

## Key Business Rules & Validations

| Rule | Enforcement |
|---|---|
| **Silver rate changes require approval** | Non-admin roles submit queued change; Admin/Super Admin approves or rejects; every action written to activity log |
| **Quotation validity** | After `Valid Until` passes, quotation auto-expires; cannot be converted; can be reopened (extends 15 days) |
| **Purchase cost revaluation** | Weighted-average formula applied on every purchase invoice; never revalued on sale/cancellation |
| **GST split logic** | Same state (or no supplier GSTIN) → CGST + SGST, half each; Different state → IGST, full; No GSTIN → treated as intra-state |
| **TCS on bullion purchases** | Rate set per invoice (0, 0.25, 0.5, 1); computed on pre-tax value; shown on invoice; excluded from ITC |
| **Shopify PII redaction** | API endpoints strip customer address/phone; email ingestion recovers PII from Shopify's "New Order" notification |
| **CSRF protection** | All state-changing API requests require `x-csrf-token` header + `XSRF-TOKEN` cookie; login, logout, password changes all enforced |
| **Session persistence** | Cookie-based sessions survive restarts; rate limit counters and login attempts persisted in PostgreSQL |
| **Rate limiting** | Login: 30 attempts / 15 min / IP; password reset: 30/hour; other endpoints: configurable; counters in `rate_limit_hits`, `login_attempts` tables |
| **Login lockout** | Configurable threshold (1–50, default 5) and duration (1–1440 min, default 15); stored per-install in settings row; disabled by default for testing |
| **Email verification** | Tokens with 24-hour expiry; new users must verify before login; resend verification available |
| **Password change** | Self-service `POST /change-password` (requireAuth); first login forces password change; admin can reset via `auth:reset` |

## Integration Requirements

| Integration | Direction | Data Flow | Notes |
|---|---|---|---|
| **Shopify** | Bidirectional | Products ↔ ERP; Orders → ERP (with PII recovery); Customers ↔ ERP; Inventory ↔ ERP; Prices → Shopify | Requires Shopify Custom App with `read/write` scopes; webhook HMAC verification; email ingestion for PII |
| **Resend** | ERP → External | Transactional emails: backup summaries, payment reminders, dues statements, daily summary, low-stock alerts | `RESEND_API_KEY` env var; fallback to SMTP (`NOTIFICATION_SMTP_HOST/PORT`) |
| **WhatsApp Cloud API** | ERP → External | Invoice/order/shipping/payment-reminder messages | Requires `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`; configured via System → Connections |
| **Razorpay** | ERP → External | Payment links on invoices; auto-reconciliation of payments | `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`; test/live mode |
| **S3-compatible storage** | ERP → External | Encrypted backup archives pushed off-site after auto-backup | `BACKUP_OFFSITE_ENDPOINT`, `BACKUP_OFFSITE_BUCKET`, `BACKUP_OFFSITE_KEY_ID`, `BACKUP_OFFSITE_SECRET` |
| **ClearTax/IRP** | ERP → External | GST e-invoicing IRN generation | `CLEARTAX_GSTIN`, `CLEARTAX_AUTH_TOKEN`, `CLEARTAX_SANDBOX`; offline mock mode until credentials set |
| **MCX/Silver API** | External → ERP | Live silver rate fetch for product repricing | `SILVER_RATE_API_URL` + optional `SILVER_RATE_API_KEY`; fallback to bundled MCX fetchers |
| **Email ingestion (IMAP)** | External → ERP | PII recovery from Shopify order notifications | `ORDER_EMAIL_*` env vars; polls every 2 minutes; merges customer name/phone/address into orders |

## Constraints & Dependencies

| Constraint | Detail |
|---|---|
| **Electron + bundled PostgreSQL** | Desktop app bundles PostgreSQL 16.4; data in `%APPDATA%\Opal Line Billing\pgdata` (port 47193); cannot coexist with dev stack on same data |
| **Port block 47191–47198** | Dedicated port block; dev uses 47191/47195, desktop uses 47192/47193; cannot mix dev and desktop on same machine |
| **Node.js 20 LTS+** | Required for Express 5, TypeScript 7, Tailwind CSS v4 migrations |
| **PostgreSQL 16+** | Required for Drizzle ORM features; bundled in desktop; dev provisions auto; cloud (Neon/Supabase) supported via `DATABASE_URL` |
| **Shopify Custom App scopes** | `read/write` on products, orders, customers, inventory; no extended permissions needed |
| **GSTIN format** | 15-digit PAN-based India GSTIN; first 2 digits = supplier state; used for CGST/SGST/IGST split |
| **Silver rate MCX schedule** | Weekend runs allowed but MCX closed Saturdays/Sundays; fetch returns last traded rate or fails; manual entry remains available |
| **ENCRYPTION_KEY** | 64-char hex for AES-256-GCM; encrypts DB-sealed secrets; auto-generated on first run if left empty; must be same across all servers sharing one database |
| **Electron code-signing** | Authenticode certificate with subject containing "Opal Line Billing"; missing cert fails NSIS build |

## Known Limitations & Unresolved Questions

| Limitation | Description |
|---|---|
| **No web interface for standalone use** | The desktop app requires the bundled Electron runtime; the web stack (npm run dev) is for development only; no published web deployment target |
| **No multi-company / multi-tenant support** | Each database instance = one install; `settings` row is per-install; no scheme for separate companies in same DB |
| **GST e-invoicing offline mock mode** | Until ClearTax credentials are set, all IRNs are generated locally as `mock`; live gateway round-trip requires API keys |
| **Shopify PII redaction limitations** | Email ingestion depends on Shopify sending "New Order" notification to the configured mailbox; if email fails, PII not recovered |
| **Silver rate weekend fetch** | MCX closed Saturdays/Sundays; auto-fetch returns last rate; users must manually enter weekend rates if needed |
| **Gold rate endpoint lacks RBAC** | `GET /api/v1/gold/rate` mirrors `/silver/rate` but has no permission check; verified as existing behavior, flagged for potential security review |
| **No LDAP/SSO integration** | Auth is local session-based only; no OAuth, OpenID Connect, or SAML support |
| **Report export formats** | Reports display in UI; PDF export via Print Designer; no native Excel/CSV export button (workaround: print to PDF then extract) |
| **Electron platform limitation** | Windows NSIS installer only; macOS/Linux builds not configured in CI; electron-builder Windows-focused |

## Future Improvements & Feature Priorities

| Priority | Feature | Description |
|---|---|---|
| **P1** | **Web interface deployment** | Publish the React app as a standalone web app (not just dev stack); separate from Electron desktop |
| **P1** | **Two-factor authentication** | TOTP-based 2FA added to login flow; optional per-user |
| **P2** | **Advanced reporting** | Excel/CSV export from reports; scheduled email delivery of GST/HSN summaries |
| **P2** | **Multi-branch support** | Per-branch inventory, sales, settings; shared product catalogue with branch-specific prices |
| **P3** | **LDAP/SSO integration** | OAuth2 / OpenID Connect; Azure AD, Google Workspace integration |
| **P3** | **Mobile app** | React Native or PWA version for on-the-go invoice approvals |
| **P4** | **Advanced analytics** | Dashboard predictive insights; sales forecasting; cohort analysis |
| **P4** | **Subscription billing** | Recurring invoices; subscription management; automatic renewals |
| **P5** | **Inventory reservation** | Reserve stock for pending orders; prevent overselling; allocation workflow |
| **P5** | **Barcode scanning** | Mobile barcode scanner for stock counting; integrate with `bwip-js` label generation |

> **Note**: All "Future improvements" are **proposed** and not currently implemented. The verified existing functionality listed in the FR table above represents the current shipped product.

## Revision History

| Date | Version | Changes |
|---|---|---|
| 2026-10-22 | 1.0 | Initial PRD documentation; distinguished 20 implemented FRs from 5 proposed enhancements + 2 verified limitations |