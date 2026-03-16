import { useEffect, useMemo, useState, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, Copy, Trophy, Download, Lock, Globe } from 'lucide-react';
import QR from 'qrcode';
import { challengesService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useToast } from '../components/ui/Toast';
import { CelebrationModal } from '../components/ui/CelebrationModal';
import GroupChat from '../components/GroupChat';
import { ChallengeSocialBadges } from '../components/ui/ChallengeSocialBadges';
import type { Challenge, ChallengeDetail, Participant } from '../types';
import { formatKES } from '../utils/currency';

export default function ChallengeDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const { showToast } = useToast();
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const [showCelebration, setShowCelebration] = useState(false);

  const { data: challenge, isLoading } = useQuery<ChallengeDetail>({
    queryKey: ['challenges', id],
    queryFn: () => challengesService.getDetail(parseInt(id!)),
    enabled: !!id,
  });

  const { data: leaderboard } = useQuery<Participant[]>({
    queryKey: ['challenges', id, 'leaderboard'],
    queryFn: () => challengesService.getLeaderboard(parseInt(id!)),
    enabled: !!id,
  });

  const { data: stats } = useQuery({
    queryKey: ['challenges', id, 'stats'],
    queryFn: () => challengesService.getStats(parseInt(id!)),
    enabled: !!id,
  });

  const rematchMutation = useMutation({
    mutationFn: () => challengesService.rematch(parseInt(id!)),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      showToast({ message: 'Rematch created!', type: 'success' });
      navigate(`/challenges/${data.challenge.id}`);
    },
    onError: (error: any) => {
      showToast({ message: error.response?.data?.error || 'Failed to create rematch', type: 'error' });
    },
  });

  // Theme-based colors for universal challenge support
  const THEME_COLORS = {
    blue: { color: '#4F9CF9', bg: '#EFF6FF' },
    green: { color: '#34D399', bg: '#ECFDF5' },
    purple: { color: '#A78BFA', bg: '#F5F3FF' },
    orange: { color: '#F59E0B', bg: '#FEF3C7' },
    pink: { color: '#EC4899', bg: '#FCE7F3' },
  };

  const getThemeMeta = (challenge: Challenge) => {
    const theme = challenge.theme || 'blue';
    const themeColors = THEME_COLORS[theme];
    const milestoneK = challenge.milestone / 1000;
    const emoji = challenge.theme_emoji || '🔥';
    
    return {
      name: `${emoji} ${milestoneK}K`,
      color: themeColors.color,
      bg: themeColors.bg,
    };
  };

  const copyInviteCode = () => {
    if (challenge?.invite_code) {
      navigator.clipboard.writeText(challenge.invite_code);
      showToast({ message: 'Invite code copied!', type: 'success' });
    }
  };

  // Generate QR code
  useEffect(() => {
    if (challenge?.invite_code && qrCanvasRef.current) {
      QR.toCanvas(qrCanvasRef.current, challenge.invite_code, {
        errorCorrectionLevel: 'H',
        margin: 2,
        width: 220,
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      }).catch((error) => {
        console.error('QR code generation error:', error);
      });
    }
  }, [challenge?.invite_code]);

  const downloadQRCode = () => {
    if (qrCanvasRef.current) {
      const link = document.createElement('a');
      link.href = qrCanvasRef.current.toDataURL('image/png');
      link.download = `challenge-${challenge?.invite_code}.png`;
      link.click();
      showToast({ message: 'QR code downloaded!', type: 'success' });
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  };

  const userParticipant =
    challenge?.my_participation ||
    leaderboard?.find((p: Participant) => p.user === user?.id);
  const isQualified = (userParticipant?.steps || 0) >= (challenge?.milestone || 0);

  const celebrationData = useMemo(() => {
    if (!challenge || !userParticipant) return null;
    return {
      challengeName: challenge.name,
      xpEarned: userParticipant.qualified ? 50 : 10,
      prizeEarned: Number.parseFloat(userParticipant.payout || '0') || 0,
      rank: (userParticipant.rank || 0) <= 1 ? 'Gold' : (userParticipant.rank || 0) <= 3 ? 'Silver' : 'Bronze',
      rankEmoji: (userParticipant.rank || 0) <= 1 ? '🏆' : (userParticipant.rank || 0) <= 3 ? '🥈' : '🥉',
      position: userParticipant.rank || undefined,
      totalParticipants: leaderboard?.length || challenge.current_participants || 0,
      levelUp: false,
      newLevel: undefined,
    };
  }, [challenge, leaderboard, userParticipant]);

  useEffect(() => {
    if (!challenge || !userParticipant || !id || !user?.id) return;

    const isCompletedQualified = challenge.status === 'completed' && userParticipant.qualified;
    if (!isCompletedQualified) return;

    const storageKey = `celebration_shown_${user.id}_${id}`;
    const hasShown = localStorage.getItem(storageKey) === 'true';
    if (!hasShown) {
      setShowCelebration(true);
      localStorage.setItem(storageKey, 'true');
    }
  }, [challenge, id, user?.id, userParticipant]);

  if (isLoading) {
    return (
      <div className="p-4 space-y-4 pb-nav">
        <div className="skeleton h-12 rounded-2xl" />
        <div className="skeleton h-32 rounded-3xl" />
        <div className="grid grid-cols-2 gap-3">
          <div className="skeleton h-24 rounded-3xl" />
          <div className="skeleton h-24 rounded-3xl" />
        </div>
        <div className="skeleton h-64 rounded-3xl" />
      </div>
    );
  }

  if (!challenge) {
    return (
      <div className="p-6 text-center pt-20">
        <div className="text-6xl mb-3 animate-float">💔</div>
        <p className="text-text-muted text-lg mb-6">Challenge not found</p>
        <button onClick={() => navigate(-1)} className="btn-primary px-6 py-3 rounded-2xl">
          Go Back
        </button>
      </div>
    );
  }

  const meta = getThemeMeta(challenge);

  return (
    <div className="screen-enter pb-nav bg-bg-page">
      {/* ── HEADER ────────────────────────── */}
      <div className="pt-safe px-4 pt-4 pb-4">
        <button
          onClick={() => navigate(-1)}
          className="card px-4 py-2 rounded-2xl flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-4 card-press"
        >
          <ChevronLeft size={18} strokeWidth={2.5} />
          <span className="text-sm font-semibold">Back</span>
        </button>

        <div className="flex items-start justify-between mb-3">
          <div className="flex-1">
            {/* Milestone badge */}
            <div
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-bold mb-3"
              style={{ 
                background: meta.bg, 
                color: meta.color
              }}
            >
              {meta.name}
            </div>
            
            <h1 className="text-[28px] font-black text-text-primary mb-2 leading-tight">
              {challenge.theme_emoji ? `${challenge.theme_emoji} ` : ''}{challenge.name}
            </h1>
          </div>
        </div>

        {/* Status pill */}
        <div className="flex items-center gap-2">
          {challenge.status === 'active' && (
            <span className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-full font-bold" style={{
              background: '#ECFDF5',
              color: '#34D399'
            }}>
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: '#34D399' }} />
              Live
            </span>
          )}
          {challenge.status === 'completed' && (
            <span className="text-xs px-3 py-1.5 rounded-full font-bold" style={{
              background: '#F5F3FF',
              color: '#A78BFA'
            }}>
              Completed
            </span>
          )}
          {challenge.status === 'pending' && (
            <span className="text-xs px-3 py-1.5 rounded-full font-bold" style={{
              background: '#FEF3C7',
              color: '#F59E0B'
            }}>
              Pending
            </span>
          )}
          
          {/* Visibility indicator */}
          {challenge.is_private ? (
            <span className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-bold" style={{
              background: '#FEE2E2',
              color: '#991B1B'
            }}>
              <Lock size={12} />
              Private
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-bold" style={{
              background: '#DBEAFE',
              color: '#1E40AF'
            }}>
              <Globe size={12} />
              Public
            </span>
          )}
        </div>

        {challenge.is_private && challenge.win_condition && (
          <div className="mt-3">
            <span className="text-xs px-3 py-1.5 rounded-full font-bold" style={{
              background: '#EFF6FF',
              color: '#1E40AF'
            }}>
              {challenge.win_condition_display || challenge.win_condition}
            </span>
          </div>
        )}
      </div>

      {/* ── STATS BENTO GRID ────────────────────────── */}
      <div className="px-4 pb-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="card rounded-3xl p-4">
            <div className="text-[10px] font-bold text-text-muted mb-1">PRIZE POOL</div>
            <div className="text-2xl font-black font-mono text-text-primary">
              {formatKES(stats?.total_pool || challenge.total_pool || '0.00')}
            </div>
          </div>
          <div className="card rounded-3xl p-4">
            <div className="text-[10px] font-bold text-text-muted mb-1">ENTRY FEE</div>
            <div className="text-2xl font-black font-mono text-text-primary">
              {formatKES(challenge.entry_fee)}
            </div>
          </div>
          <div className="card rounded-3xl p-4">
            <div className="text-[10px] font-bold text-text-muted mb-1">START DATE</div>
            <div className="text-lg font-bold text-text-primary">
              {formatDate(challenge.start_date)}
            </div>
          </div>
          <div className="card rounded-3xl p-4">
            <div className="text-[10px] font-bold text-text-muted mb-1">END DATE</div>
            <div className="text-lg font-bold text-text-primary">
              {formatDate(challenge.end_date)}
            </div>
          </div>
        </div>
      </div>

      {/* ── YOUR PROGRESS CARD ────────────────────────── */}
      {userParticipant && (
        <div className="px-4 pb-4">
          <div className="card rounded-4xl p-5">
            <h3 className="text-sm font-bold text-text-muted mb-4">YOUR PROGRESS</h3>
            
            <div className="flex items-end justify-between mb-4">
              <div>
                <div className="text-4xl font-black font-display text-text-primary mb-1">
                  {(userParticipant.steps || 0).toLocaleString()}
                </div>
                <div className="text-sm text-text-secondary">
                  / {challenge.milestone.toLocaleString()} steps
                </div>
              </div>
              <span
                className="text-xs px-3 py-1.5 rounded-xl font-bold"
                style={{
                  background: isQualified ? '#ECFDF5' : '#FEF3C7',
                  color: isQualified ? '#34D399' : '#F59E0B'
                }}
              >
                {isQualified ? '✓ QUALIFIED' : 'NOT QUALIFIED'}
              </span>
            </div>

            {/* Progress bar */}
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden mb-4">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.min(
                    100,
                    ((userParticipant.steps || 0) / challenge.milestone) * 100
                  )}%`,
                  background: meta.color
                }}
              />
            </div>

            {isQualified && challenge.status === 'active' && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Estimated payout</span>
                <span className="text-lg font-bold font-mono text-text-primary">
                  {formatKES((userParticipant?.payout ? parseFloat(userParticipant.payout) : 0) || 0)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── LEADERBOARD ────────────────────────── */}
      <div className="px-4 pb-4">
        <div className="card rounded-4xl p-5">
          <h3 className="text-lg font-black text-text-primary mb-4 flex items-center gap-2">
            <Trophy className="w-5 h-5 text-amber-500" />
            Leaderboard
          </h3>
          
          <div className="space-y-2">
            {leaderboard && leaderboard.length > 0 ? (
              leaderboard.map((participant: Participant, index: number) => {
                const isCurrentUser = participant.user === user?.id;
                const qualified = participant.steps >= challenge.milestone;

                return (
                  <div
                    key={participant.user}
                    className="bg-gray-50 rounded-2xl p-3 flex items-center gap-3 hover:bg-gray-100 transition-colors"
                  >
                    {/* Rank */}
                    <div className="w-10 h-10 flex items-center justify-center flex-shrink-0">
                      {index === 0 ? (
                        <div className="text-2xl animate-float">🥇</div>
                      ) : index === 1 ? (
                        <div className="text-2xl animate-float">🥈</div>
                      ) : index === 2 ? (
                        <div className="text-2xl animate-float">🥉</div>
                      ) : (
                        <span className="text-lg font-black text-text-muted">
                          {index + 1}
                        </span>
                      )}
                    </div>

                    {/* Username & Steps */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-text-primary truncate">
                          {participant.username}
                        </p>
                        {isCurrentUser && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold" style={{
                            background: meta.bg,
                            color: meta.color
                          }}>
                            YOU
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-mono text-text-secondary">
                        {participant.steps.toLocaleString()} steps
                      </p>
                    </div>

                    {/* Status & Payout */}
                    <div className="text-right">
                      {qualified ? (
                        <>
                          <span className="inline-block text-[10px] px-2 py-1 rounded-full font-bold mb-1" style={{
                            background: '#ECFDF5',
                            color: '#34D399'
                          }}>
                            ✓ QUAL
                          </span>
                          {participant.payout && (
                            <div className="text-sm font-bold font-mono text-text-primary">
                              {formatKES(parseFloat(participant.payout))}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-text-muted">—</span>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="text-center py-10">
                <div className="text-5xl mb-3 animate-float">🎮</div>
                <p className="text-text-secondary text-sm">No participants yet</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── PARTICIPANT FEATURES ────────────────────────── */}
      {userParticipant && challenge.is_private && (
        <>
          {/* Social Badges */}
          <div className="px-4 pb-4">
            <ChallengeSocialBadges challengeId={challenge.id} />
          </div>

          {/* Group Chat */}
          <div className="px-4 pb-4">
            <GroupChat challengeId={challenge.id} />
          </div>
        </>
      )}

      {/* ── INVITE CODE ────────────────────────── */}
      {challenge.invite_code && (
        <div className="px-4 pb-4">
          <div className="card rounded-4xl p-5">
            <h3 className="text-sm font-bold text-text-muted mb-4">INVITE CODE</h3>
            <div className="flex items-center gap-3 mb-6">
              <div className="flex-1 bg-bg-input rounded-2xl p-4 text-center">
                <div className="text-3xl font-black font-mono text-text-primary tracking-widest">
                  {challenge.invite_code}
                </div>
              </div>
              <button
                onClick={copyInviteCode}
                className="bg-white border-2 border-gray-300 hover:border-gray-400 px-4 py-4 rounded-2xl flex-shrink-0 transition-colors"
              >
                <Copy size={20} strokeWidth={2.5} className="text-text-primary" />
              </button>
            </div>
            <p className="text-xs text-text-secondary text-center mb-6">
              Share this code with friends to invite them
            </p>

            {/* QR Code Display */}
            <div className="flex flex-col items-center gap-4 pt-6 border-t border-border">
              <p className="text-xs font-bold text-text-muted">OR SCAN QR CODE</p>
              <div className="bg-white p-3 rounded-2xl inline-block">
                <canvas
                  ref={qrCanvasRef}
                  style={{ display: 'block', margin: '0 auto' }}
                />
              </div>
              <button
                onClick={downloadQRCode}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-tint-blue text-accent-blue font-semibold hover:opacity-80 transition-opacity"
              >
                <Download size={16} />
                Download QR
              </button>
            </div>
          </div>
        </div>
      )}

      {challenge.status === 'completed' && userParticipant?.qualified && (
        <div className="px-4 pb-4">
          <button
            onClick={() => setShowCelebration(true)}
            className="w-full py-3 rounded-2xl font-bold text-white shadow-lg transition-all"
            style={{ background: meta.color }}
          >
            View Celebration
          </button>
        </div>
      )}

      {challenge.status === 'completed' && challenge.is_private && (
        <div className="px-4 pb-4">
          <button
            onClick={() => rematchMutation.mutate()}
            disabled={rematchMutation.isPending}
            className="w-full py-3 rounded-2xl font-bold disabled:opacity-50"
            style={{ 
              background: meta.bg,
              color: meta.color
            }}
          >
            {rematchMutation.isPending ? 'Creating rematch...' : '🔁 Run This Challenge Again'}
          </button>
        </div>
      )}

      <CelebrationModal
        isOpen={showCelebration}
        onClose={() => setShowCelebration(false)}
        data={celebrationData || undefined}
      />
    </div>
  );
}
