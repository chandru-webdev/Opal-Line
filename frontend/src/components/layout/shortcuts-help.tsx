import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ACTION_SHORTCUTS, NAV_SHORTCUTS } from '@/lib/shortcuts'

function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] font-semibold text-foreground shadow-sm">
      {children}
    </kbd>
  )
}

function Row({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 py-2 last:border-0">
      <span className="text-sm text-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.split(' ').map((k, i) => (
          <Key key={i}>{k}</Key>
        ))}
      </span>
    </div>
  )
}

export function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>Work faster — press `?` anywhere to see this list.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Navigation — press g, then</p>
            {NAV_SHORTCUTS.map((s) => (
              <Row key={s.combo} keys={s.keys.replace('g ', '')} label={s.label} />
            ))}
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</p>
            {ACTION_SHORTCUTS.map((s) => (
              <Row key={s.combo} keys={s.keys} label={s.label} />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
