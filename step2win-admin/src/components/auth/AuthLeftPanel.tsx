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
      className="relative z-10 flex w-full shrink-0 flex-col px-5 py-7 sm:px-8 sm:py-10 lg:w-[440px] lg:justify-center lg:px-10 lg:py-12"
      style={{
        background: 'linear-gradient(180deg, #10131A 0%, #0C0F15 100%)',
        borderRight: '1px solid #1C1F2E',
      }}>
      <AuthLogo />

      <div
        className="mb-8 grid grid-cols-2 rounded-xl p-1"
        style={{ background: '#13161F', border: '1px solid #21263A' }}>
        <Link
          to="/login"
          className="rounded-lg px-4 py-2 text-center text-xs font-semibold transition-colors"
          style={{
            color: mode === 'login' ? '#F0F2F8' : '#7B82A0',
            background: mode === 'login' ? '#202536' : 'transparent',
          }}>
          Sign In
        </Link>
        <Link
          to="/register"
          className="rounded-lg px-4 py-2 text-center text-xs font-semibold transition-colors"
          style={{
            color: mode === 'register' ? '#F0F2F8' : '#7B82A0',
            background: mode === 'register' ? '#202536' : 'transparent',
          }}>
          Register
        </Link>
      </div>

      {children}
    </div>
  );
}
