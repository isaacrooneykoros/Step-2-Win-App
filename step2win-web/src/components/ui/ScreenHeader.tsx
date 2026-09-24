import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

interface ScreenHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Show a back button. `true` goes back in history; a string navigates to that path. */
  back?: boolean | string;
  /** Trailing actions — use IconButton for icon-only actions. */
  actions?: ReactNode;
  /**
   * `large`: tab root screens (big title in content, compact bar appears on scroll).
   * `compact`: secondary screens (centred title in the bar).
   */
  variant?: 'large' | 'compact';
  className?: string;
}

function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  return scrolled;
}

/**
 * Consistent top-of-screen header with safe-area handling.
 * Sticky, gains a hairline border once content scrolls under it.
 */
export function ScreenHeader({ title, subtitle, back, actions, variant = 'compact', className = '' }: ScreenHeaderProps) {
  const navigate = useNavigate();
  const scrolled = useScrolled();

  const handleBack = () => {
    if (typeof back === 'string') navigate(back);
    else if (window.history.length > 1) navigate(-1);
    else navigate('/');
  };

  const bar = (
    <div
      className={[
        'sticky top-0 z-30 bg-bg-page/95 pt-safe backdrop-blur-md transition-[border-color] duration-fast',
        'border-b',
        scrolled ? 'border-border-light' : 'border-transparent',
      ].join(' ')}
    >
      <div className="flex h-14 items-center gap-1 px-2">
        <div className="flex min-w-[44px] items-center">
          {back && (
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex h-11 w-11 items-center justify-center rounded-full text-text-primary hover:bg-bg-input"
              aria-label="Go back"
            >
              <ChevronLeft size={24} strokeWidth={2} />
            </button>
          )}
        </div>
        <div className="min-w-0 flex-1 text-center">
          {variant === 'compact' ? (
            <h1 className="truncate text-headline text-text-primary">{title}</h1>
          ) : (
            <span
              className="block truncate text-headline text-text-primary transition-opacity duration-fast"
              style={{ opacity: scrolled ? 1 : 0 }}
              aria-hidden
            >
              {title}
            </span>
          )}
        </div>
        <div className="flex min-w-[44px] items-center justify-end gap-1">{actions}</div>
      </div>
    </div>
  );

  if (variant === 'compact') {
    return (
      <header className={className}>
        {bar}
        {subtitle && <p className="px-5 pb-2 text-center text-caption text-text-muted">{subtitle}</p>}
      </header>
    );
  }

  return (
    <header className={className}>
      {bar}
      <div className="px-5 pb-4">
        <h1 className="text-title-lg text-text-primary">{title}</h1>
        {subtitle && <p className="mt-1 text-callout text-text-secondary">{subtitle}</p>}
      </div>
    </header>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  tone?: 'plain' | 'filled';
}

/** 44px icon-only button with a required accessible label. */
export function IconButton({ label, children, tone = 'plain', className = '', type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={[
        'relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-primary',
        tone === 'filled' ? 'border border-border-light bg-bg-card shadow-card hover:bg-bg-input' : 'hover:bg-bg-input',
        'disabled:opacity-40',
        className,
      ].join(' ')}
      {...props}
    >
      {children}
    </button>
  );
}

export default ScreenHeader;
