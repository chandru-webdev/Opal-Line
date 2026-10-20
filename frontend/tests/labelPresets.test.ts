import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LABEL_PRESET_LIST } from '../../backend/src/barcodeLabels'
import { FALLBACK_LABEL_PRESETS, validateReferenceLabelPresets } from '../src/lib/labelPresets'

const REFERENCE_KEYS = [
  'label-50x40',
  'label-50x25',
  'label-35x22',
  'label-50x10',
  'label-50x10-loni',
  'label-50x10-compact',
]

test('the backend preset response matches all six approved frontend templates', () => {
  assert.deepEqual(FALLBACK_LABEL_PRESETS.map((preset) => preset.key), REFERENCE_KEYS)
  assert.deepEqual(
    LABEL_PRESET_LIST.slice(0, 6).map((preset) => preset.key),
    REFERENCE_KEYS,
  )
  assert.deepEqual(
    LABEL_PRESET_LIST.slice(0, 6).map((preset) => [preset.width, preset.height]),
    [[50, 40], [50, 25], [35, 22], [50, 10], [50, 10], [50, 10]],
  )
  assert.ok(LABEL_PRESET_LIST.slice(0, 6).every((preset) => preset.brand === 'OPAL LINE'))
  assert.equal(validateReferenceLabelPresets(LABEL_PRESET_LIST, FALLBACK_LABEL_PRESETS), true)
})

test('every reference template retains its own fields and valid physical geometry', () => {
  const actual = new Map(LABEL_PRESET_LIST.map((preset) => [preset.key, preset]))
  for (const expected of FALLBACK_LABEL_PRESETS) {
    const preset = actual.get(expected.key)
    assert.ok(preset?.design, `${expected.key} design missing`)
    const design = preset.design
    assert.equal(design.width, expected.width)
    assert.equal(design.height, expected.height)
    assert.deepEqual(
      design.fields.map((field) => field.kind),
      expected.design?.fields.map((field) => field.kind),
      `${expected.key} field arrangement`,
    )
    for (const field of design.fields) {
      assert.ok(field.x >= 0 && field.x + field.maxWidth <= preset.width, `${expected.key} ${field.kind} horizontal bounds`)
      assert.ok(field.baseline > 0 && field.baseline <= preset.height, `${expected.key} ${field.kind} baseline`)
      assert.ok(field.capHeight > 0 && field.refWidth > 0, `${expected.key} ${field.kind} font geometry`)
    }
    assert.ok(design.qr.x >= 0 && design.qr.x + design.qr.size <= preset.width, `${expected.key} QR horizontal bounds`)
    assert.ok(design.qr.bottom <= preset.height, `${expected.key} QR bottom`)
    assert.ok(
      design.qr.bottom - ((design.qr.modules + 3) * design.qr.size) / design.qr.modules >= 0,
      `${expected.key} QR quiet-zone top`,
    )
  }
})

test('frontend template validation rejects missing or altered geometry and brand values', () => {
  const missingGeometry = LABEL_PRESET_LIST.map((preset) =>
    preset.key === 'label-50x10' ? { ...preset, design: undefined } : preset,
  )
  assert.equal(validateReferenceLabelPresets(missingGeometry, FALLBACK_LABEL_PRESETS), false)

  const alteredGeometry = LABEL_PRESET_LIST.map((preset) =>
    preset.key === 'label-50x10-loni' && preset.design
      ? { ...preset, design: { ...preset.design, qr: { ...preset.design.qr, x: -1 } } }
      : preset,
  )
  assert.equal(validateReferenceLabelPresets(alteredGeometry, FALLBACK_LABEL_PRESETS), false)

  const alteredBrand = LABEL_PRESET_LIST.map((preset) =>
    preset.key === 'label-50x10-compact' ? { ...preset, brand: 'OLD BRAND' } : preset,
  )
  assert.equal(validateReferenceLabelPresets(alteredBrand, FALLBACK_LABEL_PRESETS), false)
})
