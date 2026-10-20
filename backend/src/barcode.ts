// Stable product barcode identity.
//
// A barcode identifies exactly ONE sellable product. Products in this codebase
// are flat (there is no separate variant table), so "product barcode" and
// "variant barcode" are the same thing here.
//
// Everything in this module is pure so the rules can be unit-tested without a
// database, and so the create/update/assign/backfill paths share one definition
// of "valid" and "stable".
import { createHash, randomUUID } from 'node:crypto'

export const BARCODE_MIN_LENGTH = 3
export const BARCODE_MAX_LENGTH = 64

/**
 * Prefix for internally generated codes. Kept alphanumeric so the value can be
 * carried by the QR code used in the reference labels *and* by a linear
 * Code 128 symbol in the ZPL output path without changing the identifier.
 */
export const BARCODE_PREFIX = 'OL'

/** The reference `.prn` label files are authored at 203 dpi (8 dots/mm). */
export const DOTS_PER_MM = 8

// Letters, numbers, dot, dash and underscore. Must start with a letter/number
// so a stray leading separator can never be produced. No whitespace, so a
// keyboard-wedge scan and a typed value normalise to the same string.
const BARCODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function normalizeBarcode(value: unknown): string {
  if (value == null) return ''
  return String(value).trim()
}

export function isValidBarcode(value: unknown): boolean {
  return barcodeFormatError(value) === null && normalizeBarcode(value).length > 0
}

/** Human-readable reason a barcode is not acceptable, or null when it is. */
export function barcodeFormatError(value: unknown): string | null {
  const v = normalizeBarcode(value)
  if (!v) return 'Barcode cannot be empty'
  if (v.length < BARCODE_MIN_LENGTH) return `Barcode must be at least ${BARCODE_MIN_LENGTH} characters`
  if (v.length > BARCODE_MAX_LENGTH) return `Barcode must be at most ${BARCODE_MAX_LENGTH} characters`
  if (!BARCODE_RE.test(v)) return 'Barcode may only contain letters, numbers, dot, dash and underscore'
  return null
}

// Crockford-style alphabet: no I, L, O or U, so a code read aloud or typed back
// from a print-out is far less likely to be mistyped.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Deterministically derive a barcode candidate from a seed. The same seed
 * always yields the same candidate, which is what makes generation idempotent:
 * an already-assigned barcode is never recomputed or changed.
 */
export function makeBarcode(seed: string): string {
  const digest = createHash('sha256').update(seed).digest()
  let body = ''
  for (let i = 0; i < 10; i++) body += CODE_ALPHABET[digest[i] % CODE_ALPHABET.length]
  return `${BARCODE_PREFIX}${body}`
}

/**
 * A fresh, essentially-unique generation seed. Random rather than derived from
 * the product so a barcode is not guessable from an id, but only ever written
 * once (see the assign/backfill paths, which never touch an existing value).
 */
export function newBarcodeSeed(): string {
  return randomUUID()
}

/**
 * Normalise raw scanner input. Keyboard-wedge scanners usually append CR/LF and
 * some models pad with spaces or NULs; stripping all whitespace and control
 * characters means the same physical scan always resolves to the same code.
 */
export function normalizeScanCode(value: unknown): string {
  if (value == null) return ''
  // Matching control characters is intentional here: keyboard-wedge scanners
  // emit CR/LF/NUL padding that must be stripped before lookup.
  // eslint-disable-next-line no-control-regex
  const stripped = String(value).replace(/[\u0000-\u001f\u007f\s]+/g, '')
  return stripped.slice(0, 128)
}

/** Reject obviously malformed scan input before it ever reaches the database. */
export function scanCodeError(value: unknown): string | null {
  const code = normalizeScanCode(value)
  if (!code) return 'Scan code is required'
  if (code.length < 2) return 'Scan code is too short'
  return null
}

export function duplicateBarcodeMessage(barcode: string): string {
  return `Barcode "${barcode}" is already assigned to another product`
}

export function duplicateScanMessage(): string {
  return 'That code matches more than one product — fix the duplicate barcode first'
}

export function inactiveProductMessage(name: string, status: string): string {
  return `"${name}" is ${status} and cannot be scanned for stock changes`
}
