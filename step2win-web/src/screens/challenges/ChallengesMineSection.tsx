import { Globe, Lock, Plus } from 'lucide-react';
import type { Challenge } from '../../types';
import { formatKES } from '../../utils/currency';

type Tab = 'Active' | 'Mine' | 'Completed';

type MilestoneMeta = {
  name: string;
  bg: string;
  color: string;
};

type Props = {
  isLoading: boolean;
  activeTab: Tab;
  mineCount: number;
  filteredChallenges: Challenge[];
  onActiveTabChange: (tab: Tab) => void;
  onOpenCreateModal: () => void;
  onOpenActionMenu: () => void;
  onViewChallenge: (id: number) => void;
  getMilestoneMeta: (milestone: number) => MilestoneMeta;
};

export default function ChallengesMineSection({
  isLoading,
  activeTab,
  mineCount,
  filteredChallenges,
  onActiveTabChange,
  onOpenCreateModal,
  onOpenActionMenu,
  onViewChallenge,
  getMilestoneMeta,
}: Props) {
  return (
    <>
      <div className="px-4 mb-4">
        <div className="flex bg-bg-input rounded-2xl p-1.5 gap-1">
          {(['Active', 'Mine', 'Completed'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => onActiveTabChange(tab)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 ${
                activeTab === tab
                  ? 'bg-white shadow-card text-text-primary'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {tab}
              {tab === 'Mine' && mineCount > 0 && (
                <span className="ml-1.5 text-[10px] bg-accent-blue/10 text-accent-blue px-1.5 py-0.5 rounded-full font-semibold">
                  {mineCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pb-4">
        {isLoading ? (
          <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-40 rounded-3xl" />
            ))}
          </div>
        ) : filteredChallenges.length === 0 ? (
          <div className="mt-12 text-center flex flex-col items-center justify-center px-6">
            <div className="w-16 h-16 rounded-full bg-tint-blue flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-accent-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-text-primary mb-2">
              {activeTab === 'Mine' ? 'No Challenges Yet' : 'Nothing Here'}
            </h3>
            <p className="text-text-secondary text-sm mb-6 max-w-[260px]">
              {activeTab === 'Mine'
                ? 'Join or create a challenge to start competing!'
                : 'No challenges available right now.'}
            </p>
            {activeTab === 'Mine' && (
              <button
                onClick={onOpenCreateModal}
                className="bg-accent-blue text-white font-semibold px-6 py-3 rounded-2xl shadow-card"
              >
                Create Challenge
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredChallenges.map((challenge: Challenge) => {
              const meta = getMilestoneMeta(challenge.milestone);
              const mySteps = challenge.user_steps || 0;
              const daysLeft = Math.max(0, Math.ceil((new Date(challenge.end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

              return (
                <div
                  key={challenge.id}
                  className="bg-white rounded-3xl p-4 shadow-card"
                >
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="text-lg font-bold text-text-primary line-clamp-1 flex-1 pr-3">
                      {challenge.theme_emoji ? `${challenge.theme_emoji} ` : ''}{challenge.name}
                    </h3>
                    <div className="flex gap-2">
                      <div
                        className="px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap"
                        style={{
                          backgroundColor: meta.bg,
                          color: meta.color,
                        }}
                      >
                        {meta.name}
                      </div>
                      {challenge.is_private ? (
                        <div className="px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap bg-[#FEE2E2] text-[#991B1B] flex items-center gap-1">
                          <Lock size={12} />
                          Private
                        </div>
                      ) : (
                        <div className="px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap bg-[#DBEAFE] text-[#1E40AF] flex items-center gap-1">
                          <Globe size={12} />
                          Public
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="bg-[#FEF3C7] rounded-xl p-2.5">
                      <div className="text-[10px] text-text-muted mb-0.5">Entry Fee</div>
                      <div className="text-sm font-bold font-mono text-text-primary">
                        {formatKES(challenge.entry_fee)}
                      </div>
                    </div>
                    <div className="bg-[#D1FAE5] rounded-xl p-2.5">
                      <div className="text-[10px] text-text-muted mb-0.5">Pool</div>
                      <div className="text-sm font-bold font-mono text-text-primary">
                        {formatKES(challenge.total_pool)}
                      </div>
                    </div>
                    <div className="bg-[#DBEAFE] rounded-xl p-2.5">
                      <div className="text-[10px] text-text-muted mb-0.5">Days Left</div>
                      <div className="text-sm font-bold font-mono text-text-primary">
                        {daysLeft}d
                      </div>
                    </div>
                  </div>

                  {challenge.is_private && challenge.win_condition && (
                    <div className="mb-3 text-xs font-semibold text-text-secondary">
                      Win mode: {challenge.win_condition_display || challenge.win_condition}
                    </div>
                  )}

                  {activeTab === 'Mine' && (
                    <div className="mb-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-text-muted">Your Progress</span>
                        <span className="text-xs font-mono font-semibold text-accent-blue">
                          {mySteps.toLocaleString()} / {challenge.milestone.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-2 bg-bg-input rounded-full overflow-hidden">
                        <div
                          className="h-full bg-accent-blue rounded-full transition-all duration-700"
                          style={{
                            width: `${Math.min(100, (mySteps / challenge.milestone) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => onViewChallenge(challenge.id)}
                    className={`w-full py-3 rounded-2xl font-semibold transition-all ${
                      activeTab === 'Mine' || activeTab === 'Active'
                        ? 'text-accent-blue bg-tint-blue hover:bg-accent-blue/15'
                        : 'bg-accent-blue text-white shadow-card hover:shadow-lg'
                    }`}
                  >
                    {activeTab === 'Mine' || activeTab === 'Active' ? 'View Details →' : `Join — ${formatKES(challenge.entry_fee)} entry`}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <button
        onClick={onOpenActionMenu}
        className="fixed bottom-28 right-6 w-14 h-14 rounded-full bg-accent-blue flex items-center justify-center z-40 active:scale-95 transition-transform shadow-lg"
      >
        <Plus size={24} strokeWidth={3} className="text-white" />
      </button>
    </>
  );
}
