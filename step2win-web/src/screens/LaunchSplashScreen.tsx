import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { Footprints, Sparkles } from 'lucide-react';

const SPLASH_DELAY_MS = 1800;

export default function LaunchSplashScreen() {
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  useEffect(() => {
    sessionStorage.setItem('launch_seen_v1', 'true');
    const timer = window.setTimeout(() => {
      navigate(isAuthenticated ? '/' : '/login', { replace: true });
    }, SPLASH_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [isAuthenticated, navigate]);

  return (
    <div className="min-h-screen bg-bg-page flex items-center justify-center px-6 relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-64" style={{ background: 'radial-gradient(circle at 50% 20%, rgba(79,156,249,0.22), transparent 60%)' }} />
      <div className="absolute -top-10 -left-10 h-40 w-40 rounded-full bg-accent-blue/10 blur-3xl" />
      <div className="absolute -bottom-10 -right-10 h-40 w-40 rounded-full bg-accent-pink/10 blur-3xl" />

      <div className="text-center screen-enter relative z-10 max-w-sm">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-bg-card mb-5">
          <Sparkles size={14} className="text-accent-blue" />
          <span className="text-xs font-semibold text-text-secondary uppercase tracking-[0.22em]">Premium launch</span>
        </div>
        <div
          className="w-24 h-24 rounded-[2rem] bg-gradient-to-br from-accent-blue to-accent-purple flex items-center justify-center mx-auto mb-5"
          style={{ boxShadow: '0 16px 40px rgba(79,156,249,0.32)' }}
        >
          <Footprints size={42} className="text-white" />
        </div>
        <h1 className="screen-title text-4xl text-text-primary">Step2Win</h1>
        <p className="text-text-secondary mt-2 text-sm leading-relaxed">A premium fitness competition experience that feels clean, fast, and alive.</p>
        <div className="mt-6 mx-auto h-1.5 w-40 rounded-full bg-bg-input overflow-hidden">
          <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-accent-blue via-accent-purple to-accent-pink animate-pulse" />
        </div>
      </div>
    </div>
  );
}
