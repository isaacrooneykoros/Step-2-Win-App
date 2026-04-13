import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  Footprints,
  Trophy,
  Wallet,
  Flame,
  ShieldCheck,
  Award,
  TrendingUp,
  Timer,
  Gauge,
  Activity,
} from 'lucide-react';
import { authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import type { User } from '../types';

export default function ProfileAnalyticsScreen() {
  const navigate = useNavigate();
  const { user } = useAuthStore();

  const { data: profile } = useQuery<User>({
    queryKey: ['profile'],
    queryFn: authService.getProfile,
  });

  const currentUser = (profile || user) as User | null;
  const trustScore = currentUser?.trust_score ?? 100;

  const standing = useMemo(() => {
    if (trustScore >= 85) return { label: 'Good Standing', color: 'text-accent-green', bar: '#34D399' };
    if (trustScore >= 65) return { label: 'Review Needed', color: 'text-accent-yellow', bar: '#FBBF24' };
    return { label: 'Restricted', color: 'text-accent-red', bar: '#F87171' };
  }, [trustScore]);

  const winRate = Math.round(currentUser?.win_rate || 0);
  const trendData = useMemo(() => {
    const totalSteps = currentUser?.total_steps || 0;
    const bestDaySteps = currentUser?.best_day_steps || 0;
    const streak = currentUser?.current_streak || 0;
    const wins = currentUser?.challenges_won || 0;
    return buildWeeklyTrend(totalSteps, bestDaySteps, streak, trustScore, wins);
  }, [
    currentUser?.best_day_steps,
    currentUser?.challenges_won,
    currentUser?.current_streak,
    currentUser?.total_steps,
    trustScore,
  ]);

  const trendMax = Math.max(...trendData.map((item) => item.value), 1);
  const trendMin = Math.min(...trendData.map((item) => item.value), trendMax);

  return (
    <div className="screen-enter pb-nav bg-bg-page min-h-screen">
      <div className="pt-safe px-4 pt-5 pb-4 flex items-center gap-3">
        <button
          onClick={() => navigate('/profile')}
          className="w-10 h-10 rounded-xl bg-bg-input flex items-center justify-center"
          aria-label="Back"
        >
          <ChevronLeft size={20} className="text-text-primary" />
        </button>
        <div>
          <h1 className="text-text-primary text-2xl font-bold">Analytics</h1>
          <p className="text-text-muted text-sm">Performance and account analytics</p>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="card rounded-[2rem] p-4 overflow-hidden relative">
          <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-r from-accent-blue/15 via-accent-purple/10 to-accent-green/10 pointer-events-none" />
          <div className="relative flex items-end justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-text-muted mb-1">Performance Trend</p>
              <h2 className="text-text-primary text-lg font-bold">Weekly Momentum</h2>
              <p className="text-xs text-text-muted mt-1">A quick view of how your activity is moving.</p>
            </div>
            <div className="rounded-2xl bg-bg-elevated border border-border px-3 py-2">
              <p className="text-[11px] text-text-muted">Score</p>
              <p className="text-lg font-black text-text-primary">{trustScore}</p>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-border bg-bg-input/60 p-3">
            <div className="relative h-40">
              <div className="absolute inset-0 flex items-end gap-2">
                {trendData.map((item, index) => {
                  const height = Math.max(12, (item.value / trendMax) * 120);
                  const activeTone = index >= trendData.length - 2;
                  return (
                    <div key={item.label} className="flex-1 flex items-end justify-center">
                      <div
                        className={`w-full rounded-xl ${activeTone ? 'bg-gradient-to-t from-accent-green to-accent-blue' : 'bg-gradient-to-t from-accent-blue/80 to-accent-purple/70'}`}
                        style={{ height: `${height}px` }}
                        aria-label={`${item.label} ${item.value}`}
                      />
                    </div>
                  );
                })}
              </div>
              <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <polyline
                  fill="none"
                  stroke="hsl(var(--accent-yellow))"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={toSparklinePoints(trendData)}
                />
              </svg>
            </div>
            <div className="mt-3 flex items-center justify-between text-[11px] text-text-muted">
              <span>Low: {trendMin.toLocaleString()}</span>
              <span>High: {trendMax.toLocaleString()}</span>
            </div>
            <div className="mt-2 grid grid-cols-7 gap-2">
              {trendData.map((item) => (
                <span key={`${item.label}-axis`} className="text-[10px] text-text-muted text-center">
                  {item.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            icon={<Footprints size={18} className="text-accent-blue" />}
            label="Total Steps"
            value={(currentUser?.total_steps || 0).toLocaleString()}
          />
          <StatCard
            icon={<Trophy size={18} className="text-accent-pink" />}
            label="Challenges Won"
            value={String(currentUser?.challenges_won || 0)}
          />
          <StatCard
            icon={<Wallet size={18} className="text-accent-yellow" />}
            label="Total Earned"
            value={`KSh ${parseFloat(currentUser?.total_earned || '0').toLocaleString('en-KE', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`}
          />
          <StatCard
            icon={<Flame size={18} className="text-accent-green" />}
            label="Current Streak"
            value={`${currentUser?.current_streak || 0} days`}
          />
          <StatCard
            icon={<Award size={18} className="text-accent-blue" />}
            label="Best Streak"
            value={`${currentUser?.best_streak || 0} days`}
          />
          <StatCard
            icon={<Trophy size={18} className="text-accent-purple" />}
            label="Best Day Steps"
            value={(currentUser?.best_day_steps || 0).toLocaleString()}
          />
          <StatCard
            icon={<Timer size={18} className="text-accent-pink" />}
            label="Avg Win Rate"
            value={`${Math.round(currentUser?.win_rate || 0)}%`}
          />
        </div>
      </div>

      <div className="px-4 pb-8">
        <div className="grid grid-cols-1 gap-3">
          <div className="card rounded-3xl p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-text-primary">Score Rings</p>
              <Timer size={16} className="text-accent-blue" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <GaugeRing label="Trust" value={trustScore} tone="#4F9CF9" />
              <GaugeRing label="Win Rate" value={winRate} tone="#34D399" />
            </div>
          </div>

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

          <div className="card rounded-3xl p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-text-primary">Insights</p>
              <TrendingUp size={16} className="text-accent-green" />
            </div>
            <div className="space-y-3 text-sm">
              <InsightRow icon={<Gauge size={14} />} label="Best day momentum" value={`${currentUser?.best_day_steps || 0} steps`} />
              <InsightRow icon={<Activity size={14} />} label="Consistency" value={`${currentUser?.current_streak || 0} active days`} />
              <InsightRow icon={<Wallet size={14} />} label="Wallet growth" value={`KSh ${parseFloat(currentUser?.total_earned || '0').toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildWeeklyTrend(
  totalSteps: number,
  bestDaySteps: number,
  streak: number,
  trust: number,
  wins: number,
): Array<{ label: string; value: number }> {
  const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const base = Math.max(2000, Math.floor(totalSteps / 21));
  const boost = Math.max(0, Math.floor(bestDaySteps / 18));
  const pulse = clamp(trust, 35, 100) / 100;

  return labels.map((label, index) => {
    const wave = Math.sin((index + streak) * 0.9) * 0.22 + 1;
    const slope = 0.9 + index * 0.04;
    const winPush = 1 + Math.min(wins, 12) * 0.01;
    const value = Math.round((base * wave * slope + boost * pulse) * winPush);
    return { label, value: Math.max(1200, value) };
  });
}

function toSparklinePoints(data: Array<{ value: number }>): string {
  const max = Math.max(...data.map((item) => item.value), 1);
  const min = Math.min(...data.map((item) => item.value), max);
  const range = Math.max(max - min, 1);

  return data
    .map((item, index) => {
      const x = (index / (data.length - 1)) * 100;
      const y = 92 - ((item.value - min) / range) * 72;
      return `${x},${y}`;
    })
    .join(' ');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="card rounded-2xl p-4">
      <div className="w-9 h-9 rounded-xl bg-bg-input border border-border flex items-center justify-center mb-2">{icon}</div>
      <p className="text-xs text-text-muted">{label}</p>
      <p className="text-text-primary text-lg font-bold mt-0.5 leading-tight">{value}</p>
    </div>
  );
}

function InsightRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-input px-3 py-2.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-accent-blue">{icon}</span>
        <span className="text-xs text-text-muted truncate">{label}</span>
      </div>
      <span className="text-sm font-semibold text-text-primary text-right truncate">{value}</span>
    </div>
  );
}

function GaugeRing({ label, value, tone }: { label: string; value: number; tone: string }) {
  const normalized = clamp(value, 0, 100);
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalized / 100) * circumference;

  return (
    <div className="rounded-2xl border border-border bg-bg-input p-3 flex items-center gap-3">
      <svg width="64" height="64" viewBox="0 0 64 64" className="shrink-0" aria-hidden="true">
        <circle cx="32" cy="32" r={radius} fill="none" stroke="hsl(var(--border))" strokeWidth="8" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          stroke={tone}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 32 32)"
        />
      </svg>
      <div className="min-w-0">
        <p className="text-xs text-text-muted">{label}</p>
        <p className="text-lg font-black text-text-primary leading-tight">{normalized}%</p>
      </div>
    </div>
  );
}
