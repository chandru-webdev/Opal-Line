import { confirmDialog, toast } from '@/components/ui/confirm'
import { useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, Receipt, Plus, Trash2, Link2 } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DataTable } from '@/components/ui/data-table'
import type { ColumnDef } from '@/lib/table'
import { dbApi } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import type { SalesOrder } from '@/types'

interface BookingItem {
  product: string
  sku: string
  qty: number
  price: number
}

const EMPTY_ITEM: BookingItem = { product: '', sku: '', qty: 1, price: 0 }

/** Booking orders: take an advance, fulfil later, convert to invoice when ready. */
export default function Bookings() {
  const [bookings, setBookings] = useState<SalesOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [converting, setConverting] = useState<string | null>(null)

  // Create form state
  const [customer, setCustomer] = useState('')
  const [items, setItems] = useState<BookingItem[]>([{ ...EMPTY_ITEM }])
  const [advance, setAdvance] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const all = await dbApi.getSalesOrders()
      setBookings(all.filter((o) => o.isBooking || (o.tags ?? '').toLowerCase().includes('booking')))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bookings')
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

  const stats = useMemo(() => {
    const totalValue = bookings.reduce((a, o) => a + Number(o.value ?? 0), 0)
    const totalAdvance = bookings.reduce((a, o) => a + Number(o.advancePaid ?? 0), 0)
    const pending = bookings.filter((o) => !o.invoice).length
    return { totalValue, totalAdvance, pending }
  }, [bookings])

  const createBooking = async () => {
    if (!customer.trim()) { toast.error('Customer name is required.'); return }
    const valid = items.filter((it) => it.product.trim() && it.qty > 0)
    if (valid.length === 0) { toast.error('Add at least one item with a product name and quantity.'); return }
    setSaving(true)
    try {
      await dbApi.createBooking({
        customer: customer.trim(),
        items: valid.map((it) => ({ product: it.product.trim(), sku: it.sku.trim() || undefined, qty: it.qty, price: Number(it.price) || 0 })),
        advanceAmount: Number(advance) || 0,
      })
      setCreateOpen(false)
      setCustomer('')
      setItems([{ ...EMPTY_ITEM }])
      setAdvance('')
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Booking failed')
    } finally {
      setSaving(false)
    }
  }

  const sendPaymentLink = async (b: SalesOrder) => {
    try {
      const r = await dbApi.bookingPaymentLink(b.id)
      window.open(r.url, '_blank', 'noopener')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Payment link failed')
    }
  }

  const convert = async (b: SalesOrder) => {
    if (!(await confirmDialog({ title: `Convert booking ${b.internalId || b.id} to invoice? Advance of ${formatCurrency(Number(b.advancePaid ?? 0))} will be applied.` }))) return
    setConverting(b.id)
    try {
      const r = await dbApi.convertBooking(b.id)
      toast.success(`Invoice ${r.invoiceNumber} created — advance ${formatCurrency(r.advanceApplied)}, balance ${formatCurrency(r.balance)}`)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Conversion failed')
    } finally {
      setConverting(null)
    }
  }

  const columns = useMemo<ColumnDef<SalesOrder>[]>(() => [
    {
      accessorKey: 'internalId',
      header: 'Booking',
      cell: ({ row }) => (
        <div>
          <p className="text-sm font-medium">{row.original.internalId || row.original.id.slice(0, 8)}</p>
          <p className="text-xs text-muted-foreground">
            {row.original.date ? new Date(row.original.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}
          </p>
        </div>
      ),
    },
    { accessorKey: 'customer', header: 'Customer', cell: ({ row }) => <span className="text-sm">{row.original.customer || '—'}</span> },
    {
      accessorKey: 'value',
      header: 'Value',
      cell: ({ row }) => <span className="text-sm font-medium tabular-nums">{formatCurrency(Number(row.original.value ?? 0))}</span>,
    },
    {
      accessorKey: 'advancePaid',
      header: 'Advance',
      cell: ({ row }) => {
        const v = Number(row.original.value ?? 0)
        const adv = Number(row.original.advancePaid ?? 0)
        const full = v > 0 && adv >= v
        return <Badge variant={full ? 'default' : 'secondary'}>{formatCurrency(adv)}{full ? ' · Full' : ''}</Badge>
      },
    },
    {
      accessorKey: 'invoice',
      header: 'Status',
      cell: ({ row }) =>
        row.original.invoice
          ? <Badge variant="default" className="gap-1"><Receipt className="h-3 w-3" /> {row.original.invoice}</Badge>
          : <Badge variant="secondary">Awaiting conversion</Badge>,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        !row.original.invoice ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => convert(row.original)} disabled={converting === row.original.id}>
              {converting === row.original.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Receipt className="h-3.5 w-3.5" />}
              Convert
            </Button>
            <Button size="sm" variant="ghost" title="Send a Razorpay payment link for the remaining advance" onClick={() => sendPaymentLink(row.original)}>
              <Link2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null,
    },
  ], [converting])

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-4 sm:space-y-5 sm:py-6 lg:px-6">
      <PageHeader
        title="Booking Orders"
        subtitle="Record customer bookings with an advance payment, then convert to an invoice on fulfilment."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> New Booking
            </Button>
          </div>
        }
      />

      {error && <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500 dark:text-red-400">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Total booked value</p>
          <p className="text-xl font-semibold tabular-nums">{formatCurrency(stats.totalValue)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Advances collected</p>
          <p className="text-xl font-semibold tabular-nums text-emerald-600">{formatCurrency(stats.totalAdvance)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Awaiting conversion</p>
          <p className="text-xl font-semibold tabular-nums">{stats.pending}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable columns={columns} data={bookings} />
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>New booking order</DialogTitle>
            <DialogDescription>Record the order and any advance collected. Convert to an invoice later — the advance is credited automatically.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs font-medium">Customer name *</p>
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="e.g. Priya Sharma" />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium">Items *</p>
              {items.map((it, i) => (
                // flex-wrap + full-width product on phones: sku/qty/price
                // can't all fit beside the product input on a 390px screen.
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Input className="min-w-0 w-full flex-1 sm:w-auto" placeholder="Product" value={it.product} onChange={(e) => setItems((arr) => arr.map((x, j) => (j === i ? { ...x, product: e.target.value } : x)))} />
                  <Input className="w-28" placeholder="SKU" value={it.sku} onChange={(e) => setItems((arr) => arr.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))} />
                  <Input className="w-16" type="number" min={1} value={it.qty} onChange={(e) => setItems((arr) => arr.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) || 1 } : x)))} />
                  <Input className="w-24" type="number" min={0} placeholder="₹" value={it.price || ''} onChange={(e) => setItems((arr) => arr.map((x, j) => (j === i ? { ...x, price: Number(e.target.value) || 0 } : x)))} />
                  <Button variant="ghost" size="icon" onClick={() => setItems((arr) => arr.filter((_, j) => j !== i))} disabled={items.length === 1}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setItems((arr) => [...arr, { ...EMPTY_ITEM }])}>
                <Plus className="h-3.5 w-3.5" /> Add item
              </Button>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium">Advance collected (₹)</p>
              <Input type="number" min={0} value={advance} onChange={(e) => setAdvance(e.target.value)} placeholder="0" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={createBooking} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Create booking
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
