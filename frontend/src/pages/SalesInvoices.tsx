import { confirmDialog, toast } from '@/components/ui/confirm'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@/lib/table'
import { Copy, Download, Eye, FileText, Loader2, MessageCircle, MoreHorizontal, Plus, Printer, Search, Undo2, X } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTable } from '@/components/ui/data-table'
import { printCurrentPage } from '@/lib/printTemplate'
import { AppDialog } from '@/components/ui/app-dialog'
import { DialogFooter } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { dbApi } from '@/lib/api'
import { exportTable } from '@/lib/export'
import type { Invoice, InvoiceItem } from '@/types'
import { formatCurrency, formatDate } from '@/lib/format'

const paymentBadge: Record<Invoice['paymentStatus'], { label: string; variant: 'success' | 'warning' | 'danger' | 'muted' }> = {
  paid: { label: 'Paid', variant: 'success' },
  partial: { label: 'Partial', variant: 'warning' },
  pending: { label: 'Pending', variant: 'warning' },
  failed: { label: 'Failed', variant: 'danger' },
  refunded: { label: 'Refunded', variant: 'muted' },
}

const statusBadge: Record<Invoice['status'], { label: string; variant: 'success' | 'warning' | 'danger' | 'muted' | 'info' }> = {
  paid: { label: 'Paid', variant: 'success' },
  draft: { label: 'Draft', variant: 'muted' },
  issued: { label: 'Issued', variant: 'info' },
  overdue: { label: 'Overdue', variant: 'danger' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
  refunded: { label: 'Refunded', variant: 'warning' },
}

export default function SalesInvoicesPage() {
  const navigate = useNavigate()
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [paymentFilter, setPaymentFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [viewInvoice, setViewInvoice] = useState<Invoice | null>(null)
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([])
  const [customers, setCustomers] = useState<Array<{ name: string; phone?: string | null }>>([])

  const setInvoiceStatus = async (inv: Invoice, status: Invoice['status']) => {
    if (!(await confirmDialog({ title: `Mark invoice ${inv.number} as ${status}?` }))) return
    try {
      const patch: Record<string, unknown> = { status }
      if (status === 'refunded') patch.paymentStatus = 'refunded'
      await dbApi.update('invoices', inv.id, patch)
      setInvoices((prev) => prev.map((x) => (x.id === inv.id ? { ...x, ...patch } : x)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    }
  }

  useEffect(() => {
    dbApi.getInvoices().then((d) => {
      setInvoices(d)
      setLoading(false)
    }).catch(() => setLoading(false))
    dbApi.getCustomers().then((d) => setCustomers(d)).catch(() => undefined)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return invoices.filter((i) => {
      const matchQ =
        !q ||
        i.number.toLowerCase().includes(q) ||
        (i.shopifyOrder ?? '').toLowerCase().includes(q) ||
        i.customer.toLowerCase().includes(q)
      const matchPay = !paymentFilter || i.paymentStatus === paymentFilter
      const matchStatus = !statusFilter || i.status === statusFilter
      return matchQ && matchPay && matchStatus
    })
  }, [invoices, query, paymentFilter, statusFilter])

  const duplicateInvoice = async (inv: Invoice) => {
    if (!(await confirmDialog({ title: `Create a draft copy of ${inv.number}?`, description: "The draft gets a new number, today's date, and pending payment.", confirmLabel: 'Duplicate' }))) return
    setDuplicatingId(inv.id)
    try {
      const created = await dbApi.duplicateInvoice(inv.id)
      setInvoices((prev) => [created as unknown as Invoice, ...prev])
      setViewInvoice(created as unknown as Invoice)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Duplicate failed')
    } finally {
      setDuplicatingId(null)
    }
  }

  // Stable DataTable row handlers: inline lambdas would change identity every
  // render and defeat the table memo, re-rendering all rows on each keystroke
  // in the view dialog (felt as input lag).
  const openInvoice = useCallback((inv: Invoice) => {
    setViewInvoice(inv)
    setInvoiceItems(inv.items ?? [])
    if (!inv.items?.length) {
      dbApi.getInvoiceById(inv.id).then((full) => {
        if (full) setInvoiceItems(full.items ?? [])
      }).catch(() => {})
    }
  }, [])

  const openInvoicePage = useCallback((inv: Invoice) => navigate(`/sales/invoices/${inv.id}`), [navigate])

  const columns = useMemo<ColumnDef<Invoice>[]>(
    () => [
      {
        accessorKey: 'number',
        header: 'Invoice',
        meta: { headerClassName: 'min-w-[150px]' },
        cell: ({ row }) => (
          <Link to={`/sales/invoices/${row.original.id}`} className="group">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300">
                <FileText className="h-4 w-4" />
              </div>
              <div>
                <p className="font-medium text-foreground group-hover:text-primary-700">{row.original.number}</p>
                <p className="text-[11px] text-muted-foreground">{formatDate(row.original.date)}</p>
              </div>
            </div>
          </Link>
        ),
      },
      {
        accessorKey: 'shopifyOrder',
        header: 'Shopify Order',
        cell: ({ row }) => <span className="font-mono text-[12.5px] text-muted-foreground">{row.original.shopifyOrder}</span>,
      },
      {
        accessorKey: 'customer',
        header: 'Customer',
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-foreground">{row.original.customer}</p>
            <p className="text-[11px] text-muted-foreground">{row.original.customerEmail}</p>
            {row.original.customerPhone ? <p className="text-[11px] text-muted-foreground">{row.original.customerPhone}</p> : null}
          </div>
        ),
      },
      {
        accessorKey: 'grandTotal',
        header: 'Amount',
        meta: { align: 'right' as const },
        cell: ({ row }) => <span className="font-semibold tabular-nums text-foreground">{formatCurrency(row.original.grandTotal)}</span>,
      },
      {
        id: 'payment',
        header: 'Payment',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const p = paymentBadge[row.original.paymentStatus] ?? { label: String(row.original.paymentStatus ?? 'Unknown'), variant: 'muted' as const }
          return <Badge variant={p.variant} dot>{p.label}</Badge>
        },
      },
      {
        id: 'status',
        header: 'Status',
        meta: { align: 'center' as const },
        cell: ({ row }) => {
          const s = statusBadge[row.original.status] ?? { label: String(row.original.status ?? 'Unknown'), variant: 'muted' as const }
          return <Badge variant={s.variant}>{s.label}</Badge>
        },
      },
      {
        accessorKey: 'paymentMethod',
        header: 'Method',
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.paymentMethod}</span>,
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { align: 'right' as const },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" asChild>
                <Link to={`/sales/invoices/${row.original.id}`}>
                  <Eye className="h-3.5 w-3.5" />
                </Link>
              </Button>
              </TooltipTrigger>
              <TooltipContent>View / Print / PDF</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/sales/invoices/${row.original.id}`)}>
                <Printer className="h-3.5 w-3.5" />
              </Button>
              </TooltipTrigger>
              <TooltipContent>Print</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={duplicatingId === row.original.id}
                onClick={() => duplicateInvoice(row.original)}
              >
                {duplicatingId === row.original.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
              </TooltipTrigger>
              <TooltipContent>Duplicate as draft</TooltipContent>
            </Tooltip>
            <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-muted-foreground">More actions</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => navigate(`/sales/invoices/${row.original.id}`)}><Download className="h-3.5 w-3.5" /> Download PDF</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setInvoiceStatus(row.original, 'refunded')}><Undo2 className="h-3.5 w-3.5" /> Refund</DropdownMenuItem>
              <DropdownMenuItem className="text-red-600 dark:text-red-400 focus:text-red-600 dark:text-red-400" onClick={() => setInvoiceStatus(row.original, 'cancelled')}><X className="h-3.5 w-3.5" /> Cancel</DropdownMenuItem>
            </DropdownMenuContent>
            </DropdownMenu>
            </TooltipProvider>
          </div>
        ),
      },
    ],
    [navigate, duplicatingId],
  )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-4 sm:space-y-5 sm:py-6 lg:px-6">
      <PageHeader
        title="Sales Invoices"
        subtitle="Invoices generated from Shopify orders, reconciled with Razorpay payments."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => exportTable('sales-invoices.csv', columns, filtered)}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" onClick={() => navigate('/sales/orders')}>
              <Plus className="h-4 w-4" /> <span className="hidden sm:inline">New Invoice</span><span className="sm:hidden">New</span>
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="space-y-4 p-3 sm:p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            <div className="relative min-w-0 flex-1 sm:min-w-[240px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search invoice, order, customer..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Select
                options={[
                  { value: '', label: 'All Payment' },
                  { value: 'paid', label: 'Paid' },
                  { value: 'partial', label: 'Partial' },
                  { value: 'pending', label: 'Pending' },
                  { value: 'failed', label: 'Failed' },
                  { value: 'refunded', label: 'Refunded' },
                ]}
                value={paymentFilter}
                onValueChange={setPaymentFilter}
                className="w-[calc(50%-4px)] sm:w-[140px]"
              />
              <Select
                options={[
                  { value: '', label: 'All Status' },
                  { value: 'paid', label: 'Paid' },
                  { value: 'issued', label: 'Issued' },
                  { value: 'overdue', label: 'Overdue' },
                  { value: 'cancelled', label: 'Cancelled' },
                ]}
                value={statusFilter}
                onValueChange={setStatusFilter}
                className="w-[calc(50%-4px)] sm:w-[140px]"
              />
            </div>
            <div className="ml-auto text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{filtered.length}</span> of {invoices.length} invoices
            </div>
          </div>

          <DataTable
            onRowDoubleClick={openInvoicePage}
            onRowClick={openInvoice}
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No invoices match your filters"
          />
        </CardContent>
      </Card>

      <AppDialog
        open={viewInvoice !== null}
        onOpenChange={(open) => { if (!open) setViewInvoice(null) }}
        size="2xl"
        className="print-dialog"
        footerClassName="no-print"
        title={viewInvoice?.number}
        description={viewInvoice ? `Linked order ${viewInvoice.shopifyOrder || '—'} · ${formatDate(viewInvoice.date ?? '')}` : ''}
        footer={
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setViewInvoice(null)}>Close</Button>
            <Button variant="outline" onClick={() => void printCurrentPage()}>
              <Printer className="h-4 w-4" /> Print / PDF
            </Button>
            {(() => {
              const inv = viewInvoice
              if (!inv) return null
              const phone = inv.customerPhone || customers.find((c) => c.name === inv.customer)?.phone || ''
              if (!phone) return null
              return (
                <Button
                  variant="outline"
                  onClick={() => {
                    const digits = phone.replace(/\D/g, '')
                    const withCc = digits.length === 10 ? '91' + digits : digits
                    const text = encodeURIComponent(
                      `Invoice ${inv.number}\nCustomer: ${inv.customer}\nAmount: ₹${inv.grandTotal.toLocaleString('en-IN')}\nStatus: ${inv.paymentStatus}\n\n— Opal Line`,
                    )
                    window.open(`https://wa.me/${withCc}?text=${text}`, '_blank')
                  }}
                >
                  <MessageCircle className="h-4 w-4" /> WhatsApp
                </Button>
              )
            })()}
            <Button asChild className="ml-auto">
              <Link to={`/sales/invoices/${viewInvoice?.id ?? ''}`}>
                <Eye className="h-4 w-4" /> Open Full Page
              </Link>
            </Button>
          </DialogFooter>
        }
      >
          {viewInvoice ? (
            <div className="space-y-0.5 text-sm">
              <DetailRow label="Customer" value={viewInvoice.customer || '—'} />
              {viewInvoice.customerEmail ? <DetailRow label="Email" value={viewInvoice.customerEmail} /> : null}
              {viewInvoice.customerPhone ? <DetailRow label="Phone" value={viewInvoice.customerPhone} /> : null}
              {viewInvoice.customerAddress ? <DetailRow label="Address" value={viewInvoice.customerAddress} /> : null}
              {[viewInvoice.customerCity, viewInvoice.customerState, viewInvoice.customerPincode].some(Boolean) ? (
                <DetailRow label="City / State / PIN" value={[viewInvoice.customerCity, viewInvoice.customerState, viewInvoice.customerPincode].filter(Boolean).join(', ')} />
              ) : null}
              {viewInvoice.customerGstin ? <DetailRow label="GSTIN" value={viewInvoice.customerGstin} /> : null}
              <DetailRow label="Subtotal" value={formatCurrency(viewInvoice.subtotal)} />
              {viewInvoice.discount > 0 ? <DetailRow label="Discount" value={`− ${formatCurrency(viewInvoice.discount)}`} /> : null}
              <DetailRow label={`GST (${viewInvoice.gst ?? 0}%)`} value={formatCurrency(viewInvoice.gstAmount)} />
              <DetailRow label="Grand Total" value={formatCurrency(viewInvoice.grandTotal)} />
              <DetailRow label="Payment Method" value={viewInvoice.paymentMethod || '—'} />
              <DetailRow label="Payment Status" value={paymentBadge[viewInvoice.paymentStatus]?.label ?? viewInvoice.paymentStatus} />
              <DetailRow label="Invoice Status" value={statusBadge[viewInvoice.status]?.label ?? viewInvoice.status} />
              {invoiceItems.length > 0 ? (
                <div className="border-b border-border/60 py-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-muted-foreground">Items</span>
                    <span className="text-[11px] text-muted-foreground">{invoiceItems.length} product(s)</span>
                  </div>
                  <div className="space-y-1">
                    {invoiceItems.map((li, i) => (
                      <div key={i} className="flex items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium text-foreground">{li.product}</span>
                          {li.sku ? <span className="ml-1.5 font-mono text-muted-foreground">{li.sku}</span> : null}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{li.qty} × {formatCurrency(li.amount / (li.qty || 1))}</span>
                        <span className="shrink-0 tabular-nums font-medium text-foreground">{formatCurrency(li.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
      </AppDialog>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  )
}
