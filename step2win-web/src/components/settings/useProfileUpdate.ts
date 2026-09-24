import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authService } from '../../services/api';
import type { User } from '../../types';
import { useToast } from '../ui/Toast';
import { apiErrorMessage } from './apiError';

/**
 * Partial profile update (PUT /api/auth/profile/ is a partial update on the backend).
 * Shows a brief success state before `onDone` so the Button can confirm the save.
 */
export function useProfileUpdate(options: { successMessage: string; onDone?: () => void }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (data: Partial<User>) => authService.updateProfile(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      setSaved(true);
      showToast({ message: options.successMessage, type: 'success' });
      window.setTimeout(() => {
        setSaved(false);
        options.onDone?.();
      }, 800);
    },
    onError: (err: unknown) => {
      setError(apiErrorMessage(err, 'We couldn’t save your changes. Please try again.'));
    },
  });

  return {
    save: (data: Partial<User>) => {
      setError(null);
      mutation.mutate(data);
    },
    isSaving: mutation.isPending,
    saved,
    error,
    setError,
  };
}
