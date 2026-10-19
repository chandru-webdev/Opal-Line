import * as React from 'react'
import { Check, ChevronDown, Plus, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface CreatableSelectOption {
  label: string
  value: string
}

interface CreatableSelectProps {
  options: CreatableSelectOption[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  /** Shown in the "create" row, e.g. `Add "Bridal"`. Defaults to `Add`. */
  createLabel?: string
  className?: string
}

/**
 * Select that also accepts a brand-new value: type any text and pick the
 * "Add …" row (or press Enter) to commit it. Used for product category and
 * collection so a value that is not in the list can be created inline
 * instead of forcing the user to pre-create it somewhere else.
 */
export function CreatableSelect({
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  createLabel = 'Add',
  className,
}: CreatableSelectProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  const selected = options.find((o) => o.value === value)

  const trimmedQuery = query.trim()
  const filtered = React.useMemo(() => {
    const q = trimmedQuery.toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, trimmedQuery])

  // Offer creation only when the typed text does not exactly match an option
  // (case-insensitive) and is not already the current value.
  const exactMatch = options.some((o) => o.label.toLowerCase() === trimmedQuery.toLowerCase())
  const canCreate = trimmedQuery !== '' && !exactMatch && trimmedQuery.toLowerCase() !== value.toLowerCase()

  const commit = (next: string) => {
    onValueChange(next)
    setOpen(false)
    setQuery('')
  }

  React.useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 10)
      return () => window.clearTimeout(t)
    }
  }, [open])

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-primary/60',
            className,
          )}
        >
          <span className={cn('truncate', !selected && !value && 'text-muted-foreground/80')}>
            {/* A custom (typed) value has no matching option — show it as-is
                instead of falling back to the placeholder. */}
            {selected ? selected.label : (value ? value : (placeholder ?? 'Select or type…'))}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-dropdown-menu-trigger-width)] p-0"
      >
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (canCreate) commit(trimmedQuery)
                  else if (filtered[0]) commit(filtered[0].value)
                }
              }}
              placeholder={searchPlaceholder ?? 'Search or type a new value…'}
              className="h-8 pl-8"
            />
          </div>
        </div>
        <div className="max-h-64 overflow-auto p-1">
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => commit(o.value)}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                o.value === value && 'bg-muted/60',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.value === value ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
            </button>
          ))}
          {canCreate ? (
            <button
              type="button"
              onClick={() => commit(trimmedQuery)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-primary transition-colors hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {createLabel} “{trimmedQuery}”
              </span>
            </button>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">No matching options</p>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
