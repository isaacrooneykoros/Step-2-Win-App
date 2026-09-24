import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'danger-soft';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  /** Text shown while loading. Defaults to the children. */
  loadingText?: string;
  /** Briefly show a confirmed state (e.g. "Saved"). */
  isSuccess?: boolean;
  successText?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-fg hover:bg-brand-hover active:bg-brand-active',
  secondary: 'bg-bg-input text-text-primary hover:bg-border',
  outline: 'border border-border bg-bg-card text-text-primary hover:bg-bg-input',
  ghost: 'bg-transparent text-text-primary hover:bg-bg-input',
  danger: 'bg-danger text-white hover:opacity-90',
  'danger-soft': 'bg-danger-soft text-danger hover:bg-danger/15',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-callout rounded-xl gap-1.5',
  md: 'h-11 px-5 text-body rounded-control gap-2',
  lg: 'h-[52px] px-6 text-body rounded-2xl gap-2',
};

/**
 * Primary action primitive. Handles loading, success and disabled states and keeps
 * a ≥44px touch target on md/lg.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    isLoading = false,
    loadingText,
    isSuccess = false,
    successText,
    leftIcon,
    rightIcon,
    fullWidth = false,
    children,
    disabled,
    className = '',
    type = 'button',
    ...props
  },
  ref,
) {
  const isDisabled = disabled || isLoading;
  const successTone = isSuccess ? '!bg-success !text-white' : '';

  return (
    <button
      ref={ref}
      type={type}
      className={[
        'inline-flex select-none items-center justify-center whitespace-nowrap font-semibold',
        'disabled:cursor-not-allowed disabled:!bg-bg-input disabled:!text-text-muted disabled:!border-transparent',
        variantClasses[variant],
        sizeClasses[size],
        fullWidth ? 'w-full' : '',
        successTone,
        className,
      ].join(' ')}
      disabled={isDisabled}
      aria-busy={isLoading || undefined}
      {...props}
    >
      {isLoading ? (
        <>
          <Spinner size={size === 'sm' ? 14 : 16} />
          <span>{loadingText ?? children}</span>
        </>
      ) : isSuccess ? (
        <>
          <Check size={size === 'sm' ? 14 : 18} strokeWidth={2.5} aria-hidden />
          <span>{successText ?? children}</span>
        </>
      ) : (
        <>
          {leftIcon}
          {children}
          {rightIcon}
        </>
      )}
    </button>
  );
});

export default Button;
export { Button };
