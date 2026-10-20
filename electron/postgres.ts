/**
 * PostgreSQL binary discovery and major-version matching for the desktop app.
 *
 * Extracted from main.ts so the logic can be unit-tested without booting
 * Electron. Uses only node builtins (fs / path / child_process).
 *
 * Why version matching matters: PostgreSQL refuses to start a data directory
 * written by a different major version, and a newer cluster's postgresql.conf
 * can contain GUCs an older server rejects outright — PG 18 writes
 * `autovacuum_worker_slots`, which PostgreSQL 16/17 reject with
 * `FATAL: configuration file ... contains errors` and "could not start
 * server". The desktop app used to always prefer its bundled portable
 * PostgreSQL 16 and never compared it to the cluster's PG_VERSION, so an
 * existing PG 18 cluster could never start.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** System PostgreSQL majors Opal Line supports, newest first (documented 15+). */
export const PG_SUPPORTED_MAJORS = [18, 17, 16, 15]

const EXE = process.platform === 'win32' ? '.exe' : ''

/** `18` from "pg_ctl (PostgreSQL) 18.4" / "postgres (PostgreSQL) 18.4", else null. */
export function parseMajor(text: string | null | undefined): number | null {
  const m = /PostgreSQL\)?\s*(\d+)(?:\.\d+)?/.exec(text ?? '')
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Major recorded in a cluster's PG_VERSION, or null when absent/unreadable. */
export function dataDirMajor(dataDir: string): number | null {
  try {
    const raw = readFileSync(join(dataDir, 'PG_VERSION'), 'utf8').trim()
    const n = Number.parseInt(raw, 10)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Major a pg_ctl binary reports, or null when it cannot be run. */
export function binaryMajor(pgCtl: string): number | null {
  try {
    return parseMajor(execFileSync(pgCtl, ['--version'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }))
  } catch {
    return null
  }
}

/** True when `dir` is a PostgreSQL `bin` directory (contains pg_ctl). */
export function hasPgCtl(binDir: string): boolean {
  return existsSync(join(binDir, `pg_ctl${EXE}`))
}

/** Full path to one of PostgreSQL's tools inside a `bin` directory. */
export function pgTool(binDir: string, name: string): string {
  return join(binDir, `${name}${EXE}`)
}

/** This platform's executable suffix — exported for callers building paths. */
export const PG_EXE = EXE

/**
 * Installed system PostgreSQL bin dirs under `<root>\PostgreSQL\<major>\bin`,
 * newest major first. Scans the folder instead of a hardcoded list so a PG 18
 * install (only 18 is present on affected machines) is discovered.
 *
 * `programFiles` is injectable for tests; production passes nothing and the
 * usual Windows roots are searched.
 */
export function systemPostgresBinDirs(programFiles?: string): Array<{ major: number; bin: string }> {
  const roots = programFiles
    ? [programFiles]
    : [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']
        .filter((v): v is string => !!v)
  const found = new Map<number, string>()
  for (const root of new Set(roots)) {
    let entries: string[]
    try { entries = readdirSync(join(root, 'PostgreSQL')) } catch { continue }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue
      const bin = join(root, 'PostgreSQL', name, 'bin')
      if (!hasPgCtl(bin)) continue
      const major = Number(name)
      if (!found.has(major)) found.set(major, bin)
    }
  }
  return [...found.entries()]
    .map(([major, bin]) => ({ major, bin }))
    .sort((a, b) => b.major - a.major)
}

export interface PgCandidate {
  source: 'bundled' | 'system'
  /** Directory that contains pg_ctl/initdb/createdb. */
  bin: string
  /** Major version, or null when it could not be determined. */
  major: number | null
}

export interface PgSelection {
  bin: string
  major: number
  source: 'bundled' | 'system'
}

/**
 * Choose the binaries to run against a data directory.
 *
 *   - Existing cluster (`dataMajor` set): the binary major MUST equal it. A
 *     mismatch is returned as `{ error }` — never start a mismatched binary.
 *   - Fresh cluster (`dataMajor` null): prefer the bundled portable server,
 *     else the newest supported system major.
 */
export function selectPostgres(
  dataMajor: number | null,
  candidates: PgCandidate[],
): PgSelection | { error: string } {
  const known = candidates.filter((c): c is PgCandidate & { major: number } => c.major != null)

  if (dataMajor != null) {
    const match = known.find((c) => c.major === dataMajor)
    if (match) return { bin: match.bin, major: match.major, source: match.source }
    const have = [...new Set(known.map((c) => c.major))].sort((a, b) => b - a)
    return {
      error:
        `The database cluster was created by PostgreSQL ${dataMajor}, but no PostgreSQL ${dataMajor} ` +
        `binaries were found. Starting it with a different major would fail ` +
        `(PostgreSQL rejects a mismatched data directory and any newer-only setting).\n\n` +
        `Found: ${have.length ? have.map((m) => 'PostgreSQL ' + m).join(', ') : 'no PostgreSQL binaries'}\n` +
        `Install PostgreSQL ${dataMajor} (https://www.postgresql.org/download/windows/) and restart, ` +
        `or point DATABASE_URL at another server.`,
    }
  }

  const bundled = known.find((c) => c.source === 'bundled')
  const pick = bundled ?? [...known].sort((a, b) => b.major - a.major)[0]
  if (!pick) return { error: 'No PostgreSQL binaries were found (bundled or system).' }
  return { bin: pick.bin, major: pick.major, source: pick.source }
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
}

/** Last `lines` non-empty lines of a log file — for startup-failure reports. */
export function logTail(file: string, lines = 12): string {
  try {
    return nonEmptyLines(readFileSync(file, 'utf8')).slice(-Math.max(0, lines)).join('\n')
  } catch {
    return ''
  }
}

/**
 * The most useful diagnostics lines from a PostgreSQL log: the last FATAL/
 * PANIC/ERROR entries plus the final lines. Empty when the log has neither.
 * Used to turn "could not start server" into the real reason.
 */
export function logDiagnostics(file: string, max = 6): string {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return '' }
  const lines = nonEmptyLines(text)
  if (lines.length === 0) return ''
  const fatal = lines.filter((l) => /\b(FATAL|PANIC|ERROR):/.test(l)).slice(-max)
  return (fatal.length > 0 ? fatal : lines.slice(-max)).join('\n')
}
