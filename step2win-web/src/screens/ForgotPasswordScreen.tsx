import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { authService } from '../services/api';
import Input from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { AuthLayout, FormError, PasswordField, PasswordStrengthMeter } from '../components/auth/AuthParts';
import { useToast } from '../components/ui/Toast';

type Step = 'identify' | 'code' | 'password';
const CODE_LENGTH = 6;

/** Human message for a failed request; network / rate-limit aware. */
function errorMessage(err: any, fallback: string): string {
  if (!err?.response) {
    return typeof navigator !== 'undefined' && navigator.onLine === false
      ? "You're offline. Check your connection and try again."
      : "We couldn't reach Step2Win. Check your connection and try again.";
  }
  if (err.response.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  const data = err.response.data;
  if (typeof data?.error === 'string') return data.error;
  if (typeof data?.message === 'string') return data.message;
  return fallback;
}

export default function ForgotPasswordScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();
  const initialIdentifier = (location.state as { identifier?: string } | null)?.identifier ?? '';

  const [step, setStep] = useState<Step>('identify');
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [locked, setLocked] = useState(false);
  const lastSubmittedCode = useRef('');

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const t = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  const sendCode = async (isResend: boolean) => {
    setError('');
    setLoading(true);
    try {
      const res = await authService.requestPasswordReset(identifier.trim());
      setNotice(res.message);
      setResendIn(res.resend_after || 60);
      setCode('');
      setLocked(false);
      lastSubmittedCode.current = '';
      setStep('code');
      if (isResend) showToast({ message: 'If an account matches, a new code is on its way.', type: 'info' });
    } catch (err) {
      setError(errorMessage(err, "We couldn't send a code. Please try again."));
    } finally {
      setLoading(false);
    }
  };

  const verify = async (value: string) => {
    if (value.length !== CODE_LENGTH || loading) return;
    lastSubmittedCode.current = value;
    setError('');
    setLoading(true);
    try {
      const res = await authService.verifyPasswordResetCode(identifier.trim(), value);
      setResetToken(res.reset_token);
      setStep('password');
    } catch (err: any) {
      const data = err?.response?.data;
      if (data?.code === 'too_many_attempts') {
        setLocked(true);
        setError('Too many incorrect tries. Send yourself a new code to continue.');
      } else if (data?.code === 'invalid_code' && typeof data.attempts_left === 'number') {
        const left = data.attempts_left as number;
        setCode('');
        setError(`That code is incorrect or has expired. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
      } else {
        setError(errorMessage(err, "We couldn't check that code. Please try again."));
      }
    } finally {
      setLoading(false);
    }
  };

  const onCodeChange = (raw: string) => {
    // Accept pasted codes like "123 456" or "Your code: 123456".
    const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (error && !locked) setError('');
    if (digits.length === CODE_LENGTH && digits !== lastSubmittedCode.current && !locked) void verify(digits);
  };

  const confirm = async () => {
    setError('');
    setFieldErrors({});
    if (newPassword !== confirmPassword) {
      setFieldErrors({ confirm_password: "The passwords don't match." });
      return;
    }
    setLoading(true);
    try {
      await authService.confirmPasswordReset({
        reset_token: resetToken,
        new_password: newPassword,
        confirm_password: confirmPassword,
      });
      showToast({ message: 'Password changed. Sign in with your new password.', type: 'success' });
      navigate('/login', { replace: true });
    } catch (err: any) {
      const data = err?.response?.data;
      if (data?.code === 'invalid_token') {
        setStep('identify');
        setResetToken('');
        setError('That reset took too long and has expired. Request a new code to try again.');
      } else if (data?.errors && typeof data.errors === 'object') {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(data.errors as Record<string, unknown>)) {
          next[k] = Array.isArray(v) ? String(v[0]) : String(v);
        }
        setFieldErrors(next);
      } else {
        setError(errorMessage(err, "We couldn't change your password. Please try again."));
      }
    } finally {
      setLoading(false);
    }
  };

  const backToLogin = (
    <p className="text-center text-callout text-text-secondary">
      Remembered it?{' '}
      <Link to="/login" className="inline-flex min-h-touch items-center font-semibold text-brand hover:underline">
        Back to sign in
      </Link>
    </p>
  );

  if (step === 'identify') {
    return (
      <AuthLayout
        title="Reset your password"
        subtitle="Enter the email, username or phone number on your account. We'll email you a 6-digit code."
        footer={backToLogin}
      >
        <FormError message={error} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendCode(false);
          }}
        >
          <Input
            label="Email, username or phone"
            name="identifier"
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="you@example.com"
            required
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="send"
          />
          <Button type="submit" size="lg" fullWidth isLoading={loading} loadingText="Sending code" disabled={!identifier.trim()} className="mt-2">
            Send code
          </Button>
        </form>
        <p className="mt-5 text-caption text-text-muted">
          Signed up with Google? You don't have a password to reset. Go back and use Continue with Google.
        </p>
      </AuthLayout>
    );
  }

  if (step === 'code') {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="If an account matches, we've sent a 6-digit code to the email address on it. It expires in 15 minutes."
        footer={backToLogin}
      >
        {notice && !error && (
          <p className="sr-only" role="status">
            {notice}
          </p>
        )}
        <FormError message={error} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify(code);
          }}
        >
          <Input
            label="6-digit code"
            name="code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => onCodeChange(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              onCodeChange(e.clipboardData.getData('text'));
            }}
            placeholder="000000"
            maxLength={CODE_LENGTH + 6}
            autoFocus
            required
            disabled={locked}
            className="num text-center text-title tracking-[0.4em]"
            enterKeyHint="done"
            helperText="Can't find it? Check your spam or promotions folder."
          />
          <Button
            type="submit"
            size="lg"
            fullWidth
            isLoading={loading}
            loadingText="Checking"
            disabled={code.length !== CODE_LENGTH || locked}
            className="mt-2"
          >
            Continue
          </Button>
        </form>
        <div className="mt-4 flex flex-col items-center gap-1">
          <Button
            variant="ghost"
            size="md"
            onClick={() => void sendCode(true)}
            disabled={resendIn > 0 || loading}
            aria-live="polite"
          >
            {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Send a new code'}
          </Button>
          <button
            type="button"
            onClick={() => {
              setStep('identify');
              setError('');
            }}
            className="inline-flex min-h-touch items-center text-callout font-semibold text-text-secondary hover:text-text-primary"
          >
            Use a different email, username or phone
          </button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="You'll be signed out on every device and can sign in again with the new password."
      footer={backToLogin}
    >
      <FormError message={error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        {/* Lets password managers attach the new password to the right account. */}
        <input type="text" name="username" autoComplete="username" value={identifier} readOnly hidden />
        <PasswordField
          label="New password"
          name="new_password"
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
            setFieldErrors((f) => ({ ...f, new_password: '' }));
          }}
          placeholder="At least 8 characters"
          error={fieldErrors.new_password}
          required
          autoFocus
          autoComplete="new-password"
          enterKeyHint="next"
        />
        <PasswordStrengthMeter password={newPassword} />
        <PasswordField
          label="Confirm new password"
          name="confirm_password"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            setFieldErrors((f) => ({ ...f, confirm_password: '' }));
          }}
          placeholder="Re-enter the new password"
          error={fieldErrors.confirm_password}
          required
          autoComplete="new-password"
          enterKeyHint="done"
        />
        <Button
          type="submit"
          size="lg"
          fullWidth
          isLoading={loading}
          loadingText="Saving"
          disabled={!newPassword || !confirmPassword}
          className="mt-2"
        >
          Change password
        </Button>
      </form>
    </AuthLayout>
  );
}
