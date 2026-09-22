import axios from 'axios';
import { useQuery } from '@tanstack/react-query';
import { Activity, ShieldCheck, TrendingUp, WalletCards } from 'lucide-react';
import { API_BASE } from '../../config/network';

type StatsResponse = {
  total_users?: number;
  active_challenges?: number;
  pending_withdrawals?: number;
};

const ACTIVITY = [
  {
    initials: 'IR',
    gradient: 'linear-gradient(135deg,#7C6FF7,#4F9CF9)',
    text: 'New deposit',
    amount: 'KSh 500',
    color: '#22D3A0',
    time: '2m',
  },
  {
    initials: 'RK',
    gradient: 'linear-gradient(135deg,#22D3A0,#4F9CF9)',
    text: 'Challenge joined',
    amount: '',
    color: '',
    time: '5m',
  },
  {
    initials: 'MN',
    gradient: 'linear-gradient(135deg,#F5A623,#F06060)',
    text: 'Withdrawal',
    amount: 'KSh 2k',
    color: '#F06060',
    time: '9m',
  },
  {
    initials: 'JO',
    gradient: 'linear-gradient(135deg,#7C6FF7,#22D3A0)',
    text: 'New user registered',
    amount: '',
    color: '',
    time: '12m',
  },
];

const HEALTH_SIGNALS = [
  { label: 'Fraud rules', value: 'Active', icon: ShieldCheck, color: '#22D3A0' },
  { label: 'Payout review', value: 'Queued', icon: WalletCards, color: '#F5A623' },
  { label: 'Step sync', value: 'Live', icon: Activity, color: '#4F9CF9' },
];

export function AuthRightPanel() {
  const { data } = useQuery({
    queryKey: ['auth-right-panel-stats'],
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<StatsResponse | null> => {
      try {
        const response = await axios.get<StatsResponse>(`${API_BASE}/api/admin/dashboard/overview/`, {
          timeout: 4000,
        });
        return response.data;
      } catch {
        return null;
      }
    },
  });

  const statCards = [
    {
      label: 'Active users',
      value: data?.total_users !== undefined ? String(data.total_users) : '18',
      dot: '#22D3A0',
    },
    {
      label: 'Live challenges',
      value: data?.active_challenges !== undefined ? String(data.active_challenges) : '3',
      dot: '#7C6FF7',
    },
    {
      label: 'Pending w/d',
      value: data?.pending_withdrawals !== undefined ? String(data.pending_withdrawals) : '1',
      dot: '#F5A623',
    },
  ];

  return (
    <div className="relative hidden overflow-hidden lg:flex lg:flex-1 lg:flex-col lg:justify-between">
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(150deg, rgba(34,211,160,0.11) 0%, rgba(10,12,18,0) 35%, rgba(79,156,249,0.13) 100%)',
        }}
      />

      <div
        className="absolute inset-0 opacity-[0.055]"
        style={{
          backgroundImage:
            'linear-gradient(#F0F2F8 1px, transparent 1px), linear-gradient(90deg, #F0F2F8 1px, transparent 1px)',
          backgroundSize: '36px 36px',
        }}
      />

      <div
        className="relative z-10 m-8 grid grid-cols-3 gap-3"
      >
        {HEALTH_SIGNALS.map((signal) => {
          const Icon = signal.icon;
          return (
            <div
              key={signal.label}
              className="rounded-2xl p-3"
              style={{ background: 'rgba(14,16,22,0.82)', border: '1px solid #21263A' }}>
              <div className="mb-3 flex items-center justify-between">
                <Icon size={16} style={{ color: signal.color }} />
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: signal.color }} />
              </div>
              <p className="text-[10px]" style={{ color: '#7B82A0' }}>
                {signal.label}
              </p>
              <p className="mt-1 text-xs font-bold" style={{ color: '#F0F2F8' }}>
                {signal.value}
              </p>
            </div>
          );
        })}
      </div>

      <div
        className="absolute right-8 top-36 z-10 w-56 rounded-2xl p-4"
        style={{
          background: 'rgba(14,16,22,0.9)',
          border: '1px solid #21263A',
          backdropFilter: 'blur(12px)',
        }}>
        <p className="text-[10px] font-semibold tracking-widest uppercase mb-3" style={{ color: '#3D4260' }}>
          Live Activity
        </p>
        {ACTIVITY.map((activity, idx) => (
          <div
            key={activity.initials + activity.time}
            className="flex items-center gap-2 py-2"
            style={{ borderBottom: idx < ACTIVITY.length - 1 ? '1px solid #1C1F2E' : 'none' }}>
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[9px] font-bold text-white"
              style={{ background: activity.gradient }}>
              {activity.initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] leading-tight" style={{ color: '#7B82A0' }}>
                {activity.text}
                {activity.amount && (
                  <span className="ml-1 font-semibold" style={{ color: activity.color }}>
                    {activity.amount}
                  </span>
                )}
              </p>
            </div>
            <span className="text-[10px] shrink-0" style={{ color: '#3D4260' }}>
              {activity.time}
            </span>
          </div>
        ))}
      </div>

      <div className="relative z-10 p-10">
        <div
          className="mb-6 rounded-2xl p-5"
          style={{
            background: 'linear-gradient(180deg, rgba(19,22,31,0.92), rgba(14,16,22,0.92))',
            border: '1px solid #21263A',
            boxShadow: '0 18px 50px rgba(0,0,0,0.32)',
          }}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase" style={{ color: '#596077', letterSpacing: 0 }}>
                Today
              </p>
              <p className="mt-1 text-sm font-semibold" style={{ color: '#F0F2F8' }}>
                Platform control center
              </p>
            </div>
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ background: 'rgba(34,197,94,0.12)', color: '#22D3A0' }}>
              <TrendingUp size={18} />
            </div>
          </div>
          <div className="flex h-28 items-end gap-2">
            {[42, 64, 50, 76, 58, 88, 70, 96, 82, 108, 92, 116].map((height, index) => (
              <div
                key={height + index}
                className="flex-1 rounded-t-md"
                style={{
                  height,
                  background:
                    index > 8
                      ? 'linear-gradient(180deg, #22D3A0, rgba(34,211,160,0.22))'
                      : 'linear-gradient(180deg, #4F9CF9, rgba(79,156,249,0.16))',
                }}
              />
            ))}
          </div>
        </div>

        <div className="flex gap-3 mb-6">
          {statCards.map((stat) => (
            <div
              key={stat.label}
              className="flex-1 rounded-2xl p-4"
              style={{ background: 'rgba(14,16,22,0.85)', border: '1px solid #21263A' }}>
              <p className="font-syne font-bold text-2xl leading-none mb-1.5" style={{ color: '#F0F2F8' }}>
                {stat.value}
              </p>
              <p className="text-[11px] flex items-center gap-1.5" style={{ color: '#7B82A0' }}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0 inline-block" style={{ background: stat.dot }} />
                {stat.label}
              </p>
            </div>
          ))}
        </div>

        <div
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full mb-4 text-xs font-semibold"
          style={{
            background: 'rgba(34,211,160,0.12)',
            color: '#22D3A0',
            border: '1px solid rgba(34,211,160,0.2)',
          }}>
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: '#22D3A0' }} />
          Platform running smoothly
        </div>

        <h2
          className="text-4xl font-extrabold leading-tight mb-3"
          style={{
            fontFamily: 'Syne, sans-serif',
            color: '#F0F2F8',
            letterSpacing: 0,
          }}>
          Step2Win
          <br />
          Admin Portal
        </h2>

        <p className="text-sm leading-relaxed max-w-xs" style={{ color: '#7B82A0' }}>
          Manage users, challenges, payments and platform health all in one place.
        </p>
      </div>
    </div>
  );
}
