import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { App as CapacitorApp } from '@capacitor/app';
import { Fingerprint, LogOut } from 'lucide-react';
import { BrandMark } from '../brand/BrandMark';
import Button from '../ui/Button';
import { useAuthStore } from '../../store/authStore';
import { isLockEnabled, unlockApp, useLockStore } from '../../lib/biometricLock';
import { pushBackHandler } from '../../lib/backButton';
import { isIOSApp } from '../../utils/platform';

/**
 * Full-screen lock shown over the app while the biometric lock is engaged. The app behind is
 * made inert (not focusable / clickable / announced) and fully covered.
 */
export function BiometricLockGate() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logout = useAuthStore((s) => s.logout);
  const { locked, authenticating, error, lockId } = useLockStore();
  const navigate = useNavigate();
  const active = locked && isAuthenticated && isLockEnabled();

  // Hide + disable everything behind the lock.
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root || !active) return;
    root.setAttribute('inert', '');
    root.setAttribute('aria-hidden', 'true');
    return () => {
      root.removeAttribute('inert');
      root.removeAttribute('aria-hidden');
    };
  }, [active]);

  // Auto-prompt once per lock (not again after a cancel — that would trap the user in a loop).
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void unlockApp(), 350);
    return () => window.clearTimeout(timer);
  }, [active, lockId]);

  // Back while locked sends the app to the background instead of navigating underneath.
  useEffect(() => {
    if (!active) return;
    return pushBackHandler(() => {
      CapacitorApp.minimizeApp().catch(() => null);
      return true;
    });
  }, [active]);

  if (!active) return null;

  const onLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-lock-title"
      aria-describedby="app-lock-desc"
      className="fixed inset-0 z-[200] flex flex-col bg-bg-page px-6 pt-safe pb-safe"
    >
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <BrandMark size={64} />
        <h1 id="app-lock-title" className="mt-6 text-title text-text-primary">
          Step2Win is locked
        </h1>
        <p id="app-lock-desc" className="mt-2 max-w-xs text-callout text-text-secondary">
          {isIOSApp()
            ? 'Unlock with Face ID, Touch ID or your iPhone passcode.'
            : 'Unlock with your fingerprint, face or your phone’s screen lock PIN.'}
        </p>
        <p role="alert" className="mt-4 min-h-[20px] text-callout font-medium text-danger">
          {error ?? ''}
        </p>
      </div>
      <div className="mx-auto w-full max-w-sm space-y-2 pb-4">
        <Button
          fullWidth
          size="lg"
          leftIcon={<Fingerprint size={20} aria-hidden />}
          onClick={() => void unlockApp()}
          isLoading={authenticating}
          loadingText="Waiting for you…"
        >
          {error ? 'Try again' : 'Unlock'}
        </Button>
        <Button fullWidth variant="ghost" leftIcon={<LogOut size={18} aria-hidden />} onClick={() => void onLogout()} disabled={authenticating}>
          Log out instead
        </Button>
      </div>
    </div>,
    document.body,
  );
}

export default BiometricLockGate;
