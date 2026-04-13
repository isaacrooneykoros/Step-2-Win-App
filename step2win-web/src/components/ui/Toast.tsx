import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Info, AlertTriangle } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
}

const icons = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};

const colors = {
  success: {
    background: 'hsl(var(--bg-elevated) / 0.96)',
    border: 'rgba(52,211,153,0.45)',
    icon: 'text-accent-green',
  },
  error: {
    background: 'hsl(var(--bg-elevated) / 0.96)',
    border: 'rgba(248,113,113,0.45)',
    icon: 'text-accent-red',
  },
  info: {
    background: 'hsl(var(--bg-elevated) / 0.96)',
    border: 'hsl(var(--border-default))',
    icon: 'text-accent-blue',
  },
  warning: {
    background: 'hsl(var(--bg-elevated) / 0.96)',
    border: 'rgba(251,191,36,0.45)',
    icon: 'text-accent-yellow',
  },
};

export default function Toast({ message, type = 'info', duration = 3000, onClose }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onClose, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const Icon = icons[type];

  return (
    <div
      className="flex items-center gap-3 px-4 py-3.5 rounded-2xl shadow-2xl pointer-events-auto"
      style={{
        background: colors[type].background,
        border: `1px solid ${colors[type].border}`,
        backdropFilter: 'blur(10px)',
        animation: 'slideDown 0.3s ease-out',
      }}
      role="alert"
    >
      <Icon size={18} className={colors[type].icon} />
      <p className="text-sm font-medium text-text-primary">{message}</p>
    </div>
  );
}

// Toast manager hook
interface ToastConfig {
  message: string;
  type?: ToastType;
  duration?: number;
}

let toastId = 0;

export function useToast() {
  const [toasts, setToasts] = useState<Array<ToastConfig & { id: number }>>([]);

  const showToast = (config: ToastConfig) => {
    const id = toastId++;
    setToasts((prev) => [...prev, { ...config, id }]);
  };

  const removeToast = (id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  const ToastContainer = () => (
    <div className="fixed top-4 left-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          duration={toast.duration}
          onClose={() => removeToast(toast.id)}
        />
      ))}
    </div>
  );

  return { showToast, ToastContainer };
}
