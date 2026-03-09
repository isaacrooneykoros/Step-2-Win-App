import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { adminApi } from '../services/adminApi';

export function AdminRouteGuard() {
  const location = useLocation();
  const [isChecking, setIsChecking] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);

  useEffect(() => {
    let isMounted = true;

    if (!localStorage.getItem('admin_jwt')) {
      setIsAuthorized(false);
      setIsChecking(false);
      return () => {
        isMounted = false;
      };
    }

    const checkAccess = async () => {
      setIsChecking(true);

      try {
        await adminApi.getOverview();
        if (!isMounted) {
          return;
        }
        setIsAuthorized(true);
      } catch (error) {
        if (!isMounted) {
          return;
        }
        adminApi.clearAuthSession();
        setIsAuthorized(false);
      } finally {
        if (isMounted) {
          setIsChecking(false);
        }
      }
    };

    checkAccess();

    return () => {
      isMounted = false;
    };
  }, []);

  if (isChecking) {
    return <p>Checking admin access...</p>;
  }

  if (!isAuthorized) {
    return <Navigate to="/auth/login" state={{ from: location.pathname }} replace />;
  }

  return <Outlet />;
}