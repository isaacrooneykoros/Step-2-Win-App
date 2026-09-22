import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

interface AuthButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  children: ReactNode;
}

export function AuthButton({ loading, children, disabled, ...props }: AuthButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className="flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-bold text-white transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-60 hover:-translate-y-px hover:opacity-95 active:translate-y-0"
      style={{
        fontFamily: 'Syne, sans-serif',
        background: 'linear-gradient(135deg, #22C55E 0%, #4F9CF9 100%)',
        boxShadow: loading ? 'none' : '0 12px 30px rgba(34,197,94,0.22)',
        letterSpacing: 0,
      }}>
      {loading && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  );
}
