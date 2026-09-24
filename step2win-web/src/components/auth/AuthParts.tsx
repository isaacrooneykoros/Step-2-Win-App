import { forwardRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import Input from '../ui/Input';
import { IconButton } from '../ui/ScreenHeader';
import { Spinner } from '../ui/Spinner';
import { BrandMark } from '../brand/BrandMark';

/**
 * Shared layout for the signed-out screens. The page itself scrolls (no fixed CTA), so
 * the mobile keyboard can never hide the submit button, and safe areas are respected.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="min-h-[100dvh] bg-bg-page">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[420px] flex-col px-5 pt-safe pb-safe">
        <header className="pt-8 sm:pt-16">
          <BrandMark size={44} title="Step2Win" />
          <h1 className="mt-6 text-title-lg text-text-primary">{title}</h1>
          <p className="mt-1.5 text-body text-text-secondary">{subtitle}</p>
        </header>
        <div className="mt-7 flex-1">{children}</div>
        {footer && <footer className="pb-4 pt-8">{footer}</footer>}
      </div>
    </main>
  );
}

/** Form-level error, announced to assistive tech. */
export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div role="alert" className="mb-5 rounded-control bg-danger-soft px-4 py-3 text-callout text-danger">
      {message}
    </div>
  );
}

type PasswordFieldProps = Omit<ComponentProps<typeof Input>, 'type' | 'trailing'>;

/** Password input with a show/hide toggle. */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField(props, ref) {
  const [visible, setVisible] = useState(false);
  return (
    <Input
      ref={ref}
      {...props}
      type={visible ? 'text' : 'password'}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      trailing={
        <IconButton
          label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
          className="h-10 w-10 text-text-muted hover:text-text-primary"
        >
          {visible ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </IconButton>
      }
    />
  );
});

function getPasswordStrength(password: string) {
  if (password.length === 0) return { level: 0, label: '', color: 'bg-bg-input' };
  if (password.length < 6) return { level: 1, label: 'Weak', color: 'bg-danger' };
  if (password.length < 10) return { level: 2, label: 'Fair', color: 'bg-warning' };
  return { level: 3, label: 'Strong', color: 'bg-success' };
}

/** Three-bar strength meter shown under a new-password field (Register, Forgot password). */
export function PasswordStrengthMeter({ password }: { password: string }) {
  if (!password) return null;
  const strength = getPasswordStrength(password);
  return (
    <div className="-mt-2 mb-4" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3].map((level) => (
          <span
            key={level}
            className={`h-1 flex-1 rounded-full transition-colors duration-normal ${
              strength.level >= level ? strength.color : 'bg-bg-input'
            }`}
          />
        ))}
      </div>
      <p className="mt-1.5 text-caption text-text-muted">
        Strength: <span className="font-semibold text-text-secondary">{strength.label}</span>
      </p>
    </div>
  );
}

/** "or" separator between the form and third-party sign-in. */
export function OrDivider() {
  return (
    <div className="my-6 flex items-center gap-3" role="separator" aria-label="or">
      <span className="h-px flex-1 bg-border" />
      <span className="text-caption font-medium text-text-muted" aria-hidden>
        or
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Official Google "G" logo (brand asset, used per Google's sign-in branding guidelines). */
function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** Apple logo (Apple-supplied glyph shape), drawn in the button's text colour. */
function AppleLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 814 1000" aria-hidden focusable="false" fill="currentColor">
      <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z" />
    </svg>
  );
}

type ProviderButtonProps = {
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  label?: string;
};

// Shared geometry: identical size, radius and weight for every provider (App Review 4.8 /
// Apple HIG: Sign in with Apple must be at least as prominent as other sign-in buttons).
const providerButtonBase = [
  'relative inline-flex h-[52px] w-full items-center justify-center gap-3 rounded-2xl px-6',
  'text-body font-semibold transition-colors duration-fast',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
  'disabled:cursor-not-allowed disabled:opacity-60',
].join(' ');

/** Google "neutral" button: G logo on the left, "Continue with Google". */
export function GoogleButton({ onClick, disabled, isLoading, label = 'Continue with Google' }: ProviderButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={isLoading || undefined}
      className={`${providerButtonBase} social-btn-google`}
    >
      {isLoading ? <Spinner size={18} /> : <GoogleG />}
      <span>{isLoading ? 'Connecting to Google…' : label}</span>
    </button>
  );
}

/** Sign in with Apple: black (light theme) / white (dark theme), Apple logo left of the title. */
export function AppleButton({ onClick, disabled, isLoading, label = 'Sign in with Apple' }: ProviderButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={isLoading || undefined}
      className={`${providerButtonBase} social-btn-apple`}
    >
      {isLoading ? <Spinner size={18} /> : <AppleLogo size={19} />}
      <span>{isLoading ? 'Connecting to Apple…' : label}</span>
    </button>
  );
}
