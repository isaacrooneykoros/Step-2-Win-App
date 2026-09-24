import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  /** Replaces the label while loading, e.g. "Approving…". */
  loadingText?: ReactNode
  leftIcon?: ReactNode
  rightIcon?: ReactNode
  fullWidth?: boolean
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-brand text-brand-on hover:bg-brand-hover border border-transparent',
  secondary:
    'bg-surface-card text-ink-primary border border-surface-strong hover:bg-surface-elevated',
  ghost:
    'bg-transparent text-ink-secondary border border-transparent hover:bg-surface-elevated hover:text-ink-primary',
  danger:
    'bg-danger-fill text-white border border-transparent hover:brightness-95',
  'danger-soft':
    'bg-danger-soft text-danger border border-danger-line hover:brightness-[0.98]',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
}

/**
 * Button. One primary per view region; destructive actions use `danger` and
 * always go through ConfirmModal.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, loadingText, leftIcon, rightIcon, fullWidth, className, children, disabled, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-55',
        VARIANT[variant],
        SIZE[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 size={size === 'sm' ? 13 : 15} className="animate-spin" aria-hidden /> : leftIcon}
      {loading && loadingText ? loadingText : children}
      {!loading && rightIcon}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only buttons must have an accessible name. */
  label: string
  size?: ButtonSize
  variant?: 'ghost' | 'secondary'
  children: ReactNode
}

/** Square icon-only button with a required accessible label. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', className, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50',
        size === 'sm' ? 'h-8 w-8' : 'h-9 w-9',
        variant === 'ghost'
          ? 'text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary'
          : 'border border-surface-strong bg-surface-card text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
})
