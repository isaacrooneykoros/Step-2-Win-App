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
      className="w-full py-3.5 rounded-xl font-bold text-sm text-white transition-all duration-150 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed hover:opacity-90 hover:-translate-y-px active:translate-y-0"
      style={{
        fontFamily: 'Syne, sans-serif',
        background: 'linear-gradient(135deg, #7C6FF7 0%, #4F9CF9 100%)',
        boxShadow: loading ? 'none' : '0 4px 14px rgba(124,111,247,0.3)',
        letterSpacing: '0.2px',
      }}>
      {loading && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  );
}
