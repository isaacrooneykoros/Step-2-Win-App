import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  User,
  XCircle,
} from 'lucide-react';
import { AuthLayout } from '../../components/auth/AuthLayout';
import { AuthInput } from '../../components/auth/AuthInput';
import { AuthButton } from '../../components/auth/AuthButton';
import { useRegister } from '../../hooks/useAuth';

interface RegisterForm {
  username: string;
  email: string;
  password: string;
  confirm_password: string;
  admin_code: string;
}

interface FormErrors {
  username?: string;
  email?: string;
  password?: string;
  confirm_password?: string;
  admin_code?: string;
  general?: string;
}

type PasswordRule = {
  label: string;
  passed: boolean;
};

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getPasswordRules(password: string): PasswordRule[] {
  return [
    { label: '12+ characters', passed: password.length >= 12 },
    { label: 'Upper and lower case', passed: /[A-Z]/.test(password) && /[a-z]/.test(password) },
    { label: 'Number included', passed: /[0-9]/.test(password) },
    { label: 'Symbol included', passed: /[^A-Za-z0-9]/.test(password) },
  ];
}

function getPasswordStrength(password: string): { label: string; color: string; width: string } {
  if (password.length === 0) {
    return { label: '', color: 'var(--border)', width: '0%' };
  }
  const passedRules = getPasswordRules(password).filter((rule) => rule.passed).length;
  if (passedRules <= 1) {
    return { label: 'Weak', color: 'var(--danger)', width: '25%' };
  }
  if (passedRules === 2) {
    return { label: 'Fair', color: 'var(--warning)', width: '50%' };
  }
  if (passedRules === 3) {
    return { label: 'Good', color: 'var(--info)', width: '75%' };
  }
  return { label: 'Strong', color: 'var(--success)', width: '100%' };
}

function getApiFieldMessage(value: string[] | string | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : undefined;
}

function classifyRegistrationError(error: unknown): FormErrors {
  const maybeError = error as {
    response?: { status?: number; data?: Record<string, string[] | string> };
    message?: string;
  };

  const data = maybeError.response?.data;
  if (data && typeof data === 'object') {
    const mapped: FormErrors = {
      username: getApiFieldMessage(data.username),
      email: getApiFieldMessage(data.email),
      password: getApiFieldMessage(data.password),
      confirm_password: getApiFieldMessage(data.confirm_password),
      admin_code: getApiFieldMessage(data.admin_code),
      general:
        getApiFieldMessage(data.non_field_errors) ??
        getApiFieldMessage(data.detail) ??
        getApiFieldMessage(data.error),
    };

    const general = (mapped.general ?? '').toLowerCase();
    if (general.includes('admin registration code')) {
      mapped.admin_code = mapped.general;
      mapped.general = undefined;
    }
    if (general.includes('password')) {
      mapped.password = mapped.general;
      mapped.general = undefined;
    }
    if (general.includes('username')) {
      mapped.username = mapped.general;
      mapped.general = undefined;
    }
    if (general.includes('email')) {
      mapped.email = mapped.general;
      mapped.general = undefined;
    }

    return mapped.general ||
      mapped.username ||
      mapped.email ||
      mapped.password ||
      mapped.confirm_password ||
      mapped.admin_code
      ? mapped
      : { general: 'Registration failed. Review the form and try again.' };
  }

  const message = (maybeError?.message ?? '').toLowerCase();
  if (
    !maybeError?.response ||
    message.includes('network error') ||
    message.includes('failed to fetch') ||
    message.includes('cors') ||
    message.includes('timeout')
  ) {
    return {
      general: 'Network/CORS issue: the admin app could not reach the backend. Check API configuration and try again.',
    };
  }

  if (maybeError.response?.status === 429) {
    return { general: 'Another admin registration is in progress. Wait a moment and try again.' };
  }

  return { general: maybeError.message ?? 'Registration failed. Try again.' };
}

export default function RegisterPage() {
  const [form, setForm] = useState<RegisterForm>({
    username: '',
    email: '',
    password: '',
    confirm_password: '',
    admin_code: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [show, setShow] = useState(false);

  const registerMutation = useRegister();
  const strength = getPasswordStrength(form.password);
  const passwordRules = getPasswordRules(form.password);

  const updateField =
    (field: keyof RegisterForm) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const value = event.target.value;
      setForm((prev) => ({ ...prev, [field]: value }));
      setErrors((prev) => ({ ...prev, [field]: undefined, general: undefined }));
    };

  const validate = (): boolean => {
    const nextErrors: FormErrors = {};
    const trimmedUsername = form.username.trim();
    const trimmedEmail = form.email.trim();

    if (!trimmedUsername) {
      nextErrors.username = 'Username is required.';
    } else if (trimmedUsername.length < 3) {
      nextErrors.username = 'Username must be at least 3 characters.';
    } else if (trimmedUsername.length > 150) {
      nextErrors.username = 'Username must be 150 characters or fewer.';
    } else if (!/^[a-zA-Z0-9_-]+$/.test(trimmedUsername)) {
      nextErrors.username = 'Only letters, numbers, underscores and hyphens allowed.';
    }

    if (!trimmedEmail) {
      nextErrors.email = 'Email is required.';
    } else if (!validateEmail(trimmedEmail)) {
      nextErrors.email = 'Enter a valid email address.';
    }

    if (!form.password) {
      nextErrors.password = 'Password is required.';
    } else if (passwordRules.some((rule) => !rule.passed)) {
      nextErrors.password = 'Use 12+ characters with upper/lowercase letters, a number and a symbol.';
    }

    if (!form.confirm_password) {
      nextErrors.confirm_password = 'Please confirm your password.';
    } else if (form.password !== form.confirm_password) {
      nextErrors.confirm_password = 'Passwords do not match.';
    }

    if (!form.admin_code.trim()) {
      nextErrors.admin_code = 'Admin registration code is required.';
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
    registerMutation.mutate(
      {
        username: form.username.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
        confirm_password: form.confirm_password,
        admin_code: form.admin_code.trim(),
      },
      {
        onError: (error: unknown) => {
          setErrors(classifyRegistrationError(error));
        },
      }
    );
  };

  return (
    <AuthLayout mode="register">
      <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand-text">
        <ShieldCheck size={14} aria-hidden />
        First admin setup
      </p>
      <h1 className="text-lg font-semibold text-ink-primary">Create an admin account</h1>
      <p className="mb-5 mt-1 text-sm text-ink-secondary">
        Requires the one-time registration code issued by a superuser.
      </p>

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
          label="Username"
          type="text"
          autoComplete="username"
          autoFocus
          value={form.username}
          onChange={updateField('username')}
          error={errors.username}
          icon={<User size={15} />}
        />

        <AuthInput
          label="Email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={updateField('email')}
          error={errors.email}
          icon={<Mail size={15} />}
        />

        <AuthInput
          label="Password"
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          value={form.password}
          onChange={updateField('password')}
          error={errors.password}
          icon={<Lock size={15} />}
          rightSlot={
            <button
              type="button"
              onClick={() => setShow((value) => !value)}
              aria-label={show ? 'Hide passwords' : 'Show passwords'}
              aria-pressed={show}
              className="flex h-8 items-center gap-1 rounded px-2 text-xs font-medium text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary">
              {show ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
              {show ? 'Hide' : 'Show'}
            </button>
          }
        />

        {form.password.length > 0 && (
          <div className="-mt-2 mb-4" aria-live="polite">
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="text-ink-muted">Password strength</span>
              <span className="font-medium" style={{ color: strength.color }}>
                {strength.label}
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-surface-elevated">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: strength.width, background: strength.color }}
              />
            </div>
            <ul className="mt-2.5 grid grid-cols-1 gap-1 sm:grid-cols-2">
              {passwordRules.map((rule) => (
                <li
                  key={rule.label}
                  className={`flex items-center gap-1.5 text-xs ${rule.passed ? 'text-success' : 'text-ink-muted'}`}>
                  {rule.passed ? <CheckCircle2 size={12} aria-hidden /> : <XCircle size={12} aria-hidden />}
                  {rule.label}
                  <span className="sr-only">{rule.passed ? '(met)' : '(not met)'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <AuthInput
          label="Confirm password"
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          value={form.confirm_password}
          onChange={updateField('confirm_password')}
          error={errors.confirm_password}
          icon={<Lock size={15} />}
        />

        <AuthInput
          label="Registration code"
          type="text"
          autoComplete="one-time-code"
          value={form.admin_code}
          onChange={updateField('admin_code')}
          error={errors.admin_code}
          icon={<KeyRound size={15} />}
          hint="One-time setup only. The code is never stored in the browser."
          className="mono"
        />

        <AuthButton type="submit" loading={registerMutation.isPending} className="mt-1">
          {registerMutation.isPending ? 'Creating account…' : 'Create admin account'}
        </AuthButton>
      </form>

      <p className="mt-5 text-center text-sm text-ink-secondary">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-brand-text hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
