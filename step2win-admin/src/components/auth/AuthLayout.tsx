import type { ReactNode } from 'react';
import { AuthLeftPanel } from './AuthLeftPanel';
import { AuthRightPanel } from './AuthRightPanel';

interface AuthLayoutProps {
  mode: 'login' | 'register';
  children: ReactNode;
}

export function AuthLayout({ mode, children }: AuthLayoutProps) {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-6 sm:px-6 lg:px-8"
      style={{
        background:
          'linear-gradient(135deg, #060810 0%, #0A0C12 48%, #08120F 100%)',
      }}>
      <div className="relative w-full max-w-6xl">
        <div
          className="absolute -inset-px rounded-[22px] opacity-70"
          style={{
            background:
              'linear-gradient(135deg, rgba(34,211,160,0.35), rgba(79,156,249,0.18) 42%, rgba(245,166,35,0.18))',
          }}
        />

        <div
          className="relative flex flex-col overflow-hidden rounded-[20px] lg:min-h-[680px] lg:flex-row"
          style={{
            background: '#0A0C12',
            border: '1px solid #1C1F2E',
            boxShadow: '0 28px 90px rgba(0,0,0,0.58)',
          }}>
          <AuthLeftPanel mode={mode}>{children}</AuthLeftPanel>
          <AuthRightPanel />
        </div>
      </div>
    </div>
  );
}
