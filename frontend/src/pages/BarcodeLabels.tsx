import { useState, useEffect } from 'react'
import { Printer, Settings, Tag, QrCode, Check } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { dbApi, backupApi } from '@/lib/api'
import type { Product } from '@/types'

const LABEL_PRESETS = [
  { key: 'label-50x25', label: '50 × 25 mm', desc: '4 columns × 11 rows' },
  { key: 'label-50x22', label: '50 × 22 mm', desc: '4 columns × 13 rows' },
  { key: 'label-35x22', label: '35 × 22 mm', desc: '5 columns × 13 rows' },
  { key: 'label-50x10', label: '50 × 10 mm', desc: '4 columns × 28 rows' },
  { key: 'zlabel-50x30', label: '50 × 30 mm (Standard)', desc: '4 columns × 7 rows' },
  { key: 'zlabel-40x25', label: '40 × 25 mm (Compact)', desc: '4 columns × 8 rows' },
  { key: 'avery-5160', label: 'Avery 5160', desc: '3 columns × 10 rows' },
  { key: 'avery-8160', label: 'Avery 8160', desc: '4 columns × 12 rows' },
  { key: 'dymo-30256', label: 'DYMO 30256', desc: '3 columns × 8 rows' },
]

export default function BarcodeLabelsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preset, setPreset] = useState('zlabel-50x30')
  const [showPrice, setShowPrice] = useState(true)
  const [showWeight, setShowWeight] = useState(true)
  const [showQR, setShowQR] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [duplicates, setDuplicates] = useState<Set<string>>(new Set())

  useEffect(() => {
    dbApi.getProducts().then((data) => {
      setProducts(data)
      setLoading(false)
    }).catch(() => setLoading(false))
    dbApi.getProductDuplicates().then((r) => {
      setDuplicates(new Set(r.data.map((d) => d.sku.toLowerCase())))
    }).catch(() => undefined)
  }, [])

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    if (selected.size === products.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(products.map((p) => p.id)))
    }
  }

  const printLabels = () => {
    setGenerating(true)
    try {
      backupApi.downloadAllLabels({
        preset,
        showPrice,
        showWeight,
        showQR,
        // Pass the selected products so the chosen size applies to exactly the
        // labels the button promises ("Print N Labels"); no selection = all.
        ...(selected.size > 0 ? { ids: [...selected] } : {}),
      })
    } finally {
      setTimeout(() => setGenerating(false), 1000)
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
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-50/60 dark:text-primary-300 ring-1 ring-primary-100">
              <Tag className="h-5 w-5" />
            </div>
            <span>Barcode Labels</span>
          </span>
        }
        subtitle="Generate QR code and barcode labels for products"
        actions={
          <>
            <Button onClick={printLabels} disabled={generating}>
              <Printer className="h-4 w-4" />
              {generating ? 'Generating...' : `Print ${selected.size > 0 ? `${selected.size} Labels` : 'All Labels'}`}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* Options */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Settings className="h-4 w-4" /> Label Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium text-foreground">Label Size</label>
                <Select
                  options={LABEL_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
                  value={preset}
                  onValueChange={setPreset}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {LABEL_PRESETS.find((p) => p.key === preset)?.desc}
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">Show Price</span>
                  </div>
                  <Switch checked={showPrice} onCheckedChange={setShowPrice} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Show Weight</span>
                  <Switch checked={showWeight} onCheckedChange={setShowWeight} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm flex items-center gap-1"><QrCode className="h-3.5 w-3.5" /> Show QR Code</span>
                  <Switch checked={showQR} onCheckedChange={setShowQR} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="text-center text-sm text-muted-foreground">
                <p className="font-medium text-foreground">{products.length} products</p>
                <p>{selected.size > 0 ? `${selected.size} selected` : 'All products'}</p>
              </div>
              <Button variant="outline" size="sm" className="w-full mt-3" onClick={selectAll}>
                {selected.size === products.length ? 'Deselect All' : 'Select All'}
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
            <CardContent className="p-0 max-h-[500px] overflow-y-auto">
              <div className="divide-y divide-border">
                {products.map((product) => (
                  <div
                    key={product.id}
                    className={`flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors ${
                      selected.has(product.id) ? 'bg-primary-50 dark:bg-primary-500/20' : ''
                    }`}
                    onClick={() => toggleSelect(product.id)}
                  >
                    <div className={`flex h-5 w-5 items-center justify-center rounded border ${
                      selected.has(product.id)
                        ? 'bg-primary-600 border-primary-600 text-white'
                        : 'border-gray-300'
                    }`}>
                      {selected.has(product.id) && <Check className="h-3 w-3" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{product.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {product.sku}
                        {product.sku && duplicates.has(product.sku.toLowerCase()) && (
                          <Badge variant="warning" className="ml-1.5 text-[10px]">Duplicate SKU</Badge>
                        )}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-primary-700">₹{(product.sellingPrice ?? 0).toLocaleString('en-IN')}</p>
                      {product.netWeight && <p className="text-xs text-muted-foreground">{product.netWeight}g</p>}
                    </div>
                    <Badge variant="muted" className="text-[10px]">{product.category}</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}