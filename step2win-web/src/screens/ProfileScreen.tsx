import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  Settings,
  Trophy,
  Footprints,
  Wallet,
  Flame,
  ShieldCheck,
  Activity,
} from 'lucide-react';
import { authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useStepsSyncStore } from '../store/stepsSyncStore';
import { useHealthSync } from '../hooks/useHealthSync';
import type { User } from '../types';

export default function ProfileScreen() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const isStepsSocketConnected = useStepsSyncStore((state) => state.isStepsSocketConnected);
  const lastStepsUpdateAt = useStepsSyncStore((state) => state.lastStepsUpdateAt);
  const { permissionStatus } = useHealthSync();

  const { data: profile } = useQuery<User>({
    queryKey: ['profile'],
    queryFn: authService.getProfile,
  });

  const currentUser = (profile || user) as User | null;

  const formatLastUpdate = (timestamp: string | null) => {
    if (!timestamp) return 'No live updates yet';
    const time = new Date(timestamp);
    const diffMs = Date.now() - time.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins <= 0) return 'Updated just now';
    if (diffMins < 60) return `Updated ${diffMins}m ago`;
    return `Updated at ${time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  };

  const trustScore = currentUser?.trust_score ?? 100;

  const standing = useMemo(() => {
    if (trustScore >= 85) return { label: 'Good Standing', color: 'text-accent-green', bar: '#34D399' };
    if (trustScore >= 65) return { label: 'Review Needed', color: 'text-accent-yellow', bar: '#FBBF24' };
    return { label: 'Restricted', color: 'text-accent-red', bar: '#F87171' };
  }, [trustScore]);

  const calibrationBadge = useMemo(() => {
    const quality = currentUser?.calibration_quality;
    const variance = currentUser?.calibration_variance_pct ?? null;
    const calibratedAt = currentUser?.last_calibrated_at;

    if (!quality || !calibratedAt) {
      return null;
    }

    const ts = new Date(calibratedAt);
    const ageDays = Math.floor((Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24));
    const stale = ageDays >= 30;
    const rerunRecommended = quality === 'noisy' || stale;

    const tone = quality === 'excellent'
      ? 'text-accent-green'
      : quality === 'good'
        ? 'text-accent-blue'
        : 'text-accent-yellow';

    const label = quality.charAt(0).toUpperCase() + quality.slice(1);
    const subtitle = variance !== null
      ? `${label} • ${variance.toFixed(1)}% variance`
      : label;

    return {
      subtitle,
      tone,
      ts,
      ageDays,
      rerunRecommended,
    };
  }, [currentUser?.calibration_quality, currentUser?.calibration_variance_pct, currentUser?.last_calibrated_at]);

  return (
    <div className="screen-enter pb-nav bg-bg-page min-h-screen">
      <div className="pt-safe px-4 pt-5 pb-4">
        <div className="card rounded-3xl p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-black text-white"
                style={{ background: 'linear-gradient(135deg, #4F9CF9, #A78BFA)' }}
              >
                {currentUser?.username?.slice(0, 2).toUpperCase() || 'U'}
              </div>
              <div className="min-w-0">
                <h1 className="text-text-primary text-xl font-bold truncate">{currentUser?.username || 'Profile'}</h1>
                <p className="text-text-muted text-sm truncate">{currentUser?.email || 'No email set'}</p>
                {!!currentUser?.phone_number && <p className="text-text-muted text-xs mt-0.5">{currentUser.phone_number}</p>}
              </div>
            </div>
            <button
              onClick={() => navigate('/settings')}
              className="w-10 h-10 rounded-xl bg-bg-input border border-border flex items-center justify-center"
              aria-label="Open settings"
            >
              <Settings size={18} className="text-text-secondary" />
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-bg-input border border-border">
              <span className={`w-2 h-2 rounded-full ${isStepsSocketConnected ? 'bg-accent-green' : 'bg-accent-red'}`} />
              <span className={`text-[11px] font-semibold ${isStepsSocketConnected ? 'text-accent-green' : 'text-accent-red'}`}>
                {isStepsSocketConnected ? 'Live Sync Connected' : 'Live Sync Disconnected'}
              </span>
            </div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-bg-input border border-border">
              <span className={`w-2 h-2 rounded-full ${permissionStatus === 'granted' ? 'bg-accent-green' : 'bg-accent-yellow'}`} />
              <span className="text-[11px] font-semibold text-text-secondary">
                {permissionStatus === 'granted' ? 'Device Permission Enabled' : 'Device Permission Needed'}
              </span>
            </div>
          </div>
          <p className="text-text-muted text-[11px] mt-2">{formatLastUpdate(lastStepsUpdateAt)}</p>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <StatCard icon={<Footprints size={18} className="text-accent-blue" />} label="Total Steps" value={(currentUser?.total_steps || 0).toLocaleString()} />
          <StatCard icon={<Trophy size={18} className="text-accent-pink" />} label="Challenges Won" value={String(currentUser?.challenges_won || 0)} />
          <StatCard icon={<Wallet size={18} className="text-accent-yellow" />} label="Total Earned" value={`KSh ${parseFloat(currentUser?.total_earned || '0').toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
          <StatCard icon={<Flame size={18} className="text-accent-green" />} label="Current Streak" value={`${currentUser?.current_streak || 0} days`} />
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="card rounded-3xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck size={16} className="text-accent-blue" />
            <p className="text-sm font-semibold text-text-primary">Account Standing</p>
          </div>
          <p className={`text-sm font-semibold ${standing.color}`}>{standing.label}</p>
          <div className="w-full h-2 rounded-full bg-bg-input mt-2 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${trustScore}%`, backgroundColor: standing.bar }} />
          </div>
          <p className="text-xs text-text-muted mt-1">Trust score: {trustScore}/100</p>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="card rounded-3xl p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-text-primary">Stride Calibration</p>
            {calibrationBadge ? (
              <span className={`text-xs font-semibold ${calibrationBadge.tone}`}>{calibrationBadge.subtitle}</span>
            ) : (
              <span className="text-xs text-text-muted">Not calibrated yet</span>
            )}
          </div>

          {calibrationBadge ? (
            <>
              <p className="text-xs text-text-muted mt-1">
                Last calibrated: {calibrationBadge.ts.toLocaleDateString()} {calibrationBadge.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
              <p className={`text-xs mt-2 ${calibrationBadge.rerunRecommended ? 'text-accent-yellow' : 'text-text-secondary'}`}>
                {calibrationBadge.rerunRecommended
                  ? 'Recalibration recommended to improve precision.'
                  : `Calibration is stable (${calibrationBadge.ageDays} day${calibrationBadge.ageDays === 1 ? '' : 's'} old).`}
              </p>
            </>
          ) : (
            <p className="text-xs text-text-muted mt-2">Run the stride calibration wizard in Settings to improve distance and calorie precision.</p>
          )}
        </div>
      </div>

      <div className="px-4 pb-8">
        <div className="card rounded-3xl overflow-hidden">
          {[
            { icon: <Settings size={18} className="text-accent-blue" />, label: 'Open Settings', to: '/settings' },
            { icon: <Activity size={18} className="text-accent-green" />, label: 'Step Details', to: '/steps' },
            { icon: <Wallet size={18} className="text-accent-yellow" />, label: 'Wallet', to: '/wallet' },
            { icon: <Trophy size={18} className="text-accent-pink" />, label: 'Challenges', to: '/challenges' },
          ].map((item, idx, arr) => (
            <button
              key={item.label}
              onClick={() => navigate(item.to)}
              className={`w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-bg-input/60 transition-colors ${idx < arr.length - 1 ? 'border-b border-border' : ''}`}
            >
              <div className="w-9 h-9 rounded-xl bg-bg-input border border-border flex items-center justify-center">{item.icon}</div>
              <span className="flex-1 text-sm font-semibold text-text-primary">{item.label}</span>
              <ChevronRight size={18} className="text-text-muted" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="card rounded-2xl p-4">
      <div className="w-9 h-9 rounded-xl bg-bg-input border border-border flex items-center justify-center mb-2">{icon}</div>
      <p className="text-xs text-text-muted">{label}</p>
      <p className="text-text-primary text-lg font-bold mt-0.5 leading-tight">{value}</p>
    </div>
  );
}
