# Developing Opal Line Billing

Everything a new machine (or a new contributor) needs to get from clone to a
green build, plus the safety rails this repo added and why they exist.

## Setup

```bash
npm ci
npm run dev          # backend + frontend together
```

Requires Node 26. On its first run `npm run dev` provisions the local
PostgreSQL (same cluster the desktop app uses, port 47193) and writes
`backend/.env`, so nothing external is needed for day-to-day work. The desktop
app bundles its own PostgreSQL too.

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | backend + frontend with hot reload (first run provisions PostgreSQL + `backend/.env`) |
| `npm test` | backend unit tests (237 passing as of v1.0.21) |
| `npm run typecheck` | backend `tsc --noEmit` |
| `npm run lint` | frontend oxlint |
| `npm run build` | frontend production build |
| `npm run electron:dev` | desktop window (Electron) on top of the dev stack — backend + Vite + app in one command |
| `npm run electron:build` | NSIS installer → `dist-electron/` (what end users install) |
| `npm run scan:secrets` | **run this before every push** |
| `npm run test:e2e` | Playwright against a running app |

## Enable the pre-commit guard (once per clone)

```bash
git config core.hooksPath .githooks
```

`.githooks/pre-commit` blocks a commit that stages a credential-shaped path
(`.env`, `*.pfx`, `playwright/.auth/state.json`, …). Git does not clone
`core.hooksPath`, so this step is per-clone and easy to forget — if you commit
something and the hook never speaks, check that it is set.

False positive? Bypass deliberately:

```bash
SKIP_SECRET_SCAN=1 git commit -m "..."
```

A hook you cannot bypass is a hook somebody deletes, so the escape hatch is
intentional.

## The secret scan

`scripts/scan-secrets.mjs` checks two things, because a clean working tree is
not enough:

1. **Every tracked file** — path shapes (`.env`, `*.pem`, `.auth/state.json`)
   and content shapes (GitHub tokens, private keys, 64-hex session cookies).
2. **All of git history** — a secret committed and deleted in a later commit is
   still fetchable from a public repo, and deleting the branch does not help.

It runs in CI before lint, so a leak fails before anything is built or cached.
Current repo: ~3,300 blobs, ~2.5 seconds.

**If it fires on a real credential, rotate it.** Removing the commit is not
enough on a public repository — the value was world-readable from the moment
it was pushed.

## Branches

`master` and `main` are kept identical (one is a fast-forward of the other).
`master` is protected: it requires the `Lint, typecheck, test, build` check, so
push a branch and open a PR rather than pushing to `master` directly.

## CI

| Job | What it proves |
|---|---|
| `Lint, typecheck, test, build` | the required gate — secret scan, lint, typecheck, unit tests, upgrade-path test, frontend build |
| `Desktop installer e2e (Windows)` | builds the **signed** installer, silent-installs it, boots the app, runs Playwright against the installed build |
| `Nightly` (schedule only) | production dependency audit + frontend build; see below |

The e2e job needs `WIN_SIGNING_PFX_B64`. GitHub withholds repository secrets
from Dependabot-triggered runs, so a probe step sets `SIGNING_AVAILABLE` and
the rest of that job skips rather than failing. Expect **skipped**, not
**failed**, on dependency PRs — that is correct behaviour.

## Dependencies

Dependabot runs weekly (Monday 06:00 UTC) for the npm workspace and GitHub
Actions, grouping coordinated bumps into one reviewable PR.

**Check the majors before merging.** CI only proves the build passes, not that
an upgrade is safe. This repo has already been bitten twice:

- **express 5** — `app.get('*')` throws at startup. path-to-regexp v8 requires a
  *named* wildcard, and v8 wildcards match one or more segments, so `/*splat`
  still 404s on `/`. The working replacement is `/{*splat}` — confirmed against
  `/`, `/products` and `/a/b/c`. On top of that, express 5 types
  `req.params.*` as `string | string[]`; use `routeParam()` from
  `backend/src/lib/routeParams.ts` rather than casting at each site.
- **Tailwind 4** — removes `tailwind.config.js` and the `@tailwind` directives.
  Migrated: the theme now lives in `frontend/src/theme.css` as a CSS-first
  `@theme` block, PostCSS uses `@tailwindcss/postcss` instead of the
  `tailwindcss` + `autoprefixer` pair, and `darkMode: ['class']` became
  `@custom-variant dark (&:where(.dark, .dark *))`. **A v4 build emits ~68
  `@property` blocks**, so CSS grows from ~60KB to ~92KB — that is expected, not
  bloat. What matters is that the theme tokens still reach the output: check
  `--primary`, `--radius` and the `.dark` block after any theme edit, because v4
  silently drops tokens it cannot find rather than erroring.
- **TypeScript 7** — removed the `node10` module resolution outright. The
  backend moved to `module: preserve` + `moduleResolution: bundler`. That is not
  arbitrary: `scripts/build-desktop.js` bundles the backend with **esbuild**
  (`--platform=node --format=cjs`), and dev/test run through `tsx` — also
  esbuild. All three resolve like a bundler, so `node10` was stricter than
  anything that actually loads the code. `nodenext` would force explicit `.js`
  extensions on 179 relative imports for no runtime benefit.
- **dotenv 18** — moves its type declarations behind the package `exports` map,
  which breaks `node10`-era type resolution. Runtime resolution under CommonJS
  is unaffected. `backend/src/types/dotenv.d.ts` declares the module for the
  compiler.

All four majors are now migrated. Express 5 required `routeParam()` from
`backend/src/lib/routeParams.ts` (see `backend/src/routes/` for the convention)
rather than casting `req.params.*` at each of the ~115 call sites.

## Nightly (`nightly.yml`)

Runs at 03:17 UTC and on demand. Two jobs:

- **Dependency audit** — `npm audit --omit=dev` at moderate severity is
  **blocking**; that is the tree that ships in the installer. Dev-tree advisories
  and `npm outdated` are reported but non-blocking, because the known dev
  advisories (esbuild, tailwindcss, drizzle-kit) can only be cleared by the
  semver-major migrations above. A nightly that is red every night is a nightly
  everyone learns to ignore. Also re-runs the secret scan.
- **Frontend build + lint** — catches an upstream or platform drift that a push
  never exercised.

It deliberately does **not** rebuild the Windows installer; that already runs on
every push to `master`, and repeating a 90-minute build nightly to re-prove the
same commit is not worth the runner minutes.

## Cutting a release

```bash
# 1. bump the version (single source of truth)
npm version 1.0.11 --no-git-tag-version

# 2. write the notes
$EDITOR docs/release-notes-v1.0.11.md

# 3. commit + tag — the tag push is what triggers the release workflow
git add -A && git commit -m "Cut v1.0.11: <summary>"
git tag v1.0.11 && git push origin master --follow-tags
```

`electron-builder.yml` derives the installer name from `${version}`, so the
`package.json` bump is the only version edit needed.

The workflow builds a signed Windows installer and publishes a **public**
(non-draft) release with the `.exe` and `.blockmap`. If the run fails at
"Import code-signing certificate", the repo secret `WIN_SIGNING_PFX_B64` is
missing or invalid.

After tagging, confirm the newest release is actually marked *Latest*:

```bash
curl -sL -o /dev/null -w '%{url_effective}\n' \
  https://github.com/kumarboobesh765-code/Opal-Line/releases/latest
```

Two releases created close together can leave *Latest* pointing at the older
one — the flag follows publish time, not version number. Fix in the GitHub UI
or with `gh release edit v1.0.11 --latest`.

## Gotchas

- **Stale backends hold the dev port.** A leftover `node` process on 47191
  silently serves the wrong database. `taskkill` the listener before testing.
- **A fresh DB has only a locked `admin`.** Run `npm run db:seed`, or login
  returns 401. Seeding uses `SEED_ADMIN_PASSWORD` from `src/db/seed.ts`.
- **`npm ci` fails if the installed app is running** — it holds locks on
  `node_modules`. Quit Opal Line Billing first.
- **Login is rate limited** to 30 attempts / 15 minutes.
- **State-changing API calls need `x-csrf-token`** from `GET /api/v1/csrf-token`.