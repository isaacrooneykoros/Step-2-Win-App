import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, RefreshCw, Radio } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Pill } from '../components/ui/Pill';
import { Spinner } from '../components/ui/Spinner';
import { BrandMark } from '../components/brand/BrandMark';
import { resolveApiBaseUrl, resolveWsBaseUrl } from '../config/network';

type CheckState = 'idle' | 'running' | 'pass' | 'fail';

interface CheckResult {
  label: string;
  state: CheckState;
  detail: string;
}

const PREFLIGHT_SESSION_KEY = 'preflight_checked_v1';

async function checkApi(baseUrl: string): Promise<CheckResult> {
  const attempt = async (timeoutMs: number) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/api/health/`, {
        method: 'GET',
        signal: controller.signal,
      });
      return response;
    } finally {
      window.clearTimeout(timer);
    }
  };

  try {
    let response: Response;
    try {
      // Render free-tier services can take up to 50 s to wake from sleep.
      // Allow a generous first window so a cold-start doesn't look like a failure.
      response = await attempt(50000);
    } catch {
      // One more try for transient startup/network hiccups.
      response = await attempt(20000);
    }

    if (!response.ok) {
      return {
        label: 'API health',
        state: 'fail',
        detail: `HTTP ${response.status} from /api/health/`,
      };
    }

    const body = (await response.json()) as { status?: string };
    const ok = body?.status === 'ok';
    return {
      label: 'API health',
      state: ok ? 'pass' : 'fail',
      detail: ok ? 'Backend health endpoint responded OK.' : 'Unexpected health payload.',
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    const isColdStart = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
    return {
      label: 'API health',
      state: 'fail',
      detail: isColdStart
        ? 'Request timed out. The backend may still be waking up. Tap Retry in a moment.'
        : `Request failed: ${msg}. Check your network connection and tap Retry. If the problem persists, the backend URL or CORS config on Render may need updating.`,
    };
  }
}

async function checkWebSocket(wsBase: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const wsUrl = `${wsBase}/ws/health/`;
    let settled = false;
    let opened = false;
    let sawTransportError = false;
    // Give the WebSocket long enough for the backend to finish its cold-start
    // and complete the TLS + HTTP-upgrade handshake.
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        label: 'Realtime WebSocket',
        state: 'fail',
        detail: 'Connection timed out. The backend may still be starting. Tap Retry.',
      });
    }, 20000);

    try {
      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        opened = true;
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        socket.close();
        resolve({
          label: 'Realtime WebSocket',
          state: 'pass',
          detail: 'WebSocket transport reachable.',
        });
      };

      socket.onerror = () => {
        // Some runtimes fire `error` before a normal `close` event carrying
        // the real close code (e.g. 4001 for unauthenticated but reachable).
        // Defer final decision to onclose unless we time out.
        sawTransportError = true;
      };

      socket.onclose = (event) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);

        if (opened || event.code === 1000) {
          resolve({
            label: 'Realtime WebSocket',
            state: 'pass',
            detail: 'WebSocket opened and closed cleanly.',
          });
          return;
        }

        resolve({
          label: 'Realtime WebSocket',
          state: 'fail',
          detail: sawTransportError
            ? `WebSocket transport failed (close code ${event.code || 0}).`
            : `Closed before open (code ${event.code || 0}).`,
        });
      };
    } catch (error) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve({
        label: 'Realtime WebSocket',
        state: 'fail',
        detail: `Invalid WebSocket URL or runtime error: ${error instanceof Error ? error.message : 'unknown'}`,
      });
    }
  });
}

export default function PreflightScreen() {
  const navigate = useNavigate();
  const apiBase = useMemo(() => resolveApiBaseUrl(), []);
  const wsBase = useMemo(() => resolveWsBaseUrl(), []);

  const [running, setRunning] = useState(false);
  const [apiResult, setApiResult] = useState<CheckResult>({
    label: 'API health',
    state: 'idle',
    detail: '',
  });
  const [wsResult, setWsResult] = useState<CheckResult>({
    label: 'Realtime WebSocket',
    state: 'idle',
    detail: '',
  });

  const runChecks = useCallback(async () => {
    setRunning(true);
    setApiResult({ label: 'API health', state: 'running', detail: 'Checking backend health...' });
    setWsResult({ label: 'Realtime WebSocket', state: 'running', detail: 'Checking websocket reachability...' });

    const api = await checkApi(apiBase);
    setApiResult(api);
    const ws = await checkWebSocket(wsBase);
    setWsResult(ws);
    setRunning(false);
  }, [apiBase, wsBase]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const allPassed = apiResult.state === 'pass' && wsResult.state === 'pass';
  const checksDone = ['pass', 'fail'].includes(apiResult.state) && ['pass', 'fail'].includes(wsResult.state);

  const continueToLogin = () => {
    sessionStorage.setItem(PREFLIGHT_SESSION_KEY, 'true');
    navigate('/login', { replace: true });
  };

  const renderState = (result: CheckResult) => {
    if (result.state === 'running') {
      return (
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-input text-text-secondary">
          <Spinner size={16} />
        </span>
      );
    }
    if (result.state === 'pass') {
      return (
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckCircle2 size={18} aria-hidden />
        </span>
      );
    }
    if (result.state === 'fail') {
      return (
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-danger-soft text-danger">
          <AlertTriangle size={18} aria-hidden />
        </span>
      );
    }
    return (
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-input text-text-muted">
        <Radio size={18} aria-hidden />
      </span>
    );
  };

  const statusPill = (result: CheckResult) => {
    switch (result.state) {
      case 'pass':
        return <Pill tone="success">Reachable</Pill>;
      case 'fail':
        return <Pill tone="danger">Failed</Pill>;
      case 'running':
        return <Pill tone="neutral">Checking</Pill>;
      default:
        return <Pill tone="neutral">Waiting</Pill>;
    }
  };

  return (
    <main className="min-h-[100dvh] bg-bg-page">
      <div className="mx-auto w-full max-w-[420px] px-5 pt-safe pb-safe">
        <header className="pt-8">
          <BrandMark size={44} title="Step2Win" />
          <h1 className="mt-6 text-title-lg text-text-primary">Connection check</h1>
          <p className="mt-1.5 text-body text-text-secondary">
            Making sure your phone can reach Step2Win before you sign in. The first check after a quiet period can
            take up to a minute while the server wakes up.
          </p>
        </header>

        <ul className="mt-6 overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card" aria-live="polite">
          {[apiResult, wsResult].map((result, i) => (
            <li
              key={result.label}
              className={`flex items-start gap-3 p-4 ${i > 0 ? 'border-t border-border-light' : ''}`}
            >
              {renderState(result)}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body font-semibold text-text-primary">{result.label}</span>
                  {statusPill(result)}
                </div>
                <p className="mt-0.5 break-words text-caption text-text-secondary">{result.detail || 'Waiting to start'}</p>
              </div>
            </li>
          ))}
        </ul>

        {checksDone && !allPassed && (
          <div role="alert" className="mt-4 rounded-control bg-danger-soft px-4 py-3 text-callout text-danger">
            One or more checks failed. If the server was asleep, retry in a moment. Otherwise check your network
            connection.
          </div>
        )}

        <dl className="mt-4 space-y-1 break-all text-caption text-text-muted">
          <div>
            <dt className="inline font-semibold">API </dt>
            <dd className="inline">{apiBase}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">Realtime </dt>
            <dd className="inline">{wsBase}</dd>
          </div>
        </dl>

        <div className="mt-6 flex flex-col gap-3 pb-6">
          <Button size="lg" fullWidth onClick={continueToLogin} disabled={!allPassed}>
            Continue to sign in
          </Button>
          <Button
            size="lg"
            variant="outline"
            fullWidth
            onClick={() => void runChecks()}
            isLoading={running}
            loadingText="Checking"
            leftIcon={<RefreshCw size={16} aria-hidden />}
          >
            Retry checks
          </Button>
        </div>
      </div>
    </main>
  );
}
