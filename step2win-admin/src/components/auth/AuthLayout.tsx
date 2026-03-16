import type { ReactNode } from 'react';
import { AuthLeftPanel } from './AuthLeftPanel';
import { AuthRightPanel } from './AuthRightPanel';

interface AuthLayoutProps {
  mode: 'login' | 'register';
  children: ReactNode;
}

export function AuthLayout({ mode, children }: AuthLayoutProps) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: '#060810' }}>
      <div className="relative w-full max-w-5xl">
        <div
          className="absolute -inset-1 rounded-3xl opacity-30"
          style={{
            background: 'radial-gradient(ellipse at 30% 50%, #7C6FF7, transparent 60%)',
            filter: 'blur(24px)',
          }}
        />

        <div
          className="relative flex rounded-3xl overflow-hidden min-h-145"
          style={{
            background: '#0A0C12',
            border: '1px solid #1C1F2E',
            boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
          }}>
          <AuthLeftPanel mode={mode}>{children}</AuthLeftPanel>
          <AuthRightPanel />
        </div>
      </div>
    </div>
  );
}
