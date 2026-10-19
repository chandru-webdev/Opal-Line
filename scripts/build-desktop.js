#!/usr/bin/env node

/**
 * Build script for the Opal Line Desktop App.
 *
 * Steps:
 * 1. Build frontend
 * 2. Compile backend TypeScript to a single CJS bundle + runtime node_modules
 * 3. Bundle portable PostgreSQL (downloaded once into backend/pgsql) — optional
 * 4. Compile Electron main process
 * 5. Run electron-builder to create the Windows installer
 *
 * The resulting installer:
 *   - requires NO pre-installed Node.js (backend runs via ELECTRON_RUN_AS_NODE)
 *   - requires NO pre-installed PostgreSQL (portable PG is initialized into
 *     %APPDATA%\Opal Line Billing\pgdata on first launch and started
 *     automatically on port 47193)
 *   - performs first-run DB schema bootstrap + admin seeding automatically
 */

const { execSync, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// Download/extract/prune for the portable server — shared with scripts/dev.mjs,
// which fetches the same binaries on demand for fresh checkouts.
const { PG_VERSION, ensurePortablePostgres: fetchPortablePostgres } = require('./portable-pg.cjs')

const ROOT = path.resolve(__dirname, '..')
const PG_DIR = path.join(ROOT, 'backend', 'pgsql')

function run(cmd, opts = {}) {
  console.log(`  > ${cmd}`)
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts })
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function copyDir(src, dest, skip = []) {
  mkdirp(dest)
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, skip)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

async function ensurePortablePostgres() {
  try {
    await fetchPortablePostgres(PG_DIR, { log: console.log })
    fs.writeFileSync(path.join(ROOT, 'backend', 'pgsql-present.flag'), new Date().toISOString())
    return true
  } catch (err) {
    console.warn(`  ⚠️  Could not bundle PostgreSQL (${err.message}).`)
    fs.rmSync(path.join(ROOT, 'backend', 'pgsql-present.flag'), { force: true })
    return false
  }
}

async function main() {
  console.log('🔨 Building Opal Line Desktop App...\n')

  // Step 1: Build frontend
  console.log('1️⃣  Building frontend...')
  run('npm run build -w frontend')

  // Step 2: Compile backend
  console.log('\n2️⃣  Compiling backend...')
  const backendDist = path.join(ROOT, 'backend', 'dist')

  // Clean dist/ first to avoid stale artifacts (e.g. leaked .env files)
  if (fs.existsSync(backendDist)) {
    console.log('  Cleaning backend/dist/...')
    fs.rmSync(backendDist, { recursive: true, force: true })
  }
  mkdirp(backendDist)
  run('cd backend && npx tsc --outDir dist')

  // Bundle the backend entry to a single CJS file (this is what Electron runs).
  // MUST be rebuilt from current source every time — a stale index.cjs was the
  // cause of the first installer's missing-bootstrap failure.
  run('cd backend && npx esbuild src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.cjs --external:argon2 --external:better-sqlite3')

  // FIX: esbuild CJS output sets `import_meta = {}` breaking pdfkit's ICC path.
  // Patch it so import_meta.url resolves to the bundle file URL.
  // Also patch createRequire to resolve #standard-fonts/* from pdfkit's package.json.
  const bundlePath = path.join(backendDist, 'index.cjs')
  let bundle = fs.readFileSync(bundlePath, 'utf8')
  const urlShim = 'const { pathToFileURL: _ptf } = require("url"); import_meta = { url: _ptf(__filename).href };'
  bundle = bundle.replaceAll('import_meta = {};', urlShim)
  const oldCR = 'require$1 = (0, import_module.createRequire)(import_meta.url);'
  const newCR = 'var { join: _pj } = require("path"); require$1 = (0, import_module.createRequire)(_pj(__dirname, "node_modules", "pdfkit", "package.json"));'
  bundle = bundle.replace(oldCR, newCR)
  fs.writeFileSync(bundlePath, bundle)
  console.log('  Patched import_meta.url + createRequire for pdfkit')

  // Copy esbuild-externalized native addons + their transitive deps.
  // esbuild --external:argon2 means require('argon2') is left as-is at runtime,
  // so we need the actual node_modules package (with its own deps) available.
  const nativePkgs = ['argon2', '@phc', 'node-addon-api', 'node-gyp-build']
  const nmDest = path.join(backendDist, 'node_modules')
  mkdirp(nmDest)
  for (const pkg of nativePkgs) {
    const src = path.join(ROOT, 'node_modules', pkg)
    const dst = path.join(nmDest, pkg)
    if (fs.existsSync(src)) {
      copyDir(src, dst)
      console.log(`  Copied native dep: ${pkg}`)
    }
  }

  // Copy pdfkit runtime files (standard-fonts, data, package.json) so
  // createRequire can resolve #standard-fonts/* subpath imports at runtime.
  const pdfkitSrc = path.join(ROOT, 'node_modules', 'pdfkit')
  const pdfkitDest = path.join(nmDest, 'pdfkit')
  mkdirp(path.join(pdfkitDest, 'js', 'standard-fonts'))
  mkdirp(path.join(pdfkitDest, 'js', 'data'))
  fs.copyFileSync(path.join(pdfkitSrc, 'package.json'), path.join(pdfkitDest, 'package.json'))
  const stdFontsSrc = path.join(pdfkitSrc, 'js', 'standard-fonts')
  if (fs.existsSync(stdFontsSrc)) {
    copyDir(stdFontsSrc, path.join(pdfkitDest, 'js', 'standard-fonts'))
  }
  const iccSrc = path.join(backendDist, 'data', 'sRGB_IEC61966_2_1.icc')
  if (fs.existsSync(iccSrc)) {
    fs.copyFileSync(iccSrc, path.join(pdfkitDest, 'js', 'data', 'sRGB_IEC61966_2_1.icc'))
  }
  console.log('  Copied pdfkit runtime (standard-fonts + data)')

  // SECURITY: Remove any .env files that tsc may have copied into dist/
  // The Electron app generates its own .env in %APPDATA% on first run.
  const envFiles = [
    path.join(backendDist, '.env'),
    path.join(backendDist, '.env.local'),
    path.join(backendDist, '.env.production'),
  ]
  for (const f of envFiles) {
    if (fs.existsSync(f)) {
      console.log(`  ⚠️  Removing secret file from bundle: ${path.basename(f)}`)
      fs.unlinkSync(f)
    }
  }

  // Copy drizzle folder (used by migrate tooling)
  const drizzleSrc = path.join(ROOT, 'backend', 'drizzle')
  const drizzleDest = path.join(backendDist, 'drizzle')
  if (fs.existsSync(drizzleSrc)) copyDir(drizzleSrc, drizzleDest)

  // Step 3: Portable PostgreSQL. REQUIRED by default: backend/pgsql is not in
  // git, so a target PC has nothing else to fall back on — an installer built
  // without it fails on every user's machine with "No PostgreSQL database is
  // available". Pass --no-postgres to deliberately build a bundle that needs
  // an external PostgreSQL or DATABASE_URL instead.
  console.log('\n3️⃣  Bundling PostgreSQL...')
  const noPgFlag = process.argv.includes('--no-postgres')
  const hasPg = await ensurePortablePostgres()
  if (!hasPg && !noPgFlag) {
    throw new Error(
      'Portable PostgreSQL could not be bundled — the installer would then fail on\n' +
      ' every target PC with "No PostgreSQL database is available".\n' +
      '  Fix the download (internet access to get.enterprisedb.com) and retry, or\n' +
      '  pass --no-postgres to build a bundle that requires an external PostgreSQL.',
    )
  }
  if (!hasPg) console.warn('  ⚠️  --no-postgres: building WITHOUT a bundled database.')

  // PostgreSQL's exes link against the VC++ 2015-2022 runtime, which fresh
  // Windows machines may not have installed. Ship the redistributable DLLs
  // next to the pg binaries — Windows prefers application-dir DLLs, so the
  // bundled copies are used without needing a system-wide install.
  if (hasPg) {
    const redist = ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    let bundled = 0
    for (const dll of redist) {
      const src = path.join(sys32, dll)
      const dst = path.join(PG_DIR, 'bin', dll)
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst)
        bundled++
      }
    }
    console.log(
      bundled > 0
        ? `  Bundled ${bundled} VC++ runtime DLL(s) with PostgreSQL`
        : '  VC++ runtime DLLs already present with PostgreSQL',
    )
  }

  // Step 4: Compile Electron
  console.log('\n4️⃣  Compiling Electron main process...')
  run('cd electron && npx tsc')

  // Step 5: Build installer
  console.log('\n5️⃣  Building Windows installer...')
  run('npx electron-builder --config electron/electron-builder.yml --win')

  // Belt and braces: the installer must actually contain the server. A build
  // that silently dropped pgsql (filter mistake, stale flag file) would only
  // be discovered on a user's PC as "No PostgreSQL found".
  if (hasPg) {
    const shipped = path.join(ROOT, 'dist-electron', 'win-unpacked', 'resources', 'pgsql', 'bin', 'pg_ctl.exe')
    if (!fs.existsSync(shipped)) {
      throw new Error(`Build finished but ${shipped} is missing — the installer would ship without PostgreSQL.`)
    }
    console.log('  ✔ Verified: bundled PostgreSQL is inside the installer (win-unpacked/resources/pgsql).')
  }

  console.log('\n✅ Build complete!')
  const { version } = require(path.join(ROOT, 'package.json'))
  console.log(`📦 Installer: dist-electron/Opal Line Billing-Setup-${version}.exe`)
  console.log(hasPg
    ? '   ✔ Bundled PostgreSQL — target PCs need NOTHING pre-installed.'
    : '   ⚠ No PostgreSQL bundled — target PCs need PostgreSQL or DATABASE_URL.')
}

main().catch((err) => {
  console.error('Build failed:', err)
  process.exit(1)
})
