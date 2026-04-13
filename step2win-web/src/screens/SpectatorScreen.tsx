import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Trophy, Users, Clock, Zap } from 'lucide-react';
import { challengesService } from '../services/api/challenges';
import type { SpectatorParticipant } from '../types';

const THEME = {
  blue: '#4F9CF9',
  green: '#34D399',
  purple: '#A78BFA',
  orange: '#FB923C',
  pink: '#F472B6',
};

const RANK_MEDALS = ['', '', ''];

export default function SpectatorScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['challenges', 'spectate', id],
    queryFn: () => challengesService.getSpectatorLeaderboard(Number(id)),
    enabled: !!id,
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F8F9FB' }}>
        <div className="w-8 h-8 rounded-full border-2 border-[#4F9CF9] border-t-transparent animate-spin" />
      </div>
    );
  }

  const { challenge, leaderboard, qualified_count, total_participants, user_is_participant } = data;
  const accent = THEME[challenge.theme as keyof typeof THEME] || THEME.blue;
  const maxSteps = Math.max(...leaderboard.map((p) => p.steps), 1);

  return (
    <div className="min-h-screen pb-24" style={{ background: '#F8F9FB' }}>
      <div className="px-4 pt-6 pb-4">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: 'hsl(var(--bg-card))', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}
          >
            <ChevronLeft size={20} color="#111827" />
          </button>
          <div className="text-center">
            <h1 className="text-[#111827] text-base font-bold">{challenge.name}</h1>
            <p className="text-[#9CA3AF] text-xs">Live Leaderboard</p>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full" style={{ background: '#ECFDF5' }}>
            <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#34D399' }} />
            <span className="text-xs font-semibold" style={{ color: '#34D399' }}>
              Live
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {[
            { icon: <Users size={12} />, label: 'Participants', value: String(total_participants) },
            { icon: <Trophy size={12} />, label: 'Qualified', value: `${qualified_count}/${total_participants}` },
            {
              icon: <Clock size={12} />,
              label: 'Days Left',
              value: `${new Date(challenge.end_date) > new Date() ? Math.ceil((new Date(challenge.end_date).getTime() - Date.now()) / 86400000) : 0}d`,
            },
          ].map((stat) => (
            <div key={stat.label} className="rounded-xl p-2.5 text-center" style={{ background: 'hsl(var(--bg-card))', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              <div className="flex justify-center mb-1" style={{ color: accent }}>
                {stat.icon}
              </div>
              <p className="text-[#111827] text-sm font-bold">{stat.value}</p>
              <p className="text-[#9CA3AF] text-xs">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mx-4 mb-4 rounded-2xl p-4 flex items-center justify-between" style={{ background: `${accent}15`, border: `1px solid ${accent}30` }}>
        <div>
          <p className="text-xs font-semibold" style={{ color: accent }}>
            Total Prize Pool
          </p>
          <p className="text-[#111827] text-xl font-bold">KES {Number(challenge.total_pool).toLocaleString()}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-[#9CA3AF]">Entry fee</p>
          <p className="text-[#111827] text-sm font-bold">KES {Number(challenge.entry_fee).toLocaleString()}</p>
        </div>
      </div>

      <div className="mx-4 rounded-2xl overflow-hidden" style={{ background: 'hsl(var(--bg-card))', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div className="px-4 py-3" style={{ borderBottom: '1px solid hsl(var(--border-light))' }}>
          <p className="text-[#111827] text-sm font-bold">Rankings</p>
          <p className="text-[#9CA3AF] text-xs">Top {qualified_count} participants qualify for payout</p>
        </div>

        {leaderboard.map((participant: SpectatorParticipant, index: number) => (
          <LeaderboardRow
            key={`${participant.username}-${index}`}
            participant={participant}
            index={index}
            maxSteps={maxSteps}
            milestone={challenge.milestone}
            accent={accent}
            totalCount={leaderboard.length}
          />
        ))}
      </div>

      {!user_is_participant && challenge.status !== 'completed' && (
        <div className="mx-4 mt-4 rounded-2xl p-4" style={{ background: `${accent}10`, border: `1px solid ${accent}25` }}>
          <p className="text-[#111827] text-sm font-bold mb-1">Want to compete?</p>
          <p className="text-[#6B7280] text-xs mb-3">Join this challenge and your name will appear on this leaderboard.</p>
          <button
            onClick={() => navigate(`/challenges/lobby/${challenge.id}`)}
            className="w-full py-3 rounded-xl text-white text-sm font-bold flex items-center justify-center gap-2"
            style={{ background: accent }}
          >
            <Zap size={14} />
            Join Challenge  KES {Number(challenge.entry_fee).toLocaleString()}
          </button>
        </div>
      )}
    </div>
  );
}

function LeaderboardRow({
  participant,
  index,
  maxSteps,
  milestone,
  accent,
  totalCount,
}: {
  participant: SpectatorParticipant;
  index: number;
  maxSteps: number;
  milestone: number;
  accent: string;
  totalCount: number;
}) {
  const isQualified = participant.steps >= milestone;
  const barWidth = maxSteps > 0 ? (participant.steps / maxSteps) * 100 : 0;

  return (
    <div className={`px-4 py-3.5 ${index < totalCount - 1 ? 'border-b border-[#F3F4F6]' : ''}`} style={{ background: !isQualified ? '#FAFAFA' : undefined }}>
      <div className="flex items-center gap-3">
        <div className="w-7 text-center flex-shrink-0">
          {index < 3 ? <span className="text-lg">{RANK_MEDALS[index]}</span> : <span className="text-[#9CA3AF] text-sm font-bold">{participant.rank}</span>}
        </div>

        <div
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-white text-xs font-bold"
          style={{ background: isQualified ? accent : '#D1D5DB' }}
        >
          {participant.avatar_initials}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5">
              <p className="text-[#111827] text-sm font-bold truncate">{participant.username}</p>
              {isQualified && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full text-white" style={{ background: accent }}>
                   QLD
                </span>
              )}
            </div>
            <p className="text-[#111827] text-xs font-bold flex-shrink-0 ml-2">{participant.steps_display}</p>
          </div>

          <div className="w-full h-1.5 rounded-full" style={{ background: '#F3F4F6' }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${barWidth}%`,
                background: isQualified ? accent : '#D1D5DB',
              }}
            />
          </div>

          {isQualified && participant.estimated_payout && (
            <p className="text-xs mt-0.5" style={{ color: accent }}>
              Est. KES {participant.estimated_payout.toLocaleString()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}


