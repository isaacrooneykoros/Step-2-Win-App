import React, { useEffect, useState } from 'react';
import { Trophy, Star, Gift, ZapOff, PartyPopper, Sparkles, Flame, Dumbbell } from 'lucide-react';
import { formatKES } from '../../utils/currency';

interface CelebrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  data?: {
    challengeName: string;
    xpEarned: number;
    prizeEarned: number;
    rank?: string;
    rankEmoji?: string;
    position?: number;
    totalParticipants?: number;
    newLevel?: number;
    levelUp?: boolean;
  };
}

// Confetti particle generator
const Confetti: React.FC = () => {
  const [particles, setParticles] = useState<
    Array<{
      id: number;
      left: number;
      duration: number;
      delay: number;
      color: string;
    }>
  >([]);

  useEffect(() => {
    const colors = [
      'from-blue-400 to-blue-500',
      'from-purple-400 to-purple-500',
      'from-pink-400 to-pink-500',
      'from-yellow-400 to-yellow-500',
      'from-green-400 to-green-500',
    ];

    const newParticles = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      duration: 2 + Math.random() * 1,
      delay: Math.random() * 0.5,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));

    setParticles(newParticles);
  }, []);

  return (
    <>
      {particles.map((particle) => (
        <div
          key={particle.id}
          className={`absolute w-2 h-2 rounded-full bg-gradient-to-b ${particle.color} pointer-events-none`}
          style={{
            left: `${particle.left}%`,
            top: '-10px',
            animation: `confettiFall ${particle.duration}s linear ${particle.delay}s forwards`,
            opacity: 0.8,
          }}
        />
      ))}
      <style>{`
        @keyframes confettiFall {
          to {
            transform: translateY(100vh) rotateZ(360deg);
            opacity: 0;
          }
        }
      `}</style>
    </>
  );
};

export const CelebrationModal: React.FC<CelebrationModalProps> = ({
  isOpen,
  onClose,
  data = {
    challengeName: 'Morning Walk Challenge',
    xpEarned: 250,
    prizeEarned: 45.50,
    rank: 'Gold',
    rankEmoji: '🏅',
    position: 1,
    totalParticipants: 248,
    levelUp: true,
    newLevel: 5,
  },
}) => {
  const [showContent, setShowContent] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setShowContent(false);
      const timer = setTimeout(() => setShowContent(true), 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isWinner = data.position === 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden">
      {/* Backdrop with blur */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm cursor-pointer"
        onClick={onClose}
      />

      {/* Confetti */}
      <div className="absolute inset-0 pointer-events-none">
        <Confetti />
      </div>

      {/* Main Card */}
      <div className="relative z-10 mx-4 max-w-sm w-full">
        <div
          className={`bg-white rounded-3xl shadow-modal transition-all duration-500 ${
            showContent ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
          }`}
        >
          {/* Header with celebration icon */}
          <div className="relative pt-8 text-center overflow-hidden">
            {/* Main Icon */}
            <div className={`relative flex justify-center mb-6 transition-all duration-1000 ${
              showContent ? 'animate-bounce' : 'opacity-0'
            }`}>
              {isWinner ? (
                <div className="bg-tint-yellow rounded-full p-4">
                  <Trophy className="w-16 h-16 text-yellow-400" />
                </div>
              ) : (
                <div className="bg-tint-blue rounded-full p-4">
                  <Star className="w-16 h-16 text-blue-500" />
                </div>
              )}
            </div>

            {/* Victory Message */}
            <h1 className={`text-4xl font-bold text-text-primary mb-2 transition-all duration-700 flex items-center justify-center gap-3 ${showContent ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}>
              {isWinner ? (
                <>
                  <PartyPopper className="w-9 h-9 text-green-500" />
                  <span>Victory!</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-9 h-9 text-blue-400" />
                  <span>Completed!</span>
                </>
              )}
            </h1>

            <p className="text-text-secondary text-lg px-6 mb-6">{data.challengeName}</p>

            {/* Divider */}
            <div className="h-px bg-border" />
          </div>

          {/* Content */}
          <div className={`px-6 py-8 space-y-6 transition-all duration-700 ${
            showContent ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
          }`}>
            {/* Position Badge */}
            {data.position && (
              <div className="flex items-center justify-center bg-tint-blue rounded-2xl p-4">
                <div className="text-center">
                  <p className="text-text-muted text-sm mb-1">Finished in</p>
                  <div className="text-3xl font-bold text-accent-blue font-display">
                    #{data.position} of {data.totalParticipants}
                  </div>
                </div>
              </div>
            )}

            {/* XP & Rank Display */}
            <div className="grid grid-cols-2 gap-4">
              {/* XP Earned */}
              <div className="bg-tint-blue rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <ZapOff className="w-5 h-5 text-accent-blue" />
                  <p className="text-text-muted text-sm">XP Earned</p>
                </div>
                <p className="text-3xl font-bold text-accent-blue font-display">
                  +{data.xpEarned}
                </p>
              </div>

              {/* Prize Earned */}
              <div className="bg-tint-yellow rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Gift className="w-5 h-5 text-accent-yellow" />
                  <p className="text-text-muted text-sm">Prize Pool</p>
                </div>
                <p className="text-3xl font-bold text-accent-yellow font-display">
                  {formatKES(data.prizeEarned)}
                </p>
              </div>
            </div>

            {/* Level Up */}
            {data.levelUp && data.newLevel && (
              <div className="bg-tint-purple rounded-2xl p-4">
                <div className="text-center space-y-2">
                  <p className="text-text-muted text-sm font-semibold">🎊 LEVEL UP!</p>
                  <div className="flex items-center justify-center gap-2">
                    <span className="text-2xl font-bold text-accent-purple font-display">
                      Level {data.newLevel}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Rank Display */}
            {data.rank && (
              <div className="bg-bg-page rounded-2xl p-4">
                <p className="text-text-muted text-sm mb-3 text-center">Current Rank</p>
                <div className="flex items-center justify-center gap-3">
                  <div className="text-4xl">{data.rankEmoji}</div>
                  <div className="text-3xl font-bold text-text-primary">{data.rank}</div>
                </div>
              </div>
            )}

            {/* Motivational Message */}
            <div className="text-center text-text-secondary text-sm bg-bg-page rounded-xl p-4 flex items-center justify-center gap-2">
              {isWinner ? (
                <>
                  <Flame className="w-4 h-4 text-orange-500" />
                  <span>You've dominated the leaderboard! Keep the momentum going!</span>
                </>
              ) : (
                <>
                  <Dumbbell className="w-4 h-4 text-blue-500" />
                  <span>Great effort! Complete more challenges to improve your ranking!</span>
                </>
              )}
            </div>
          </div>

          {/* Footer Button */}
          <div className="px-6 pb-6 pt-4 border-t border-border">
            <button
              onClick={onClose}
              className="w-full px-6 py-3 rounded-xl bg-accent-blue text-white font-semibold transition-all hover:shadow-card active:scale-95"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
