import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@/lib/table'
import { Building2, CheckCircle2, Download, Eye, Loader2, PackageCheck, Plus, Search, ShoppingCart, Trash2, Wallet, Weight, XCircle } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { dbApi } from '@/lib/api'
import { exportTable } from '@/lib/export'
import type { Product, PurchaseOrder, PurchaseOrderReceipt, Supplier } from '@/types'
import { SupplierPicker } from '@/components/ui/supplier-picker'
import { formatCurrency, formatDate, formatWeight } from '@/lib/format'

/** One editable line on the new-PO form. */
interface DraftLine {
  sku: string
  product: string
  qty: string
  weight: string
  rate: string
}

function emptyLine(): DraftLine {
  return { sku: '', product: '', qty: '1', weight: '', rate: '' }
}

/** A "custom" option lets a line be typed in when the SKU is not in the catalog. */
const CUSTOM_SKU = '__custom__'

function lineAmount(line: DraftLine): number {
  const weight = Number(line.weight) || 0
  const rate = Number(line.rate) || 0
  return Math.round(weight * rate * 100) / 100
}

const statusBadge: Record<PurchaseOrder['status'], { label: string; variant: 'warning' | 'success' | 'info' | 'muted' }> = {
  open: { label: 'Open', variant: 'warning' },
  received: { label: 'Received', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
  draft: { label: 'Draft', variant: 'info' },
  closed: { label: 'Closed', variant: 'muted' },
}

export default function PurchaseOrdersPage() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ supplier: '', supplierId: '' })
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()])
  const [viewPo, setViewPo] = useState<PurchaseOrder | null>(null)
  const [receipt, setReceipt] = useState<PurchaseOrderReceipt | null>(null)
  const [receiptLoading, setReceiptLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    dbApi.getPurchaseOrdersWithItems().then((d) => {
      setOrders(d)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    // Defer: load() sets loading state synchronously (react/set-state-in-effect).
    queueMicrotask(load)
  }, [load])

  useEffect(() => {
    dbApi.getSuppliers().then(setSuppliers).catch(() => setSuppliers([]))
    dbApi.getProducts().then(setProducts).catch(() => setProducts([]))
  }, [])

  const openView = useCallback(async (po: PurchaseOrder) => {
    setViewPo(po)
    setReceipt(null)
    setReceiptLoading(true)
    try {
      setReceipt(await dbApi.getOrderReceipt(po.id))
    } catch {
      setReceipt(null)
    } finally {
      setReceiptLoading(false)
    }
  }, [])

  const openDialog = () => {
    setForm({ supplier: '', supplierId: '' })
    setLines([emptyLine()])
    setError('')
    setDialogOpen(true)
  }

  const pickProduct = (index: number, sku: string) => {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== index) return l
        if (sku === CUSTOM_SKU) return { ...l, sku: '' }
        const p = products.find((x) => x.sku === sku)
        return { ...l, sku, product: p?.name ?? l.product, weight: p ? String(p.netWeight ?? '') : l.weight }
      }),
    )
  }

  const setLine = (index: number, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  const removeLine = (index: number) => {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))
  }

  const lineTotals = useMemo(() => {
    const usable = lines.filter((l) => l.sku.trim() !== '' || l.product.trim() !== '')
    return {
      count: usable.length,
      qty: usable.reduce((a, l) => a + (Math.max(1, Math.floor(Number(l.qty) || 1))), 0),
      weight: Math.round(usable.reduce((a, l) => a + (Number(l.weight) || 0), 0) * 100) / 100,
      value: Math.round(usable.reduce((a, l) => a + lineAmount(l), 0) * 100) / 100,
    }
  }, [lines])

  const submit = async () => {
    if (!form.supplier) {
      setError('Select a supplier')
      return
    }
    const usable = lines.filter((l) => l.sku.trim() !== '' || l.product.trim() !== '')
    if (usable.length === 0) {
      setError('Add at least one line item')
      return
    }
    setSaving(true)
    setError('')
    try {
      const count = orders.length + 1
      const created =       await dbApi.create<PurchaseOrder>('purchase-orders', {
        number: `PO-${new Date().getFullYear()}-${String(count + 17).padStart(4, '0')}`,
        supplier: form.supplier || (suppliers.find((s) => s.id === form.supplierId)?.name ?? ''),
        supplierId: form.supplierId || null,
        items: lineTotals.count,
        qty: lineTotals.qty,
        weight: lineTotals.weight,
        value: lineTotals.value,
        status: 'open',
        date: new Date().toISOString(),
      })
      await dbApi.setPurchaseOrderLines(
        created.id,
        usable.map((l) => ({
          product: l.product.trim(),
          sku: l.sku.trim(),
          qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
          weight: Number(l.weight) || 0,
          rate: Number(l.rate) || 0,
        })),
      )
      setDialogOpen(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create purchase order')
    } finally {
      setSaving(false)
    }
  }

  const setStatus = useCallback(async (order: PurchaseOrder, status: PurchaseOrder['status']) => {
    await dbApi.update('purchase-orders', order.id, { status })
    load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return orders.filter((o) => {
      const matchQ = !q || o.number.toLowerCase().includes(q) || o.supplier.toLowerCase().includes(q)
      const matchStatus = !statusFilter || o.status === statusFilter
      return matchQ && matchStatus
    })
  }, [orders, query, statusFilter])

  const totalValue = orders.filter((o) => o.status === 'open').reduce((a, o) => a + o.value, 0)
  const totalWeight = orders.reduce((a, o) => a + o.weight, 0)

  const columns = useMemo<ColumnDef<PurchaseOrder>[]>(
    () => [
      {
        accessorKey: 'number',
        header: 'PO Number',
        meta: { headerClassName: 'min-w-[170px]' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
              <ShoppingCart className="h-4 w-4" />
            </div>
            <div>
              <p className="font-mono font-medium text-foreground">{row.original.number}</p>
              <p className="text-[11px] text-muted-foreground">{formatDate(row.original.date)}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'supplier',
        header: 'Supplier',
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground" /> {row.original.supplier}
          </span>
        ),
      },
      {
        accessorKey: 'items',
        header: 'Items',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.items}</span>,
      },
      {
        accessorKey: 'qty',
        header: 'Qty',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.qty}</span>,
      },
      {
        accessorKey: 'weight',
        header: 'Weight',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatWeight(row.original.weight)}</span>,
      },
      {
        accessorKey: 'value',
        header: 'Order Value',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.value)}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const s = statusBadge[row.original.status] ?? { label: row.original.status ?? "—", variant: "muted" as const }
          return <Badge variant={s.variant} dot>{s.label}</Badge>
        },
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const, headerClassName: 'w-10' },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => openView(row.original)}>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View PO</TooltipContent>
              </Tooltip>
              {row.original.status === 'open' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => setStatus(row.original, 'received')}>
                      <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Mark Received</TooltipContent>
                </Tooltip>
              )}
              {row.original.status !== 'cancelled' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => navigate('/purchase/invoices')}>
                      <Wallet className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Create Purchase Invoice</TooltipContent>
                </Tooltip>
              )}
              {row.original.status !== 'cancelled' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={() => setStatus(row.original, 'cancelled')}>
                      <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel PO</TooltipContent>
                </Tooltip>
              )}
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [setStatus, navigate, openView],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title="Purchase Orders"
        subtitle="Orders raised with silver suppliers for raw material and finished pieces."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => exportTable('purchase-orders.csv', columns, filtered)}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" onClick={openDialog}>
              <Plus className="h-4 w-4" /> New Purchase Order
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniCard icon={ShoppingCart} label="Total POs" value={String(orders.length)} sub="All purchase orders" tint="bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300" />
        <MiniCard icon={ShoppingCart} label="Open" value={String(orders.filter((o) => o.status === 'open').length)} sub="Awaiting receipt" tint="bg-warning-50 text-warning-700" />
        <MiniCard icon={Weight} label="Total Weight" value={formatWeight(totalWeight)} sub="Gross across POs" tint="bg-info-50 text-info-700" />
        <MiniCard icon={Building2} label="Open Value" value={formatCurrency(totalValue)} sub="Committed to suppliers" tint="bg-success-50 text-success-700" />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search PO number, supplier..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              options={[
                { value: '', label: 'All Status' },
                { value: 'open', label: 'Open' },
                { value: 'received', label: 'Received' },
                { value: 'draft', label: 'Draft' },
                { value: 'closed', label: 'Closed' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
              value={statusFilter}
              onValueChange={setStatusFilter}
              className="w-[140px]"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {orders.length} POs
            </div>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No purchase orders found"
            onRowClick={(o) => openView(o)}
          />
        </CardContent>
      </Card>

      <Dialog open={viewPo !== null} onOpenChange={(open) => { if (!open) setViewPo(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Purchase Order {viewPo?.number}</DialogTitle>
            <DialogDescription>{viewPo ? formatDate(viewPo.date) : ''}</DialogDescription>
          </DialogHeader>
          {viewPo && (
            <div className="space-y-3 text-sm">
              <div className="space-y-2">
                <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span className="font-medium">{viewPo.supplier}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Status</span><Badge variant={statusBadge[viewPo.status].variant} dot>{statusBadge[viewPo.status].label}</Badge></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Quantity</span><span>{viewPo.qty}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Weight</span><span>{formatWeight(viewPo.weight)}</span></div>
              </div>

              {(viewPo.lines ?? []).length > 0 ? (
                <div className="overflow-hidden rounded-md border border-border/60">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Item</th>
                        <th className="px-3 py-2 font-medium">SKU</th>
                        <th className="px-3 py-2 text-right font-medium">Qty</th>
                        <th className="px-3 py-2 text-right font-medium">Weight</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(viewPo.lines ?? []).map((l, i) => (
                        <tr key={`${l.sku}-${i}`} className="border-b border-border/40 last:border-0">
                          <td className="px-3 py-2">{l.product || '—'}</td>
                          <td className="px-3 py-2 font-mono text-xs">{l.sku || '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{l.qty}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatWeight(l.weight)}</td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(l.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <div className="flex justify-between border-t pt-2 font-semibold"><span>Order value</span><span>{formatCurrency(viewPo.value)}</span></div>
            </div>
          )}

          {/* Ordered vs received — cancelled invoices are excluded. */}
          <div className="rounded-md border border-border/60 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <PackageCheck className="h-3.5 w-3.5" /> Received against this order
            </p>
            {receiptLoading ? (
              <p className="text-xs text-muted-foreground">Loading receipt…</p>
            ) : !receipt ? (
              <p className="text-xs text-muted-foreground">No receipt information available.</p>
            ) : receipt.invoiceCount === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing received yet — record a purchase invoice against this order to see it here.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-[11px] text-muted-foreground">Ordered</p>
                    <p className="font-medium tabular-nums">{receipt.orderedQty} pcs</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Received</p>
                    <p className="font-medium tabular-nums">{receipt.receivedQty} pcs</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Variance</p>
                    {receipt.shortBy > 0 ? (
                      <p className="font-medium tabular-nums text-red-600 dark:text-red-400">−{receipt.shortBy} short</p>
                    ) : receipt.overBy > 0 ? (
                      <p className="font-medium tabular-nums text-warning-600 dark:text-warning-400">+{receipt.overBy} over</p>
                    ) : (
                      <p className="font-medium text-success-600 dark:text-success-400">Complete</p>
                    )}
                  </div>
                </div>
                <ul className="mt-2 space-y-1">
                  {receipt.invoices.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between text-xs">
                      <span className="font-mono">{inv.number}</span>
                      <span className="text-muted-foreground">
                        {inv.qty} pcs · {formatWeight(inv.weight)} · {formatDate(inv.date)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Purchase Order</DialogTitle>
            <DialogDescription>Raise a purchase order with a supplier for silver raw material.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field label="Supplier">
              <SupplierPicker
                suppliers={suppliers}
                value={form.supplierId}
                onValueChange={(id) => {
                  const s = suppliers.find((x) => x.id === id)
                  setForm((f) => ({ ...f, supplierId: id, supplier: s?.name ?? '' }))
                }}
                onCreateSupplier={(s) => setSuppliers((prev) => [s, ...prev])}
                placeholder="Select supplier…"
                searchPlaceholder="Search suppliers by name, contact, phone or city"
                emptyText="No supplier found"
                className="w-full"
              />
            </Field>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Line items</p>
                <Button variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
                  <Plus className="h-3.5 w-3.5" /> Add line
                </Button>
              </div>
              <div className="overflow-x-auto rounded-md border border-border/60">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="min-w-[190px] px-2 py-2 font-medium">Product / SKU</th>
                      <th className="w-20 px-2 py-2 text-right font-medium">Qty</th>
                      <th className="w-28 px-2 py-2 text-right font-medium">Weight (gm)</th>
                      <th className="w-28 px-2 py-2 text-right font-medium">Rate / gm</th>
                      <th className="w-24 px-2 py-2 text-right font-medium">Amount</th>
                      <th className="w-10 px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => (
                      <tr key={index} className="border-b border-border/40 last:border-0">
                        <td className="px-2 py-1.5">
                          <Select
                            options={[
                              { value: '', label: 'Select a product…' },
                              ...products.map((p) => ({ value: p.sku, label: `${p.name} (${p.sku})` })),
                              { value: CUSTOM_SKU, label: 'Other / type manually' },
                            ]}
                            value={line.sku === '' ? (line.product ? CUSTOM_SKU : '') : line.sku}
                            onValueChange={(v) => pickProduct(index, v)}
                            className="h-8 text-xs"
                          />
                          <Input
                            value={line.product}
                            onChange={(e) => setLine(index, { product: e.target.value })}
                            placeholder="Item name / SKU"
                            className="mt-1 h-7 text-xs"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input type="number" min="1" value={line.qty} onChange={(e) => setLine(index, { qty: e.target.value })} className="h-8 text-right text-xs" />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input type="number" min="0" step="0.001" value={line.weight} onChange={(e) => setLine(index, { weight: e.target.value })} className="h-8 text-right text-xs" />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input type="number" min="0" step="0.01" value={line.rate} onChange={(e) => setLine(index, { rate: e.target.value })} className="h-8 text-right text-xs" />
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-xs">{formatCurrency(lineAmount(line))}</td>
                        <td className="px-2 py-1.5 text-right">
                          <Button variant="ghost" size="icon-sm" onClick={() => removeLine(index)} aria-label="Remove line">
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1.5 text-right text-xs text-muted-foreground">
                {lineTotals.count} line(s) · {lineTotals.qty} pcs · {formatWeight(lineTotals.weight)} · {formatCurrency(lineTotals.value)}
              </p>
            </div>
            {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create Purchase Order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function MiniCard({ icon: Icon, label, value, sub, tint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; tint: string }) {
  return (
    <Card className="p-3 sm:p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{value}</p>
          {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
        </div>
      </div>
    </Card>
  )
}
