import { useRef, useState } from 'react'
import { Upload, FileSpreadsheet, Images, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { dbApi } from '@/lib/api'
import { cn } from '@/lib/utils'

type Mode = 'csv' | 'images'

interface Result {
  ok: boolean
  lines: string[]
}

/**
 * Bulk tools for products:
 *  - csv: paste/upload CSV → maps headers → creates/updates products by SKU
 *  - images: pick multiple files → matched to products by filename (SKU.ext)
 */
export function BulkImportDialog({ open, onOpenChange, mode, onDone }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: Mode
  onDone?: () => void
}) {
  const [csvText, setCsvText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const imgInput = useRef<HTMLInputElement>(null)

  const reset = () => { setCsvText(''); setFiles([]); setResult(null) }

  const parseCsv = (text: string): Array<Record<string, string>> => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length < 2) return []
    const split = (line: string) => {
      const out: string[] = []
      let cur = ''
      let inQ = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') { cur += '"'; i++ } else inQ = !inQ
        } else if (ch === ',' && !inQ) { out.push(cur); cur = '' } else cur += ch
      }
      out.push(cur)
      return out.map((c) => c.trim())
    }
    const headers = split(lines[0])
    return lines.slice(1).map((line) => {
      const cells = split(line)
      const row: Record<string, string> = {}
      headers.forEach((h, i) => { if (cells[i] !== undefined) row[h] = cells[i] })
      return row
    })
  }

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
      reader.readAsDataURL(file)
    })

  const run = async () => {
    setBusy(true)
    setResult(null)
    try {
      if (mode === 'csv') {
        const rows = parseCsv(csvText)
        if (rows.length === 0) {
          setResult({ ok: false, lines: ['No CSV rows found — include a header row and at least one product.'] })
          return
        }
        const r = await dbApi.bulkImportProducts(rows)
        const lines = [`Created ${r.created} new product${r.created === 1 ? '' : 's'}, updated ${r.updated}.`]
        for (const e of r.errors.slice(0, 10)) lines.push(`⚠ ${e}`)
        if (r.errors.length > 10) lines.push(`… and ${r.errors.length - 10} more issues`)
        setResult({ ok: r.errors.length === 0, lines })
      } else {
        const images = await Promise.all(
          files.map(async (f) => ({ filename: f.name, dataUrl: await fileToDataUrl(f) })),
        )
        const r = await dbApi.bulkUploadProductImages(images)
        const lines = [`Matched & attached ${r.matched} of ${files.length} image${files.length === 1 ? '' : 's'}.`]
        if (r.unmatched.length > 0) lines.push(`No SKU match (name files as SKU.jpg): ${r.unmatched.slice(0, 8).join(', ')}${r.unmatched.length > 8 ? '…' : ''}`)
        for (const e of r.errors.slice(0, 5)) lines.push(`⚠ ${e}`)
        setResult({ ok: r.unmatched.length === 0 && r.errors.length === 0, lines })
      }
      onDone?.()
    } catch (err) {
      setResult({ ok: false, lines: [err instanceof Error ? err.message : 'Import failed'] })
    } finally {
      setBusy(false)
    }
  }

  const isCsv = mode === 'csv'
  const canRun = isCsv ? csvText.trim().length > 0 : files.length > 0

  return (
    <AppDialog
      open={open}
      onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}
      size="lg"
      titleAdornment={isCsv ? <FileSpreadsheet className="h-4 w-4" /> : <Images className="h-4 w-4" />}
      title={isCsv ? 'Bulk import products (CSV)' : 'Bulk upload product images'}
      description={
        isCsv
          ? 'Paste CSV or upload a file. Headers are auto-mapped (name, sku, purity, net weight, making charge, price, stock, huid…). Existing SKUs are updated, new ones created.'
          : 'Pick image files named after the product SKU (e.g. SLV-RNG-00001.jpg). Each image is attached to the matching product automatically.'
      }
      footer={
        <div className="flex flex-row justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => { reset(); onOpenChange(false) }}>Close</Button>
          <Button size="sm" onClick={run} disabled={busy || !canRun}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isCsv ? 'Import products' : 'Upload & match'}
          </Button>
        </div>
      }
    >

        {isCsv ? (
          <div className="space-y-2">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) setCsvText(await f.text())
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> Upload CSV file
            </Button>
            <textarea
              className="h-44 w-full resize-none rounded-md border bg-transparent p-2 font-mono text-xs outline-none"
              placeholder={'name,sku,category,purity,net weight,making charge,price,stock,huid\nSilver Ring,SLV-RNG-001,Rings,92.5,4.2,20,850,10,'}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <input
              ref={imgInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <Button variant="outline" size="sm" onClick={() => imgInput.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> Choose images
            </Button>
            {files.length > 0 && (
              <p className="text-xs text-muted-foreground">{files.length} file(s) selected — first: {files[0].name}</p>
            )}
          </div>
        )}

        {result && (
          <div className={cn('rounded-md border p-3 text-xs space-y-1', result.ok ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10')}>
            {result.lines.map((l, i) => (
              <p key={i} className="flex items-start gap-1.5">
                {l.startsWith('⚠') ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500 dark:text-amber-400" /> : <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />}
                <span>{l.replace(/^⚠ /, '')}</span>
              </p>
            ))}
          </div>
        )}

    </AppDialog>
  )
}
