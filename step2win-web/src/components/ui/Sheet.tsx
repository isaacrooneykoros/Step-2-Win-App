import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { duration, usePrefersReducedMotion } from '../../lib/motion';
import { pushBackHandler } from '../../lib/backButton';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Sticky action area, e.g. primary button. */
  footer?: ReactNode;
  /** Prevent dismissal via backdrop/Escape (e.g. while a payment is in flight). */
  dismissible?: boolean;
  /** Width on tablet/desktop where the sheet becomes a centred dialog. */
  size?: 'sm' | 'md' | 'lg';
  hideCloseButton?: boolean;
}

let openCount = 0;

/**
 * Mobile-first modal surface: bottom sheet on phones, centred dialog from 640px.
 * Handles scroll lock, Escape, initial focus, focus restore and exit animation.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
  size = 'md',
  hideCloseButton = false,
}: SheetProps) {
  const reduced = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();
  // Callers usually pass inline closures; keep the latest without re-running effects.
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  onCloseRef.current = onClose;
  dismissibleRef.current = dismissible;

  // Mount → animate in; close → animate out → unmount.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setMounted(true);
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMounted(false), reduced ? 0 : duration.normal);
    return () => window.clearTimeout(timer);
  }, [open, reduced]);

  // Android back closes the top-most open sheet before any navigation. A non-dismissible sheet
  // (payment in flight) swallows the press so the user can't navigate out from under it.
  useEffect(() => {
    if (!open) return;
    return pushBackHandler(() => {
      if (dismissibleRef.current) onCloseRef.current();
      return true;
    });
  }, [open]);

  // Scroll lock (ref-counted so stacked sheets behave).
  useEffect(() => {
    if (!mounted) return;
    openCount += 1;
    document.body.style.overflow = 'hidden';
    return () => {
      openCount -= 1;
      if (openCount <= 0) document.body.style.overflow = '';
      restoreFocusRef.current?.focus?.();
    };
  }, [mounted]);

  // Initial focus + Escape + simple focus trap.
  useEffect(() => {
    if (!visible) return;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [],
      ).filter((el) => !el.hasAttribute('disabled'));
    // Focus the panel (not the first input) so the mobile keyboard doesn't pop open
    // unexpectedly. Callers can opt in with data-autofocus.
    const preferred = panel?.querySelector<HTMLElement>('[data-autofocus]');
    (preferred ?? panel)?.focus({ preventScroll: true });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissibleRef.current) {
        event.stopPropagation();
        onCloseRef.current();
      }
      if (event.key === 'Tab') {
        const items = focusables();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible]);

  if (!mounted) return null;

  const maxW = size === 'sm' ? 'sm:max-w-sm' : size === 'lg' ? 'sm:max-w-xl' : 'sm:max-w-md';

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-6">
      <div
        className="absolute inset-0 bg-[hsl(var(--scrim)/0.45)] transition-opacity duration-normal ease-standard"
        style={{ opacity: visible ? 1 : 0 }}
        onClick={dismissible ? onClose : undefined}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={[
          'relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-bg-elevated shadow-modal outline-none',
          'rounded-t-[28px] sm:rounded-[24px]',
          maxW,
          'transition-[transform,opacity] duration-deliberate ease-enter',
        ].join(' ')}
        style={{
          transform: visible ? 'translateY(0)' : 'translateY(24px)',
          opacity: visible ? 1 : 0,
        }}
      >
        <div className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-border sm:hidden" aria-hidden />
        {(title || !hideCloseButton) && (
          <div className="flex shrink-0 items-start gap-3 px-5 pb-2 pt-3 sm:pt-5">
            <div className="min-w-0 flex-1">
              {title && (
                <h2 id={titleId} className="text-title text-text-primary">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="mt-1 text-callout text-text-secondary">
                  {description}
                </p>
              )}
            </div>
            {!hideCloseButton && dismissible && (
              <button
                type="button"
                onClick={onClose}
                className="-mr-1.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-bg-input"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-2">{children}</div>
        {footer && <div className="shrink-0 border-t border-border-light bg-bg-elevated px-5 pb-safe pt-3">{footer}</div>}
        {!footer && <div className="pb-safe shrink-0" />}
      </div>
    </div>,
    document.body,
  );
}

export default Sheet;
