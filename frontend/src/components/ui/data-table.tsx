import * as React from 'react'
import {
  flexRender,
  useTable,
  type ColumnVisibilityState,
  type RowData,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown, Settings2 } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table'
import { Button } from './button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from './dropdown-menu'
import { cn } from '@/lib/utils'
import { appTableFeatures, type ColumnDef } from '@/lib/table'

export type { ColumnDef, AppTableFeatures } from '@/lib/table'

interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<TData>[]
  data: TData[]
  loading?: boolean
  emptyMessage?: string
  className?: string
  initialVisibility?: ColumnVisibilityState
  /** Controlled visibility (persisted per page). Overrides internal state when provided. */
  columnVisibility?: ColumnVisibilityState
  onColumnVisibilityChange?: (v: ColumnVisibilityState) => void
  onRowClick?: (row: TData) => void
  /** Called when a row is double-clicked (falls back to onRowClick when not provided). */
  onRowDoubleClick?: (row: TData) => void
  /** Called whenever the set of selected rows changes (checkbox column shown when provided). */
  onSelectionChange?: (selectedRows: TData[]) => void
}

/**
 * Memoized on purpose: pages re-render for many small reasons (dialog state,
 * pollers, toasts). Without the memo the whole table — headers plus every
 * rendered cell — is rebuilt on each of those renders, which measured as a
 * ~370 ms main-thread stall when opening a dialog on data-heavy pages (the
 * "dialog opens with a lag" report). Rendering is now skipped unless the
 * props actually changed, so pages should pass stable callbacks
 * (useCallback / setState) for the memo to hold.
 */
function DataTableInner<TData extends RowData>({
  columns,
  data,
  loading,
  emptyMessage = 'No records found',
  className,
  initialVisibility,
  columnVisibility: controlledVisibility,
  onColumnVisibilityChange,
  onRowClick,
  onRowDoubleClick,
  onSelectionChange,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [rowSelection, setRowSelection] = React.useState({})
  const [internalVisibility, setInternalVisibility] = React.useState<ColumnVisibilityState>(
    initialVisibility ?? {},
  )
  const columnVisibility = controlledVisibility ?? internalVisibility
  const setColumnVisibility: React.Dispatch<React.SetStateAction<ColumnVisibilityState>> = (updater) => {
    const next = typeof updater === 'function' ? updater(columnVisibility) : updater
    if (onColumnVisibilityChange) onColumnVisibilityChange(next)
    else setInternalVisibility(next)
  }

  const table = useTable({
    features: appTableFeatures,
    data,
    columns,
    state: { sorting, rowSelection, columnVisibility },
    enableRowSelection: true,
    onRowSelectionChange: (updater) => {
      setRowSelection((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        if (onSelectionChange) {
          onSelectionChange(Object.keys(next).filter((k) => next[k]).map((k) => data[Number(k)]).filter(Boolean))
        }
        return next
      })
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
  })

  const hasHidableColumns = table.getAllLeafColumns().filter((c) => c.getCanHide()).length > 2

  return (
    <div className={cn('w-full', className)}>
      {hasHidableColumns && (
        <div className="mb-2 flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Settings2 className="h-3.5 w-3.5" /> Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 w-52 overflow-y-auto">
              <DropdownMenuLabel className="text-xs">Show columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table
                .getAllLeafColumns()
                .filter((c) => c.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(v) => column.toggleVisibility(!!v)}
                    onSelect={(e) => e.preventDefault()}
                    className="text-xs"
                  >
                    {typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="bg-muted/30 hover:bg-muted/30">
              {onSelectionChange && (
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={table.getIsAllRowsSelected()}
                    ref={(el) => { if (el) el.indeterminate = table.getIsSomeRowsSelected() }}
                    onChange={table.getToggleAllRowsSelectedHandler()}
                    onClick={(e) => e.stopPropagation()}
                  />
                </TableHead>
              )}
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort()
                const sorted = header.column.getIsSorted()
                return (
                  <TableHead key={header.id} className={cn(header.column.columnDef.meta?.headerClassName)}>
                    {header.isPlaceholder ? null : (
                      <button
                        className={cn(
                          'flex w-full items-center gap-1',
                          header.column.columnDef.meta?.align === 'right' && 'justify-end',
                          header.column.columnDef.meta?.align === 'center' && 'justify-center',
                          canSort && 'cursor-pointer select-none hover:text-foreground',
                        )}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {canSort ? (
                          sorted === 'asc' ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : sorted === 'desc' ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ChevronsUpDown className="h-3 w-3 opacity-40" />
                          )
                        ) : null}
                      </button>
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-28 text-center">
                <div className="flex flex-col items-center gap-3">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  <p className="text-xs text-muted-foreground">Loading data...</p>
                </div>
              </TableCell>
            </TableRow>
          ) : table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() && 'selected'}
                className={onRowClick || onSelectionChange ? 'cursor-pointer' : undefined}
                onClick={onRowClick ? (e) => {
                  if ((e.target as HTMLElement).closest('button, a, [role=menuitem], input, select, textarea')) return
                  onRowClick(row.original)
                } : onSelectionChange ? () => row.toggleSelected() : undefined}
                onDoubleClick={onRowDoubleClick ? (e) => {
                  if ((e.target as HTMLElement).closest('button, a, [role=menuitem], input, select, textarea')) return
                  onRowDoubleClick(row.original)
                } : undefined}
              >
                {onSelectionChange && (
                  <TableCell>
                    <input
                      type="checkbox"
                      className="cursor-pointer"
                      checked={row.getIsSelected()}
                      onClick={(e) => e.stopPropagation()}
                      onChange={row.getToggleSelectedHandler()}
                    />
                  </TableCell>
                )}
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cn(cell.column.columnDef.meta?.align === 'right' && 'text-right', cell.column.columnDef.meta?.align === 'center' && 'text-center')}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

// React.memo erases the component's generic parameter (it would be inferred
// as RowData, breaking pages that pass typed ColumnDef arrays), so the memo
// result is re-cast to the original generic signature.
export const DataTable = React.memo(DataTableInner) as typeof DataTableInner
