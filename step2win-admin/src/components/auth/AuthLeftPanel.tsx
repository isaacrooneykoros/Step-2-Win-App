import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AuthLogo } from './AuthLogo';

interface AuthLeftPanelProps {
  mode: 'login' | 'register';
  children: ReactNode;
}

export function AuthLeftPanel({ mode, children }: AuthLeftPanelProps) {
  return (
    <div
      className="w-105 shrink-0 flex flex-col justify-center px-10 py-12 relative z-10"
      style={{ background: '#0E1016', borderRight: '1px solid #1C1F2E' }}>
      <AuthLogo />

      <div
        className="inline-flex items-center rounded-xl p-1 mb-8"
        style={{ background: '#13161F', border: '1px solid #21263A' }}>
        <Link
          to="/login"
          className="px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
          style={{
            color: mode === 'login' ? '#F0F2F8' : '#7B82A0',
            background: mode === 'login' ? '#1C1F2E' : 'transparent',
          }}>
          Sign In
        </Link>
        <Link
          to="/register"
          className="px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
          style={{
            color: mode === 'register' ? '#F0F2F8' : '#7B82A0',
            background: mode === 'register' ? '#1C1F2E' : 'transparent',
          }}>
          Register
        </Link>
      </div>

      {children}
    </div>
  );
}
