import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SilverRatePoint } from '@/types'
import { SilverRateHistoryBody } from './silver-rate-history'
import { SilverRateChart } from '@/components/charts/silver-rate-chart'
import { rateDayLabel } from '@/lib/format'

// Silver Rate History card body: it owns a 7/30/90-day toggle and renders the
// backfilled series (one IST calendar day per point from the API). Pin the
// states the card can show (empty state, toggle with an active window), the
// chart mount, and the axis/tooltip label helper ("2026-10-05" → "5 Oct").
//
// recharts paints its SVG from a layout effect, so renderToStaticMarkup only
// yields wrapper elements — same contract as financial-charts.test.tsx. The
// body test asserts the responsive container it mounts; the chart itself is
// rendered at a fixedSize so its recharts wrapper exists without a DOM.

const noop = () => {}

const points: SilverRatePoint[] = [
  { date: '2026-10-13', rate: 91 },
  { date: '2026-10-14', rate: 92 },
  { date: '2026-10-15', rate: 93 },
  { date: '2026-10-16', rate: 94 },
  { date: '2026-10-17', rate: 95 },
  { date: '2026-10-18', rate: 95 },
  { date: '2026-10-19', rate: 96 },
]

function render(days: 7 | 30 | 90, data: SilverRatePoint[]) {
  return renderToStaticMarkup(
    <SilverRateHistoryBody points={data} days={days} onDaysChange={noop} onSetRate={noop} />,
  )
}

test('empty history renders the Set Silver Rate state instead of a chart', () => {
  const html = render(7, [])
  assert.match(html, /No silver rate history/)
  assert.match(html, /Set Silver Rate/)
  assert.doesNotMatch(html, /recharts-wrapper/, 'no chart without data')
  assert.doesNotMatch(html, /role="tablist"/, 'no window toggle without data')
})

test('history with data renders the 7/30/90 toggle and the chart container', () => {
  const html = render(7, points)
  assert.match(html, /role="tablist"/)
  assert.match(html, />7 Days</)
  assert.match(html, />30 Days</)
  assert.match(html, />90 Days</)
  assert.match(
    html,
    /aria-selected="true"[^>]*>7 Days</,
    'the default window (7 Days) must be the active tab',
  )
  assert.match(html, /recharts-responsive-container/, 'the chart mounts inside its responsive container')
  assert.doesNotMatch(html, /No silver rate history/)
})

test('switching the window moves the active tab', () => {
  const html = render(90, [...points, ...points, ...points])
  assert.match(
    html,
    /aria-selected="true"[^>]*>90 Days</,
    'the active tab must follow the selected window',
  )
})

test('the chart renders its recharts wrapper at the fixed size', () => {
  const html = renderToStaticMarkup(<SilverRateChart data={points} fixedSize={{ width: 640, height: 200 }} />)
  assert.ok(html.includes('recharts-wrapper'), 'the chart mounts a recharts wrapper')
  assert.ok(html.includes('width:640px') && html.includes('height:200px'), 'fixed size drives the wrapper')
})

test('rateDayLabel formats IST calendar days for the axis and tooltip', () => {
  assert.equal(rateDayLabel('2026-10-05'), '5 Oct')
  assert.equal(rateDayLabel('2026-11-23'), '23 Nov')
  assert.equal(rateDayLabel('2026-01-01'), '1 Jan')
  assert.equal(rateDayLabel('garbage'), 'garbage', 'unknown input passes through unchanged')
})
