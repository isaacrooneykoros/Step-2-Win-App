import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Footprints, Trophy, Wallet, Flame, ChevronRight, Zap, Compass, Target, X, CheckCircle } from 'lucide-react';
import { stepsService, challengesService, gamificationService, walletService } from '../services/api';
import { usersService } from '../services/api/users';
import { useAuthStore } from '../store/authStore';
import { useStepsSyncStore } from '../store/stepsSyncStore';
import { StepStatChips } from '../components/ui/StepStatChips';
import type { Challenge } from '../types';
import { formatKES } from '../utils/currency';

export default function HomeScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const updateUser = useAuthStore((state) => state.updateUser);
  const isStepsSocketConnected = useStepsSyncStore((state) => state.isStepsSocketConnected);
  const lastStepsUpdateAt = useStepsSyncStore((state) => state.lastStepsUpdateAt);

  const [goalModalOpen, setGoalModalOpen] = useState(false);
  const [goalInput, setGoalInput] = useState('');
  const [goalSaving, setGoalSaving] = useState(false);
  const [goalError, setGoalError] = useState('');
  const [goalSuccess, setGoalSuccess] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);

  const { data: todayData, isLoading: loadingToday } = useQuery({
    queryKey: ['health', 'today'],
    queryFn: stepsService.getTodayHealth,
  });

  const { data: weeklyData, isLoading: loadingWeekly } = useQuery({
    queryKey: ['steps', 'weekly'],
    queryFn: stepsService.getWeekly,
  });

  const { data: myChallenges = [], isLoading: loadingChallenges } = useQuery({
    queryKey: ['challenges', 'my'],
    queryFn: challengesService.getMyChallenges,
  });

  const { data: myBadges = [] } = useQuery({
    queryKey: ['gamification', 'badges', 'my'],
    queryFn: gamificationService.getMyBadges,
  });

  const { data: walletSummary } = useQuery({
    queryKey: ['wallet', 'summary'],
    queryFn: walletService.getSummary,
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
  });

  const { data: myResults } = useQuery({
    queryKey: ['challenges', 'my-results'],
    queryFn: () => challengesService.getMyRecentResults(),
    staleTime: 5 * 60 * 1000,
  });

  const activeChallenge = Array.isArray(myChallenges)
    ? myChallenges.find((c: Challenge) => c.status === 'active')
    : undefined;

  const liveWalletBalance = (walletSummary?.balance || user?.wallet_balance || '0').toString();

  const steps = todayData?.steps || 0;
  const stepGoal = activeChallenge?.milestone || user?.daily_goal || 10000;
  const progress = Math.max(0, Math.min(1, stepGoal > 0 ? steps / stepGoal : 0));
  const pct = Math.round(progress * 100);
  // const today = new Date().toISOString().split('T')[0];
  const days = weeklyData || [];

  const streak = 5;
  const weekTotal = days.reduce((sum, d) => sum + d.steps, 0);
  const todayIndex = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  const getDaysSince = (startDate: string) => {
    const start = new Date(startDate);
    const currentDate = new Date();
    const diffTime = Math.abs(currentDate.getTime() - start.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  };

  const formatLastUpdate = (timestamp: string | null) => {
    if (!timestamp) return 'No live updates yet';
    const time = new Date(timestamp);
    const diffMs = Date.now() - time.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins <= 0) return 'Updated just now';
    if (diffMins < 60) return `Updated ${diffMins}m ago`;
    return `Updated at ${time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  };

  const handleSaveGoal = async () => {
    const parsed = parseInt(goalInput, 10);
    if (isNaN(parsed) || parsed < 1000 || parsed > 60000) {
      setGoalError('Enter a goal between 1,000 and 60,000 steps');
      return;
    }

    setGoalSaving(true);
    setGoalError('');

    try {
      await usersService.updateDailyGoal(parsed);
      if (user) {
        updateUser({ ...user, daily_goal: parsed });
      }
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      setGoalSuccess(true);
      setTimeout(() => {
        setGoalSuccess(false);
        setGoalModalOpen(false);
        setGoalInput('');
      }, 1200);
    } catch (err: any) {
      setGoalError(err?.response?.data?.error || 'Could not update goal. Try again.');
    } finally {
      setGoalSaving(false);
    }
  };

  const openGoalModal = () => {
    setGoalInput(String(user?.daily_goal || 10000));
    setGoalError('');
    setGoalSuccess(false);
    setGoalModalOpen(true);
  };

  if (loadingToday || loadingWeekly || loadingChallenges) {
    return (
      <div className="screen-enter pt-safe pb-nav">
        <div className="px-5 pt-3 pb-3">
          <div className="skeleton h-4 w-32 mb-2 rounded-lg" />
          <div className="skeleton h-8 w-48 rounded-lg" />
        </div>
        <div className="px-4 mb-3">
          <div className="skeleton h-20 rounded-3xl" />
        </div>
        <div className="px-4 mb-3">
          <div className="skeleton h-80 rounded-4xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="screen-enter pb-nav bg-bg-page">
      {/*  HEADER  */}
      <div className="pt-safe px-6 pt-4 pb-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-text-muted text-xs font-medium">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          </p>
          <h1 className="text-text-primary text-2xl font-bold leading-tight mt-1">
            {getGreeting()}, {user?.username}
          </h1>
          <div className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-bg-input border border-border">
            <span className={`w-2 h-2 rounded-full ${isStepsSocketConnected ? 'bg-accent-green' : 'bg-accent-red'}`} />
            <span className={`text-[11px] font-semibold ${isStepsSocketConnected ? 'text-accent-green' : 'text-accent-red'}`}>
              {isStepsSocketConnected ? 'Live Sync Connected' : 'Live Sync Disconnected'}
            </span>
          </div>
          <p className="text-text-muted text-[11px] mt-1">{formatLastUpdate(lastStepsUpdateAt)}</p>
        </div>
        {/* Wallet balance pill */}
        <div 
          className="bg-tint-yellow border border-yellow-100 rounded-full px-4 py-2 flex items-center gap-2 cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => navigate('/wallet')}
        >
          <Wallet size={16} className="text-yellow-600" />
          <span className="font-mono font-semibold text-yellow-700 text-sm">
            {formatKES(liveWalletBalance)}
          </span>
        </div>
      </div>

      {/*  2x2 STATS GRID  */}
      <div className="px-4 mb-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Steps Card */}
        <Link to="/steps" className="card rounded-3xl p-5 shadow-sm block active:scale-98 transition-transform">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-full bg-accent-blue/10 flex items-center justify-center">
              <Footprints size={20} className="text-accent-blue" />
            </div>
            <span className="text-text-secondary text-sm font-medium">Today's Steps</span>
          </div>
          <p className="text-3xl font-black text-text-primary mb-1">
            {steps.toLocaleString()}
          </p>
          <div className="h-2 bg-bg-input rounded-full overflow-hidden mb-2">
            <div 
              className="h-full bg-accent-blue rounded-full transition-all duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
              <p className="text-text-muted text-xs">
                {steps >= stepGoal
                  ? 'Goal reached!'
                  : `${Math.max(stepGoal - steps, 0).toLocaleString()} steps to go`}
          </p>
          <StepStatChips
            distance={todayData?.distance_km}
            calories={todayData?.calories_active}
            activeMins={todayData?.active_minutes}
          />
          <div className="flex items-center justify-between mt-2">
            <p className="text-text-muted text-xs">Tap for details</p>
            <ChevronRight size={14} className="text-text-muted" />
          </div>
        </Link>

        {/* Challenge Card */}
        <div className="card rounded-3xl p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-full bg-accent-pink/10 flex items-center justify-center">
              <Trophy size={20} className="text-accent-pink" />
            </div>
            <span className="text-text-secondary text-sm font-medium">Challenge</span>
          </div>
          {activeChallenge ? (
            <>
              <p className="text-lg font-bold text-text-primary mb-1 line-clamp-2 leading-tight">
                {activeChallenge.name}
              </p>
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-pink" />
                <span>Day {getDaysSince(activeChallenge.start_date)} of 7</span>
              </div>
            </>
          ) : (
            <>
              <p className="text-lg font-bold text-text-primary mb-1">
                No Active
              </p>
              <p className="text-xs text-text-muted">
                Join a challenge to compete
              </p>
            </>
          )}
        </div>

        {/* Pool Card */}
        <div className="card rounded-3xl p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-full bg-accent-yellow/10 flex items-center justify-center">
              <Wallet size={20} className="text-accent-yellow" />
            </div>
            <span className="text-text-secondary text-sm font-medium">Prize Pool</span>
          </div>
          <p className="text-3xl font-black text-text-primary mb-1">
            {formatKES(activeChallenge ? activeChallenge.total_pool || '0' : '0')}
          </p>
          <p className="text-text-muted text-xs">
            {activeChallenge ? `Est. payout: ${formatKES(parseFloat(activeChallenge.total_pool || '0') * 0.35)}` : 'Join to compete'}
          </p>
        </div>

        {/* Streak Card */}
        <div className="card rounded-3xl p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-full bg-accent-green/10 flex items-center justify-center">
              <Flame size={20} className="text-accent-green" />
            </div>
            <span className="text-text-secondary text-sm font-medium">Streak</span>
          </div>
          <p className="text-3xl font-black text-text-primary mb-1 flex items-center gap-1">
            {streak}
            {streak >= 7 && <Flame className="w-6 h-6 text-orange-500" />}
            {streak >= 3 && streak < 7 && <Zap className="w-6 h-6 text-blue-400" />}
          </p>
          <p className="text-text-muted text-xs">
            {streak > 0 ? 'Keep it going!' : 'Start your streak'}
          </p>
        </div>
      </div>

      {/*  WEEKLY CHART  */}
      <div className="px-4 mb-4">
        <div className="card rounded-3xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-text-primary font-bold text-base">This Week</h3>
            <span className="font-mono text-text-secondary text-sm font-semibold">
              {weekTotal.toLocaleString()}
            </span>
          </div>
          <div className="flex items-end gap-2" style={{ height: 120 }}>
            {days.map((day, i) => {
              const maxSteps = Math.max(...days.map(d => d.steps), 1);
              const barH = Math.max((day.steps / maxSteps) * 96, 8);
              const isToday = i === todayIndex;
              const hasSteps = day.steps > 0;
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-2">
                  <span className="text-[10px] font-medium text-text-muted h-4 flex items-center">
                    {hasSteps ? (
                      day.steps >= 1000 ? `${(day.steps/1000).toFixed(1)}k` : day.steps
                    ) : ''}
                  </span>
                  <div 
                    className="w-full rounded-lg transition-all duration-700 ease-out"
                    style={{
                      height: `${barH}px`,
                      minHeight: 8,
                      backgroundColor: isToday
                        ? '#4F9CF9'
                        : hasSteps
                          ? '#BFDBFE'
                          : '#F3F4F6',
                    }}
                  />
                  <span className={`text-xs font-medium ${
                    isToday ? 'text-accent-blue' : 'text-text-muted'
                  }`}>
                    {['M','T','W','T','F','S','S'][i]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/*  Quick Actions  */}
      <div className="px-4 mb-6">
        <h2 className="text-text-primary font-bold text-base mb-3">Quick Actions</h2>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <button
            onClick={() => navigate('/challenges')}
            className="flex flex-col items-center gap-2 p-4 rounded-2xl active:scale-95 transition-transform"
            style={{ background: '#4F9CF9', boxShadow: '0 4px 14px rgba(79,156,249,0.35)' }}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(255,255,255,0.2)' }}
            >
              <Trophy size={20} color="#FFFFFF" />
            </div>
            <p className="text-white text-xs font-bold text-center leading-tight">Join{'\n'}Challenge</p>
          </button>

          <button
            onClick={() => navigate('/challenges/lobby')}
            className="card flex flex-col items-center gap-2 p-4 rounded-2xl active:scale-95 transition-transform"
            style={{
              boxShadow: '0 1px 6px rgba(0,0,0,0.08)',
            }}
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: '#F5F3FF' }}>
              <Compass size={20} color="#A78BFA" />
            </div>
            <p className="text-text-primary text-xs font-bold text-center leading-tight">Discover{'\n'}Lobby</p>
          </button>

          <button
            onClick={() => {
              if (myResults?.has_results) {
                setResultsOpen(true);
              } else {
                navigate('/challenges');
              }
            }}
            className="card flex flex-col items-center gap-2 p-4 rounded-2xl active:scale-95 transition-transform relative"
            style={{
              boxShadow: '0 1px 6px rgba(0,0,0,0.08)',
            }}
          >
            {myResults?.has_results && myResults?.my_result?.payout_kes && Number(myResults.my_result.payout_kes) > 0 && (
              <div
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-white"
                style={{ background: '#34D399', fontSize: '8px', fontWeight: 700 }}
              >
                
              </div>
            )}
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: '#FDF2F8' }}>
              <Trophy size={20} color="#F472B6" />
            </div>
            <p className="text-text-primary text-xs font-bold text-center leading-tight">My{'\n'}Results</p>
          </button>

          <button
            onClick={openGoalModal}
            className="card flex flex-col items-center gap-2 p-4 rounded-2xl active:scale-95 transition-transform"
            style={{
              boxShadow: '0 1px 6px rgba(0,0,0,0.08)',
            }}
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: '#FFFBEB' }}>
              <Target size={20} color="#FBBF24" />
            </div>
            <p className="text-text-primary text-xs font-bold text-center leading-tight">Daily{'\n'}Goal</p>
            <p className="text-text-muted" style={{ fontSize: '9px', marginTop: '-4px' }}>
              {((user?.daily_goal || 10000) / 1000).toFixed(0)}K steps
            </p>
          </button>
        </div>
      </div>

      {/*  EARNED BADGES  */}
      {myBadges.length > 0 && (
        <div className="px-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-text-primary font-bold text-base">Achievements</h3>
            <span className="text-accent-yellow text-sm font-bold">{myBadges.length}</span>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {myBadges.slice(0, 4).map((userBadge) => (
              <div 
                key={userBadge.id}
                className="card rounded-2xl p-3 shadow-sm flex flex-col items-center justify-center text-center hover:shadow-md transition-shadow"
                title={userBadge.badge.name}
              >
                <span className="text-2xl mb-1.5">{userBadge.badge.icon}</span>
                <span className="text-text-muted text-[10px] font-semibold uppercase tracking-tight leading-tight line-clamp-2">
                  {userBadge.badge.name}
                </span>
              </div>
            ))}
            {myBadges.length > 4 && (
              <button 
                onClick={() => navigate('/profile')}
                className="card rounded-2xl p-3 shadow-sm flex flex-col items-center justify-center text-center hover:shadow-md transition-shadow"
              >
                <span className="text-xl font-bold text-accent-blue">+{myBadges.length - 4}</span>
                <span className="text-text-muted text-[10px] font-semibold uppercase tracking-tight">More</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/*  Daily Goal Modal  */}
      {goalModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)' }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setGoalModalOpen(false);
          }}
        >
          <div className="w-full rounded-t-3xl p-6 modal-enter" style={{ background: 'hsl(var(--bg-card))', maxWidth: '480px' }}>
            <div className="w-10 h-1 rounded-full mx-auto mb-5" style={{ background: '#E5E7EB' }} />

            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-[#111827] text-lg font-bold">Daily Step Goal</h3>
                <p className="text-[#9CA3AF] text-xs mt-0.5">
                  Sets your personal target  separate from challenge milestones
                </p>
              </div>
              <button
                onClick={() => setGoalModalOpen(false)}
                className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: '#F3F4F6' }}
              >
                <X size={16} color="#6B7280" />
              </button>
            </div>

            <div className="flex gap-2 mb-4">
              {[5000, 8000, 10000, 12000, 15000].map((preset) => (
                <button
                  key={preset}
                  onClick={() => setGoalInput(String(preset))}
                  className="flex-1 py-2 rounded-xl text-xs font-bold transition-all"
                  style={{
                    background: goalInput === String(preset) ? '#4F9CF9' : '#F3F4F6',
                    color: goalInput === String(preset) ? '#FFFFFF' : '#6B7280',
                  }}
                >
                  {preset >= 1000 ? `${preset / 1000}K` : preset}
                </button>
              ))}
            </div>

            <div className="mb-2">
              <label className="text-[#6B7280] text-xs font-medium mb-1.5 block">Or enter a custom goal</label>
              <div
                className="flex items-center gap-3 px-4 py-3 rounded-xl"
                style={{
                  background: '#F3F4F6',
                  border: goalError ? '1.5px solid #F87171' : '1.5px solid transparent',
                }}
              >
                <Target size={16} color="#9CA3AF" />
                <input
                  type="number"
                  value={goalInput}
                  onChange={(e) => {
                    setGoalInput(e.target.value);
                    setGoalError('');
                  }}
                  placeholder="e.g. 12000"
                  min={1000}
                  max={60000}
                  className="flex-1 text-[#111827] text-sm font-bold bg-transparent outline-none"
                />
                <span className="text-[#9CA3AF] text-xs">steps</span>
              </div>
              {goalError && <p className="text-[#F87171] text-xs mt-1.5">{goalError}</p>}
            </div>

            <p className="text-[#9CA3AF] text-xs mb-5">
              Range: 1,000  60,000 steps  Current: {(user?.daily_goal || 10000).toLocaleString()} steps
            </p>

            {goalSuccess ? (
              <div
                className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2"
                style={{ background: '#ECFDF5' }}
              >
                <CheckCircle size={18} color="#34D399" />
                <span className="text-[#34D399] text-sm font-bold">Goal updated!</span>
              </div>
            ) : (
              <button
                onClick={handleSaveGoal}
                disabled={goalSaving || !goalInput}
                className="w-full py-3.5 rounded-xl text-white text-sm font-bold flex items-center justify-center gap-2 transition-opacity"
                style={{
                  background: '#4F9CF9',
                  boxShadow: '0 4px 14px rgba(79,156,249,0.3)',
                  opacity: goalSaving || !goalInput ? 0.6 : 1,
                }}
              >
                {goalSaving ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Target size={16} />
                    Set Goal to {parseInt(goalInput || '0', 10).toLocaleString() || ''} steps
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {/*  My Results Bottom Sheet  */}
      {resultsOpen && myResults?.has_results && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)' }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setResultsOpen(false);
          }}
        >
          <div
            className="w-full rounded-t-3xl modal-enter overflow-hidden"
            style={{ background: 'hsl(var(--bg-card))', maxWidth: '480px', maxHeight: '85vh' }}
          >
            <div className="w-10 h-1 rounded-full mx-auto mt-4 mb-1" style={{ background: '#E5E7EB' }} />

            <div className="overflow-y-auto" style={{ maxHeight: 'calc(85vh - 32px)' }}>
              <div className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-[#111827] text-lg font-bold">Latest Results</h3>
                    <p className="text-[#9CA3AF] text-xs">{myResults.challenge?.name}</p>
                  </div>
                  <button
                    onClick={() => setResultsOpen(false)}
                    className="w-8 h-8 rounded-xl flex items-center justify-center"
                    style={{ background: '#F3F4F6' }}
                  >
                    <X size={16} color="#6B7280" />
                  </button>
                </div>

                {myResults.my_result && (() => {
                  const r = myResults.my_result;
                  const won = Number(r.payout_kes) > 0;
                  const isRefund = r.payout_method === 'refund';
                  const medals = ['', '', ''];

                  return (
                    <div
                      className="rounded-2xl p-4 mb-4"
                      style={{
                        background: won
                          ? 'linear-gradient(135deg, #34D399 0%, #10B981 100%)'
                          : isRefund
                            ? 'linear-gradient(135deg, #FBBF24 0%, #F59E0B 100%)'
                            : '#F9FAFB',
                        boxShadow: won ? '0 4px 16px rgba(52,211,153,0.3)' : 'none',
                      }}
                    >
                      <p className="text-xs font-bold mb-1" style={{ color: won || isRefund ? 'rgba(255,255,255,0.8)' : '#9CA3AF' }}>
                        {isRefund ? 'REFUNDED' : won ? 'YOU WON ' : 'DID NOT QUALIFY'}
                      </p>

                      <p
                        className="font-bold mb-0.5"
                        style={{
                          fontSize: '30px',
                          fontFamily: 'DM Serif Display, serif',
                          color: won || isRefund ? '#FFFFFF' : '#111827',
                          lineHeight: 1,
                        }}
                      >
                        KES {Number(r.payout_kes).toLocaleString()}
                      </p>

                      <p className="text-sm" style={{ color: won || isRefund ? 'rgba(255,255,255,0.8)' : '#6B7280' }}>
                        {r.final_steps.toLocaleString()} steps
                        {r.final_rank
                          ? `  ${r.final_rank <= 3 ? medals[r.final_rank - 1] : `Rank #${r.final_rank}`}`
                          : ''}
                      </p>

                      {r.tied_with_count > 0 && (
                        <div className="mt-2.5 rounded-xl p-2.5" style={{ background: 'rgba(255,255,255,0.2)' }}>
                          <p className="text-white text-xs leading-relaxed">
                            {r.payout_method === 'dead_heat'
                              ? `Tied with ${r.tied_with_count} other(s)  prize pool split equally`
                              : `Tied  broken by: ${r.tiebreaker_label}`}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {myResults.summary && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
                    {[
                      { label: 'Players', value: String(myResults.summary.total_participants) },
                      { label: 'Qualified', value: String(myResults.summary.qualified_count) },
                      { label: 'Pool', value: `KES ${Number(myResults.challenge?.net_pool || 0).toLocaleString()}` },
                    ].map((s) => (
                      <div key={s.label} className="rounded-xl p-2.5 text-center" style={{ background: '#F8F9FB', border: '1px solid #F3F4F6' }}>
                        <p className="text-[#111827] text-sm font-bold">{s.value}</p>
                        <p className="text-[#9CA3AF] text-xs">{s.label}</p>
                      </div>
                    ))}
                  </div>
                )}

                {myResults.leaderboard && myResults.leaderboard.length > 0 && (
                  <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid #F3F4F6' }}>
                    <p className="text-[#111827] text-xs font-bold px-4 py-2.5" style={{ borderBottom: '1px solid hsl(var(--border-light))', background: '#F9FAFB' }}>
                      Leaderboard
                    </p>
                    {myResults.leaderboard.slice(0, 5).map((r, i) => {
                      const medals = ['', '', ''];
                      const won = Number(r.payout_kes) > 0;
                      return (
                        <div
                          key={`${r.username}-${i}`}
                          className={`flex items-center gap-3 px-4 py-3 ${
                            i < Math.min(myResults.leaderboard!.length, 5) - 1 ? 'border-b border-[#F3F4F6]' : ''
                          }`}
                        >
                          <span className="w-6 text-center text-sm flex-shrink-0">
                            {r.final_rank && r.final_rank <= 3 ? (
                              medals[r.final_rank - 1]
                            ) : (
                              <span className="text-[#9CA3AF] text-xs font-bold">{r.final_rank || ''}</span>
                            )}
                          </span>
                          <div
                            className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                            style={{ background: won ? '#4F9CF9' : '#D1D5DB' }}
                          >
                            {r.username.slice(0, 2).toUpperCase()}
                          </div>
                          <p className="flex-1 text-[#111827] text-sm font-semibold truncate">
                            {r.username}
                            {r.tied_with_count > 0 && <span className="text-[#FBBF24] text-xs"> tie</span>}
                          </p>
                          <p className="text-xs font-bold flex-shrink-0" style={{ color: won ? '#34D399' : '#9CA3AF' }}>
                            {r.payout_method === 'refund'
                              ? 'Refund'
                              : won
                                ? `KES ${Number(r.payout_kes).toLocaleString()}`
                                : ''}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}

                {myResults.challenge && (
                  <button
                    onClick={() => {
                      setResultsOpen(false);
                      navigate(`/challenges/${myResults.challenge!.id}/results`);
                    }}
                    className="w-full mt-3 py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold"
                    style={{ background: '#F3F4F6', color: '#6B7280' }}
                  >
                    View Full Results
                    <ChevronRight size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


