import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Printer, Settings, Tag, QrCode, Check, Barcode, AlertTriangle, FileCode2, Wand2 } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { toast, confirmDialog } from '@/components/ui/confirm'
import { dbApi, backupApi } from '@/lib/api'
import type { Product } from '@/types'

interface LabelPreset {
  key: string
  label: string
  width: number
  height: number
  columns: number
  rows: number
  reference?: boolean
}

// Shown until the backend preset list loads. Mirrors LABEL_PRESET_LIST on the
// server so the four reference sizes are always available.
const FALLBACK_PRESETS: LabelPreset[] = [
  { key: 'label-50x40', label: '50 × 40 mm', width: 50, height: 40, columns: 4, rows: 7, reference: true },
  { key: 'label-50x25', label: '50 × 25 mm', width: 50, height: 25, columns: 4, rows: 11, reference: true },
  { key: 'label-35x22', label: '35 × 22 mm', width: 35, height: 22, columns: 5, rows: 13, reference: true },
  { key: 'label-50x10', label: '50 × 10 mm', width: 50, height: 10, columns: 4, rows: 28, reference: true },
]

const DEFAULT_PRESET = 'label-50x40'

export default function BarcodeLabelsPage() {
  const [searchParams] = useSearchParams()
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [presets, setPresets] = useState<LabelPreset[]>(FALLBACK_PRESETS)
  const [preset, setPreset] = useState(DEFAULT_PRESET)
  const [showPrice, setShowPrice] = useState(true)
  const [showWeight, setShowWeight] = useState(true)
  const [showQR, setShowQR] = useState(true)
  const [showBrand, setShowBrand] = useState(true)
  const [copies, setCopies] = useState(1)
  const [format, setFormat] = useState<'qr' | 'code128'>('qr')
  const [generating, setGenerating] = useState(false)
  const [duplicates, setDuplicates] = useState<Set<string>>(new Set())
  const [brand, setBrand] = useState('')
  const [missingCount, setMissingCount] = useState(0)

  const loadProducts = useCallback(() => {
    return dbApi.getProducts().then((data) => {
      setProducts(data)
      setMissingCount(data.filter((p) => !p.barcode || !String(p.barcode).trim()).length)
      // Preselect products passed via ?ids=… (used by the Products page's
      // "Print Label" / bulk actions so the operator lands here ready to print).
      const idsParam = (searchParams.get('ids') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
      if (idsParam.length > 0) {
        const available = new Set(data.map((p) => p.id))
        setSelected(new Set(idsParam.filter((id) => available.has(id))))
      }
    })
  }, [searchParams])

  useEffect(() => {
    let active = true
    Promise.all([
      loadProducts(),
      dbApi.getProductDuplicates().then((r) => {
        if (active) setDuplicates(new Set(r.data.map((d) => d.sku.toLowerCase())))
      }),
      backupApi
        .getLabelPresets()
        .then((list) => {
          if (active && Array.isArray(list) && list.length > 0) setPresets(list)
        })
        .catch(() => undefined),
      dbApi
        .getSettings()
        .then((s) => {
          if (active && s?.businessName) setBrand(s.businessName)
        })
        .catch(() => undefined),
    ])
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [loadProducts])

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = () => {
    if (selected.size === products.length) setSelected(new Set())
    else setSelected(new Set(products.map((p) => p.id)))
  }

  const currentPreset = presets.find((p) => p.key === preset) ?? presets[0]
  const sample = useMemo(() => {
    for (const p of products) if (selected.size === 0 || selected.has(p.id)) return p
    return products[0]
  }, [products, selected])

  const printCount = (selected.size > 0 ? selected.size : products.length) * Math.max(1, copies)
  const ids = useCallback(() => (selected.size > 0 ? [...selected] : []), [selected])

  const printLabels = () => {
    setGenerating(true)
    try {
      backupApi.downloadAllLabels({
        preset,
        showPrice,
        showWeight,
        showQR,
        showBrand,
        copies,
        brandName: brand || undefined,
        // Pass the selected products so the chosen size applies to exactly the
        // labels the button promises; no selection = all.
        ...(selected.size > 0 ? { ids: ids() } : {}),
      })
    } finally {
      setTimeout(() => setGenerating(false), 1000)
    }
  }

  const downloadZpl = async () => {
    const targetIds = selected.size > 0 ? ids() : products.map((p) => p.id)
    if (targetIds.length === 0) {
      toast.error('No products to print')
      return
    }
    setGenerating(true)
    try {
      await backupApi.downloadLabelsZpl(targetIds, { preset, copies, format, showPrice, brandName: brand || undefined })
      toast.success(`Prepared ZPL for ${targetIds.length} label${targetIds.length === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build ZPL')
    } finally {
      setGenerating(false)
    }
  }

  const generateMissing = async () => {
    if (missingCount === 0) {
      toast.info('Every product already has a barcode')
      return
    }
    try {
      const preview = await dbApi.generateMissingBarcodes({ dryRun: true })
      const ok = await confirmDialog({
        title: `Generate ${preview.candidates} barcode${preview.candidates === 1 ? '' : 's'}?`,
        description: 'Only products that do not already have a barcode will be updated. Existing barcodes are never changed.',
        confirmLabel: 'Generate',
      })
      if (!ok) return
      const result = await dbApi.generateMissingBarcodes({})
      await loadProducts()
      toast.success(`Assigned ${result.assigned} barcode${result.assigned === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not generate barcodes')
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[1200px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-5 px-4 py-4 sm:py-6 lg:px-6">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-50 text-primary-700 ring-1 ring-primary-100 dark:bg-primary-50/60 dark:text-primary-300">
              <Tag className="h-5 w-5" />
            </div>
            <span>Barcode Labels</span>
          </span>
        }
        subtitle="Design, preview and print scannable product labels"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={downloadZpl} disabled={generating}>
              <FileCode2 className="h-4 w-4" /> ZPL
            </Button>
            <Button onClick={printLabels} disabled={generating || products.length === 0}>
              <Printer className="h-4 w-4" />
              {generating ? 'Generating…' : `Print ${printCount} Label${printCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        }
      />

      {missingCount > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3 border border-amber-300 bg-amber-50 p-4 sm:flex-row sm:items-center dark:border-amber-500/40 dark:bg-amber-950/30">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="flex-1 text-sm text-amber-800 dark:text-amber-200">
              {missingCount} product{missingCount === 1 ? '' : 's'} have no barcode yet. Labels for them fall back to the SKU.
            </p>
            <Button size="sm" variant="outline" onClick={generateMissing}>
              <Wand2 className="h-3.5 w-3.5" /> Generate Missing
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* Options */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Settings className="h-4 w-4" /> Label Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium text-foreground">Label Size</label>
                <Select
                  options={presets.map((p) => ({
                    value: p.key,
                    label: p.reference ? `${p.label} •` : p.label,
                  }))}
                  value={preset}
                  onValueChange={setPreset}
                  className="mt-1"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {currentPreset
                    ? `${currentPreset.width} × ${currentPreset.height} mm · ${currentPreset.columns} cols × ${currentPreset.rows} rows`
                    : ''}
                </p>
              </div>

              <div>
                <label htmlFor="copies" className="text-sm font-medium text-foreground">
                  Copies per product
                </label>
                <Input
                  id="copies"
                  type="number"
                  min={1}
                  max={999}
                  value={copies}
                  onChange={(e) => setCopies(Math.min(999, Math.max(1, Number(e.target.value) || 1)))}
                  className="mt-1"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Show Price</span>
                  <Switch checked={showPrice} onCheckedChange={setShowPrice} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Show Weight</span>
                  <Switch checked={showWeight} onCheckedChange={setShowWeight} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Show Brand</span>
                  <Switch checked={showBrand} onCheckedChange={setShowBrand} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-sm">
                    <QrCode className="h-3.5 w-3.5" /> Show Code
                  </span>
                  <Switch checked={showQR} onCheckedChange={setShowQR} />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-foreground">ZPL code format</label>
                <Select
                  options={[
                    { value: 'qr', label: 'QR code' },
                    { value: 'code128', label: 'Linear (Code 128)' },
                  ]}
                  value={format}
                  onValueChange={(v) => setFormat(v as 'qr' | 'code128')}
                  className="mt-1"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  PDF labels always use the QR symbol. This option only changes the ZPL export.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Live preview — drawn at the label's real aspect ratio. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Preview</CardTitle>
            </CardHeader>
            <CardContent>
              {currentPreset && (
                <div
                  className="flex w-full flex-col justify-between overflow-hidden rounded-md border border-border bg-white p-1.5 text-[8px] leading-tight text-gray-900"
                  style={{ aspectRatio: `${currentPreset.width} / ${currentPreset.height}` }}
                >
                  <div className="min-w-0">
                    {showBrand && brand ? <p className="truncate font-semibold">{brand}</p> : null}
                    <p className="truncate font-medium">{sample?.name ?? 'Product name'}</p>
                    {currentPreset.height > 12 && sample?.category ? (
                      <p className="truncate text-gray-400">{sample.category}</p>
                    ) : null}
                  </div>
                  <div className="flex items-end justify-between gap-2">
                    <div className="min-w-0">
                      {showPrice ? (
                        <p className="truncate font-semibold text-emerald-600">
                          Rate: {(sample?.sellingPrice ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}/-
                        </p>
                      ) : null}
                      {showQR ? (
                        <p className="truncate text-gray-400">
                          {currentPreset.height <= 12 ? '' : 'Code: '}
                          {sample?.barcode || sample?.sku || '—'}
                        </p>
                      ) : null}
                    </div>
                    {showQR ? (
                      <div className="flex shrink-0 items-center justify-center rounded-sm bg-gray-900/90 text-white" style={{ width: '38%', aspectRatio: '1' }}>
                        <QrCode className="h-1/2 w-1/2" />
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
              <p className="mt-2 text-center text-xs text-muted-foreground">
                {printCount} label{printCount === 1 ? '' : 's'} will be printed
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="text-center text-sm text-muted-foreground">
                <p className="font-medium text-foreground">{products.length} products</p>
                <p>{selected.size > 0 ? `${selected.size} selected` : 'All products'}</p>
              </div>
              <Button variant="outline" size="sm" className="mt-3 w-full" onClick={selectAll}>
                {selected.size === products.length && products.length > 0 ? 'Deselect All' : 'Select All'}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Product list */}
        <div className="md:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Products</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[560px] overflow-y-auto p-0">
              <div className="divide-y divide-border">
                {products.map((product) => {
                  const missing = !product.barcode || !String(product.barcode).trim()
                  return (
                    <div
                      key={product.id}
                      className={`flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 ${
                        selected.has(product.id) ? 'bg-primary-50 dark:bg-primary-500/20' : ''
                      }`}
                      onClick={() => toggleSelect(product.id)}
                    >
                      <div
                        className={`flex h-5 w-5 items-center justify-center rounded border ${
                          selected.has(product.id) ? 'border-primary-600 bg-primary-600 text-white' : 'border-gray-300'
                        }`}
                      >
                        {selected.has(product.id) && <Check className="h-3 w-3" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{product.name}</p>
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="font-mono">{product.sku}</span>
                          {missing ? (
                            <Badge variant="warning" className="text-[10px]">
                              No barcode
                            </Badge>
                          ) : (
                            <span className="flex items-center gap-1">
                              <Barcode className="h-3 w-3" /> <span className="font-mono">{product.barcode}</span>
                            </span>
                          )}
                          {duplicates.has(product.sku.toLowerCase()) && (
                            <Badge variant="warning" className="text-[10px]">
                              Duplicate SKU
                            </Badge>
                          )}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-primary-700">
                          ₹{(product.sellingPrice ?? 0).toLocaleString('en-IN')}
                        </p>
                        {product.netWeight ? <p className="text-xs text-muted-foreground">{product.netWeight}g</p> : null}
                      </div>
                      <Badge variant="muted" className="text-[10px]">
                        {product.category}
                      </Badge>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
