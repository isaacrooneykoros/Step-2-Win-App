import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Footprints,
  Trophy,
  DollarSign,
  Flame,
  TrendingUp,
  Calendar,
  Award,
  Star,
  BarChart2,
  Zap,
  Key,
  Shield,
  ShieldCheck,
  FileText,
  LifeBuoy,
  LogOut,
  Activity,
  ChevronRight,
  Smartphone,
} from 'lucide-react';
import { authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useStepsSyncStore } from '../store/stepsSyncStore';
import { useToast } from '../components/ui/Toast';
import { BaseModal } from '../components/ui/BaseModal';
import { useHealthSync } from '../hooks/useHealthSync';

function nextRankSteps(played: number): string {
  if (played < 3) return `${3 - played} more`;
  if (played < 10) return `${10 - played} more`;
  if (played < 25) return `${25 - played} more`;
  if (played < 50) return `${50 - played} more`;
  if (played < 100) return `${100 - played} more`;
  return '0 more';
}

export default function ProfileScreen() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { user, logout } = useAuthStore();
  const isStepsSocketConnected = useStepsSyncStore((state) => state.isStepsSocketConnected);
  const lastStepsUpdateAt = useStepsSyncStore((state) => state.lastStepsUpdateAt);
  const { syncHealth, isSyncing } = useHealthSync();
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: '',
  });

  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: authService.getProfile,
  });

  const { data: deviceStatus } = useQuery({
    queryKey: ['device-status'],
    queryFn: authService.getDeviceStatus,
  });

  const changePasswordMutation = useMutation({
    mutationFn: (data: any) => authService.changePassword(data),
    onSuccess: () => {
      setShowPasswordModal(false);
      setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });
      showToast({ message: 'Password updated successfully!', type: 'success' });
    },
    onError: (error: any) => {
      showToast({ message: error.response?.data?.error || 'Failed to update password', type: 'error' });
    },
  });

  const handlePasswordChange = () => {
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      showToast({ message: 'Passwords do not match', type: 'error' });
      return;
    }
    if (passwordForm.new_password.length < 6) {
      showToast({ message: 'Password must be at least 6 characters', type: 'error' });
      return;
    }
    changePasswordMutation.mutate({
      current_password: passwordForm.current_password,
      new_password: passwordForm.new_password,
    });
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const currentUser = profile || user;

  const formatLastUpdate = (timestamp: string | null) => {
    if (!timestamp) return 'No live updates yet';
    const time = new Date(timestamp);
    const diffMs = Date.now() - time.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins <= 0) return 'Updated just now';
    if (diffMins < 60) return `Updated ${diffMins}m ago`;
    return `Updated at ${time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  };

  const RANK_CONFIG = {
    Newcomer: { color: '#9CA3AF', tint: '#F9FAFB', emoji: '🌱' },
    Challenger: { color: '#4F9CF9', tint: '#EFF6FF', emoji: '⚡' },
    Competitor: { color: '#A78BFA', tint: '#F5F3FF', emoji: '🎯' },
    Veteran: { color: '#FBBF24', tint: '#FFFBEB', emoji: '🏅' },
    Elite: { color: '#F472B6', tint: '#FDF2F8', emoji: '💎' },
    Champion: { color: '#34D399', tint: '#ECFDF5', emoji: '🏆' },
  };

  const rank = currentUser?.player_rank || 'Newcomer';
  const rankConfig = RANK_CONFIG[rank] || RANK_CONFIG.Newcomer;
  const winRate = currentUser?.win_rate || 0;
  const played = currentUser?.challenges_joined || 0;
  const won = currentUser?.challenges_won || 0;

  return (
    <div className="screen-enter pb-nav bg-bg-page">
      {/* ── AVATAR HERO ────────────────────────── */}
      <div className="flex flex-col items-center pt-safe pt-8 pb-6 px-4">
        <div className="relative mb-4">
          <div
            className="w-28 h-28 rounded-full flex items-center justify-center text-3xl font-black text-white"
            style={{
              background: 'linear-gradient(135deg, #4F9CF9, #A78BFA)',
            }}
          >
            {currentUser?.username?.slice(0, 2).toUpperCase() || 'U'}
          </div>
          <div className="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-accent-green border-4 border-white flex items-center justify-center">
            <div className="w-2.5 h-2.5 rounded-full bg-white" />
          </div>
        </div>
        <h2 className="text-text-primary text-xl font-bold">{currentUser?.username}</h2>
        <p className="text-text-muted text-sm mt-1">{currentUser?.email}</p>
        <div className="mt-2 inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-bg-input">
          <span className={`w-2 h-2 rounded-full ${isStepsSocketConnected ? 'bg-accent-green' : 'bg-accent-red'}`} />
          <span className={`text-[11px] font-semibold ${isStepsSocketConnected ? 'text-accent-green' : 'text-accent-red'}`}>
            {isStepsSocketConnected ? 'Live Sync Connected' : 'Live Sync Disconnected'}
          </span>
        </div>
        <p className="text-text-muted text-[11px] mt-1">{formatLastUpdate(lastStepsUpdateAt)}</p>
      </div>

      {/* ── Performance Overview ── */}
      <div className="px-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[#111827] text-base font-bold">Performance Overview</h2>
          <div
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full"
            style={{ background: rankConfig.tint, border: `1px solid ${rankConfig.color}25` }}
          >
            <span style={{ fontSize: '13px' }}>{rankConfig.emoji}</span>
            <span className="text-xs font-bold" style={{ color: rankConfig.color }}>
              {rank}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="rounded-2xl p-4" style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: '#EFF6FF' }}>
              <BarChart2 size={18} color="#4F9CF9" />
            </div>
            <p className="text-[#9CA3AF] text-xs font-medium">Challenges Played</p>
            <p className="text-[#111827] text-2xl font-bold mt-0.5">{played}</p>
            <p className="text-[#9CA3AF] text-xs mt-1">{played === 0 ? 'Join your first!' : `${won} won`}</p>
          </div>

          <div className="rounded-2xl p-4" style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: '#FDF2F8' }}>
              <Trophy size={18} color="#F472B6" />
            </div>
            <p className="text-[#9CA3AF] text-xs font-medium">Challenges Won</p>
            <p className="text-[#111827] text-2xl font-bold mt-0.5">{won}</p>
            <p className="text-[#9CA3AF] text-xs mt-1">
              {won === 0 ? 'Keep going!' : won === 1 ? 'First win! 🎉' : 'Keep winning!'}
            </p>
          </div>
        </div>

        <div className="rounded-2xl p-4 mb-3" style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: '#ECFDF5' }}>
                <TrendingUp size={14} color="#34D399" />
              </div>
              <p className="text-[#111827] text-sm font-bold">Win Rate</p>
            </div>
            <p className="text-[#111827] text-lg font-bold" style={{ fontFamily: 'DM Serif Display, serif' }}>
              {winRate.toFixed(1)}%
            </p>
          </div>
          <div className="w-full h-2.5 rounded-full" style={{ background: '#F3F4F6' }}>
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${winRate}%`,
                background:
                  winRate >= 50
                    ? 'linear-gradient(90deg, #34D399, #10B981)'
                    : winRate >= 25
                      ? 'linear-gradient(90deg, #FBBF24, #F59E0B)'
                      : '#E5E7EB',
              }}
            />
          </div>
          <p className="text-[#9CA3AF] text-xs mt-2">
            {played === 0
              ? 'Play your first challenge to see your win rate'
              : `${won} win${won !== 1 ? 's' : ''} from ${played} challenge${played !== 1 ? 's' : ''}`}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="rounded-2xl p-4" style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: '#EFF6FF' }}>
              <Footprints size={18} color="#4F9CF9" />
            </div>
            <p className="text-[#9CA3AF] text-xs font-medium">Total Steps</p>
            <p className="text-[#111827] text-2xl font-bold mt-0.5">{(currentUser?.total_steps || 0).toLocaleString()}</p>
            <p className="text-[#9CA3AF] text-xs mt-1">
              {currentUser?.best_day_steps && currentUser.best_day_steps > 0
                ? `Best day: ${currentUser.best_day_steps.toLocaleString()}`
                : 'Lifetime total'}
            </p>
          </div>

          <div className="rounded-2xl p-4" style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: '#FFFBEB' }}>
              <DollarSign size={18} color="#FBBF24" />
            </div>
            <p className="text-[#9CA3AF] text-xs font-medium">Total Earned</p>
            <p className="text-[#111827] font-bold mt-0.5" style={{ fontSize: '18px', fontFamily: 'DM Serif Display, serif' }}>
              KSh {parseFloat(currentUser?.total_earned || '0').toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="text-[#9CA3AF] text-xs mt-1">
              {won > 0
                ? `Avg KSh ${parseFloat(currentUser?.avg_payout_kes || '0').toLocaleString('en-KE', { minimumFractionDigits: 2 })} / win`
                : 'From challenge wins'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="rounded-2xl p-4" style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: '#FDF2F8' }}>
              <Star size={18} color="#F472B6" />
            </div>
            <p className="text-[#9CA3AF] text-xs font-medium">Best Streak</p>
            <p className="text-[#111827] text-2xl font-bold mt-0.5">
              {currentUser?.best_streak || 0}
              <span className="text-sm font-medium text-[#9CA3AF]"> days</span>
            </p>
            <p className="text-[#9CA3AF] text-xs mt-1">Personal record</p>
          </div>

          <div className="rounded-2xl p-4" style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: '#ECFDF5' }}>
              <Flame size={18} color="#34D399" />
            </div>
            <p className="text-[#9CA3AF] text-xs font-medium">Current Streak</p>
            <p className="text-[#111827] text-2xl font-bold mt-0.5">
              {currentUser?.current_streak || 0}
              <span className="text-sm font-medium text-[#9CA3AF]"> days</span>
            </p>
            <p className="text-[#9CA3AF] text-xs mt-1">
              {(currentUser?.current_streak || 0) >= 7
                ? 'On fire! 🔥'
                : (currentUser?.current_streak || 0) > 0
                  ? 'Keep it up!'
                  : 'Start today!'}
            </p>
          </div>
        </div>

        <div className="rounded-2xl overflow-hidden" style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
          {[
            {
              icon: <Calendar size={15} color="#A78BFA" />,
              tint: '#F5F3FF',
              label: 'Member Since',
              value: currentUser?.member_since || 'Loading...',
            },
            {
              icon: <Award size={15} color={rankConfig.color} />,
              tint: rankConfig.tint,
              label: 'Player Rank',
              value: `${rankConfig.emoji} ${rank}`,
              note: played < 100 ? `${nextRankSteps(played)} challenges to next rank` : 'Max rank achieved!',
            },
            {
              icon: <Zap size={15} color="#FBBF24" />,
              tint: '#FFFBEB',
              label: 'Avg Payout / Win',
              value: won > 0
                ? `KSh ${parseFloat(currentUser?.avg_payout_kes || '0').toLocaleString('en-KE', { minimumFractionDigits: 2 })}`
                : '—',
              note: won === 0 ? 'Win a challenge to see this' : undefined,
            },
          ].map((item, i, arr) => (
            <div
              key={item.label}
              className={`flex items-center gap-3 px-4 py-3.5 ${i < arr.length - 1 ? 'border-b border-[#F3F4F6]' : ''}`}
            >
              <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: item.tint }}>
                {item.icon}
              </div>
              <div className="flex-1">
                <p className="text-[#9CA3AF] text-xs">{item.label}</p>
                <p className="text-[#111827] text-sm font-bold">{item.value}</p>
                {item.note && <p className="text-[#9CA3AF] text-xs">{item.note}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── First-time nudge (show only if no challenges played) ── */}
      {played === 0 && (
        <div
          className="mx-4 mb-4 rounded-2xl p-4 flex items-center gap-3"
          style={{ background: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)', border: '1px solid #BFDBFE' }}
        >
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: '#4F9CF9' }}
          >
            <Trophy size={20} color="#FFFFFF" />
          </div>
          <div className="flex-1">
            <p className="text-[#111827] text-sm font-bold">Ready to compete?</p>
            <p className="text-[#6B7280] text-xs leading-relaxed mt-0.5">
              Join your first challenge to start building your record.
            </p>
          </div>
          <button
            onClick={() => navigate('/challenges')}
            className="px-3 py-2 rounded-xl text-white text-xs font-bold flex-shrink-0"
            style={{ background: '#4F9CF9' }}
          >
            Join
          </button>
        </div>
      )}

      {/* ── DEVICE CARD ────────────────────────── */}
      <div className="px-4 pb-4">
        <div className="card rounded-3xl p-5">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-tint-green flex items-center justify-center flex-shrink-0">
              <Activity size={24} strokeWidth={2.5} className="text-accent-green" />
            </div>
            <div className="flex-1">
              <h3 className="text-text-primary font-bold mb-1">Fitness Device</h3>
              <p className="text-text-muted text-xs mb-1.5">Tracking: Steps • Distance • Calories • Active Minutes</p>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${
                  deviceStatus?.bound ? 'bg-accent-green' : 'bg-accent-red'
                }`} />
                <span className={`text-sm font-medium ${
                  deviceStatus?.bound ? 'text-accent-green' : 'text-accent-red'
                }`}>
                  {deviceStatus?.bound ? 'Connected' : 'Not Connected'}
                </span>
              </div>
            </div>
            <button
              onClick={syncHealth}
              className="px-4 py-2 rounded-xl text-sm font-bold text-accent-blue bg-tint-blue"
            >
              {isSyncing ? 'Syncing…' : 'Sync'}
            </button>
          </div>
        </div>
      </div>

      {/* ── TRUST CARD ────────────────────────── */}
      {profile?.trust_score !== undefined && (
        <div className="px-4 pb-4">
          <div className="card rounded-3xl p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-xl bg-tint-blue flex items-center justify-center">
                <ShieldCheck size={18} className="text-accent-blue" />
              </div>
              <div className="flex-1">
                <p className="text-text-primary text-sm font-bold">Account Standing</p>
                <p className="text-text-muted text-xs">Updated after each sync</p>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                profile.trust_score > 80 ? 'bg-tint-green text-accent-green' :
                profile.trust_score > 60 ? 'bg-tint-yellow text-accent-yellow' :
                                          'bg-red-50 text-red-500'
              }`}>
                {profile.trust_score > 80 ? '✓ Good Standing' :
                 profile.trust_score > 60 ? '⚠ Under Review' : '⛔ Restricted'}
              </span>
            </div>

            <div className="progress-track h-2 mb-1.5 bg-gray-200 rounded-full">
              <div className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${profile.trust_score}%`,
                  background: profile.trust_score > 80 ? '#34D399' :
                              profile.trust_score > 60 ? '#FBBF24' : '#F87171',
                }} />
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted text-xs">Trust Score</span>
              <span className="text-text-primary text-xs font-bold">{profile.trust_score}/100</span>
            </div>
            {profile.trust_score <= 80 && (
              <p className="mt-3 text-xs text-text-muted bg-bg-input rounded-lg p-2.5">
                Score recovers automatically with normal daily activity.
                Contact support if you believe this is an error.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── SETTINGS MENU ────────────────────────── */}
      <div className="px-4 pb-4">
        <div className="card rounded-3xl overflow-hidden">
          {[
            { icon: Key, label: 'Change Password', iconColor: 'text-accent-blue', bgColor: 'bg-tint-blue', onClick: () => setShowPasswordModal(true) },
            { icon: Smartphone, label: 'Active Devices', iconColor: 'text-accent-purple', bgColor: 'bg-tint-purple', onClick: () => navigate('/profile/sessions') },
            { icon: LifeBuoy, label: 'Support Center', iconColor: 'text-accent-green', bgColor: 'bg-tint-green', onClick: () => navigate('/support') },
            { icon: Shield, label: 'Privacy Policy', iconColor: 'text-accent-purple', bgColor: 'bg-tint-purple', onClick: () => setShowPrivacyModal(true) },
            { icon: FileText, label: 'Terms of Service', iconColor: 'text-accent-purple', bgColor: 'bg-tint-purple', onClick: () => setShowTermsModal(true) },
            { icon: LogOut, label: 'Logout', iconColor: 'text-accent-red', bgColor: 'bg-tint-red', onClick: handleLogout, danger: true },
          ].map(({ icon: Icon, label, iconColor, bgColor, onClick, danger }, i, arr) => (
            <button
              key={label}
              onClick={onClick}
              className={`w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-gray-50 transition-colors ${
                i < arr.length - 1 ? 'border-b border-border' : ''
              }`}
            >
              <div className={`w-10 h-10 rounded-full ${bgColor} flex items-center justify-center flex-shrink-0`}>
                <Icon size={18} strokeWidth={2.5} className={iconColor} />
              </div>
              <span className={`flex-1 font-bold text-sm ${
                danger ? 'text-accent-red' : 'text-text-primary'
              }`}>
                {label}
              </span>
              <ChevronRight size={20} className="text-text-muted" />
            </button>
          ))}
        </div>
      </div>

      {/* ── PASSWORD MODAL ────────────────────────── */}
      <BaseModal open={showPasswordModal} onClose={() => setShowPasswordModal(false)}>
        <h2 className="text-2xl font-black text-text-primary mb-2">Change Password</h2>
        <p className="text-sm text-text-muted mb-6">Update your account password</p>

        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-semibold text-text-secondary mb-2">Current Password</label>
            <input
              type="password"
              value={passwordForm.current_password}
              onChange={(e) => setPasswordForm({ ...passwordForm, current_password: e.target.value })}
              placeholder="Enter current password"
              className="input-field w-full"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-text-secondary mb-2">New Password</label>
            <input
              type="password"
              value={passwordForm.new_password}
              onChange={(e) => setPasswordForm({ ...passwordForm, new_password: e.target.value })}
              placeholder="Enter new password"
              className="input-field w-full"
            />
            <p className="text-xs text-text-muted mt-2">Minimum 6 characters</p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-text-secondary mb-2">Confirm New Password</label>
            <input
              type="password"
              value={passwordForm.confirm_password}
              onChange={(e) => setPasswordForm({ ...passwordForm, confirm_password: e.target.value })}
              placeholder="Confirm new password"
              className="input-field w-full"
            />
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => setShowPasswordModal(false)}
            className="flex-1 btn-secondary py-3 rounded-2xl"
          >
            Cancel
          </button>
          <button
            onClick={handlePasswordChange}
            disabled={changePasswordMutation.isPending}
            className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40"
          >
            {changePasswordMutation.isPending ? 'Updating...' : 'Update'}
          </button>
        </div>
      </BaseModal>

      {/* ── PRIVACY MODAL ────────────────────────── */}
      <BaseModal open={showPrivacyModal} onClose={() => setShowPrivacyModal(false)}>
        <h2 className="text-2xl font-black text-text-primary mb-2">Privacy Policy</h2>
        <div className="space-y-3 text-sm text-text-muted max-h-96 overflow-y-auto">
          <p>
            <strong className="text-text-primary">Last updated:</strong> March 1, 2026
          </p>
          <p>
            Step2Win is committed to protecting your privacy. This policy explains how we collect, use, and safeguard your information when using our platform.
          </p>
          <h3 className="text-text-primary font-bold mt-4">Information We Collect</h3>
          <p>We collect account details, step data, challenge activity, and payment data needed to operate the app.</p>
          <h3 className="text-text-primary font-bold mt-4">How We Use Information</h3>
          <p>We use your data for challenge tracking, wallet operations, and account-related communication.</p>
          <h3 className="text-text-primary font-bold mt-4">Data Security</h3>
          <p>We apply security controls, but no internet transmission method is fully risk-free.</p>
        </div>
        <button
          onClick={() => setShowPrivacyModal(false)}
          className="w-full btn-primary py-3 rounded-2xl mt-6"
        >
          Got it
        </button>
      </BaseModal>

      {/* ── TERMS MODAL ────────────────────────── */}
      <BaseModal open={showTermsModal} onClose={() => setShowTermsModal(false)}>
        <h2 className="text-2xl font-black text-text-primary mb-2">Terms of Service</h2>
        <div className="space-y-3 text-sm text-text-muted max-h-96 overflow-y-auto">
          <p>
            By using Step2Win, you agree to fair challenge participation, accurate account details, and responsible wallet usage.
          </p>
          <h3 className="text-text-primary font-bold mt-4">Challenge Rules</h3>
          <p>Entry fees are locked during active challenges. Payouts are distributed based on qualification and rank.</p>
          <h3 className="text-text-primary font-bold mt-4">Account Responsibility</h3>
          <p>You are responsible for account security and all activity under your credentials.</p>
          <h3 className="text-text-primary font-bold mt-4">Wallet & Withdrawals</h3>
          <p>Withdrawals may require review and can be delayed for verification and fraud prevention.</p>
        </div>
        <button
          onClick={() => setShowTermsModal(false)}
          className="w-full btn-primary py-3 rounded-2xl mt-6"
        >
          Accept
        </button>
      </BaseModal>
    </div>
  );
}
