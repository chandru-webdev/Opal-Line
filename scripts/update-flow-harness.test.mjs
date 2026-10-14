// Unit tests for the pure helpers in scripts/update-flow-test.mjs — the
// version math, the same-length asar anchor patch, and the feed manifest.
// The live harness itself needs an installed app and is run manually:
//   node scripts/update-flow-test.mjs [--expect reject|happy]
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEED_ANCHOR, feedUrlForPort, patchAsarAnchor, bumpPatchVersion,
  isNewerVersionStr, buildFeedManifest,
} from './update-flow-test.mjs'

test('bumpPatchVersion increments only the patch segment', () => {
  assert.equal(bumpPatchVersion('1.0.21'), '1.0.22')
  assert.equal(bumpPatchVersion('1.0.9'), '1.0.10')
  assert.equal(bumpPatchVersion('v2.3.4'), '2.3.5')
  assert.equal(bumpPatchVersion('1.0'), '1.0.1')
})

test('isNewerVersionStr matches the updater semantics', () => {
  assert.equal(isNewerVersionStr('1.0.21', '1.0.22'), true)
  assert.equal(isNewerVersionStr('1.0.21', '1.0.21'), false)
  assert.equal(isNewerVersionStr('1.0.22', '1.0.21'), false)
  assert.equal(isNewerVersionStr('1.0.9', '1.0.10'), true)
  assert.equal(isNewerVersionStr('1.1.0', '1.0.99'), false)
  assert.equal(isNewerVersionStr('1.0.21', 'v1.0.22'), true)
})

test('feedUrlForPort produces a same-length https URL to 127.0.0.1', () => {
  const patched = feedUrlForPort(47991)
  assert.equal(Buffer.byteLength(patched), Buffer.byteLength(FEED_ANCHOR))
  assert.ok(patched.startsWith('https://127.0.0.1:47991/'))
  assert.ok(patched.endsWith('/'.repeat(Buffer.byteLength(FEED_ANCHOR) - 'https://127.0.0.1:47991/'.length)))
  // an absurdly long port cannot fit and must refuse rather than corrupt
  assert.throws(() => feedUrlForPort(123456789012345), /port too long/)
})

test('patchAsarAnchor patches exactly one occurrence without changing length', () => {
  const before = Buffer.from(`junk before ${FEED_ANCHOR}kumarboobesh765-code/Opal-Line/releases/latest junk after`)
  const len = before.length
  const rep = feedUrlForPort(47991)
  const { occurrences, patched, out } = patchAsarAnchor(before, rep)
  assert.equal(occurrences, 1)
  assert.equal(patched, true)
  assert.equal(out.length, len, 'archive offsets depend on an unchanged length')
  assert.ok(out.toString('utf8').includes(rep))
  assert.ok(!out.toString('utf8').includes(FEED_ANCHOR))
  // input untouched (pure function)
  assert.ok(before.toString('utf8').includes(FEED_ANCHOR))
})

test('patchAsarAnchor refuses ambiguous or missing anchors', () => {
  const twice = Buffer.from(`${FEED_ANCHOR}a${FEED_ANCHOR}b`)
  assert.deepEqual(patchAsarAnchor(twice, feedUrlForPort(47991)), { occurrences: 2, patched: false, out: twice })
  const none = Buffer.from('no feed url here')
  assert.deepEqual(patchAsarAnchor(none, feedUrlForPort(47991)), { occurrences: 0, patched: false, out: none })
  // identity replacement is a no-op even with one occurrence
  const one = Buffer.from(`x${FEED_ANCHOR}y`)
  assert.equal(patchAsarAnchor(one).patched, false)
})

test('buildFeedManifest carries the digest, size and asset URL the updater reads', () => {
  const m = buildFeedManifest({ version: '1.0.22', port: 47991, size: 145670064, sha256: 'a'.repeat(64) })
  assert.equal(m.tag_name, 'v1.0.22')
  assert.equal(m.assets.length, 1)
  const a = m.assets[0]
  assert.equal(a.name, 'Opal.Line.Billing-Setup-1.0.22.exe')
  assert.equal(a.browser_download_url, 'https://127.0.0.1:47991/installer.exe')
  assert.equal(a.size, 145670064)
  assert.equal(a.digest, `sha256:${'a'.repeat(64)}`)
  // the asset name must satisfy the updater's /-Setup-.*\.exe$/i selection
  assert.match(a.name, /-Setup-.*\.exe$/i)
})
