/**
 * Platform-wide responses the admin can trigger from Settings:
 * - 503 {code: "maintenance"}  -> full-screen "We'll be right back" state with retry
 * - 403 {code: "feature_disabled"} -> a calm toast with the specific message
 *
 * Mounted from the API client so every screen gets it without extra wiring.
 */
import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import axios from 'axios';
import { Wrench, RefreshCw } from 'lucide-react';
import { toast } from '../../components/ui/Toast';
import { resolveApiBaseUrl } from '../../config/network';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function MaintenanceScreen({ message }: { message: string }) {
  const [checking, setChecking] = useState(false);
  const [stillDown, setStillDown] = useState(false);

  const retry = async () => {
    setChecking(true);
    setStillDown(false);
    try {
      const { data } = await axios.get(`${resolveApiBaseUrl()}/api/app/config/`, { timeout: 10000 });
      if (!data?.maintenance?.enabled) {
        hideMaintenance();
        window.location.reload();
        return;
      }
    } catch {
      // Network or server still unavailable: stay on this screen.
    }
    setStillDown(true);
    setChecking(false);
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="maintenance-title"
      aria-describedby="maintenance-message"
      className="fixed inset-0 z-[1000] flex flex-col items-center justify-center bg-bg-page px-6 text-center"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-warning-soft text-warning" aria-hidden>
        <Wrench size={28} strokeWidth={1.75} />
      </div>
      <h1 id="maintenance-title" className="mb-2 text-title text-text-primary">
        We&apos;ll be right back
      </h1>
      <p id="maintenance-message" className="mb-2 max-w-[320px] whitespace-pre-line text-callout text-text-secondary">
        {message}
      </p>
      <p className="mb-6 max-w-[320px] text-caption text-text-muted">Your balance and challenges are safe while we work.</p>
      <button
        type="button"
        onClick={retry}
        disabled={checking}
        className="btn-primary flex h-11 items-center gap-2 rounded-control px-5 text-callout"
      >
        <RefreshCw size={16} className={checking ? 'animate-spin' : ''} aria-hidden />
        {checking ? 'Checking…' : 'Try again'}
      </button>
      <p className="mt-3 min-h-[1.25rem] text-caption text-text-muted" aria-live="polite">
        {stillDown ? 'Still updating. Please try again in a few minutes.' : ''}
      </p>
    </div>
  );
}

export function showMaintenance(message?: string) {
  const text = message?.trim() || "Step2Win is getting a quick upgrade. We'll be right back.";
  if (!host) {
    host = document.createElement('div');
    host.id = 's2w-maintenance';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root?.render(<MaintenanceScreen message={text} />);
}

export function hideMaintenance() {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

export function notifyFeatureDisabled(message?: string) {
  toast({ type: 'info', message: message || 'This is paused for a short while. Please try again later.', duration: 6000 });
}
