import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface TabItem<V extends string = string> {
  value: V
  label: ReactNode
  /** Optional count shown after the label (e.g. queue size). */
  count?: number
  disabled?: boolean
}

interface TabsProps<V extends string> {
  items: readonly TabItem<V>[]
  value: V
  onChange: (value: V) => void
  /** Accessible name for the tab list. */
  label: string
  /** `underline` for page sections, `segmented` for compact switches (periods, views). */
  variant?: 'underline' | 'segmented'
  size?: 'sm' | 'md'
  className?: string
  /** id prefix used to link tabs with panels: tab `${idPrefix}-tab-${value}`, panel `${idPrefix}-panel-${value}`. */
  idPrefix?: string
}

/**
 * Tabs (WAI-ARIA tablist). Arrow keys move between tabs, Home/End jump.
 * Render the matching panel yourself with role="tabpanel" and
 * aria-labelledby={`${idPrefix}-tab-${value}`} when you pass idPrefix.
 */
export function Tabs<V extends string>({
  items, value, onChange, label, variant = 'underline', size = 'md', className, idPrefix,
}: TabsProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const enabled = items.filter((i) => !i.disabled)

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const idx = enabled.findIndex((i) => i.value === value)
    let next = -1
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length
    else if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0) return
    e.preventDefault()
    const target = enabled[next]
    onChange(target.value)
    const domIdx = items.findIndex((i) => i.value === target.value)
    refs.current[domIdx]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        variant === 'underline'
          ? 'flex gap-4 overflow-x-auto border-b border-surface-border'
          : 'inline-flex rounded-md border border-surface-border bg-surface-sunken p-0.5',
        className,
      )}
    >
      {items.map((item, i) => {
        const selected = item.value === value
        return (
          <button
            key={item.value}
            ref={(el) => { refs.current[i] = el }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${item.value}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            onKeyDown={onKeyDown}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium transition-colors disabled:opacity-50',
              variant === 'underline'
                ? cn(
                    '-mb-px border-b-2 pb-2 pt-1',
                    size === 'sm' ? 'text-xs' : 'text-sm',
                    selected ? 'border-brand text-ink-primary' : 'border-transparent text-ink-muted hover:text-ink-primary',
                  )
                : cn(
                    'rounded px-2.5',
                    size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm',
                    selected ? 'bg-surface-card text-ink-primary shadow-card' : 'text-ink-muted hover:text-ink-primary',
                  ),
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <span
                className={cn(
                  'num rounded px-1.5 text-2xs font-semibold',
                  selected ? 'bg-brand-soft text-brand-text' : 'bg-surface-elevated text-ink-secondary',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Compact segmented switch — alias of Tabs with the segmented look. */
export function SegmentedControl<V extends string>(props: Omit<TabsProps<V>, 'variant'>) {
  return <Tabs {...props} variant="segmented" size={props.size ?? 'sm'} />
}
