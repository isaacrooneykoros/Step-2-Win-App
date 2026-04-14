import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Lock } from 'lucide-react';
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
      <h1
        className="text-3xl font-extrabold mb-1.5 leading-tight"
        style={{ fontFamily: 'Syne, sans-serif', color: '#F0F2F8', letterSpacing: '-0.5px' }}>
        Welcome back
      </h1>
      <p className="text-sm mb-8 leading-relaxed" style={{ color: '#7B82A0' }}>
        Sign in to your admin account to continue
      </p>

      {errors.general && (
        <div
          className="flex items-center gap-2.5 px-4 py-3 rounded-xl mb-5 text-sm"
          style={{
            background: 'rgba(240,96,96,0.1)',
            border: '1px solid rgba(240,96,96,0.2)',
            color: '#F06060',
          }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="#F06060" strokeWidth="1.5" />
            <path d="M12 8v4m0 4h.01" stroke="#F06060" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {errors.general}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <AuthInput
          type="text"
          placeholder="Username or email"
          autoComplete="username"
          autoFocus
          value={form.username}
          onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
          error={errors.username}
          icon={<Mail size={15} color="#7B82A0" />}
        />

        <div className="relative">
          <AuthInput
            type={show ? 'text' : 'password'}
            placeholder="Password"
            autoComplete="current-password"
            value={form.password}
            onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
            error={errors.password}
            icon={<Lock size={15} color="#7B82A0" />}
          />
          <button
            type="button"
            onClick={() => setShow((value) => !value)}
            className="absolute right-3.5 top-3.5 text-xs transition-colors"
            style={{ color: '#3D4260' }}
            onMouseEnter={(event) => {
              event.currentTarget.style.color = '#7B82A0';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.color = '#3D4260';
            }}>
            {show ? 'Hide' : 'Show'}
          </button>
        </div>

        <div className="text-right -mt-2 mb-5">
          <span className="text-xs" style={{ color: '#3D4260' }}>
            Admin access only
          </span>
        </div>

        <AuthButton type="submit" loading={loginMutation.isPending}>
          {loginMutation.isPending ? 'Signing in...' : 'Sign In to Dashboard'}
        </AuthButton>
      </form>

      <AuthDivider label="Authorized personnel only" />

      <p className="text-center text-sm" style={{ color: '#7B82A0' }}>
        Don&apos;t have an account?{' '}
        <Link to="/register" className="font-semibold transition-colors" style={{ color: '#7C6FF7' }}>
          Request access
        </Link>
      </p>
    </AuthLayout>
  );
}
