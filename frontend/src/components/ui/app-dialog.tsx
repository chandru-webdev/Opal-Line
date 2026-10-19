import type { ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  type DialogSize,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/**
 * The app's one dialog component. Use this instead of hand-rolling
 * `<DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">` at each
 * call site — sizing, spacing, mobile insets and scrolling are handled once
 * here and adapt to the content:
 *
 *   - short content (a confirm) → compact, content-sized box
 *   - long content (a form)    → body scrolls while header + footer stay put
 *   - phones                    → inset, rounded, dvh-based max height
 *
 * Title/description live in a fixed header, actions in a fixed footer; only
 * the body scrolls, so Save/Cancel are always reachable.
 *
 * ```tsx
 * <AppDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   size="2xl"
 *   title="Add Product"
 *   description="Create a product in the billing software."
 *   footer={<><Button …>Cancel</Button><Button …>Save</Button></>}
 * >
 *   …body…
 * </AppDialog>
 * ```
 */
export interface AppDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** Optional sub-text under the title. */
  description?: ReactNode
  /** Width preset; defaults to `md`. `className` still overrides everything. */
  size?: DialogSize
  /** Fixed action bar at the bottom (buttons, validation messages…). Omit for pure display dialogs. */
  footer?: ReactNode
  /** Scrollable body content. */
  children?: ReactNode
  /** Extra node in the title row (icon, status chip…). */
  titleAdornment?: ReactNode
  /** Hide the built-in × (e.g. when a destructive close needs confirming). */
  hideClose?: boolean
  className?: string
  bodyClassName?: string
  /** Extra classes for the fixed footer bar (e.g. `no-print` in print dialogs). */
  footerClassName?: string
}

export function AppDialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  footer,
  children,
  titleAdornment,
  hideClose,
  className,
  bodyClassName,
  footerClassName,
}: AppDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose={hideClose}
        size={size}
        className={cn(
          // flex column with a scrollable middle: header/footer never scroll
          // away, and the p-0/gap-0 overrides neutralise the primitive's
          // padding at both breakpoints (sections carry their own).
          'flex flex-col gap-0 overflow-hidden p-0 sm:gap-0 sm:p-0',
          className,
        )}
      >
        <DialogHeader className="shrink-0 border-b border-border/60 px-4 pb-3 pt-4 text-left sm:px-6 sm:pt-6">
          <DialogTitle className="flex items-center gap-2 pr-8">
            {titleAdornment}
            {title}
          </DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6', bodyClassName)}>{children}</div>

        {footer ? (
          <div className={cn('shrink-0 border-t border-border/60 px-4 pb-4 pt-3 sm:px-6 sm:pb-6', footerClassName)}>{footer}</div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
