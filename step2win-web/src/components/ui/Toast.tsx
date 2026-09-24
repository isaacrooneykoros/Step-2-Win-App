import { useEffect } from 'react';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastConfig {
  message: string;
  type?: ToastType;
  duration?: number;
}

interface ToastItem extends ToastConfig {
  id: number;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (config: ToastConfig) => void;
  dismiss: (id: number) => void;
}

let nextId = 0;

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (config) =>
    set((state) => ({
      // Drop exact duplicates that are already visible (e.g. repeated sync errors).
      toasts: state.toasts.some((t) => t.message === config.message)
        ? state.toasts
        : [...state.toasts.slice(-2), { ...config, id: nextId++ }],
    })),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative access for non-React code. */
export const toast = (config: ToastConfig) => useToastStore.getState().push(config);

const meta = {
  success: { icon: CheckCircle2, className: 'text-success' },
  error: { icon: XCircle, className: 'text-danger' },
  info: { icon: Info, className: 'text-info' },
  warning: { icon: AlertTriangle, className: 'text-warning' },
};

function ToastView({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const type = item.type ?? 'info';
  const { icon: Icon, className } = meta[type];

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(item.id), item.duration ?? (type === 'error' ? 5000 : 3200));
    return () => window.clearTimeout(timer);
  }, [dismiss, item.id, item.duration, type]);

  return (
    <div
      className="pointer-events-auto flex w-full items-start gap-3 rounded-2xl border border-border-light bg-bg-elevated px-4 py-3 shadow-raised"
      style={{ animation: 'slideDown var(--dur-normal) var(--ease-enter) both' }}
      role={type === 'error' ? 'alert' : 'status'}
    >
      <Icon size={20} className={`mt-px shrink-0 ${className}`} aria-hidden />
      <p className="min-w-0 flex-1 text-callout font-medium text-text-primary">{item.message}</p>
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        className="-m-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-bg-input"
        aria-label="Dismiss notification"
      >
        <X size={16} />
      </button>
    </div>
  );
}

/** Render once near the app root. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[120] mx-auto flex max-w-md flex-col gap-2 px-4 pt-safe"
      aria-live="polite"
    >
      {toasts.map((item) => (
        <ToastView key={item.id} item={item} />
      ))}
    </div>
  );
}

// Legacy: screens still render <ToastContainer />. The global <Toaster /> now does the work,
// so this is a stable no-op component (no remounts, toasts survive navigation).
function ToastContainer() {
  return null;
}

/** Hook API kept identical to the previous implementation. */
export function useToast() {
  const push = useToastStore((s) => s.push);
  return { showToast: push, ToastContainer };
}

export default ToastView;
