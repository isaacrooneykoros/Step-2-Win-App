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
    return { label: '', color: '#21263A', width: '0%' };
  }
  const passedRules = getPasswordRules(password).filter((rule) => rule.passed).length;
  if (passedRules <= 1) {
    return { label: 'Weak', color: '#F06060', width: '25%' };
  }
  if (passedRules === 2) {
    return { label: 'Fair', color: '#F5A623', width: '50%' };
  }
  if (passedRules === 3) {
    return { label: 'Good', color: '#4F9CF9', width: '75%' };
  }
  return { label: 'Strong', color: '#22D3A0', width: '100%' };
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
      <div
        className="mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold"
        style={{
          background: 'rgba(34,211,160,0.12)',
          border: '1px solid rgba(34,211,160,0.22)',
          color: '#22D3A0',
        }}>
        <ShieldCheck size={14} />
        First admin setup
      </div>

      <h1
        className="mb-2 text-3xl font-extrabold leading-tight sm:text-[34px]"
        style={{ fontFamily: 'Syne, sans-serif', color: '#F0F2F8', letterSpacing: 0 }}>
        Secure admin access
      </h1>
      <p className="mb-7 text-sm leading-relaxed" style={{ color: '#8B93AD' }}>
        Create the first Step2Win operator account with a verified setup code.
      </p>

      {errors.general && (
        <div
          className="mb-5 flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm"
          style={{
            background: 'rgba(240,96,96,0.1)',
            border: '1px solid rgba(240,96,96,0.2)',
            color: '#F06060',
          }}>
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{errors.general}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <AuthInput
          type="text"
          placeholder="Username"
          autoComplete="username"
          autoFocus
          value={form.username}
          onChange={updateField('username')}
          error={errors.username}
          icon={<User size={15} color="#7B82A0" />}
        />

        <AuthInput
          type="email"
          placeholder="Email address"
          autoComplete="email"
          value={form.email}
          onChange={updateField('email')}
          error={errors.email}
          icon={<Mail size={15} color="#7B82A0" />}
        />

        <div className="relative">
          <AuthInput
            type={show ? 'text' : 'password'}
            placeholder="Create a strong password"
            autoComplete="new-password"
            value={form.password}
            onChange={updateField('password')}
            error={errors.password}
            icon={<Lock size={15} color="#7B82A0" />}
          />
          <button
            type="button"
            onClick={() => setShow((value) => !value)}
            className="absolute right-3 top-2.5 flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
            style={{ color: '#7B82A0' }}
            aria-label={show ? 'Hide password' : 'Show password'}
            title={show ? 'Hide password' : 'Show password'}>
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {form.password.length > 0 && (
          <div className="-mt-2 mb-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold" style={{ color: '#7B82A0' }}>
                Password strength
              </span>
              <span className="text-[11px] font-semibold" style={{ color: strength.color }}>
                {strength.label}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full" style={{ background: '#21263A' }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: strength.width, background: strength.color }}
              />
            </div>
            <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {passwordRules.map((rule) => (
                <div
                  key={rule.label}
                  className="flex items-center gap-1.5 text-[11px]"
                  style={{ color: rule.passed ? '#22D3A0' : '#596077' }}>
                  {rule.passed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                  {rule.label}
                </div>
              ))}
            </div>
          </div>
        )}

        <AuthInput
          type={show ? 'text' : 'password'}
          placeholder="Confirm password"
          autoComplete="new-password"
          value={form.confirm_password}
          onChange={updateField('confirm_password')}
          error={errors.confirm_password}
          icon={<Lock size={15} color="#7B82A0" />}
        />

        <AuthInput
          type="text"
          placeholder="Admin registration code"
          autoComplete="one-time-code"
          value={form.admin_code}
          onChange={updateField('admin_code')}
          error={errors.admin_code}
          icon={<KeyRound size={15} color="#7B82A0" />}
          hint="One-time setup only. The code is never stored in the browser."
        />

        <AuthButton type="submit" loading={registerMutation.isPending}>
          {registerMutation.isPending ? 'Creating secure account...' : 'Create Admin Account'}
        </AuthButton>
      </form>

      <p className="mt-5 text-center text-sm" style={{ color: '#7B82A0' }}>
        Already have an account?{' '}
        <Link to="/login" className="font-semibold" style={{ color: '#7C6FF7' }}>
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
