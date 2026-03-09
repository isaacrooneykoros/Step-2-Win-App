import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Users, Clock, Trophy, Eye, Zap } from 'lucide-react';
import { challengesService } from '../services/api/challenges';

const THEME: Record<string, { bg: string; accent: string }> = {
  blue: { bg: '#EFF6FF', accent: '#4F9CF9' },
  green: { bg: '#ECFDF5', accent: '#34D399' },
  purple: { bg: '#F5F3FF', accent: '#A78BFA' },
  orange: { bg: '#FFF7ED', accent: '#FB923C' },
  pink: { bg: '#FDF2F8', accent: '#F472B6' },
};

export default function ChallengePreviewScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: challenge, isLoading } = useQuery({
    queryKey: ['challenges', 'lobby', id],
    queryFn: () => challengesService.getLobbyCard(Number(id)),
    enabled: !!id,
  });

  if (isLoading || !challenge) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F8F9FB' }}>
        <div className="w-8 h-8 rounded-full border-2 border-[#4F9CF9] border-t-transparent animate-spin" />
      </div>
    );
  }

  const theme = THEME[challenge.theme] || THEME.blue;
  const canJoin = !challenge.user_is_joined && challenge.spots_remaining > 0 && ['pending', 'active'].includes(challenge.status);

  const handleJoin = () => {
    navigate('/challenges', { state: { joinCode: challenge.invite_code } });
  };

  const handleSpectate = () => {
    navigate(`/challenges/${challenge.id}/spectate`);
  };

  return (
    <div className="min-h-screen pb-32" style={{ background: '#F8F9FB' }}>
      <div className="relative px-4 pt-6 pb-8" style={{ background: theme.bg }}>
        <button
          onClick={() => navigate(-1)}
          className="w-9 h-9 rounded-xl flex items-center justify-center mb-4"
          style={{ background: 'rgba(255,255,255,0.8)' }}
        >
          <ChevronLeft size={20} color="#111827" />
        </button>

        {challenge.is_featured && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full mb-2" style={{ background: '#FEF3C7' }}>
            <span style={{ color: '#D97706', fontSize: '11px', fontWeight: 700 }}>⭐ Featured Challenge</span>
          </div>
        )}

        <h1 className="text-[#111827] text-2xl font-bold mb-1">{challenge.name}</h1>

        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: `${theme.accent}20`, color: theme.accent }}>
            {challenge.milestone_label}
          </span>
          <span className="text-[#6B7280] text-xs">
            {challenge.status === 'active' ? `${challenge.days_remaining} days remaining` : 'Open for registration'}
          </span>
        </div>
      </div>

      <div className="mx-4 -mt-4 rounded-2xl p-4 mb-4" style={{ background: '#FFFFFF', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}>
        <div className="text-center mb-3">
          <p className="text-[#9CA3AF] text-xs mb-1">Total Prize Pool</p>
          <p className="text-[#111827] font-bold" style={{ fontSize: '36px', lineHeight: 1 }}>
            KES {Number(challenge.effective_pool_kes).toLocaleString()}
          </p>
          {Number(challenge.platform_bonus_kes) > 0 && (
            <p className="text-xs mt-1" style={{ color: theme.accent }}>
              Includes KES {Number(challenge.platform_bonus_kes).toLocaleString()} platform bonus
            </p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3 pt-3" style={{ borderTop: '1px solid #F3F4F6' }}>
          {[
            { icon: <Trophy size={14} />, label: 'Entry Fee', value: `KES ${Number(challenge.entry_fee).toLocaleString()}` },
            { icon: <Users size={14} />, label: 'Participants', value: `${challenge.participant_count}/${challenge.max_participants}` },
            { icon: <Clock size={14} />, label: challenge.status === 'active' ? 'Days Left' : 'Duration', value: challenge.status === 'active' ? `${challenge.days_remaining}d` : '7 days' },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center mx-auto mb-1" style={{ background: theme.bg, color: theme.accent }}>
                {stat.icon}
              </div>
              <p className="text-[#111827] text-sm font-bold">{stat.value}</p>
              <p className="text-[#9CA3AF] text-xs">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mx-4 mb-4 rounded-2xl p-4" style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div className="flex justify-between items-center mb-2">
          <p className="text-[#111827] text-sm font-bold">Spots Filling</p>
          <p className="text-xs font-semibold" style={{ color: challenge.is_almost_full ? '#EF4444' : theme.accent }}>
            {challenge.spots_remaining} of {challenge.max_participants} remaining
          </p>
        </div>
        <div className="w-full h-3 rounded-full" style={{ background: '#F3F4F6' }}>
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${challenge.fill_percentage}%`,
              background: challenge.is_almost_full ? 'linear-gradient(90deg, #EF4444, #F97316)' : theme.accent,
            }}
          />
        </div>
        {challenge.is_almost_full && (
          <p className="text-[#EF4444] text-xs font-semibold mt-2 text-center">🔥 Almost full — join before it's too late!</p>
        )}
      </div>

      <div className="mx-4 mb-4 rounded-2xl p-4" style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <p className="text-[#111827] text-sm font-bold mb-3">How Payouts Work</p>
        {[
          { step: '1', text: `Walk ${(challenge.milestone / 1000).toFixed(0)}K steps in 7 days to qualify` },
          { step: '2', text: 'Winners split the pool proportionally by steps walked' },
          { step: '3', text: 'Winnings sent directly to your M-Pesa wallet' },
          { step: '4', text: '5% platform fee deducted from total pool' },
        ].map((item) => (
          <div key={item.step} className="flex items-start gap-3 mb-2 last:mb-0">
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-white text-xs font-bold"
              style={{ background: theme.accent }}
            >
              {item.step}
            </div>
            <p className="text-[#6B7280] text-xs leading-relaxed">{item.text}</p>
          </div>
        ))}
      </div>

      <div
        className="fixed bottom-0 left-0 right-0 px-4 pb-6 pt-3"
        style={{ background: 'rgba(248,249,251,0.95)', backdropFilter: 'blur(8px)', borderTop: '1px solid #F3F4F6' }}
      >
        {challenge.user_is_joined ? (
          <div className="flex flex-col gap-2">
            <div className="w-full py-3.5 rounded-xl text-center text-sm font-bold" style={{ background: '#ECFDF5', color: '#34D399' }}>
              ✓ You're participating in this challenge
            </div>
            <button
              onClick={handleSpectate}
              className="w-full py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
              style={{ background: '#F9FAFB', color: '#6B7280', border: '1px solid #E5E7EB' }}
            >
              <Eye size={15} />
              View Live Leaderboard
            </button>
          </div>
        ) : canJoin ? (
          <div className="flex flex-col gap-2">
            <button
              onClick={handleJoin}
              className="w-full py-3.5 rounded-xl text-white text-sm font-bold flex items-center justify-center gap-2"
              style={{ background: theme.accent, boxShadow: `0 4px 16px ${theme.accent}40` }}
            >
              <Zap size={15} />
              Join for KES {Number(challenge.entry_fee).toLocaleString()}
            </button>
            {challenge.status === 'active' && (
              <button
                onClick={handleSpectate}
                className="w-full py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
                style={{ background: '#F9FAFB', color: '#6B7280', border: '1px solid #E5E7EB' }}
              >
                <Eye size={15} />
                Watch Leaderboard First
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="w-full py-3.5 rounded-xl text-center text-sm font-bold" style={{ background: '#F9FAFB', color: '#9CA3AF' }}>
              {challenge.spots_remaining === 0 ? 'Challenge is full' : 'Challenge ended'}
            </div>
            {challenge.status === 'active' && (
              <button
                onClick={handleSpectate}
                className="w-full py-3.5 rounded-xl text-white text-sm font-bold flex items-center justify-center gap-2"
                style={{ background: theme.accent }}
              >
                <Eye size={15} />
                Watch Live Leaderboard
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
