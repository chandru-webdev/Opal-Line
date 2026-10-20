import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ImagePlus, Loader2, Plus, Trash2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CreatableSelect } from '@/components/ui/creatable-select'
import { Switch } from '@/components/ui/switch'
import { AppDialog } from '@/components/ui/app-dialog'
import { toast } from '@/components/ui/confirm'
import { dbApi, shopifyApi, uploadsApi } from '@/lib/api'
import { findDuplicateProduct, generateBarcode, generateSku, type DuplicateMatch } from '@/lib/productCodes'
import type { Product, Supplier } from '@/types'
import { cn, safeImageUrl } from '@/lib/utils'
import { todayIST } from '@/lib/format'
import { SupplierPicker } from '@/components/ui/supplier-picker'

const API_ORIGIN = (import.meta.env.VITE_API_BASE ?? '').replace(/\/api\/v1$/, '') || ''

export interface ProductDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'add' | 'edit'
  product?: Product | null
  onSaved: (product: Product, pushed: boolean) => void
  /** Already-loaded catalogue (Products page) — avoids a full re-fetch on open. */
  products?: Product[]
  /** Opens the duplicate panel's "Edit existing product" target. */
  onEditProduct?: (product: Product) => void
}

interface ProductForm {
  name: string
  description: string
  sku: string
  barcode: string
  huid: string
  category: string
  collection: string
  purity: string
  supplier: string
  stoneWeight: string
  netWeight: string
  makingCharge: string
  gst: string
  silverRate: string
  sellingPrice: string
  compareAtPrice: string
  stock: string
  reorderLevel: string
  vendor: string
  productType: string
  tags: string
  image: string
  images: string[]
  trackInventory: boolean
  chargeOnTax: boolean
  pushToShopify: boolean
}

const CATEGORIES = [
  // Business default: most of the catalogue is silver jewellery, so a new
  // product starts here instead of the previous 'Rings' default.
  'Silver jewels',
  'Rings',
  'Chains',
  'Bracelets',
  'Earrings',
  'Pendants',
  'Mangalsutra',
  'Anklets',
  'Toe Rings',
  'Nose Pins',
  'Necklaces',
  'Bangles',
  'Accessories',
]

const DEFAULT_CATEGORY = 'Silver jewels'

// The catalogue ships with one curated category; new ones can be added inline
// from the category picker and are remembered in this browser for next time.
const CATEGORY_OPTIONS = [DEFAULT_CATEGORY]
const CUSTOM_CATEGORIES_KEY = 'opal.customCategories'

function loadCustomCategories(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_CATEGORIES_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((c): c is string => typeof c === 'string' && c.trim() !== '') : []
  } catch {
    return []
  }
}

const EMPTY_FORM: ProductForm = {
  name: '',
  description: '',
  sku: '',
  barcode: '',
  huid: '',
  category: DEFAULT_CATEGORY,
  collection: '',
  purity: '92.5',
  supplier: '',
  stoneWeight: '',
  netWeight: '',
  makingCharge: '20',
  gst: '3',
  silverRate: '',
  sellingPrice: '',
  compareAtPrice: '',
  stock: '',
  reorderLevel: '5',
  vendor: '',
  productType: '',
  tags: '',
  image: '',
  images: [],
  trackInventory: true,
  chargeOnTax: true,
  pushToShopify: true,
}

function fromProduct(p: Product): ProductForm {
  return {
    name: p.name ?? '',
    description: p.description ?? '',
    sku: p.sku ?? '',
    barcode: p.barcode ?? '',
    huid: p.huid ?? '',
    category: p.category ?? DEFAULT_CATEGORY,
    collection: p.collection ?? '',
    purity: p.purity != null ? String(p.purity) : '92.5',
    supplier: p.supplier ?? '',
    stoneWeight: p.stoneWeight != null ? String(p.stoneWeight) : '',
    netWeight: p.netWeight != null ? String(p.netWeight) : '',
    makingCharge: p.makingCharge != null ? String(p.makingCharge) : '20',
    gst: p.gst != null ? String(p.gst) : '3',
    silverRate: p.silverRate != null ? String(p.silverRate) : '',
    sellingPrice: p.sellingPrice != null ? String(p.sellingPrice) : '',
    compareAtPrice: p.compareAtPrice != null ? String(p.compareAtPrice) : '',
    stock: p.stock != null ? String(p.stock) : '',
    reorderLevel: p.reorderLevel != null ? String(p.reorderLevel) : '5',
    vendor: p.vendor ?? '',
    productType: p.productType ?? '',
    tags: p.tags ?? '',
    image: p.image ?? '',
    images: Array.isArray(p.images) ? p.images : [],
    trackInventory: p.trackInventory ?? true,
    chargeOnTax: p.chargeOnTax ?? true,
    pushToShopify: false,
  }
}

function computePrice(form: ProductForm): number {
  const rate = parseFloat(form.silverRate)
  const making = parseFloat(form.makingCharge)
  const net = parseFloat(form.netWeight)
  const gst = parseFloat(form.gst)
  if (![rate, making, net, gst].every(Number.isFinite) || net <= 0 || rate <= 0) return NaN
  return Math.round((rate + making) * net * (1 + gst / 100) * 100) / 100
}

function buildBody(form: ProductForm, silverRate: number, sellingPrice: number, supplierIdVal?: string) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    sku: form.sku.trim(),
    barcode: form.barcode.trim() || null,
    huid: form.huid.trim() || null,
    category: form.category,
    collection: form.collection.trim() || null,
    purity: parseFloat(form.purity) || null,
    supplier: form.supplier.trim() || null,
    supplierId: supplierIdVal || null,
    stoneWeight: parseFloat(form.stoneWeight) || null,
    netWeight: parseFloat(form.netWeight) || null,
    makingCharge: parseFloat(form.makingCharge) || null,
    gst: parseFloat(form.gst) || null,
    silverRate,
    sellingPrice,
    compareAtPrice: parseFloat(form.compareAtPrice) || null,
    stock: parseInt(form.stock, 10) || 0,
    reorderLevel: parseInt(form.reorderLevel, 10) || 0,
    image: form.image.trim() || (form.images[0] ?? null),
    images: form.images.length > 0 ? form.images : null,
    vendor: form.vendor.trim() || null,
    productType: form.productType.trim() || null,
    tags: form.tags.trim() || null,
    trackInventory: form.trackInventory,
    chargeOnTax: form.chargeOnTax,
  }
}

/** One editable stock count in the edit dialog — a row per location. */
interface StockRow {
  locationId: string
  name: string
  /** Balance the ledger currently holds at this location (whole pcs). */
  original: number
  value: string
}

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-foreground">{title}</p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function ProductDialog({ open, onOpenChange, mode, product, onSaved, products, onEditProduct }: ProductDialogProps) {
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState<string>('')
  // Active duplicate (same SKU or barcode) — resolved inline before saving.
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null)
  // Categories added inline by this user (persisted per browser).
  const [customCategories, setCustomCategories] = useState<string[]>(loadCustomCategories)
  // Collection names already used by products (loaded once per mount) so the
  // collection picker can offer them alongside the built-in categories.
  const [collectionChoices, setCollectionChoices] = useState<string[]>([])
  const [barcodeBusy, setBarcodeBusy] = useState(false)
  const collectionsLoaded = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Latest catalogue for code generation + duplicate checks without turning
  // `products` into a dependency of the open effect.
  const productsRef = useRef<Product[]>([])
  // Edit-mode stock counts: one editable row per location. products.stock is
  // only the cross-location rollup, so the per-location truth comes from the
  // ledger when the dialog opens.
  const [levelDraft, setLevelDraft] = useState<StockRow[]>([])

  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  useEffect(() => {
    if (products) productsRef.current = products
  }, [products])

  // Suppliers load once per mount — never on the open path — so opening the
  // dialog is a pure render with zero network waits (was: a fetch on every
  // open that re-rendered the whole form mid-animation).
  useEffect(() => {
    dbApi.getSuppliers().then(setSuppliers).catch(() => setSuppliers([]))
    // Collection fallback (pages that don't pass `products`): fetch lazily
    // after first paint so it never competes with the dialog opening.
    const t = window.setTimeout(() => {
      if (collectionsLoaded.current || products) return
      collectionsLoaded.current = true
      dbApi.getProducts().then((ps) => {
        const cols = Array.from(new Set(ps.map((p) => p.collection).filter((c): c is string => Boolean(c))))
        setCollectionChoices(cols)
      }).catch(() => setCollectionChoices([]))
    }, 250)
    return () => window.clearTimeout(t)
  }, [products])

  useEffect(() => {
    if (!open) return
    const initial = mode === 'edit' && product
      ? fromProduct(product)
      : {
          ...EMPTY_FORM,
          // New products get unique identifiers up front (house style
          // SLV-RNG-00001, scan-ready EAN-13); saving re-checks and the
          // duplicate panel offers fresh codes if anything still collides.
          sku: generateSku(productsRef.current, EMPTY_FORM.category),
          barcode: generateBarcode(productsRef.current),
        }
    const p = computePrice(initial)
    if (Number.isFinite(p)) initial.sellingPrice = String(Math.round(p * 100) / 100)
    // Defer the reset out of the effect body (react/set-state-in-effect).
    queueMicrotask(() => {
      setForm(initial)
      setSupplierId(product?.supplierId ?? '')
      setError('')
      setDuplicate(null)
    })
  }, [open, mode, product])

  // Edit mode: the product already exists, so the server can assign a real,
  // globally-unique barcode immediately. Add mode pre-fills a locally generated
  // EAN-13 (see the effect above) and the backend still assigns one on save if
  // the field is left blank (see the create route).
  const generateServerBarcode = async () => {
    if (!product?.id) return
    setBarcodeBusy(true)
    try {
      const res = await dbApi.generateProductBarcode(product.id)
      set('barcode', res.barcode)
      setError('')
      toast.success(res.created ? `Generated barcode ${res.barcode}` : `Barcode: ${res.barcode}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate a barcode')
    } finally {
      setBarcodeBusy(false)
    }
  }

  // Stock levels behind the edit dialog: clear first (deferred — sync setState
  // in an effect is linted), then load this product's per-location balances.
  // Products never counted through the ledger have no level rows — seed Main
  // Store with products.stock; the backend's adoption rule makes saving it
  // unchanged a no-op instead of a double-count.
  useEffect(() => {
    queueMicrotask(() => setLevelDraft((prev) => (prev.length === 0 ? prev : [])))
    if (!open || mode !== 'edit' || !product?.sku) return
    const pid = product.id
    const seed = Math.floor(Number(product.stock ?? 0))
    let cancelled = false
    Promise.all([dbApi.getStockLevels(product.sku), dbApi.getInventoryLocations()])
      .then(([rows, locs]) => {
        if (cancelled) return
        const nameFor = (id: string) => locs.find((l) => l.id === id)?.name ?? id
        const mine = rows
          .filter((r) => r.productId === pid)
          .sort((a, b) => String(a.locationId).localeCompare(String(b.locationId)))
        const draft: StockRow[] =
          mine.length > 0
            ? mine.map((r) => {
                const qty = Math.floor(Number(r.qty) || 0)
                return { locationId: r.locationId, name: nameFor(r.locationId), original: qty, value: String(qty) }
              })
            : [
                {
                  locationId: 'LOC-DEFAULT',
                  name: locs.find((l) => l.id === 'LOC-DEFAULT')?.name ?? 'Main Store',
                  original: seed,
                  value: String(seed),
                },
              ]
        setLevelDraft(draft)
      })
      .catch(() => {
        if (!cancelled) setLevelDraft([])
      })
    return () => {
      cancelled = true
    }
  }, [open, mode, product])

  const setPricing = (key: 'silverRate' | 'makingCharge' | 'netWeight' | 'gst', value: string) => {
    setForm((f) => {
      const next = { ...f, [key]: value }
      const p = computePrice(next)
      if (Number.isFinite(p)) next.sellingPrice = String(Math.round(p * 100) / 100)
      return next
    })
  }

  const categorySelectOptions = useMemo(() => {
    // One curated default for now; categories the user added inline join the
    // list (remembered per browser), plus the current value while editing.
    const labels = new Set<string>([...CATEGORY_OPTIONS, ...customCategories])
    if (form.category) labels.add(form.category)
    // Keep the default first, alphabetical after it.
    return Array.from(labels)
      .sort((a, b) => (a === DEFAULT_CATEGORY ? -1 : b === DEFAULT_CATEGORY ? 1 : a.localeCompare(b)))
      .map((c) => ({ value: c, label: c }))
  }, [customCategories, form.category])

  const commitCategory = (value: string) => {
    set('category', value)
    setCustomCategories((prev) => {
      const known = [...CATEGORY_OPTIONS, ...prev].some((c) => c.toLowerCase() === value.toLowerCase())
      if (known) return prev
      const next = [...prev, value]
      try {
        localStorage.setItem(CUSTOM_CATEGORIES_KEY, JSON.stringify(next))
      } catch {
        // Private mode / quota — the category still applies to this product.
      }
      return next
    })
  }

  const collectionSelectOptions = useMemo(() => {
    const labels = new Set<string>([...collectionChoices, ...CATEGORIES])
    if (form.collection) labels.add(form.collection)
    return Array.from(labels)
      .sort((a, b) => a.localeCompare(b))
      .map((c) => ({ value: c, label: c }))
  }, [collectionChoices, form.collection])

  const computed = computePrice(form)
  const hasAutoPrice = Number.isFinite(computed)
  const sellingLocked = hasAutoPrice

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const list = Array.from(files).slice(0, 20 - form.images.length)
    if (list.length === 0) {
      setError('Maximum 20 images per product')
      return
    }
    setUploading(true)
    setError('')
    try {
      const dataUrls = await Promise.all(
        list.map(
          (file) =>
            new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result))
              reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
              reader.readAsDataURL(file)
            }),
        ),
      )
      const res = await uploadsApi.uploadImages(dataUrls)
      const saved = [...form.images, ...res.paths]
      setForm((f) => ({
        ...f,
        images: saved,
        // First image becomes the primary product photo automatically.
        image: f.image.trim() || res.paths[0] || f.image,
      }))
      if (res.errors?.length) setError(res.errors.join('; '))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Image upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeImage = (path: string) => {
    setForm((f) => {
      const images = f.images.filter((x) => x !== path)
      return { ...f, images, image: f.image === path ? (images[0] ?? '') : f.image }
    })
  }

  // Drag-to-reorder gallery; first image is the primary/cover
  const dragIndex = useRef<number | null>(null)
  const reorderImage = (from: number, to: number) => {
    setForm((f) => {
      const images = [...f.images]
      const [moved] = images.splice(from, 1)
      images.splice(to, 0, moved)
      return { ...f, images, image: images[0] ?? '' }
    })
  }
  const setPrimaryImage = (path: string) => {
    setForm((f) => {
      const images = [path, ...f.images.filter((x) => x !== path)]
      return { ...f, images, image: path }
    })
  }

  const submit = async () => {
    const name = form.name.trim()
    const sku = form.sku.trim()
    if (!name || !sku) {
      setError('Title and SKU are required')
      return
    }
    const silverRate = parseFloat(form.silverRate)
    if (!Number.isFinite(silverRate) || silverRate <= 0) {
      setError('A valid silver rate (₹/gm) is required to price the product')
      return
    }
    const sellingPrice = parseFloat(form.sellingPrice) || computePrice(form)
    if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) {
      setError('A valid selling price is required')
      return
    }
    setSaving(true)
    setError('')
    try {
      const body = buildBody(form, silverRate, sellingPrice, supplierId)
      // Duplicate guard: never silently create a second product on the same
      // identifier — offer to open the existing one or mint fresh codes.
      const dup = findDuplicateProduct(
        productsRef.current,
        body.sku ?? '',
        body.barcode ?? '',
        mode === 'edit' ? product?.id : undefined,
      )
      if (dup) {
        setDuplicate(dup)
        return
      }
      let saved: Product
      if (mode === 'edit' && product) {
        // Stock is owned by the ledger: sending it here would be rejected. The
        // per-location counts below go through the dedicated endpoint, which
        // records a count_adjust movement per changed location instead of a
        // silent overwrite of the rollup.
        const { stock: _stock, ...editable } = body
        saved = await dbApi.update<Product>('products', product.id, editable)
        const changedRows = levelDraft.filter((r) => Math.floor(Number(r.value) || 0) !== r.original)
        for (const r of changedRows) {
          await dbApi.setProductStock(product.id, Math.floor(Number(r.value) || 0), r.locationId)
        }
        if (changedRows.length > 0) {
          // Keep the list in sync without a refetch: the rollup is the sum of
          // the per-location counts just written.
          saved = { ...saved, stock: levelDraft.reduce((a, r) => a + Math.floor(Number(r.value) || 0), 0) }
        }
      } else {
        saved = await dbApi.create<Product>('products', {
          ...body,
          hsn: '71131130',
          shopifyStatus: 'not-listed',
          status: 'active',
          createdAt: todayIST(),
        })
      }
      let pushed = false
      const linked = saved.shopifyId != null && String(saved.shopifyId).trim() !== '' && !String(saved.shopifyId).trim().startsWith('#')
      const priceChanged =
        Number(saved.sellingPrice ?? 0) !== Number(product?.sellingPrice ?? 0) ||
        Number(saved.compareAtPrice ?? 0) !== Number(product?.compareAtPrice ?? 0)
      if (form.pushToShopify) {
        // New/placeholder listings are created; already-listed products get
        // their content + local images pushed as an update by the backend.
        // Best-effort: an unconfigured store or a Shopify outage must never make
        // a locally-saved product read as "failed to create", so a push error is
        // reported as a warning and the product still saves.
        try {
          const result = await shopifyApi.pushProducts([saved.id])
          pushed = result.created > 0 || (result.updated ?? 0) > 0
          if (result.created > 0 && form.trackInventory && (saved.stock ?? 0) > 0) {
            try {
              await shopifyApi.pushInventory([saved.id])
            } catch {
              // Inventory push is best-effort here; it can be retried from the Shopify tools.
            }
          }
        } catch (e) {
          pushed = false
          toast.info(
            `Saved locally. Shopify push failed: ${e instanceof Error ? e.message : 'unknown error'}`,
          )
        }
      }
      // Price changes always travel through the dedicated price endpoint — the
      // content/image push intentionally leaves variants untouched.
      if (mode === 'edit' && linked && priceChanged) {
        try {
          const r = await shopifyApi.updateProductPrice(saved.id)
          pushed = r.updated === 1 || pushed
        } catch {
          // Best-effort; the local price is saved and can be pushed from Shopify → Price tools.
        }
      }
      onOpenChange(false)
      onSaved(saved, pushed)
    } catch (e) {
      // The backend unique constraint is the final word (races, other users):
      // map "already exists" onto the same resolve panel when we can match it.
      const msg = e instanceof Error ? e.message : 'Failed to save product'
      if (/already exists/i.test(msg)) {
        const dup = findDuplicateProduct(
          productsRef.current,
          form.sku,
          form.barcode,
          mode === 'edit' ? product?.id : undefined,
        )
        if (dup) {
          setDuplicate(dup)
          return
        }
      }
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  const regenerateCodes = () => {
    setForm((f) => ({
      ...f,
      sku: generateSku(productsRef.current, f.category),
      barcode: generateBarcode(productsRef.current),
    }))
    setDuplicate(null)
    setError('')
  }

  // Validation + duplicate panels live in the footer so they are always
  // visible — the body of this dialog scrolls, the footer does not.
  const duplicatePanel = duplicate ? (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/60 px-3 py-2 text-sm text-amber-900">
      <p>
        <span className="font-medium">{duplicate.field === 'sku' ? 'SKU' : 'Barcode'}</span>{' '}
        <span className="font-mono">{duplicate.field === 'sku' ? form.sku : form.barcode}</span> is already used
        by <span className="font-medium">“{duplicate.product.name}”</span>
        {duplicate.product.sku ? (
          <> (SKU <span className="font-mono">{duplicate.product.sku}</span>)</>
        ) : null}
        .
      </p>
      <div className="flex flex-wrap gap-2">
        {onEditProduct ? (
          <Button variant="outline" size="sm" onClick={() => onEditProduct(duplicate.product)}>
            Edit existing product
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={regenerateCodes}>
          Generate new codes
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDuplicate(null)}>
          Keep editing
        </Button>
      </div>
    </div>
  ) : null

  const errorPanel = error ? (
    <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2 text-sm text-red-700">
      <span className="mt-0.5 block h-2 w-2 shrink-0 rounded-full bg-red-600" />
      <p>{error}</p>
    </div>
  ) : null

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      size="2xl"
      title={mode === 'edit' ? 'Edit Product' : 'Add Product'}
      description={
        mode === 'edit'
          ? 'Update the product in the billing software. Shopify options are only used when "Push to Shopify" is on.'
          : 'Create a product in the billing software. Shopify options (title, SKU, inventory tracking, photo, vendor and tags) are pushed when "Push to Shopify" is on.'
      }
      footer={
        <div className="flex flex-col gap-2">
          {duplicatePanel}
          {errorPanel}
          <div className="flex flex-row justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {saving
                ? 'Saving...'
                : mode === 'edit'
                  ? 'Save Changes'
                  : form.pushToShopify
                    ? 'Create & Push to Shopify'
                    : 'Create Product'}
            </Button>
          </div>
        </div>
      }
    >

        <div className="space-y-5">
          <div className="space-y-3">
            <SectionTitle title="Basic details" />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Title *" className="col-span-2">
                <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Silver Classic Ring" />
              </Field>
              <Field label="Description" className="col-span-2">
                <textarea
                  className="min-h-[90px] w-full resize-y rounded-md border bg-transparent p-2 text-sm outline-none focus:ring-1 focus:ring-primary-400"
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="Product description shown on the Shopify listing — features, dimensions, care instructions…"
                  rows={4}
                />
                <p className="text-[11px] text-muted-foreground">Synced to Shopify body_html when the product is pushed.</p>
              </Field>
              <Field label="SKU *">
                <Input value={form.sku} onChange={(e) => set('sku', e.target.value)} placeholder="e.g. SLV-RNG-00001" />
              </Field>
              <Field label="Barcode">
                <div className="flex gap-1.5">
                  <Input
                    value={form.barcode}
                    onChange={(e) => set('barcode', e.target.value)}
                    placeholder={mode === 'edit' ? 'Code encoded in the label' : 'Auto-generated if left blank'}
                    className="font-mono"
                  />
                  {mode === 'edit' && product?.id ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      disabled={barcodeBusy}
                      onClick={generateServerBarcode}
                      title="Generate a unique barcode"
                    >
                      <Wand2 className={cn('h-4 w-4', barcodeBusy && 'animate-pulse')} />
                    </Button>
                  ) : null}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {mode === 'edit'
                    ? 'This exact value is encoded in the printed QR/barcode.'
                    : 'Leave blank to generate a unique barcode automatically on save.'}
                </p>
              </Field>
              <Field label="HUID (Hallmark)">
                <Input value={form.huid} onChange={(e) => set('huid', e.target.value)} placeholder="e.g. HUIA07" />
              </Field>
              <Field label="Category">
                <CreatableSelect
                  options={categorySelectOptions}
                  value={form.category}
                  onValueChange={commitCategory}
                  placeholder="Select or type a category…"
                  createLabel="Add category"
                />
              </Field>
              <Field label="Collection">
                <CreatableSelect
                  options={collectionSelectOptions}
                  value={form.collection}
                  onValueChange={(v) => set('collection', v)}
                  placeholder="Select or type a collection…"
                  createLabel="Add collection"
                />
              </Field>
              <Field label="Purity %">
                <Input type="number" step="0.1" value={form.purity} onChange={(e) => set('purity', e.target.value)} />
              </Field>
                <Field label="Supplier">
                  <SupplierPicker
                    suppliers={suppliers}
                    value={supplierId}
                    onValueChange={setSupplierId}
                    onCreateSupplier={(s) => setSuppliers((prev) => [s, ...prev])}
                    placeholder="Select supplier…"
                    searchPlaceholder="Search suppliers by name, contact, phone or city"
                    emptyText="No supplier found"
                    className="w-full"
                  />
                </Field>
            </div>
          </div>

          <div className="space-y-3">
            <SectionTitle title="Weight & pricing" />
            <div className="grid grid-cols-3 gap-3">
              <Field label="Stone weight (g)">
                <Input type="number" step="0.01" value={form.stoneWeight} onChange={(e) => set('stoneWeight', e.target.value)} />
              </Field>
              <Field label="Net weight (g)">
                <Input type="number" step="0.01" value={form.netWeight} onChange={(e) => setPricing('netWeight', e.target.value)} />
              </Field>
              <Field label="Silver rate (₹/g) *">
                <Input type="number" step="0.01" value={form.silverRate} onChange={(e) => setPricing('silverRate', e.target.value)} />
              </Field>
              <Field label="Making charge (₹/g)">
                <Input type="number" step="0.01" value={form.makingCharge} onChange={(e) => setPricing('makingCharge', e.target.value)} />
              </Field>
              <Field label="GST %">
                <Input type="number" step="0.1" value={form.gst} onChange={(e) => setPricing('gst', e.target.value)} />
              </Field>
              <Field label="Selling price (₹)">
                <Input
                  type="number"
                  step="0.01"
                  value={form.sellingPrice}
                  onChange={(e) => set('sellingPrice', e.target.value)}
                  disabled={sellingLocked}
                  placeholder={hasAutoPrice ? 'Auto-calculated' : 'Enter price'}
                />
              </Field>
              <Field label="Compare-at price (₹)">
                <Input type="number" step="0.01" value={form.compareAtPrice} onChange={(e) => set('compareAtPrice', e.target.value)} placeholder="Optional strikethrough" />
              </Field>
              {mode === 'edit' ? (
                <Field label="Stock (pcs)">
                  {levelDraft.length > 0 ? (
                    <div className="space-y-1.5">
                      {levelDraft.map((row, i) => (
                        <div key={row.locationId} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{row.name}</span>
                          <Input
                            type="number"
                            min={0}
                            step="1"
                            aria-label={`Stock at ${row.name}`}
                            className="w-24"
                            value={row.value}
                            onChange={(e) =>
                              setLevelDraft((prev) => prev.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                            }
                          />
                        </div>
                      ))}
                      <p className="flex justify-between text-[11px] text-muted-foreground">
                        <span>Total</span>
                        <span className="font-medium tabular-nums text-foreground">
                          {levelDraft.reduce((a, r) => a + Math.floor(Number(r.value) || 0), 0)}
                        </span>
                      </p>
                    </div>
                  ) : (
                    // Loading (or a product with no SKU): keep the rollup visible.
                    <Input type="number" step="1" value={form.stock} disabled />
                  )}
                </Field>
              ) : (
                <Field label="Opening stock (pcs)">
                  <Input type="number" step="1" value={form.stock} onChange={(e) => set('stock', e.target.value)} />
                </Field>
              )}
              {mode === 'edit' ? (
                <p className="text-[11px] text-muted-foreground">
                  Saved as a <span className="font-medium text-foreground">count correction</span> in that location's stock
                  ledger. Use <span className="font-medium text-foreground">Stock Transfer</span> to move stock between
                  locations.
                </p>
              ) : null}
            </div>
            {hasAutoPrice ? (
              <p className="text-[11px] text-muted-foreground">
                Auto price from rate × net weight + making + GST: <span className="font-semibold text-foreground">₹{computed.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">Enter net weight and silver rate to auto-calculate the selling price.</p>
            )}
          </div>

          <div className="space-y-3">
            <SectionTitle title="Shopify listing" hint={mode === 'edit' ? 'Pushing creates a new Shopify listing only for products not yet listed.' : 'Used when pushing the product to Shopify.'} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vendor">
                <Input value={form.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="e.g. Opal Line" />
              </Field>
              <Field label="Product type">
                <Input value={form.productType} onChange={(e) => set('productType', e.target.value)} placeholder="e.g. Jewelry" />
              </Field>
              <Field label="Tags" className="col-span-2">
                <Input value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="Comma separated, e.g. silver, handmade, gift" />
              </Field>
              <Field label="Product images" className="col-span-2">
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {form.images.map((path, idx) => {
                      const preview = safeImageUrl(path) ?? (path.startsWith('/uploads/') ? `${API_ORIGIN}${path}` : undefined)
                      const isPrimary = idx === 0
                      return (
                        <div
                          key={path}
                          draggable
                          onDragStart={() => { dragIndex.current = idx }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => { if (dragIndex.current !== null && dragIndex.current !== idx) reorderImage(dragIndex.current, idx); dragIndex.current = null }}
                          className={cn('group relative h-16 w-16 cursor-grab overflow-hidden rounded-md border bg-muted active:cursor-grabbing', isPrimary && 'border-primary-500 ring-1 ring-primary-500')}
                          title={isPrimary ? 'Primary image — drag to reorder' : 'Drag to reorder'}
                        >
                          {preview ? <img src={preview} alt="product" className="h-full w-full object-cover" /> : null}
                          {isPrimary && (
                            <span className="absolute left-0 top-0 rounded-br bg-primary-600 px-1 text-[8px] font-semibold text-white">COVER</span>
                          )}
                          <div className="absolute inset-x-0 bottom-0 hidden justify-center gap-0.5 bg-black/50 p-0.5 group-hover:flex">
                            {!isPrimary && (
                              <button type="button" onClick={() => setPrimaryImage(path)} className="rounded px-1 text-[9px] text-white hover:bg-white/20" title="Set as primary">★</button>
                            )}
                            <button
                              type="button"
                              onClick={() => removeImage(path)}
                              className="rounded px-1 text-[9px] text-white hover:bg-white/20"
                              title="Remove image"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading || form.images.length >= 20}
                      className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
                      title="Upload images (jpg, png, webp)"
                    >
                      {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                      <span className="text-[10px]">Add</span>
                    </button>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                    multiple
                    className="hidden"
                    onChange={(e) => void handleFiles(e.target.files)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Up to 20 images. The first one is the main photo. All images are pushed to Shopify when the product is pushed.
                  </p>
                </div>
              </Field>
              <Field label="Or paste an image URL" className="col-span-2">
                <Input value={form.image} onChange={(e) => set('image', e.target.value)} placeholder="https://... (Shopify fetches the photo)" />
              </Field>
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <p className="text-[13px] font-medium text-foreground">Track inventory</p>
                  <p className="text-[11px] text-muted-foreground">Shopify manages stock for this product.</p>
                </div>
                <Switch checked={form.trackInventory} onCheckedChange={(v) => set('trackInventory', v)} />
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <p className="text-[13px] font-medium text-foreground">Charge on tax</p>
                  <p className="text-[11px] text-muted-foreground">Mark this product as taxable on Shopify. Tax is calculated by Shopify at checkout.</p>
                </div>
                <Switch checked={form.chargeOnTax} onCheckedChange={(v) => set('chargeOnTax', v)} />
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <p className="text-[13px] font-medium text-foreground">Push to Shopify</p>
                  <p className="text-[11px] text-muted-foreground">
                    {mode === 'edit' ? 'Create the Shopify listing now if this product is not listed yet.' : 'Create the Shopify listing and push stock immediately.'}
                  </p>
                </div>
                <Switch checked={form.pushToShopify} onCheckedChange={(v) => set('pushToShopify', v)} />
              </div>
            </div>
          </div>
        </div>

    </AppDialog>
  )
}
