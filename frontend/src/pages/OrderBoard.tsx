import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, RefreshCw, GripVertical, ListChecks, Receipt, Search, X, History, ExternalLink, MoveRight } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { dbApi } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import { confirmDialog, toast } from '@/components/ui/confirm'
import type { SalesOrder } from '@/types'

const COLUMNS: Array<{ key: SalesOrder['status']; label: string; accent: string }> = [
  { key: 'imported', label: 'New', accent: 'bg-sky-500' },
  { key: 'confirmed', label: 'Confirmed', accent: 'bg-violet-500' },
  { key: 'processing', label: 'Processing', accent: 'bg-amber-500' },
  { key: 'fulfilled', label: 'Fulfilled', accent: 'bg-emerald-500' },
  { key: 'cancelled', label: 'Cancelled', accent: 'bg-rose-500' },
]

interface OrderEvent {
  id: string
  orderId: string
  event: string
  details: string | null
  actor: string | null
  createdAt: string
}

function eventAccent(event: string): string {
  const e = event.toLowerCase()
  if (e.includes('fulfilled')) return 'bg-emerald-500'
  if (e.includes('return')) return 'bg-rose-500'
  if (e.includes('invoice') || e.includes('convert')) return 'bg-violet-500'
  if (e.includes('cancel')) return 'bg-zinc-400'
  return 'bg-sky-500'
}

/** Kanban pipeline for sales orders — drag cards between status columns. */
export default function OrderBoard() {
  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [panelOrder, setPanelOrder] = useState<SalesOrder | null>(null)
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setOrders(await dbApi.getSalesOrders())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(() => {
      void load()
    })
  }, [])

  const openTimeline = async (o: SalesOrder) => {
    setPanelOrder(o)
    setEvents([])
    setEventsLoading(true)
    try {
      const res = await dbApi.getOrderEvents(o.id)
      setEvents(res.data ?? [])
    } catch {
      setEvents([])
    } finally {
      setEventsLoading(false)
    }
  }

  // Search across order id, customer, invoice number and tags. Filtering
  // happens before the per-column grouping so empty columns stay visible.
  const filteredOrders = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return orders
    return orders.filter((o) =>
      (o.customer ?? '').toLowerCase().includes(q) ||
      (o.internalId ?? '').toLowerCase().includes(q) ||
      (o.shopifyId ?? '').toLowerCase().includes(q) ||
      (o.invoice ?? '').toLowerCase().includes(q) ||
      (o.tags ?? '').toLowerCase().includes(q),
    )
  }, [orders, query])

  const byStatus = useMemo(() => {
    const map = new Map<string, SalesOrder[]>()
    for (const col of COLUMNS) map.set(col.key, [])
    for (const o of filteredOrders) {
      const key = (COLUMNS.find((c) => c.key === o.status)?.key ?? 'imported') as SalesOrder['status']
      map.get(key)?.push(o)
    }
    return map
  }, [filteredOrders])

  // Select every order the current search matched — then bulk-move them.
  const selectMatches = () => setSelected(new Set(filteredOrders.map((o) => o.id)))

  const move = async (orderId: string, status: SalesOrder['status']) => {
    const order = orders.find((o) => o.id === orderId)
    if (!order || order.status === status) return
    setMoving(orderId)
    try {
      const updated = await dbApi.updateOrderStatus(orderId, status)
      // The freshly raised invoice (if any) beats the pre-update snapshot.
      const invoice = updated.autoInvoice ?? updated.invoice ?? order.invoice
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status, invoice } : o)))
      if (panelOrder?.id === orderId) setPanelOrder((p) => (p ? { ...p, status, invoice } : p))
      // Receiving the order auto-raised its sales invoice — surface it so the
      // counter knows a bill now exists without checking Sales Invoices.
      if (updated.autoInvoice) toast.success(`Invoice ${updated.autoInvoice} created for ${order.internalId ?? order.shopifyId ?? 'order'}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status update failed')
    } finally {
      setMoving(null)
      setDragId(null)
      setOverCol(null)
    }
  }

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleColumn = (_status: string, colOrders: SalesOrder[]) =>
    setSelected((prev) => {
      const next = new Set(prev)
      const allSelected = colOrders.length > 0 && colOrders.every((o) => next.has(o.id))
      for (const o of colOrders) {
        if (allSelected) next.delete(o.id)
        else next.add(o.id)
      }
      return next
    })

  // Bulk stage move: one confirmed call per selection batch keeps the supply
  // chain moving faster than dragging cards one by one.
  const bulkMove = async (status: SalesOrder['status']) => {
    const ids = [...selected]
    if (ids.length === 0) return
    const col = COLUMNS.find((c) => c.key === status)
    if (!(await confirmDialog({ title: `Move ${ids.length} order(s) to "${col?.label ?? status}"?` }))) return
    setBulkBusy(true)
    try {
      const r = await dbApi.bulkOrderStatus(ids, status)
      toast.success(`${r.updated} order(s) moved to ${r.status}${r.invoicesCreated ? ` · ${r.invoicesCreated} invoice(s) created` : ''}`)
      setSelected(new Set())
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk move failed')
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-4 sm:space-y-5 sm:py-6 lg:px-6">
      <PageHeader
        title="Order Pipeline"
        subtitle="Drag orders across the fulfilment pipeline. Click a card to see its timeline."
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
          </Button>
        }
      />

      {error && <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500 dark:text-red-400">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search order id, customer, invoice..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={selectMatches} disabled={filteredOrders.length === 0}>
          <ListChecks className="h-3.5 w-3.5" /> Select all matches ({filteredOrders.length})
        </Button>
        {query.trim() && (
          <span className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{filteredOrders.length}</span> of {orders.length} orders
          </span>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
          <span className="text-xs font-medium">{selected.size} selected</span>
          {COLUMNS.filter((c) => c.key !== 'cancelled').map((c) => (
            <Button key={c.key} size="sm" variant="outline" onClick={() => bulkMove(c.key)} disabled={bulkBusy}>
              <MoveRight className="h-3.5 w-3.5" /> {c.label}
            </Button>
 ))}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {loading && orders.length === 0 ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading orders…
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-3">
          {COLUMNS.map((col) => {
            const colOrders = byStatus.get(col.key) ?? []
            const total = colOrders.reduce((a, o) => a + Number(o.value ?? 0), 0)
            return (
              <div
                key={col.key}
                className={cn(
                  'flex min-h-[320px] w-[260px] shrink-0 flex-col rounded-lg border bg-card/40 transition-colors',
                  overCol === col.key && dragId && 'border-primary bg-primary/5',
                )}
                onDragOver={(e) => { e.preventDefault(); setOverCol(col.key) }}
                onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
                onDrop={(e) => { e.preventDefault(); if (dragId) void move(dragId, col.key) }}
              >
                <div className="flex items-center gap-2 border-b p-3">
                  <span className={cn('h-2 w-2 rounded-full', col.accent)} />
                  <span className="text-sm font-medium">{col.label}</span>
                  <Badge variant="secondary" className="ml-auto">{colOrders.length}</Badge>
                  {colOrders.length > 0 && col.key !== 'cancelled' && (
                    <button
                      type="button"
                      aria-label={`Select all ${col.label} orders`}
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => toggleColumn(col.key, colOrders)}
                    >
                      select
                    </button>
                  )}
                </div>
                <p className="px-3 pt-1.5 text-xs text-muted-foreground">{formatCurrency(total)}</p>
                <div className="flex-1 space-y-2 p-2">
                  {colOrders.map((o) => (
                    <div
                      key={o.id}
                      draggable
                      onDragStart={() => setDragId(o.id)}
                      onDragEnd={() => { setDragId(null); setOverCol(null) }}
                      className={cn(
                        'group cursor-grab rounded-md border bg-card p-2.5 shadow-sm transition-opacity active:cursor-grabbing',
                        dragId === o.id && 'opacity-40',
                        moving === o.id && 'animate-pulse',
                        panelOrder?.id === o.id && 'border-primary ring-1 ring-primary',
                      )}
                      onClick={() => { if (!dragId) void openTimeline(o) }}
                    >
                      <div className="flex items-start gap-1.5">
                        <input
                          type="checkbox"
                          aria-label={`Select order ${o.internalId || o.shopifyId}`}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer"
                          checked={selected.has(o.id)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelect(o.id)}
                        />
                        <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">{o.customer || 'Walk-in'}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {o.internalId || o.shopifyId || o.id.slice(0, 8)}
                            {o.isBooking ? ' · Booking' : ''}
                          </p>
                          <div className="mt-1 flex items-center justify-between gap-1">
                            <span className="text-xs font-semibold">{formatCurrency(Number(o.value ?? 0))}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {o.date ? new Date(o.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''}
                            </span>
                          </div>
                          {o.invoice ? (
                            <p className="mt-1 flex items-center gap-1 text-[10px] text-emerald-600">
                              <Receipt className="h-3 w-3" /> {o.invoice}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                  {colOrders.length === 0 && (
                    <p className="py-6 text-center text-[11px] text-muted-foreground/70">Drop orders here</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Order timeline side panel */}
      {panelOrder && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setPanelOrder(null)} />
          <aside className="relative z-10 flex h-full w-full max-w-md flex-col border-l bg-card shadow-xl">
            <div className="flex items-start justify-between gap-2 border-b p-4">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold">{panelOrder.customer || 'Walk-in'}</h3>
                <p className="truncate text-xs text-muted-foreground">
                  {panelOrder.internalId || panelOrder.shopifyId || panelOrder.id}
                  {panelOrder.isBooking ? ' · Booking' : ''}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">{panelOrder.status || 'unknown'}</Badge>
                  <span className="text-sm font-semibold">{formatCurrency(Number(panelOrder.value ?? 0))}</span>
                  {panelOrder.invoice ? (
                    <span className="flex items-center gap-1 text-xs text-emerald-600"><Receipt className="h-3 w-3" /> {panelOrder.invoice}</span>
                  ) : null}
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setPanelOrder(null)} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <p className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <History className="h-3.5 w-3.5" /> Order Timeline
              </p>
              {eventsLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading events…
                </div>
              ) : events.length === 0 ? (
                <p className="py-6 text-sm text-muted-foreground">No events recorded yet for this order.</p>
              ) : (
                <ol className="relative space-y-4 border-l pl-4">
                  {events.map((ev) => (
                    <li key={ev.id} className="relative">
                      <span className={cn('absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-card', eventAccent(ev.event))} />
                      <p className="text-xs font-semibold">{ev.event}</p>
                      {ev.details && <p className="mt-0.5 text-xs text-muted-foreground">{ev.details}</p>}
                      <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                        {ev.createdAt ? new Date(ev.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                        {ev.actor ? ` · by ${ev.actor}` : ''}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="border-t p-3">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => navigate(`/sales/orders?order=${panelOrder.id}`)}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open full order details
              </Button>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
