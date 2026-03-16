import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';

export function ProtectedRoute() {
  const { accessToken, user, isHydrated } = useAuthStore();

  if (!isHydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#060810' }}>
        <div className="flex flex-col items-center gap-4">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #7C6FF7, #4F9CF9)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M13 4C13 4 15 7 15 10C15 13 13 15 10 16C9 16.3 8 17 8 18C8 19 9 20 11 20C13 20 15 19 17 17"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="8" cy="10" r="2" fill="white" />
            </svg>
          </div>
          <div
            className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#7C6FF7', borderTopColor: 'transparent' }}
          />
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
