import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from '@/components/ui/confirm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { AppDialog } from '@/components/ui/app-dialog'
import { DialogFooter } from '@/components/ui/dialog'
import { dbApi } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import type { Invoice, Product } from '@/types'

/** Sentinel: the line's product is typed by hand, not picked from the catalogue. */
const CUSTOM_SKU = '__custom__'

/** One editable line in the manual-invoice form. */
interface DraftLine {
  product: string
  sku: string
  qty: string
  /** Line TOTAL weight in grams — the backend prices on weight × silver rate. */
  weight: string
  silverRate: string
  makingCharge: string
}

function emptyLine(): DraftLine {
  return { product: '', sku: '', qty: '1', weight: '', silverRate: '', makingCharge: '' }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Line amount exactly as the backend computes it: weight × silver rate + making charge. */
function lineAmount(line: DraftLine): number {
  const weight = Number(line.weight) || 0
  const rate = Number(line.silverRate) || 0
  const making = Number(line.makingCharge) || 0
  return round2(weight * rate + making)
}

interface DraftForm {
  customer: string
  customerEmail: string
  customerPhone: string
  buyerGstin: string
  paymentMethod: string
  paymentStatus: string
  status: string
  gst: string
  discount: string
}

function emptyForm(): DraftForm {
  return {
    customer: '', customerEmail: '', customerPhone: '', buyerGstin: '',
    paymentMethod: 'Cash', paymentStatus: 'pending', status: 'issued',
    gst: '3', discount: '0',
  }
}

export interface ManualInvoiceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-fill the buyer, e.g. when billing from a specific order. */
  initialCustomer?: string
  initialCustomerPhone?: string
  /** Called with the row the server returned, after it has been created. */
  onCreated?: (invoice: Invoice) => void
}

/**
 * Bill a walk-in or phone sale straight to an invoice — no sales order needed.
 *
 * The server mints the invoice number (settings-driven prefix + stamp) and
 * recomputes every total from the lines, so this form mirrors that maths rather
 * than owning it. Each line carrying a SKU deducts stock; lines typed by hand
 * leave stock alone.
 *
 * Shared by the Sales Invoices "New Invoice" button and the Sales Orders page,
 * so both entry points bill identically.
 */
export function ManualInvoiceDialog({
  open,
  onOpenChange,
  initialCustomer,
  initialCustomerPhone,
  onCreated,
}: ManualInvoiceDialogProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [form, setForm] = useState<DraftForm>(emptyForm)
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()])

  // Reset the form each time the dialog opens so a stale draft (or the previous
  // order's pre-fill) never leaks into the next invoice.
  useEffect(() => {
    if (!open) return
    // Defer the setState out of the effect body (react/set-state-in-effect).
    queueMicrotask(() => {
      setError('')
      setForm({ ...emptyForm(), customer: initialCustomer ?? '', customerPhone: initialCustomerPhone ?? '' })
      setLines([emptyLine()])
    })
  }, [open, initialCustomer, initialCustomerPhone])

  // Catalogue is only needed for the SKU picker — load it on first open.
  useEffect(() => {
    if (!open || products.length > 0) return
    dbApi.getProducts().then(setProducts).catch(() => setProducts([]))
  }, [open, products.length])

  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  const removeLine = (index: number) =>
    setLines((prev) => (prev.length === 1 ? [emptyLine()] : prev.filter((_, i) => i !== index)))

  const knownSkus = useMemo(
    () => Array.from(new Set(products.map((p) => p.sku).filter(Boolean))).sort(),
    [products],
  )

  // Picking a catalogue SKU prefills the item name and per-piece net weight.
  const pickProduct = (index: number, sku: string) => {
    if (sku === CUSTOM_SKU) {
      setLine(index, { sku: '', product: '' })
      return
    }
    const p = products.find((x) => x.sku === sku)
    setLine(index, { sku, product: p?.name ?? '', weight: p?.netWeight != null ? String(p.netWeight) : '' })
  }

  const totals = useMemo(() => {
    const subtotal = round2(lines.reduce((a, l) => a + lineAmount(l), 0))
    const gstRate = Number(form.gst) || 0
    const gstAmount = round2(subtotal * gstRate / 100)
    const discount = Number(form.discount) || 0
    return { subtotal, gstRate, gstAmount, discount, grandTotal: round2(subtotal + gstAmount - discount) }
  }, [lines, form.gst, form.discount])

  const submit = async () => {
    const customer = form.customer.trim()
    if (!customer) { setError('Customer name is required'); return }
    const usable = lines.filter((l) => l.sku.trim() !== '' || l.product.trim() !== '')
    if (usable.length === 0) { setError('Add at least one line item'); return }
    setSaving(true)
    setError('')
    try {
      const payload = {
        customer,
        customerEmail: form.customerEmail.trim() || null,
        customerPhone: form.customerPhone.trim() || null,
        buyerGstin: form.buyerGstin.trim() || null,
        paymentMethod: form.paymentMethod.trim() || null,
        paymentStatus: form.paymentStatus,
        status: form.status,
        gst: Number(form.gst) || 0,
        discount: Number(form.discount) || 0,
        date: new Date().toISOString(),
        items: usable.map((l) => ({
          product: l.product.trim(),
          sku: l.sku.trim(),
          qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
          weight: Number(l.weight) || 0,
          silverRate: Number(l.silverRate) || 0,
          makingCharge: Number(l.makingCharge) || 0,
          amount: lineAmount(l),
        })),
      }
      // No number in the payload — the server mints the next invoice number.
      const created = await dbApi.create<Invoice>('invoices', payload)
      toast.success(`Invoice ${created.number} created`)
      onOpenChange(false)
      onCreated?.(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invoice')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => { if (!next) onOpenChange(false) }}
      size="2xl"
      title="New Sales Invoice"
      description="Bill a walk-in or phone sale directly — no sales order needed. The invoice number is minted automatically; each line with a SKU deducts stock."
      footer={
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Create invoice
          </Button>
        </DialogFooter>
      }
    >
      <div className="space-y-4 text-sm">
        {error ? (
          <div className="rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">{error}</div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Customer *">
            <Input value={form.customer} onChange={(e) => setForm((f) => ({ ...f, customer: e.target.value }))} placeholder="Walk-in customer" />
          </Field>
          <Field label="Phone">
            <Input value={form.customerPhone} onChange={(e) => setForm((f) => ({ ...f, customerPhone: e.target.value }))} />
          </Field>
          <Field label="Email"><Input type="email" value={form.customerEmail} onChange={(e) => setForm((f) => ({ ...f, customerEmail: e.target.value }))} /></Field>
          <Field label="Buyer GSTIN (optional)"><Input value={form.buyerGstin} onChange={(e) => setForm((f) => ({ ...f, buyerGstin: e.target.value.toUpperCase() }))} placeholder="e.g. 27AAAAA0000A1Z5" maxLength={15} /></Field>
        </div>

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
                  <th className="min-w-[190px] px-3 py-2 font-medium">Product / SKU</th>
                  <th className="w-20 px-2 py-2 text-right font-medium">Qty</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Weight (gm)</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Rate / gm</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Making (₹)</th>
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
                          ...knownSkus.map((sku) => {
                            const p = products.find((x) => x.sku === sku)
                            return { value: sku, label: `${p?.name ?? sku} (${sku})` }
                          }),
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
                      <Input type="number" min="0" step="0.01" value={line.silverRate} onChange={(e) => setLine(index, { silverRate: e.target.value })} className="h-8 text-right text-xs" />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input type="number" min="0" step="0.01" value={line.makingCharge} onChange={(e) => setLine(index, { makingCharge: e.target.value })} className="h-8 text-right text-xs" />
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-xs">
                      {formatCurrency(lineAmount(line))}
                    </td>
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
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid grid-cols-2 gap-3">
            <Field label="GST (%)">
              <Input type="number" min="0" step="0.01" value={form.gst} onChange={(e) => setForm((f) => ({ ...f, gst: e.target.value }))} />
            </Field>
            <Field label="Discount (₹)">
              <Input type="number" min="0" step="0.01" value={form.discount} onChange={(e) => setForm((f) => ({ ...f, discount: e.target.value }))} />
            </Field>
            <Field label="Payment method">
              <Input value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))} placeholder="Cash / UPI / Card" />
            </Field>
            <Field label="Payment status">
              <Select
                options={[
                  { value: 'pending', label: 'Pending' },
                  { value: 'partial', label: 'Partial' },
                  { value: 'paid', label: 'Paid' },
                ]}
                value={form.paymentStatus}
                onValueChange={(v) => setForm((f) => ({ ...f, paymentStatus: v }))}
              />
            </Field>
            <Field label="Invoice status">
              <Select
                options={[
                  { value: 'issued', label: 'Issued' },
                  { value: 'draft', label: 'Draft' },
                  { value: 'paid', label: 'Paid' },
                ]}
                value={form.status}
                onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}
              />
            </Field>
          </div>
          <div className="space-y-1 self-start rounded-md border border-border/60 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{formatCurrency(totals.subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">GST ({totals.gstRate}%)</span><span className="tabular-nums">{formatCurrency(totals.gstAmount)}</span></div>
            {totals.discount > 0 ? (
              <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="tabular-nums">− {formatCurrency(totals.discount)}</span></div>
            ) : null}
            <div className="flex justify-between border-t border-border/60 pt-1 font-semibold"><span>Grand total</span><span className="tabular-nums">{formatCurrency(totals.grandTotal)}</span></div>
          </div>
        </div>
      </div>
    </AppDialog>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
