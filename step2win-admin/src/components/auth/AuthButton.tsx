import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

interface AuthButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  children: ReactNode;
}

/** Full-width primary submit for auth forms. */
export function AuthButton({ loading, children, disabled, className, ...props }: AuthButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`flex h-10 w-full items-center justify-center gap-2 rounded-md bg-brand text-sm font-semibold text-brand-on transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ''}`}>
      {loading && <Loader2 size={15} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
