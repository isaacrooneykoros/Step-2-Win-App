import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, RefreshCw, Wifi, Radio } from 'lucide-react';
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
        ? 'Request timed out — the backend may still be waking up. Tap Retry in a moment.'
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
        detail: 'Connection timed out — backend may still be starting. Tap Retry.',
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
      return <RefreshCw className="animate-spin text-accent-blue" size={18} />;
    }
    if (result.state === 'pass') {
      return <CheckCircle2 className="text-accent-green" size={18} />;
    }
    if (result.state === 'fail') {
      return <AlertTriangle className="text-accent-red" size={18} />;
    }
    return <Radio className="text-text-muted" size={18} />;
  };

  return (
    <div className="min-h-screen bg-bg-page px-4 py-8">
      <div className="max-w-xl mx-auto card p-6 screen-enter">
        <div className="flex items-center gap-3 mb-3">
          <Wifi className="text-accent-blue" size={22} />
          <h1 className="text-2xl font-black text-text-primary">App Debug Preflight</h1>
        </div>

        <p className="text-sm text-text-muted mb-6">
          Network checks run before login to confirm your phone can reach both API and realtime services.
          On Render's free tier the backend sleeps when idle — <strong>first launch may take up to 70 s</strong> to wake up. Tap <em>Retry Checks</em> if checks fail on the first attempt.
        </p>

        <div className="space-y-3 mb-5">
          {[apiResult, wsResult].map((result) => (
            <div key={result.label} className="bg-bg-card rounded-2xl p-4 border border-border flex items-start gap-3">
              <div className="mt-0.5">{renderState(result)}</div>
              <div>
                <div className="text-sm font-bold text-text-primary">{result.label}</div>
                <div className="text-xs text-text-muted mt-1">{result.detail || 'Pending...'}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="text-xs text-text-muted mb-6 space-y-1">
          <div>API base: {apiBase}</div>
          <div>WS base: {wsBase}</div>
        </div>

        {checksDone && !allPassed && (
          <div className="bg-tint-red border border-red-200 text-accent-red px-4 py-3 rounded-xl text-sm mb-4">
            One or more checks failed. If the backend just woke up from sleep, tap <strong>Retry Checks</strong>. Otherwise verify backend URL, CORS, and SSL on Render.
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void runChecks()}
            disabled={running}
            className="btn-secondary px-4 py-2 rounded-xl disabled:opacity-60"
          >
            Retry Checks
          </button>
          <button
            type="button"
            onClick={continueToLogin}
            disabled={!allPassed}
            className="btn-primary px-4 py-2 rounded-xl disabled:opacity-60"
          >
            Continue to Login
          </button>
        </div>
      </div>
    </div>
  );
}
