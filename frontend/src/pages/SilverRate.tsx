import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock,
  Gem,
  History,
  IndianRupee,
  RefreshCw,
  ShieldCheck,
  Tag,
  TrendingUp,
  Undo2,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { dbApi, shopifyApi } from '@/lib/api'
import { useSilverRate } from '@/lib/silver-rate-context'
import type { Product, SilverRate, SilverRateAutoStatus, SilverRateRequestRow, SilverRateRow } from '@/types'
import { formatCurrency, formatDateTime, formatWeight } from '@/lib/format'
import { cn } from '@/lib/utils'

interface SilverUpdateResult {
  ok: boolean
  rate: number
  previousRate: number
  affected: number
  matched: number
  updated: number
  skipped: number
  errors: string[]
  message?: string
  steps?: Array<{ key: string; label: string; status: 'done' | 'failed' | 'skipped'; detail?: string }>
}

interface Step {
  key: string
  label: string
  icon: LucideIcon
  desc: string
}

const steps: Step[] = [
  { key: 'request', label: 'Enter New Rate', icon: Tag, desc: 'Admin sets the new silver rate' },
  { key: 'preview', label: 'Preview Impact', icon: TrendingUp, desc: 'Review product price changes' },
  { key: 'approve', label: 'Approve & Sync', icon: ShieldCheck, desc: 'Push approved prices to Shopify' },
]

export default function SilverRatePage() {
  const { refresh: refreshSilverRate } = useSilverRate()
  const [step, setStep] = useState(0)
  const [newRate, setNewRate] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [syncFirst, setSyncFirst] = useState(true)
  const [currentRate, setCurrentRate] = useState<SilverRate>({ purity: 92.5, rate: 0, previousRate: 0, updatedAt: '', change: 0, changePercent: 0, currency: '₹' })
  const [history, setHistory] = useState<SilverRateRow[]>([])
  const [result, setResult] = useState<SilverUpdateResult | null>(null)
  const [pendingResult, setPendingResult] = useState<{ message: string; rate: number } | null>(null)
  const [syncingProducts, setSyncingProducts] = useState(false)
  const [syncResult, setSyncResult] = useState<{ ok: boolean; synced: number; created: number; updated: number; removed: number; errors: string[] } | null>(null)
  const [requests, setRequests] = useState<SilverRateRequestRow[]>([])
  const [isApprover, setIsApprover] = useState(false)
  const [autoStatus, setAutoStatus] = useState<SilverRateAutoStatus | null>(null)
  const [togglingAuto, setTogglingAuto] = useState(false)
  const [fetchingNow, setFetchingNow] = useState(false)
  const [fetchNowResult, setFetchNowResult] = useState<{ ok: boolean; message: string } | null>(null)

  const loadAll = useCallback(() => {
    refreshSilverRate()
    dbApi.getSilverRate().then(setCurrentRate).catch(() => {})
    dbApi.getProducts().then(setProducts).catch(() => setProducts([]))
    dbApi.getSilverRateRows().then((r) => setHistory(r.data ?? [])).catch(() => setHistory([]))
    dbApi.getSilverRateRequests().then((r) => {
      setRequests(r.requests ?? [])
      setIsApprover(r.isApprover)
    }).catch(() => {
      setRequests([])
      setIsApprover(false)
    })
    dbApi.getSilverRateAutoStatus().then(setAutoStatus).catch(() => setAutoStatus(null))
  }, [refreshSilverRate])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const syncProducts = async () => {
    setSyncingProducts(true)
    setSyncResult(null)
    try {
      const res = await shopifyApi.syncProductsToDb()
      setSyncResult(res)
      dbApi.getProducts().then(setProducts).catch(() => setProducts([]))
    } catch (e) {
      setSyncResult({ ok: false, synced: 0, created: 0, updated: 0, removed: 0, errors: [e instanceof Error ? e.message : 'Product sync failed'] })
    } finally {
      setSyncingProducts(false)
    }
  }

  const rateValue = parseFloat(newRate)
  const rateValid = !isNaN(rateValue) && rateValue > 0

  const affected = useMemo(() => {
    return products.map((p) => {
      const silverValue = p.netWeight * currentRate.rate
      const makingTotal = p.netWeight * p.makingCharge
      const subtotal = silverValue + makingTotal
      const gstPct = p.gst ?? 3
      const gstAmount = (subtotal * gstPct) / 100
      const oldPrice = subtotal + gstAmount
      const newSilverValue = p.netWeight * (rateValid ? rateValue : currentRate.rate)
      const newSubtotal = newSilverValue + makingTotal
      const newGst = (newSubtotal * gstPct) / 100
      const newPrice = newSubtotal + newGst
      return { product: p, oldPrice, newPrice }
    })
  }, [rateValid, rateValue, products, currentRate.rate])

  const totalDelta = useMemo(() => {
    if (!rateValid) return 0
    return affected.reduce((acc, a) => acc + (a.newPrice - a.oldPrice), 0)
  }, [affected, rateValid])

  const openUpdate = () => {
    setNewRate(String(currentRate.rate))
    setStep(1)
    setDialogOpen(true)
  }

  const confirmChange = () => {
    setStep(2)
  }

  const approve = async () => {
    setProcessing(true)
    setError('')
    try {
      const res = await dbApi.submitSilverRateRequest(rateValue, syncFirst)
      if (res.direct) {
        setResult(res)
      } else {
        setPendingResult({ message: res.message, rate: rateValue })
      }
      setStep(3)
      loadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update silver rate')
    } finally {
      setProcessing(false)
    }
  }

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    try {
      if (decision === 'approve') await dbApi.approveSilverRateRequest(id)
      else await dbApi.rejectSilverRateRequest(id)
      loadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to ${decision} request`)
    }
  }

  const toggleAuto = async () => {
    if (!autoStatus) return
    setTogglingAuto(true)
    try {
      await dbApi.toggleSilverRateAuto(!autoStatus.enabled)
      const fresh = await dbApi.getSilverRateAutoStatus()
      setAutoStatus(fresh)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle auto rate')
    } finally {
      setTogglingAuto(false)
    }
  }

  const fetchNow = async () => {
    setFetchingNow(true)
    setFetchNowResult(null)
    try {
      const res = await dbApi.fetchSilverRateNow()
      setFetchNowResult({
        ok: res.ok,
        message: res.ok ? `Fetched ₹${(res.rate ?? 0).toFixed(2)}/gm — ${(res.repriced ?? 0).toLocaleString('en-IN')} products repriced` : res.error ?? 'Fetch failed',
      })
      loadAll()
    } catch (e) {
      setFetchNowResult({ ok: false, message: e instanceof Error ? e.message : 'Fetch failed' })
    } finally {
      setFetchingNow(false)
    }
  }

  const rollbackTo = (rate: number) => {
    setNewRate(String(rate))
    setStep(1)
    setDialogOpen(true)
  }

  const pendingCount = useMemo(() => requests.filter((r) => r.status === 'pending').length, [requests])
  // Admin / Super Admin can apply a rate change (and fetch the spot rate)
  // directly; every other role always goes through approval.
  const canApprove = isApprover || autoStatus?.isApprover === true

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/" className="hover:text-primary-700">Dashboard</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">Silver Rate</span>
      </div>

      <PageHeader
        title="Silver Rate Management"
        subtitle="Silver rates drive all product pricing. Changes are previewed and approved before syncing to Shopify."
        actions={
          <>
            <Button variant="outline" onClick={syncProducts} disabled={syncingProducts} className="gap-2">
              <RefreshCw className={cn('h-4 w-4', syncingProducts && 'animate-spin')} />
              {syncingProducts ? 'Syncing products...' : 'Sync Products from Shopify'}
            </Button>
            <Button onClick={openUpdate} className="gap-2">
              <TrendingUp className="h-4 w-4" /> {canApprove ? 'Update Silver Rate' : 'Request Rate Change'}
            </Button>
          </>
        }
      />

      {!canApprove ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-800">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">Approval required</p>
            <p className="text-[13px]">
              Rate changes submitted by your role are queued for an Admin or Super Admin to approve. The rate stays unchanged until then.
            </p>
          </div>
        </div>
      ) : null}

      {syncResult ? (
        <div
          className={cn(
            'flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm',
            syncResult.ok ? 'border-success-100 bg-success-50/60 text-success-700' : 'border-red-200 bg-red-50/60 text-red-700',
          )}
        >
          {syncResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          <div>
            <p className="font-semibold">{syncResult.ok ? 'Products synced' : 'Product sync failed'}</p>
            <p className="text-[13px]">
              {syncResult.ok
                ? `${syncResult.synced} live products synced from Shopify — ${syncResult.created} created, ${syncResult.updated} updated, ${syncResult.removed} removed.`
                : syncResult.errors.join(' ')}
            </p>
          </div>
        </div>
      ) : null}

      {fetchNowResult ? (
        <div
          className={cn(
            'flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm',
            fetchNowResult.ok ? 'border-success-100 bg-success-50/60 text-success-700' : 'border-red-200 bg-red-50/60 text-red-700',
          )}
        >
          {fetchNowResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          <div>
            <p className="font-semibold">{fetchNowResult.ok ? 'Spot rate fetched' : 'Spot rate fetch failed'}</p>
            <p className="text-[13px]">{fetchNowResult.message}</p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Rate Change Approvals</CardTitle>
            </div>
            {pendingCount > 0 ? <Badge variant="warning" className="text-[10px]">{pendingCount} pending</Badge> : <Badge variant="muted" className="text-[10px]">None pending</Badge>}
          </CardHeader>
          <CardContent>
            {requests.length === 0 ? (
              <p className="py-4 text-center text-[13px] text-muted-foreground">
                {canApprove
                  ? 'No rate change requests. Staff submissions will appear here for approval.'
                  : 'No rate change requests yet. Any rate change you submit is sent to an Admin or Super Admin for approval.'}
              </p>
            ) : (
              <div className="space-y-2">
                {requests.map((r) => (
                  <div key={r.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold tabular-nums text-foreground">₹{(r.rate ?? 0).toFixed(2)} / gm</span>
                      <Badge variant={r.status === 'pending' ? 'warning' : r.status === 'approved' ? 'success' : 'danger'} dot>
                        {r.status}
                      </Badge>
                      {r.previousRate != null ? (
                        <span className="text-[11px] text-muted-foreground">from ₹{r.previousRate.toFixed(2)}</span>
                      ) : null}
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {r.requestedBy ?? 'Unknown'}
                        {r.requestedByRole ? ` · ${r.requestedByRole}` : ''} · {formatDateTime(r.requestedAt)}
                      </span>
                    </div>
                    {r.decidedBy ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.decidedBy} · {formatDateTime(r.decidedAt)}
                        {r.decisionNote ? ` — "${r.decisionNote}"` : ''}
                      </p>
                    ) : null}
                    {r.resultNote ? <p className="mt-1 text-[11px] text-muted-foreground">{r.resultNote}</p> : null}
                    {isApprover && r.status === 'pending' ? (
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="success" className="gap-1" onClick={() => decide(r.id, 'approve')}>
                          <Check className="h-3.5 w-3.5" /> Approve &amp; Apply
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1" onClick={() => decide(r.id, 'reject')}>
                          <XCircle className="h-3.5 w-3.5" /> Reject
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Auto Silver Rate</CardTitle>
            </div>
            <Badge variant={autoStatus?.enabled ? 'success' : 'muted'} dot>
              {autoStatus?.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {autoStatus ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border p-3">
                    <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Schedule</p>
                    <p className="mt-0.5 text-[13px] font-semibold text-foreground">Daily {autoStatus.schedule}</p>
                    <p className="text-[11px] text-muted-foreground">Next: {formatDateTime(autoStatus.nextRunAt)}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Last fetch</p>
                    <p className="mt-0.5 text-[13px] font-semibold text-foreground">
                      {autoStatus.lastRate != null ? `₹${autoStatus.lastRate.toFixed(2)} / gm` : autoStatus.lastResult ?? '—'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {autoStatus.lastRunAt ? formatDateTime(autoStatus.lastRunAt) : 'Never run'}
                      {autoStatus.lastResult ? ` · ${autoStatus.lastResult}` : ''}
                    </p>
                  </div>
                </div>
                {autoStatus.lastError ? (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-xs text-red-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{autoStatus.lastError}</span>
                  </div>
                ) : null}
                {!autoStatus.apiUrlConfigured ? (
                  <p className="text-[11px] text-muted-foreground">
                    Rate source not configured — set <code className="rounded bg-muted px-1">SILVER_RATE_API_URL</code> to enable spot-rate fetching.
                  </p>
                ) : null}
                {!canApprove ? (
                  <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>Fetching applies the live spot rate and reprices products, so only Admin or Super Admin can run it.</span>
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={fetchNow}
                    disabled={fetchingNow || !autoStatus.apiUrlConfigured || !canApprove}
                    title={canApprove ? undefined : 'Only Admin or Super Admin can fetch and apply the live silver rate'}
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', fetchingNow && 'animate-spin')} />
                    {fetchingNow ? 'Fetching…' : 'Fetch spot rate now'}
                  </Button>
                  <Button size="sm" variant={autoStatus.enabled ? 'outline' : 'soft-primary'} onClick={toggleAuto} disabled={togglingAuto}>
                    {togglingAuto ? 'Saving…' : autoStatus.enabled ? 'Disable auto rate' : 'Enable auto rate'}
                  </Button>
                </div>
              </>
            ) : (
              <p className="py-4 text-center text-[13px] text-muted-foreground">Auto-rate status unavailable.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="overflow-hidden border-primary-100 bg-gradient-to-br from-primary-700 to-primary-900 text-white lg:col-span-1">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-primary-200">
                <Tag className="h-4 w-4" />
                <p className="text-xs font-semibold uppercase tracking-wide">Current Silver Rate</p>
              </div>
              <Badge variant="success" className="bg-success-500/20 text-success-100 border-success-500/30">
                92.5 Sterling Silver
              </Badge>
            </div>
            <p className="mt-3 text-4xl font-bold tabular-nums tracking-tight">₹{currentRate.rate.toFixed(2)}</p>
            <p className="text-sm font-medium text-primary-200">per gram</p>
            <div className="mt-4 flex items-center gap-2 rounded-md bg-white/10 px-3 py-2 text-xs">
              <Clock className="h-3.5 w-3.5" />
              <span className="text-primary-200">Last updated:</span>
              <span className="font-medium text-white">{formatDateTime(currentRate.updatedAt)}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-1">
          <CardContent className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Today's Change</p>
            <div className="mt-2 flex items-end gap-3">
              <p className="text-3xl font-bold tabular-nums text-foreground">
                +₹{currentRate.change.toFixed(2)}
              </p>
              <Badge variant="success" className="mb-1">+{currentRate.changePercent.toFixed(2)}%</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">vs previous rate ₹{currentRate.previousRate.toFixed(2)} / gm</p>
            <div className="mt-4 rounded-md bg-success-50 px-3 py-2 text-xs font-medium text-success-700">
              Last update synced approved prices to {products.length} Shopify products
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-1">
          <CardContent className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Price Change Impact</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <ImpactTile label="Products Affected" value={`${products.length}`} icon={Gem} tint="text-primary-700 bg-primary-50" />
              <ImpactTile label="Total Value Shift" value={rateValid ? formatCurrency(totalDelta) : '—'} icon={IndianRupee} tint="text-warning-700 bg-warning-50" />
              <ImpactTile label="Avg. Price Change" value={rateValid ? formatCurrency(totalDelta / products.length) : '—'} icon={TrendingUp} tint="text-success-700 bg-success-50" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm">Rate History & Approvals</CardTitle>
          </div>
          <CardDescription>Every rate change is logged with the admin who approved it.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Old Rate</TableHead>
                <TableHead>New Rate</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Approved By</TableHead>
                <TableHead className="text-center">Shopify Sync</TableHead>
                <TableHead className="text-center">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    No rate history yet.
                  </TableCell>
                </TableRow>
              ) : (
                history.map((h) => {
                  const prev = h.previousRate ?? currentRate.previousRate
                  const diff = Math.round((h.rate - prev) * 100) / 100
                  const source = h.source ?? 'legacy'
                  const sourceLabel = source === 'auto' ? 'Auto fetch' : source === 'approval' ? 'Approved request' : source === 'manual' ? 'Manual' : 'Legacy entry'
                  return (
                    <TableRow key={h.id}>
                      <TableCell className="font-medium">{formatDateTime(h.updatedAt)}</TableCell>
                      <TableCell className="tabular-nums">₹{prev.toFixed(2)}</TableCell>
                      <TableCell className="tabular-nums font-semibold">₹{h.rate.toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant={diff > 0 ? 'success' : diff < 0 ? 'danger' : 'muted'}>
                          {diff > 0 ? '+' : diff < 0 ? '−' : ''}₹{Math.abs(diff).toFixed(2)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="leading-tight">
                          <p className="font-medium text-foreground">{h.updatedBy ?? 'Unknown'}</p>
                          <p className="text-[10.5px] text-muted-foreground">
                            {sourceLabel}
                            {h.approvedBy && h.approvedBy !== h.updatedBy ? ` · approved by ${h.approvedBy}` : ''}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant={h.syncStatus === 'synced' ? 'success' : h.syncStatus === 'failed' ? 'danger' : 'muted'} dot>
                          {h.syncStatus === 'synced' ? 'Synced' : h.syncStatus === 'failed' ? 'Failed' : h.syncStatus === 'skipped' ? 'Skipped' : '—'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        {h.rate !== currentRate.rate ? (
                          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-primary" onClick={() => rollbackTo(h.rate)}>
                            <Undo2 className="h-3.5 w-3.5" /> Restore
                          </Button>
                        ) : (
                          <Badge variant="muted" className="text-[10px]">Current</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent size="3xl">
          <DialogHeader>
            <DialogTitle>Update Silver Rate</DialogTitle>
            <DialogDescription>
              Set the new 92.5% silver rate. All product prices will be recomputed and previewed before syncing to Shopify.
            </DialogDescription>
          </DialogHeader>

          {step < 3 ? (
            <>
              <Stepper step={step} />

              {step === 1 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border bg-muted/40 p-3">
                      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Old Rate</Label>
                      <p className="mt-1 text-lg font-bold tabular-nums text-foreground">₹{currentRate.rate.toFixed(2)} / gm</p>
                    </div>
                    <div className="rounded-lg border border-primary-200 bg-primary-50/60 p-3">
                      <Label className="text-[11px] uppercase tracking-wide text-primary-700">New Rate</Label>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="text-lg font-bold text-foreground">₹</span>
                        <Input
                          autoFocus
                          type="number"
                          min="0"
                          step="0.1"
                          value={newRate}
                          onChange={(e) => setNewRate(e.target.value)}
                          className="h-8 w-32 border-primary-200 font-bold tabular-nums focus-visible:ring-primary"
                        />
                        <span className="text-sm font-medium text-muted-foreground">/ gm</span>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-warning-100 bg-warning-50/70 p-3">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-700" />
                      <div className="text-xs text-warning-700">
                        <p className="font-semibold">Affects {products.length} products</p>
                        <p className="mt-0.5">
                          {rateValid
                            ? `Estimated total price change across catalog: ${formatCurrency(totalDelta)}.`
                            : 'Enter a valid rate to see the estimated impact.'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {step === 2 && rateValid && (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <MiniBadge label="Old Rate" value={`₹${currentRate.rate.toFixed(2)}`} />
                    <MiniBadge label="New Rate" value={`₹${rateValue.toFixed(2)}`} />
                    <MiniBadge label="Change" value={`${rateValue >= currentRate.rate ? '+' : ''}₹${(rateValue - currentRate.rate).toFixed(2)}`} accent={rateValue >= currentRate.rate ? 'green' : 'red'} />
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Preview — estimated price changes ({products.length} products)
                      </p>
                      <Badge variant="warning">{formatCurrency(totalDelta)} total shift</Badge>
                    </div>
                    <div className="max-h-64 overflow-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow className="sticky top-0 bg-muted/60">
                            <TableHead>Product</TableHead>
                            <TableHead className="text-right">Net Wt</TableHead>
                            <TableHead className="text-right">Old Price</TableHead>
                            <TableHead className="text-right">New Price</TableHead>
                            <TableHead className="text-right">Difference</TableHead>
                            <TableHead className="text-center">Shopify</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {affected.map(({ product, oldPrice, newPrice }) => {
                            const diff = newPrice - oldPrice
                            const rounded = Math.abs(diff) < 0.01
                            return (
                              <TableRow key={product.id}>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
                                      <Gem className="h-3.5 w-3.5" />
                                    </div>
                                    <div>
                                      <p className="font-medium text-foreground">{product.name}</p>
                                      <p className="text-[10px] text-muted-foreground">{product.sku}</p>
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right tabular-nums text-muted-foreground">{formatWeight(product.netWeight)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatCurrency(oldPrice)}</TableCell>
                                <TableCell className="text-right font-semibold tabular-nums text-foreground">{formatCurrency(newPrice)}</TableCell>
                                <TableCell className="text-right">
                                  <span className={cn('font-semibold tabular-nums', rounded ? 'text-muted-foreground' : diff > 0 ? 'text-success-700' : 'text-red-600 dark:text-red-400')}>
                                    {rounded ? '—' : `${diff > 0 ? '+' : ''}${formatCurrency(diff)}`}
                                  </span>
                                </TableCell>
                                <TableCell className="text-center">
                                  <Badge variant={product.shopifyStatus === 'synced' ? 'success' : 'warning'} dot>
                                    {product.shopifyStatus === 'synced' ? 'Synced' : 'Pending'}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-lg border border-primary-100 bg-primary-50/40 p-3">
                    <div className="flex items-start gap-2.5">
                      <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-primary-700" />
                      <div className="text-xs text-primary-900">
                        <p className="font-semibold">Sync all products from Shopify first</p>
                        <p className="mt-0.5 text-primary-700/80">
                          Imports the live Shopify catalog into billing and removes obsolete products before applying the new rate.
                        </p>
                      </div>
                    </div>
                    <Switch checked={syncFirst} onCheckedChange={setSyncFirst} aria-label="Sync all products from Shopify first" />
                  </div>
                </div>
              )}

              <DialogFooter className="mt-2">
                {error ? (
                  <div className="mb-2 flex w-full items-start gap-2 rounded-md border border-red-200 bg-red-50/60 p-2.5 text-xs text-red-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                ) : null}
                {step === 1 ? (
                  <>
                    <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button onClick={confirmChange} disabled={!rateValid}>
                      Preview Changes <ArrowRight className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
                    <Button variant="success" onClick={approve} disabled={processing}>
                      {processing ? (
                        <>
                          <RefreshCw className="h-4 w-4 animate-spin" /> Updating Shopify...
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="h-4 w-4" /> Approve & Update Shopify
                        </>
                      )}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className={cn('flex h-14 w-14 items-center justify-center rounded-full', result && !result.ok ? 'bg-red-50 text-red-600 dark:text-red-400' : 'bg-success-50 text-success-700')}>
                {result && !result.ok ? <AlertTriangle className="h-7 w-7" /> : <CheckCircle2 className="h-7 w-7" />}
              </div>
              {pendingResult ? (
                <>
                  <p className="text-base font-semibold text-foreground">Request submitted for approval</p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {pendingResult.message} You asked for ₹{pendingResult.rate.toFixed(2)}/gm — an Admin or Super Admin must approve it before prices change.
                  </p>
                </>
              ) : (
                <p className="text-base font-semibold text-foreground">
                  {result && !result.ok ? 'Silver rate saved, but Shopify sync had errors' : 'Price update approved & synced'}
                </p>
              )}
              {result?.steps && result.steps.length > 0 ? (
                <div className="w-full max-w-md space-y-2 py-2 text-left">
                  {result.steps.map((s) => (
                    <div key={s.key} className="flex items-start gap-2.5 rounded-lg border px-3 py-2">
                      {s.status === 'done' ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-700" />
                      ) : s.status === 'failed' ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                      ) : (
                        <CircleDollarSign className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-foreground">{s.label}</p>
                        {s.detail ? <p className="text-xs text-muted-foreground">{s.detail}</p> : null}
                      </div>
                      <span
                        className={cn(
                          'ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                          s.status === 'done' && 'bg-success-50 text-success-700',
                          s.status === 'failed' && 'bg-red-50 text-red-600 dark:text-red-400',
                          s.status === 'skipped' && 'bg-muted text-muted-foreground',
                        )}
                      >
                        {s.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="max-w-sm text-sm text-muted-foreground">
                  New silver rate ₹{rateValue.toFixed(2)}/gm applied to {result ? result.affected : products.length} products
                  {result ? ` · ${result.updated} pushed to Shopify · ${result.skipped} skipped · ${result.matched} matched` : ''}.
                </p>
              )}
              {result && result.errors.length > 0 ? (
                <div className="max-h-24 w-full max-w-sm overflow-auto rounded-lg border border-red-200 bg-red-50/60 p-2 text-left text-xs text-red-700">
                  {result.errors.slice(0, 5).map((msg, i) => (
                    <p key={i} className="font-mono">{msg}</p>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                <CircleDollarSign className="h-3.5 w-3.5 text-success-700" />
                Prices were recomputed from the new silver rate and synced to Shopify
              </div>
              <Button className="mt-2" onClick={() => setDialogOpen(false)}>
                <Check className="h-4 w-4" /> Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => {
        const done = i < step
        const active = i === step
        return (
          <div key={s.key} className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                  done && 'border-success bg-success-50 text-success-700',
                  active && 'border-primary bg-primary text-white shadow-sm',
                  !done && !active && 'border-border text-muted-foreground',
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <div className="min-w-0">
                <p className={cn('truncate text-xs font-semibold', active ? 'text-foreground' : done ? 'text-success-700' : 'text-muted-foreground')}>
                  {s.label}
                </p>
              </div>
            </div>
            {i < steps.length - 1 ? (
              <div className={cn('h-px flex-1', i < step ? 'bg-success/40' : 'bg-border')} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function MiniBadge({ label, value, accent }: { label: string; value: string; accent?: 'green' | 'red' }) {
  return (
    <div className={cn('rounded-lg border p-3', accent === 'green' ? 'border-success-100 bg-success-50/60' : accent === 'red' ? 'border-red-100 bg-red-50/60' : 'bg-muted/40')}>
      <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-sm font-bold tabular-nums', accent === 'green' ? 'text-success-700' : accent === 'red' ? 'text-red-600 dark:text-red-400' : 'text-foreground')}>
        {value}
      </p>
    </div>
  )
}

function ImpactTile({ label, value, icon: Icon, tint }: { label: string; value: string; icon: LucideIcon; tint: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border bg-card p-2.5">
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', tint)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate text-[13px] font-semibold tabular-nums text-foreground">{value}</p>
      </div>
    </div>
  )
}
