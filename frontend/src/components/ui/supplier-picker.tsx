import * as React from 'react'
import { Check, ChevronDown, Plus, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SupplierDialog, type SupplierFormPayload } from '@/components/supplier-dialog'
import { dbApi } from '@/lib/api'
import type { Supplier } from '@/types'

export interface SupplierPickerProps {
  suppliers: Supplier[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
  disabled?: boolean
  onCreateSupplier?: (supplier: Supplier) => void
}

export function SupplierPicker({
  suppliers,
  value,
  onValueChange,
  placeholder = 'Select supplier…',
  searchPlaceholder = 'Search suppliers…',
  emptyText = 'No supplier found',
  className,
  disabled,
  onCreateSupplier,
}: SupplierPickerProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const selected = suppliers.find((s) => s.id === value)

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return suppliers
    return suppliers.filter((s) => {
      const name = (s.name ?? '').toLowerCase()
      const contact = (s.contact ?? '').toLowerCase()
      const phone = (s.phone ?? '').toLowerCase()
      const city = (s.city ?? '').toLowerCase()
      return name.includes(q) || contact.includes(q) || phone.includes(q) || city.includes(q)
    })
  }, [suppliers, query])

  React.useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 10)
      return () => window.clearTimeout(t)
    }
  }, [open])

  const handleCreate = async (payload: SupplierFormPayload) => {
    setSaving(true)
    setError(null)
    try {
      const created = (await dbApi.create<Supplier>('suppliers', {
        name: payload.name.trim(),
        contact: payload.contact.trim() || null,
        phone: payload.phone.trim() || null,
        alternatePhone: payload.alternatePhone.trim() || null,
        email: payload.email.trim() || null,
        gstin: payload.gstin.trim().toUpperCase() || null,
        city: payload.city.trim() || null,
        address: payload.address.trim() || null,
        status: payload.status || 'active',
        outstanding: 0,
      })) as Supplier
      onCreateSupplier?.(created)
      onValueChange(created.id)
      setDialogOpen(false)
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add supplier')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery('')
        }}
      >
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-primary/60 disabled:cursor-not-allowed disabled:opacity-50',
              className,
            )}
          >
            <span className={cn('truncate', !selected && 'text-muted-foreground/80')}>
              {selected ? selected.name : placeholder}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="start"
            side="bottom"
            avoidCollisions={false}
            sideOffset={4}
            className="z-50 w-[var(--radix-dropdown-menu-trigger-width)] min-w-[16rem] p-0"
          >
            <div className="border-b p-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="h-8 pl-8"
                />
              </div>
            </div>
            <div className="max-h-64 overflow-auto p-1">
              {filtered.length === 0 ? (
                <div className="space-y-2 p-2">
                  <p className="px-2 py-4 text-center text-xs text-muted-foreground">{emptyText}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false)
                      setError(null)
                      setDialogOpen(true)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Add new supplier</span>
                  </button>
                </div>
              ) : (
                <>
                  {filtered.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        onValueChange(s.id)
                        setOpen(false)
                      }}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                        s.id === value && 'bg-muted/60',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{s.name}</span>
                        {(s.city || s.phone) ? (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {[s.city, s.phone].filter(Boolean).join(' • ')}
                          </span>
                        ) : null}
                      </span>
                      {s.id === value ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
                    </button>
                  ))}
                  <div className="mt-1 border-t pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false)
                        setError(null)
                        setDialogOpen(true)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Add new supplier</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>

      <SupplierDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o)
          if (!o) setError(null)
        }}
        mode="add"
        onSubmit={handleCreate}
        saving={saving}
        error={error}
      />
    </>
  )
}
