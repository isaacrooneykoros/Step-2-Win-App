import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, Lock, Mail } from 'lucide-react';
import { AuthLayout } from '../../components/auth/AuthLayout';
import { AuthInput } from '../../components/auth/AuthInput';
import { AuthButton } from '../../components/auth/AuthButton';
import { AuthDivider } from '../../components/auth/AuthDivider';
import { useLogin } from '../../hooks/useAuth';

interface LoginForm {
  username: string;
  password: string;
}

interface FormErrors {
  username?: string;
  password?: string;
  general?: string;
}

function classifyLoginError(error: unknown): string {
  const maybeError = error as {
    response?: { status?: number; data?: { error?: string; detail?: string } };
    message?: string;
  };

  const responseStatus = maybeError?.response?.status;
  const responseError = maybeError?.response?.data?.error ?? maybeError?.response?.data?.detail ?? '';
  const message = (maybeError?.message ?? '').toLowerCase();

  if (
    !maybeError?.response ||
    message.includes('network error') ||
    message.includes('failed to fetch') ||
    message.includes('cors') ||
    message.includes('timeout')
  ) {
    return 'Network/CORS issue: the app could not reach the backend. Check the Vercel and Render API settings.';
  }

  if (responseStatus === 401) {
    return 'Invalid username or password.';
  }

  if (responseStatus === 403) {
    return responseError || 'Admin access required.';
  }

  if (responseStatus === 429) {
    return responseError || 'Too many login attempts. Please wait and try again.';
  }

  if (responseError) {
    return responseError;
  }

  return maybeError?.message || 'Login failed. Please try again.';
}

export default function LoginPage() {
  const [form, setForm] = useState<LoginForm>({ username: '', password: '' });
  const [errors, setErrors] = useState<FormErrors>({});
  const [show, setShow] = useState(false);
  const loginMutation = useLogin();

  const validate = (): boolean => {
    const nextErrors: FormErrors = {};
    if (!form.username.trim()) {
      nextErrors.username = 'Username or email is required.';
    }
    if (!form.password) {
      nextErrors.password = 'Password is required.';
    } else if (form.password.length < 6) {
      nextErrors.password = 'Password must be at least 6 characters.';
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }

    setErrors({});
    loginMutation.mutate(
      { username: form.username.trim(), password: form.password },
      {
        onError: (error: unknown) => {
          setErrors({ general: classifyLoginError(error) });
        },
      }
    );
  };

  return (
    <AuthLayout mode="login">
      <h1 className="text-lg font-semibold text-ink-primary">Sign in</h1>
      <p className="mb-5 mt-1 text-sm text-ink-secondary">Use your staff account to open the console.</p>

      {errors.general && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5 text-sm text-danger">
          <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span>{errors.general}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <AuthInput
          label="Username or email"
          type="text"
          autoComplete="username"
          autoFocus
          value={form.username}
          onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
          error={errors.username}
          icon={<Mail size={15} />}
        />

        <AuthInput
          label="Password"
          type={show ? 'text' : 'password'}
          autoComplete="current-password"
          value={form.password}
          onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
          error={errors.password}
          icon={<Lock size={15} />}
          rightSlot={
            <button
              type="button"
              onClick={() => setShow((value) => !value)}
              aria-label={show ? 'Hide password' : 'Show password'}
              aria-pressed={show}
              className="flex h-8 items-center gap-1 rounded px-2 text-xs font-medium text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary">
              {show ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
              {show ? 'Hide' : 'Show'}
            </button>
          }
        />

        <AuthButton type="submit" loading={loginMutation.isPending} className="mt-1">
          {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
        </AuthButton>
      </form>

      <AuthDivider label="First time here?" />

      <p className="text-center text-sm text-ink-secondary">
        <Link to="/register" className="font-medium text-brand-text hover:underline">
          Set up an admin account
        </Link>{' '}
        <span className="text-ink-muted">with a registration code</span>
      </p>
    </AuthLayout>
  );
}
