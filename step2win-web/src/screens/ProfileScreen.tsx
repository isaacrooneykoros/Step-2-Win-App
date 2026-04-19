import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  Settings,
  Wallet,
  Activity,
  UserCircle2,
  Smartphone,
  BarChart3,
  LifeBuoy,
  ShieldCheck,
  Database,
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
  const moderationAction = currentUser?.moderation_last_action || null;
  const moderationReviewedAt = currentUser?.moderation_reviewed_at || null;
  const moderationMessage = currentUser?.moderation_message || '';
  const standingLabel = useMemo(() => {
    if (trustScore >= 85) return 'Good Standing';
    if (trustScore >= 65) return 'Review Needed';
    return 'Restricted';
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
        <div className="card rounded-[2rem] p-5 overflow-hidden relative">
          <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-accent-blue/15 via-accent-purple/10 to-transparent pointer-events-none" />
          <div className="relative flex flex-col items-center text-center">
            <div className="relative">
              {currentUser?.profile_picture_url ? (
                <img
                  src={currentUser.profile_picture_url}
                  alt="Profile"
                  className="w-24 h-24 rounded-[2rem] object-cover shadow-soft ring-4 ring-white/70"
                />
              ) : (
                <div
                  className="w-24 h-24 rounded-[2rem] flex items-center justify-center text-3xl font-black text-white shadow-soft ring-4 ring-white/70"
                  style={{ background: 'linear-gradient(135deg, #4F9CF9, #A78BFA)' }}
                >
                  {currentUser?.username?.slice(0, 2).toUpperCase() || 'U'}
                </div>
              )}
              <button
                onClick={() => navigate('/settings')}
                className="absolute -right-1 -bottom-1 w-10 h-10 rounded-full bg-bg-elevated border border-border flex items-center justify-center shadow-soft"
                aria-label="Open settings"
              >
                <Settings size={18} className="text-text-secondary" />
              </button>
            </div>

            <div className="mt-4">
              <h1 className="text-text-primary text-2xl font-bold">{currentUser?.username || 'Profile'}</h1>
              <p className="text-text-muted text-sm mt-1">{currentUser?.email || 'No email set'}</p>
              {!!currentUser?.phone_number && <p className="text-text-muted text-xs mt-0.5">{currentUser.phone_number}</p>}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <BadgePill active={isStepsSocketConnected} activeLabel="Live Sync Connected" inactiveLabel="Live Sync Disconnected" />
              <BadgePill active={permissionStatus === 'granted'} activeLabel="Device Permission Enabled" inactiveLabel="Device Permission Needed" />
              <BadgePill active={true} activeLabel={standingLabel} inactiveLabel={standingLabel} neutral />
            </div>

            <p className="text-text-muted text-[11px] mt-3">{formatLastUpdate(lastStepsUpdateAt)}</p>
          </div>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="card rounded-3xl p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-sm font-semibold text-text-primary">Analytics</p>
            <button
              onClick={() => navigate('/profile/analytics')}
              className="text-xs text-accent-blue font-semibold"
            >
              Open Dashboard
            </button>
          </div>
          <p className="text-xs text-text-muted mb-4">
            Total steps, challenges won, earnings, streak performance, and account standing are now in Analytics.
          </p>
          <button
            onClick={() => navigate('/profile/analytics')}
            className="w-full btn-primary py-3 rounded-2xl"
          >
            View Analytics
          </button>
        </div>
      </div>

      {(moderationAction || moderationMessage) && (
        <div className="px-4 pb-4">
          <div className="card rounded-3xl p-4 border border-border">
            <div className="flex items-center gap-2 mb-2">
              <ShieldCheck size={16} className="text-accent-blue" />
              <p className="text-sm font-semibold text-text-primary">Moderation Update</p>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">
              {moderationMessage || 'Your flagged step activity was reviewed by the admin team.'}
            </p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[11px] text-text-muted uppercase tracking-wide">
                Decision: {String(moderationAction || 'reviewed').replace('_', ' ')}
              </span>
              <span className="text-[11px] text-text-muted">
                {moderationReviewedAt
                  ? new Date(moderationReviewedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                  : ''}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="px-4 pb-4">
        <div className="card rounded-3xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <UserCircle2 size={16} className="text-accent-blue" />
            <p className="text-sm font-semibold text-text-primary">Account Details</p>
          </div>

          <div className="space-y-2 text-sm">
            <InfoRow label="Email" value={currentUser?.email || 'Not set'} />
            <InfoRow label="Phone" value={currentUser?.phone_number || 'Not set'} />
            <InfoRow label="Player Rank" value={currentUser?.player_rank || 'Newcomer'} />
            <InfoRow
              label="Member Since"
              value={currentUser?.member_since ? new Date(currentUser.member_since).toLocaleDateString() : 'Unknown'}
            />
            <InfoRow label="Account Standing" value={`${standingLabel} (${trustScore}/100)`} />
          </div>

          <button
            onClick={() => navigate('/settings')}
            className="w-full btn-secondary py-3 rounded-2xl mt-4"
          >
            Edit Account Settings
          </button>
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

          <button
            onClick={() => navigate('/steps')}
            className="w-full btn-secondary py-3 rounded-2xl mt-4"
          >
            Open Step Details
          </button>
        </div>
      </div>

      <div className="px-4 pb-8">
        <div className="card rounded-3xl overflow-hidden">
          {[
            { icon: <BarChart3 size={18} className="text-accent-blue" />, label: 'Analytics Dashboard', to: '/profile/analytics' },
            { icon: <Smartphone size={18} className="text-accent-green" />, label: 'Active Sessions', to: '/profile/sessions' },
            { icon: <Database size={18} className="text-accent-blue" />, label: 'Sync Outbox', to: '/settings/sync-outbox' },
            { icon: <Wallet size={18} className="text-accent-yellow" />, label: 'Wallet', to: '/wallet' },
            { icon: <Activity size={18} className="text-accent-pink" />, label: 'Challenges', to: '/challenges' },
            { icon: <LifeBuoy size={18} className="text-accent-purple" />, label: 'Help & Support', to: '/support' },
            { icon: <Settings size={18} className="text-accent-blue" />, label: 'Open Settings', to: '/settings' },
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-input px-3 py-2.5">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="text-sm text-text-primary font-semibold text-right">{value}</span>
    </div>
  );
}

function BadgePill({
  active,
  activeLabel,
  inactiveLabel,
  neutral = false,
}: {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
  neutral?: boolean;
}) {
  const label = active ? activeLabel : inactiveLabel;
  const classes = neutral
    ? 'bg-bg-input border-border text-text-secondary'
    : active
      ? 'bg-tint-green border-border text-accent-green'
      : 'bg-tint-red border-border text-accent-red';

  return (
    <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-semibold ${classes}`}>
      {!neutral && <span className={`w-2 h-2 rounded-full ${active ? 'bg-accent-green' : 'bg-accent-red'}`} />}
      {neutral && <ShieldCheck size={12} />}
      {label}
    </span>
  );
}
