import { Navigate, Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { BrandMark } from '../BrandMark';

export function ProtectedRoute() {
  const { accessToken, user, isHydrated } = useAuthStore();

  if (!isHydrated) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-base" role="status" aria-live="polite">
        <div className="flex flex-col items-center gap-3 text-ink-muted">
          <BrandMark size={32} />
          <p className="flex items-center gap-2 text-xs">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            Restoring session…
          </p>
        </div>
      </div>
    );
  }

  if (!accessToken || !user) {
    return <Navigate to="/login" replace />;
  }

  if (!user.is_staff) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
