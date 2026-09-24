import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { authService } from '../../services/api';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { useToast } from '../ui/Toast';
import { apiErrorMessage } from './apiError';

interface PasswordSheetProps {
  open: boolean;
  onClose: () => void;
}

const EMPTY = { current_password: '', new_password: '', confirm_password: '' };

export function PasswordSheet({ open, onClose }: PasswordSheetProps) {
  const { showToast } = useToast();
  const [form, setForm] = useState(EMPTY);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: (data: { old_password: string; new_password: string; confirm_password: string }) => authService.changePassword(data),
    onSuccess: () => {
      setSaved(true);
      showToast({ message: 'Password updated.', type: 'success' });
      window.setTimeout(() => {
        setSaved(false);
        setForm(EMPTY);
        onClose();
      }, 900);
    },
    onError: (err: unknown) => {
      setError(apiErrorMessage(err, 'We couldn’t change your password. Check your current password and try again.'));
    },
  });

  const close = () => {
    if (mutation.isPending) return;
    setForm(EMPTY);
    setError(null);
    onClose();
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    if (!form.current_password) {
      setError('Enter your current password.');
      return;
    }
    if (form.new_password.length < 6) {
      setError('Your new password must be at least 6 characters.');
      return;
    }
    if (form.new_password !== form.confirm_password) {
      setError('The new passwords don’t match.');
      return;
    }
    mutation.mutate({
      old_password: form.current_password,
      new_password: form.new_password,
      confirm_password: form.confirm_password,
    });
  };

  const type = reveal ? 'text' : 'password';
  const toggle = (
    <button
      type="button"
      onClick={() => setReveal((v) => !v)}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full text-text-muted hover:bg-bg-input"
      aria-label={reveal ? 'Hide passwords' : 'Show passwords'}
      aria-pressed={reveal}
    >
      {reveal ? <EyeOff size={18} /> : <Eye size={18} />}
    </button>
  );

  return (
    <Sheet
      open={open}
      onClose={close}
      dismissible={!mutation.isPending}
      title="Change password"
      description="Use at least 6 characters. Other devices stay signed in until you log them out."
      footer={
        <div className="flex gap-3 pb-3">
          <Button variant="secondary" fullWidth onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            fullWidth
            onClick={() => submit()}
            isLoading={mutation.isPending}
            loadingText="Updating"
            isSuccess={saved}
            successText="Updated"
          >
            Update password
          </Button>
        </div>
      }
    >
      <form onSubmit={submit} noValidate>
        <Input
          label="Current password"
          type={type}
          autoComplete="current-password"
          value={form.current_password}
          onChange={(e) => setForm({ ...form, current_password: e.target.value })}
          trailing={toggle}
        />
        <Input
          label="New password"
          type={type}
          autoComplete="new-password"
          value={form.new_password}
          onChange={(e) => setForm({ ...form, new_password: e.target.value })}
        />
        <Input
          label="Confirm new password"
          type={type}
          autoComplete="new-password"
          value={form.confirm_password}
          onChange={(e) => setForm({ ...form, confirm_password: e.target.value })}
          error={error ?? undefined}
          containerClassName="!mb-0"
        />
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Sheet>
  );
}

export default PasswordSheet;
