import axios from 'axios';
import { useQuery } from '@tanstack/react-query';

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

export function AuthRightPanel() {
  const { data } = useQuery({
    queryKey: ['auth-right-panel-stats'],
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<StatsResponse | null> => {
      const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';
      try {
        const response = await axios.get<StatsResponse>(`${base}/api/admin/dashboard/overview/`, {
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
    <div className="hidden lg:flex lg:flex-1 relative overflow-hidden lg:flex-col lg:justify-end">
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 70% 40%, rgba(124,111,247,0.15) 0%, transparent 70%), radial-gradient(ellipse 40% 40% at 30% 70%, rgba(79,156,249,0.10) 0%, transparent 60%)',
        }}
      />

      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            'linear-gradient(#7C6FF7 1px, transparent 1px), linear-gradient(90deg, #7C6FF7 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <div
        className="absolute top-8 right-8 w-52 rounded-2xl p-4 z-10"
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
            letterSpacing: '-0.8px',
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
