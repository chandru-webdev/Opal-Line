import { useCallback, useEffect, useState } from 'react'
import { ShieldAlert, Tag, TrendingDown, TrendingUp } from 'lucide-react'
import { dbApi } from '@/lib/api'
import { useSilverRate } from '@/lib/silver-rate-context'
import type { SilverHistoryDays, SilverRate, SilverRatePoint } from '@/types'
import { SilverRateChart } from '@/components/charts/silver-rate-chart'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const WINDOWS: ReadonlyArray<{ days: SilverHistoryDays; label: string }> = [
  { days: 7, label: '7 Days' },
  { days: 30, label: '30 Days' },
  { days: 90, label: '90 Days' },
]

interface HistoryFetch {
  days: SilverHistoryDays
  attempt: number
  points: SilverRatePoint[] | null
  error: string | null
}

/** Today's rate with its day-over-day direction (green up, red down, muted flat). */
export function SilverRateBadge({ rate }: { rate: SilverRate | null }) {
  if (!rate) return <Badge variant="muted" className="text-[10px]">Today: —</Badge>
  const direction = rate.change > 0 ? 'up' : rate.change < 0 ? 'down' : 'flat'
  return (
    <Badge
      variant={direction === 'up' ? 'success' : direction === 'down' ? 'danger' : 'muted'}
      className="text-[10px]"
    >
      {direction === 'up' ? <TrendingUp /> : direction === 'down' ? <TrendingDown /> : null}
      Today: ₹{rate.rate.toFixed(2)} / gm
    </Badge>
  )
}

function CardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-7 w-44" />
      <Skeleton className="h-[200px] w-full" />
    </div>
  )
}

/** Same shape as financial-analytics' CardError, with silver-specific copy. */
function CardLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      icon={ShieldAlert}
      title="Couldn't load silver history"
      description="There was an error fetching the rate series. Please try again."
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      }
      className="px-2 py-6"
    />
  )
}

/** Chart body: window toggle + line, or the empty state. Exported for tests. */
export function SilverRateHistoryBody({
  points,
  days,
  onDaysChange,
  onSetRate,
}: {
  points: SilverRatePoint[]
  days: SilverHistoryDays
  onDaysChange: (days: SilverHistoryDays) => void
  onSetRate: () => void
}) {
  if (points.length === 0) {
    return (
      <EmptyState
        icon={Tag}
        title="No silver rate history"
        description="Update today's rate to start the trend line."
        action={
          <Button size="sm" variant="soft-primary" onClick={onSetRate}>
            Set Silver Rate
          </Button>
        }
        className="px-2 py-6"
      />
    )
  }
  return (
    <>
      <Tabs value={String(days)} onValueChange={(v) => onDaysChange(Number(v) as SilverHistoryDays)}>
        <TabsList className="h-7">
          {WINDOWS.map((w) => (
            <TabsTrigger key={w.days} value={String(w.days)} className="h-6 px-2.5 text-[11px]">
              {w.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="mt-3">
        <SilverRateChart data={points} />
      </div>
    </>
  )
}

/**
 * Silver Rate History card. It owns its 7/30/90-day window (anchored on
 * today): the page-wide dashboard range does not drive it. Server-side
 * backfill guarantees one point per IST day inside the window.
 */
export function SilverRateHistoryCard({ onSetRate }: { onSetRate: () => void }) {
  const { rate } = useSilverRate()
  const [days, setDays] = useState<SilverHistoryDays>(7)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<HistoryFetch | null>(null)

  useEffect(() => {
    let cancelled = false
    const wanted = { days, attempt }
    dbApi
      .getSilverRateHistory(days)
      .then((points) => {
        if (!cancelled) setResult({ ...wanted, points, error: null })
      })
      .catch((err: unknown) => {
        console.error('Silver history error:', err)
        if (!cancelled) setResult({ ...wanted, points: null, error: 'Failed to load rate history' })
      })
    return () => {
      cancelled = true
    }
  }, [days, attempt])

  const reload = useCallback(() => setAttempt((a) => a + 1), [])

  // A result for a superseded window (or attempt) is stale: keep showing the
  // skeleton instead of flashing the old range while the new one loads.
  const matched = result && result.days === days && result.attempt === attempt ? result : null

  return (
    <Card className="xl:col-span-1">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Silver Rate History ({rate?.purity ?? 92.5})</CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Last {days} days · ₹ / gm</p>
        </div>
        <SilverRateBadge rate={rate} />
      </CardHeader>
      <CardContent>
        {!matched ? (
          <CardSkeleton />
        ) : matched.error ? (
          <CardLoadError onRetry={reload} />
        ) : matched.points ? (
          <SilverRateHistoryBody
            points={matched.points}
            days={days}
            onDaysChange={setDays}
            onSetRate={onSetRate}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}
