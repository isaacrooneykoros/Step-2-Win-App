import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { AuthLogo } from './AuthLogo';
import { ThemeToggle } from '../ThemeToggle';
import { API_BASE } from '../../config/network';

interface AuthLayoutProps {
  /** Kept for compatibility; both modes share one calm layout. */
  mode: 'login' | 'register';
  children: ReactNode;
}

function apiHost(): string {
  try {
    return new URL(API_BASE).host;
  } catch {
    return API_BASE;
  }
}

/**
 * Sign-in shell: one centred card on the page background, the environment the
 * console is connected to, and nothing else. No marketing, no sample data.
 */
export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-base">
      <div className="flex justify-end p-3">
        <ThemeToggle />
      </div>
      <main className="flex flex-1 items-start justify-center px-4 pb-10 pt-[6vh] sm:items-center sm:pt-0">
        <div className="w-full max-w-[400px]">
          <AuthLogo />
          <div className="rounded-lg border border-surface-border bg-surface-card p-6 shadow-card sm:p-7">{children}</div>
          <div className="mt-4 space-y-1 text-center text-xs text-ink-muted">
            <p className="flex items-center justify-center gap-1.5">
              <Lock size={12} aria-hidden />
              Restricted to authorised Step2Win staff.
            </p>
            <p>
              Connected to <span className="mono text-ink-secondary">{apiHost()}</span>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
