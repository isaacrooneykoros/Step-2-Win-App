import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { authService } from '../services/api/auth';
import { useAuthStore } from '../store/authStore';

export function useLogin() {
  const setAuth = useAuthStore((state) => state.setAuth);
  const navigate = useNavigate();

  return useMutation({
    mutationFn: authService.login,
    onSuccess: (data) => {
      const user = {
        ...data.user,
        is_superuser: data.user.is_superuser ?? false,
      };
      if (!user.is_staff) {
        throw new Error('You do not have admin access.');
      }
      setAuth(data.access, data.refresh, user);
      navigate('/dashboard', { replace: true });
    },
  });
}

export function useRegister() {
  const setAuth = useAuthStore((state) => state.setAuth);
  const navigate = useNavigate();

  return useMutation({
    mutationFn: authService.register,
    onSuccess: (data) => {
      const user = {
        ...data.user,
        is_superuser: data.user.is_superuser ?? false,
      };
      if (!user.is_staff) {
        throw new Error('Account created but admin access not granted. Contact a superadmin.');
      }
      setAuth(data.access, data.refresh, user);
      navigate('/dashboard', { replace: true });
    },
  });
}

export function useLogout() {
  const clearAuth = useAuthStore((state) => state.clearAuth);
  const navigate = useNavigate();

  return () => {
    const refresh = localStorage.getItem('s2w_admin_refresh') ?? '';
    void authService.logout(refresh);
    clearAuth();
    navigate('/login', { replace: true });
  };
}
