import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { cn } from '../../lib/cn'

const CONTROL =
  'w-full rounded-md border bg-surface-input text-ink-primary placeholder:text-ink-muted ' +
  'transition-colors outline-none focus-visible:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

const controlSize = (size: 'sm' | 'md') => (size === 'sm' ? 'h-8 text-xs' : 'h-9 text-sm')
const borderFor = (invalid?: boolean) => (invalid ? 'border-danger' : 'border-surface-strong')

export interface FieldProps {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  /** id of the control; generated when omitted. */
  htmlFor?: string
  className?: string
  children: ReactNode
}

/** Label + control + hint/error, wired for screen readers. */
export function Field({ label, hint, error, required, htmlFor, className, children }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-xs font-medium text-ink-secondary">
          {label}
          {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p id={htmlFor ? `${htmlFor}-hint` : undefined} className="text-xs text-ink-muted">{hint}</p>
      ) : null}
    </div>
  )
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  size?: 'sm' | 'md'
  leftIcon?: ReactNode
  rightSlot?: ReactNode
  containerClassName?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, size = 'md', leftIcon, rightSlot, className, containerClassName, id, required, ...props },
  ref,
) {
  const autoId = useId()
  const inputId = id ?? autoId
  const control = (
    <div className="relative">
      {leftIcon && (
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted">{leftIcon}</span>
      )}
      <input
        ref={ref}
        id={inputId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
        className={cn(CONTROL, controlSize(size), borderFor(!!error), leftIcon ? 'pl-8' : 'pl-3', rightSlot ? 'pr-9' : 'pr-3', className)}
        {...props}
      />
      {rightSlot && <span className="absolute right-1 top-1/2 -translate-y-1/2">{rightSlot}</span>}
    </div>
  )
  if (!label && !hint && !error) return <div className={containerClassName}>{control}</div>
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={inputId} className={containerClassName}>
      {control}
    </Field>
  )
})

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  size?: 'sm' | 'md'
  containerClassName?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, size = 'md', className, containerClassName, id, children, required, ...props },
  ref,
) {
  const autoId = useId()
  const selectId = id ?? autoId
  const control = (
    <div className="relative">
      <select
        ref={ref}
        id={selectId}
        required={required}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, controlSize(size), borderFor(!!error), 'appearance-none pl-3 pr-8', className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown size={14} aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted" />
    </div>
  )
  if (!label && !hint && !error) return <div className={containerClassName}>{control}</div>
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={selectId} className={containerClassName}>
      {control}
    </Field>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  containerClassName?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, containerClassName, id, required, rows = 3, ...props },
  ref,
) {
  const autoId = useId()
  const areaId = id ?? autoId
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={areaId} className={containerClassName}>
      <textarea
        ref={ref}
        id={areaId}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, borderFor(!!error), 'px-3 py-2 text-sm leading-relaxed', className)}
        {...props}
      />
    </Field>
  )
})

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange' | 'value'> {
  value: string
  onChange: (value: string) => void
  size?: 'sm' | 'md'
  /** Accessible name; defaults to the placeholder. */
  label?: string
  containerClassName?: string
}

/** Search box with a clear button. Controlled: `value` + `onChange(string)`. */
export function SearchInput({
  value, onChange, size = 'md', placeholder = 'Search…', label, className, containerClassName, ...props
}: SearchInputProps) {
  return (
    <div className={cn('relative w-full sm:w-64', containerClassName)}>
      <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label ?? (typeof placeholder === 'string' ? placeholder : 'Search')}
        className={cn(CONTROL, controlSize(size), borderFor(false), 'pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden', className)}
        {...props}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-muted hover:bg-surface-elevated hover:text-ink-primary"
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
