import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { resolveApiBaseUrl } from '../config/network';
import Input from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { AuthLayout, FormError, PasswordField } from '../components/auth/AuthParts';
import { SocialSignIn } from '../components/auth/SocialSignIn';
import { LegalSheet, type LegalSlug } from '../components/auth/LegalSheet';
import { useToast } from '../components/ui/Toast';

export default function RegisterScreen() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const { showToast } = useToast();
  
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    phone_number: '',
    password: '',
    confirm_password: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);
  const [legalDoc, setLegalDoc] = useState<LegalSlug | null>(null);

  const getFieldError = (value: unknown): string => {
    if (Array.isArray(value)) {
      return typeof value[0] === 'string' ? value[0] : '';
    }
    return typeof value === 'string' ? value : '';
  };

  const getPasswordStrength = (password: string) => {
    if (password.length === 0) return { level: 0, label: '', color: 'bg-bg-input' };
    if (password.length < 6) return { level: 1, label: 'Weak', color: 'bg-danger' };
    if (password.length < 10) return { level: 2, label: 'Fair', color: 'bg-warning' };
    return { level: 3, label: 'Strong', color: 'bg-success' };
  };

  const passwordStrength = getPasswordStrength(formData.password);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setErrors({ ...errors, [e.target.name]: '' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setIsLoading(true);

    try {
      const response = await authService.register(formData);
      await setAuth(response.user, response.access, response.refresh);
      navigate('/');
    } catch (err: any) {
      const data = err?.response?.data;
      let toastMessage = 'Request failed. Please try again.';

      if (data && typeof data === 'object') {
        const normalizedErrors = (data.details && typeof data.details === 'object') ? data.details : data;
        setErrors(normalizedErrors as Record<string, string>);

        if (typeof data.message === 'string') {
          setErrors((prev) => ({ ...prev, form: data.message }));
          toastMessage = data.message;
        } else if (typeof data.error === 'string') {
          setErrors((prev) => ({ ...prev, form: data.error }));
          toastMessage = data.error;
        } else {
          const nonFieldErrors = (normalizedErrors as Record<string, unknown>).non_field_errors;
          if (Array.isArray(nonFieldErrors) && typeof nonFieldErrors[0] === 'string') {
            toastMessage = nonFieldErrors[0];
          }
        }
      } else if (!err?.response) {
        toastMessage = `Unable to reach server at ${resolveApiBaseUrl()}. Confirm VITE_API_BASE_URL points to a reachable backend.`;
        setErrors({ form: toastMessage });
      } else {
        setErrors({ form: 'Registration failed. Please try again.' });
      }

      showToast({ message: toastMessage, type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Track verified steps, join challenges and build a daily habit."
      footer={
        <p className="text-center text-callout text-text-secondary">
          Already have an account?{' '}
          <Link to="/login" className="inline-flex min-h-touch items-center font-semibold text-brand hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <FormError message={errors.form} />

      <form onSubmit={handleSubmit}>
        <Input
          label="Username"
          name="username"
          type="text"
          value={formData.username}
          onChange={handleChange}
          placeholder="Choose a username"
          error={getFieldError(errors.username)}
          required
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
        />

        <Input
          label="Email"
          name="email"
          type="email"
          inputMode="email"
          value={formData.email}
          onChange={handleChange}
          placeholder="you@example.com"
          error={getFieldError(errors.email)}
          required
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="next"
        />

        <Input
          label="M-Pesa phone number"
          name="phone_number"
          type="tel"
          inputMode="tel"
          value={formData.phone_number}
          onChange={handleChange}
          placeholder="2547XXXXXXXX"
          error={getFieldError(errors.phone_number)}
          helperText="Used for deposits and withdrawals."
          required
          autoComplete="tel"
          enterKeyHint="next"
        />

        <PasswordField
          label="Password"
          name="password"
          value={formData.password}
          onChange={handleChange}
          placeholder="Create a password"
          error={getFieldError(errors.password)}
          required
          autoComplete="new-password"
          enterKeyHint="next"
        />
        {formData.password && (
          <div className="-mt-2 mb-4" aria-live="polite">
            <div className="flex gap-1" aria-hidden>
              {[1, 2, 3].map((level) => (
                <span
                  key={level}
                  className={`h-1 flex-1 rounded-full transition-colors duration-normal ${
                    passwordStrength.level >= level ? passwordStrength.color : 'bg-bg-input'
                  }`}
                />
              ))}
            </div>
            <p className="mt-1.5 text-caption text-text-muted">
              Strength: <span className="font-semibold text-text-secondary">{passwordStrength.label}</span>
            </p>
          </div>
        )}

        <PasswordField
          label="Confirm password"
          name="confirm_password"
          value={formData.confirm_password}
          onChange={handleChange}
          placeholder="Re-enter your password"
          error={getFieldError(errors.confirm_password)}
          required
          autoComplete="new-password"
          enterKeyHint="done"
        />

        <p className="mb-5 text-caption text-text-muted">
          By creating an account you agree to our{' '}
          <button type="button" onClick={() => setLegalDoc('terms-and-conditions')} className="font-semibold text-text-secondary underline underline-offset-2 hover:text-text-primary">
            Terms
          </button>{' '}
          and{' '}
          <button type="button" onClick={() => setLegalDoc('privacy-policy')} className="font-semibold text-text-secondary underline underline-offset-2 hover:text-text-primary">
            Privacy Policy
          </button>
          . Challenge entries are contributions to a shared pool; payouts depend on qualifying.
        </p>

        <Button type="submit" size="lg" fullWidth isLoading={isLoading} disabled={socialBusy} loadingText="Creating account">
          Create account
        </Button>
      </form>

      <SocialSignIn
        mode="register"
        disabled={isLoading}
        onBusyChange={setSocialBusy}
        onError={(message) => setErrors(message ? { form: message } : {})}
      />

      <LegalSheet slug={legalDoc} onClose={() => setLegalDoc(null)} />
    </AuthLayout>
  );
}
