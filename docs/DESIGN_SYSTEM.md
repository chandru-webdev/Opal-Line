# DESIGN_SYSTEM.md — UI/UX Design System

## UI Framework & Styling Technology

| Aspect | Detail |
|---|---|
| **UI framework** | React 19.3.1 |
| **Styling** | Tailwind CSS 4.3.3 (CSS-first, no `tailwind.config.js`) |
| **Theme source** | `frontend/src/theme.css` — `@theme` CSS block with CSS custom properties (tokens) |
| **Dark mode** | `class` based: `<html class="dark">` toggled via theme toggle in AppShell; `@custom-variant dark (&:where(.dark, .dark *))` |
| **CSS reset/preflight** | Tailwind `@tailwind base;` + `@tailwind components;` + `@tailwind utilities;` (via PostCSS) |
| **PostCSS plugin** | `@tailwindcss/postcss` (v4 replaces `tailwindcss` + `autoprefixer` pair) |
| **CSS variables** | Defined in `frontend/src/theme.css`; read by Tailwind via `@theme` block; exposed as `var(--token-name)` |
| **Component library** | @radix-ui/react-* ( primitives: Dialog, DropdownMenu, Table, Input, Button, Switch, Slider, Tooltip, SwitchRoot, Separator, Sheet, Progress, Popover, Collapse, Alert, Progress, RadioGroup, CheckboxGroup, Sheet, Tooltip, TreeView) + lucide-react for icons |
| **Custom components** | Built on top of Radix primitives + Tailwind utilities; no separate design system repo |
| **Responsive breakpoints** | Tailwind v4 default + project overrides in `theme.css` |
| **CSS-first theme** | All tokens in `theme.css` as `--token-name` variables; Tailwind reads these via `@theme` block |

### Theme CSS Structure (`frontend/src/theme.css`)

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* =========================================================
   CSS Tokens — these are the design system's single source of truth
   ========================================================= */

/* Color palette */
:root {
  --color-primary: #18181b;
  --color-primary-foreground: #fafafa;
  --color-secondary: #e5e5e7;
  --color-secondary-foreground: #18181b;
  --color-accent: #005fcc;
  --color-success: #22c55e;
  --color-warning: #eab308;
  --color-error: #ef4444;
  --color-muted: #737373;
  --color-muted-foreground: #a3a3a3;
}

/* Light mode */
html:not(.dark) {
  --background: #ffffff;
  --foreground: #18181b;
  --card: #ffffff;
  --card-foreground: #18181b;
  --popover: #ffffff;
  --popover-foreground: #18181b;
}

/* Dark mode */
html.dark {
  --background: #0a0a0f;
  --foreground: #fafafa;
  --card: #18181b;
  --card-foreground: #fafafa;
  --popover: #18181b;
  --popover-foreground: #fafafa;
}

/* Typography */
:root {
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Noto Sans", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --font-size-xs: 0.75rem;     /* 12px */
  --font-size-sm: 0.875rem;   /* 14px */
  --font-size-md: 1rem;        /* 16px */
  --font-size-lg: 1.125rem;   /* 18px */
  --font-size-xl: 1.25rem;    /* 20px */
  --font-size-2xl: 1.5rem;    /* 24px */
  --font-size-3xl: 1.875rem;  /* 30px */
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-bold: 700;
  --leading-relaxed: 1.625;
  --tracking-tight: -0.025em;
}

/* =========================================================
   Component Tokens
   ========================================================= */

/* Buttons */
.btn {
  @apply inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2;
}
.btn-primary {
  @apply btn bg-primary text-primary-foreground hover:bg-primary/90;
}
.btn-secondary {
  @apply btn bg-secondary text-secondary-foreground hover:bg-secondary/80;
}
.btn-danger {
  @apply btn bg-error text-error hover:bg-error/90;
}

/* Inputs */
.input {
  @apply block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2;
}

/* Cards */
.card {
  @apply rounded-lg border bg-card shadow-card text-card-foreground;
}

/* Modals / Dialogs */
.dialog {
  @apply fixed inset-0 z-50;
}
.dialog-content {
  @apply bg-card w-full max-w-lg rounded-lg p-6 shadow-lg;
}

/* Tables */
.table {
  @apply w-full rounded-md border-collapse;
}
.table th {
  @apply p-3 text-left text-sm font-medium text-muted-foreground border-b;
}
.table td {
  @apply p-3 text-sm text-foreground border-b align-middle;
}

/* Navigation */
.nav-link {
  @apply relative inline-flex items-center rounded-md px-2 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/10;
}
.nav-link.active {
  @apply bg-primary/10;
}

/* Accessibility */
.visually-hidden {
  @apply absolute w-1 h-1 overflow-hidden bg-transparent border-0 px-0 py-0:
  clip-path: inset(50%);
  clip: rect(0 0 0 0);
  white-space: nowrap;
  width: 1px;
  height: 1px;
}
```

### Color Palette (from `theme.css`)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-primary` | `#18181b` | `#18181b` | Main background, nav bars |
| `--color-primary-foreground` | `#fafafa` | `#fafafa` | Text on primary |
| `--color-secondary` | `#e5e5e7` | `#e5e5e7` | Surfaces, dividers |
| `--color-secondary-foreground` | `#18181b` | `#18181b` | Text on secondary |
| `--color-accent` | `#005fcc` | `#005fcc` | Primary actions, links |
| `--color-success` | `#22c55e` | `#22c55e` | Success states, save buttons |
| `--color-warning` | `#eab308` | `#eab308` | Warnings, caution UI |
| `--color-error` | `#ef4444` | `#ef4444` | Error states, delete buttons |
| `--color-muted` | `#737373` | `#737373` | Disabled text, secondary labels |
| `--color-muted-foreground` | `#a3a3a3` | `#a3a3a3` | Muted secondary text |

### Typography (from `theme.css`)

| Token | Value | Usage |
|---|---|---|
| `--font-size-sm` | `0.875rem` (14px) | Body text, captions |
| `--font-size-md` | `1rem` (16px) | Default paragraph text |
| `--font-size-lg` | `1.125rem` (18px) | Section headings |
| `--font-size-xl` | `1.25rem` (20px) | Page headings |
| `--font-size-2xl` | `1.5rem` (24px) | Dashboard KPI labels |
| `--font-size-3xl` | `1.875rem` (30px) | Page titles |
| `--leading-relaxed` | `1.625` | Line height for readability |
| `--tracking-tight` | `-0.025em` | Tighter lettering for headers |

### Spacing & Sizing

| Token | Value | Usage |
|---|---|---|
| `--space-1` | `0.25rem` (4px) | Tight padding/margin |
| `--space-2` | `0.5rem` (8px) | Standard spacing |
| `--space-3` | `0.75rem` (12px) | Card padding |
| `--space-4` | `1rem` (16px) | Component margin |
| `--space-6` | `1.5rem` (24px) | Section gap |
| `--space-8` | `2rem` (32px) | Large gap between sections |
| `--space-12` | `3rem` (48px) | Page-level margin |

### Breakpoints (Tailwind CSS v4)

| Breakpoint | CSS media query | Usage |
|---|---|---|
| `sm` | `@media (min-width: 640px)` | Small screens, mobile landscape |
| `md` | `@media (min-width: 768px)` | Tablets |
| `lg` | `@media (min-width: 1024px)` | Laptops, small desktops |
| `xl` | `@media (min-width: 1280px)` | Desktops |
| `2xl` | `@media (min-width: 1536px)` | Large desktops |

### Responsive Behavior

- **Mobile-first**: Base styles apply to all widths; breakpoints add enhancements
- **AppShell**: Sidebar collapses to hamburger menu below `md` (1024px)
- **Tables**: Horizontal scroll on mobile; stacked cell layout on narrow screens
- **Images**: `max-width: 100%; height: auto;` — never overflow container
- **Forms**: Full-width inputs on mobile; compact layout on lg+
- **Modals**: Open full-width; on small screens, `max-w-sm` applies

### Component Variants & Interaction States

| Component | Variants | States |
|---|---|---|
| **Button** | `primary`, `secondary`, `danger`, `link`, `ghost` | `default`, `hover`, `active`, `focus`, `disabled`, `loading` |
| **Input** | `default`, `error`, `success` | `default`, `focus`, `disabled`, `with-icon` |
| **Card** | `default`, `elevated`, `bordered` | `default`, `hover`, `selected` |
| **Table** | `default`, `compact`, `striped` | `default`, `hover-row`, `selected-row` |
| **Dialog/Modal** | `default`, `full-width`, `confirm` | `open`, `closing`, `closed` |
| **Navigation link** | `active`, `inactive`, `divider` | `hover`, `focus`, `active` |
| **Switch/Toggle** | `on`, `off`, `disabled` | `checked`, `unchecked`, `focus` |
| **Avatar** | `initials`, `image`, `group` | `hover`, `selected` |

### Accessibility Standards

| Area | Standard | Implementation |
|---|---|---|
| **WCAG compliance** | AA for color contrast | `scripts/check-palette.mjs` validates light + dark + print; all tokens meet AA |
| **Keyboard navigation** | All interactive elements reachable via Tab | Radix primitives handle focus management |
| **Focus indicators** | `focus-visible` rings via Tailwind | `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` |
| **ARIA labels** | Descriptive labels for form controls | `aria-label`, `aria-described-used` used where placeholder alone is unclear |
| **Screen reader** | Logical DOM order; meaningful link/text | Confirm/ToastHost announcements via React Context |
| **Color contrast** | Minimum 4.5:1 for normal text, 3:1 for large text | Verified via palette check script; `--color-primary` on `--color-primary-foreground` meets 8.5:1 |
| **Reduced motion** | Respect `prefers-reduced-motion` | Transition durations scaled; no auto-playing carousels |
| **Touch target minimum** | 44×44dp minimum | Button/padding sizes ensure >= 44px hit area |

### Design Tokens & CSS Variables

All design tokens are defined in `frontend/src/theme.css` as CSS custom properties (`.js` `var()`-compatible). The `@theme` block in the same file maps these to Tailwind's internal system.

```css
/* Example token usage */
:root {
  --primary: #18181b;
  --primary-foreground: #fafafa;
  --radius: 0.5rem;
}

/* Tailwind reads these via @theme */
@theme inline {
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --border-radius: var(--radius);
}
```

### Current UI Inconsistencies & Recommendations

| Issue | Current | Recommendation |
|---|---|---|
| **Button radius inconsistency** | Some buttons use `.5rem`, others `0.75rem` | Standardize on `--radius` token (currently `0.5rem`); update all via build codemod |
| **Input height variance** | `py-2` vs `py-3` used across forms | Enforce `py-2` + `--space-3` (`0.75rem`) vertical rhythm consistently |
| **Card shadow values** | `shadow-sm`, `shadow`, `shadow-lg` used | Define `shadow-card` token in `theme.css`; use consistently across card-like components |
| **Focus ring contrast** | Some focus rings use `var(--color-primary)` on light background | Ensure `focus-visible:ring-ring` references the correct token; verify contrast on dark mode |
| **Deprecated Tailwind v3 patterns** | Occasional `flex`/`grid` without `gap` | Migrate to Tailwind v4 `gap-y-6` etc.; the build still compiles but v4 syntax preferred |
| **Hardcoded color strings** | A few components use `#18181b` directly instead of `var(--color-primary)` | Replace with token references; run a codemod to find `color-primary` → `var(--color-primary)` |
| **Responsive-hidden patterns** | `hidden sm:block` used in some places | Standardize on `hidden sm:block` (consistent order) across codebase |
| **Dialog padding** | Some modals use `p-4`, others `p-6` | Standardize on `p-6` for content modals, `p-4` for small inline dialogs |
| **Text ellipsis** | Mixed `line-clamp-2` vs `-line-clamp-2` | Use `line-clamp-2` (no space) consistently; PostCSS/sorting handles it |