// Stale-update-download housekeeping, extracted from main.ts so the logic can
// be unit-tested the same way userdata.ts and logrotate.ts are (see
// scripts/update-sweep.test.mjs — compile with tsc, import from dist/).
//
// Update downloads land in the OS temp folder as OpalLine-Setup-<ver>.exe and
// nothing ever removed them: across the 1.0.3 → 1.0.18 cycles they silently
// accumulated to 2.1 GB of dead installers in %TEMP%. sweepDownloads removes
// the ones for a version the app already runs (or older); a download for a
// NEWER version is a pending update waiting in the ready → install flow and
// must survive.
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export function isNewerVersion(current: string, latest: string): boolean {
  const pa = current.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = latest.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** Filenames produced by downloadUpdateAndOfferInstall — and those we never touch. */
const SETUP_NAME = /^OpalLine-Setup-(\d+\.\d+\.\d+[\w.-]*)\.exe$/

/**
 * Remove OpalLine-Setup-*.exe installers for versions <= current in `dir`.
 * Returns the names actually removed (ascending name order is not guaranteed
 * — readdir order). Files whose name does not match the exact update
 * download pattern are never touched, and a locked file aborts only its own
 * removal: the sweep continues, and the next launch retries it.
 * Throws if `dir` cannot be read — callers decide whether that is fatal.
 */
export function sweepDownloads(dir: string, current: string): string[] {
  const swept: string[] = []
  for (const name of readdirSync(dir)) {
    const m = SETUP_NAME.exec(name)
    if (!m) continue
    if (isNewerVersion(current, m[1])) continue // pending update — keep
    try {
      rmSync(join(dir, name), { force: true })
      swept.push(name)
    } catch { /* locked (e.g. the setup is running) — try again next launch */ }
  }
  return swept
}
