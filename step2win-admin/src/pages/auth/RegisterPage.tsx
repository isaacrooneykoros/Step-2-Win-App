import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { User, Mail, Lock } from 'lucide-react';
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

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getPasswordStrength(password: string): { label: string; color: string; width: string } {
  if (password.length === 0) {
    return { label: '', color: '#21263A', width: '0%' };
  }
  if (password.length < 6) {
    return { label: 'Weak', color: '#F06060', width: '25%' };
  }
  if (password.length < 8) {
    return { label: 'Fair', color: '#F5A623', width: '50%' };
  }
  if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return { label: 'Good', color: '#4F9CF9', width: '75%' };
  }
  return { label: 'Strong', color: '#22D3A0', width: '100%' };
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

  const validate = (): boolean => {
    const nextErrors: FormErrors = {};

    if (!form.username.trim()) {
      nextErrors.username = 'Username is required.';
    } else if (form.username.length < 3) {
      nextErrors.username = 'Username must be at least 3 characters.';
    } else if (!/^[a-zA-Z0-9_-]+$/.test(form.username)) {
      nextErrors.username = 'Only letters, numbers, underscores and hyphens allowed.';
    }

    if (!form.email.trim()) {
      nextErrors.email = 'Email is required.';
    } else if (!validateEmail(form.email)) {
      nextErrors.email = 'Enter a valid email address.';
    }

    if (!form.password) {
      nextErrors.password = 'Password is required.';
    } else if (form.password.length < 8) {
      nextErrors.password = 'Password must be at least 8 characters.';
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
          const maybeError = error as {
            response?: { data?: Record<string, string[] | string> };
            message?: string;
          };
          const data = maybeError.response?.data;
          if (data && typeof data === 'object') {
            const mapped: FormErrors = {};
            if (Array.isArray(data.username)) {
              mapped.username = data.username[0];
            }
            if (Array.isArray(data.email)) {
              mapped.email = data.email[0];
            }
            if (Array.isArray(data.password)) {
              mapped.password = data.password[0];
            }
            if (Array.isArray(data.confirm_password)) {
              mapped.confirm_password = data.confirm_password[0];
            }
            if (Array.isArray(data.admin_code)) {
              mapped.admin_code = data.admin_code[0];
            }
            if (Array.isArray(data.non_field_errors)) {
              mapped.general = data.non_field_errors[0];
            }
            if (typeof data.error === 'string') {
              mapped.general = data.error;
            }
            setErrors(mapped);
            return;
          }
          setErrors({ general: maybeError.message ?? 'Registration failed. Try again.' });
        },
      }
    );
  };

  return (
    <AuthLayout mode="register">
      <h1
        className="text-3xl font-extrabold mb-1.5 leading-tight"
        style={{ fontFamily: 'Syne, sans-serif', color: '#F0F2F8', letterSpacing: '-0.5px' }}>
        Request access
      </h1>
      <p className="text-sm mb-7 leading-relaxed" style={{ color: '#7B82A0' }}>
        Create the first Step2Win admin account
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
          placeholder="Username"
          autoComplete="username"
          autoFocus
          value={form.username}
          onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
          error={errors.username}
          icon={<User size={15} color="#7B82A0" />}
        />

        <AuthInput
          type="email"
          placeholder="Email address"
          autoComplete="email"
          value={form.email}
          onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
          error={errors.email}
          icon={<Mail size={15} color="#7B82A0" />}
        />

        <div className="relative">
          <AuthInput
            type={show ? 'text' : 'password'}
            placeholder="Create a strong password"
            autoComplete="new-password"
            value={form.password}
            onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
            error={errors.password}
            icon={<Lock size={15} color="#7B82A0" />}
          />
          <button
            type="button"
            onClick={() => setShow((value) => !value)}
            className="absolute right-3.5 top-3.5 text-xs"
            style={{ color: '#3D4260' }}>
            {show ? 'Hide' : 'Show'}
          </button>
        </div>

        {form.password.length > 0 && (
          <div className="mb-4 -mt-2">
            <div className="h-1 rounded-full overflow-hidden" style={{ background: '#21263A' }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: strength.width, background: strength.color }}
              />
            </div>
            <p className="text-[11px] mt-1" style={{ color: strength.color }}>
              {strength.label}
            </p>
          </div>
        )}

        <AuthInput
          type={show ? 'text' : 'password'}
          placeholder="Confirm password"
          autoComplete="new-password"
          value={form.confirm_password}
          onChange={(event) => setForm((prev) => ({ ...prev, confirm_password: event.target.value }))}
          error={errors.confirm_password}
          icon={<Lock size={15} color="#7B82A0" />}
        />

        <AuthInput
          type="text"
          placeholder="Admin registration code"
          autoComplete="one-time-code"
          value={form.admin_code}
          onChange={(event) => setForm((prev) => ({ ...prev, admin_code: event.target.value }))}
          error={errors.admin_code}
          hint="One-time setup — only works before any admin exists. Value comes from the backend ADMIN_REGISTRATION_CODE environment variable."
        />

        <AuthButton type="submit" loading={registerMutation.isPending}>
          {registerMutation.isPending ? 'Creating account...' : 'Create Admin Account'}
        </AuthButton>
      </form>

      <p className="text-center text-sm mt-5" style={{ color: '#7B82A0' }}>
        Already have an account?{' '}
        <Link to="/login" className="font-semibold" style={{ color: '#7C6FF7' }}>
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
