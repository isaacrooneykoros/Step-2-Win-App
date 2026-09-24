import { Check, Flame, Footprints, ShieldCheck, Trophy, Wallet } from 'lucide-react';

/**
 * Small, code-built illustrations for the onboarding pages. Each one explains a single
 * idea and animates only when its page becomes active (a state change, not decoration).
 * Colors come from tokens so they follow light/dark mode; reduced motion collapses
 * every transition globally via index.css.
 */

interface IllustrationProps {
  active: boolean;
}

const ringTransition = 'stroke-dashoffset var(--dur-data, 900ms) var(--ease-enter)';

/** MOVE — a step ring filling up, with a "verified" seal. */
export function MoveIllustration({ active }: IllustrationProps) {
  const r = 70;
  const c = 2 * Math.PI * r;
  const progress = 0.72;

  return (
    <div className="relative flex h-full w-full items-center justify-center" aria-hidden>
      <svg viewBox="0 0 180 180" className="h-full max-h-[220px] w-auto">
        <circle cx="90" cy="90" r={r} fill="none" stroke="hsl(var(--bg-input))" strokeWidth="14" />
        <circle
          cx="90"
          cy="90"
          r={r}
          fill="none"
          stroke="hsl(var(--brand))"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={active ? c * (1 - progress) : c}
          transform="rotate(-90 90 90)"
          style={{ transition: ringTransition }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-soft text-brand">
          <Footprints size={28} strokeWidth={2} />
        </span>
      </div>
      <span
        className={[
          'absolute bottom-1 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-light',
          'bg-bg-card px-3 py-1.5 text-caption font-semibold text-text-primary shadow-card',
          'transition-[opacity,transform] duration-normal ease-enter',
          active ? 'translate-y-0 opacity-100 delay-500' : 'translate-y-2 opacity-0',
        ].join(' ')}
      >
        <ShieldCheck size={14} className="text-success" strokeWidth={2.25} />
        Verified steps
      </span>
    </div>
  );
}

/** CHALLENGE — a compact leaderboard: you among friends and the community. */
export function ChallengeIllustration({ active }: IllustrationProps) {
  const rows = [
    { width: 92, you: false, tone: 'bg-text-muted/30' },
    { width: 78, you: true, tone: 'bg-brand' },
    { width: 64, you: false, tone: 'bg-text-muted/30' },
    { width: 48, you: false, tone: 'bg-text-muted/30' },
  ];

  return (
    <div className="flex h-full w-full items-center justify-center" aria-hidden>
      <div className="w-full max-w-[300px] rounded-card border border-border-light bg-bg-card p-3 shadow-card">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-caption font-semibold text-text-secondary">Weekend 50k</span>
          <Trophy size={16} className="text-text-muted" />
        </div>
        <ol className="space-y-1.5">
          {rows.map((row, i) => (
            <li
              key={i}
              className={`flex items-center gap-2.5 rounded-xl px-2 py-2 ${row.you ? 'bg-brand-soft' : ''}`}
            >
              <span className="num w-3 text-center text-caption font-semibold text-text-muted">{i + 1}</span>
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-micro font-bold ${
                  row.you ? 'bg-brand text-brand-fg' : 'bg-bg-input text-text-secondary'
                }`}
              >
                {row.you ? 'You' : ['A', 'B', 'C', 'D'][i]}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-bg-input">
                <span
                  className={`block h-full rounded-full ${row.tone} transition-[width] duration-deliberate ease-enter`}
                  style={{ width: active ? `${row.width}%` : '0%', transitionDelay: active ? `${120 + i * 70}ms` : '0ms' }}
                />
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** EARN — entries form a pool; only qualified finishers share it. */
export function EarnIllustration({ active }: IllustrationProps) {
  const people = [true, true, true, false, false];

  return (
    <div className="flex h-full w-full items-center justify-center" aria-hidden>
      <div className="w-full max-w-[300px] rounded-card border border-border-light bg-bg-card p-4 shadow-card">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-reward-soft text-reward-ink">
            <Wallet size={16} strokeWidth={2.25} />
          </span>
          <span className="text-callout font-semibold text-text-primary">Challenge pool</span>
        </div>

        {/* The pool fills from everyone's entries… */}
        <div className="mt-3 flex h-3 gap-1">
          {people.map((_, i) => (
            <span key={i} className="flex-1 overflow-hidden rounded-full bg-bg-input">
              <span
                className="block h-full rounded-full bg-reward transition-[width] duration-normal ease-enter"
                style={{ width: active ? '100%' : '0%', transitionDelay: active ? `${100 + i * 80}ms` : '0ms' }}
              />
            </span>
          ))}
        </div>

        {/* …and is split among those who qualified. */}
        <div className="mt-4 flex justify-between">
          {people.map((qualified, i) => (
            <span key={i} className="flex flex-col items-center gap-1.5">
              <span
                className={[
                  'flex h-9 w-9 items-center justify-center rounded-full transition-colors duration-normal',
                  qualified && active ? 'bg-success-soft text-success' : 'bg-bg-input text-text-muted',
                ].join(' ')}
                style={{ transitionDelay: active ? '700ms' : '0ms' }}
              >
                {qualified ? <Check size={16} strokeWidth={2.75} /> : <span className="h-1.5 w-3 rounded-full bg-current" />}
              </span>
              <span className={`text-micro font-medium ${qualified ? 'text-text-secondary' : 'text-text-muted'}`}>
                {qualified ? 'Share' : 'Missed'}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** BUILD CONSISTENCY — a week of hit goals and a streak count. */
export function ConsistencyIllustration({ active }: IllustrationProps) {
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const done = 5;

  return (
    <div className="flex h-full w-full items-center justify-center" aria-hidden>
      <div className="w-full max-w-[300px] rounded-card border border-border-light bg-bg-card p-4 shadow-card">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-callout font-semibold text-text-primary">
            <Flame size={16} className="text-brand" strokeWidth={2.25} />
            <span className="num">5-day streak</span>
          </span>
          <span className="text-caption text-text-muted">Daily goal</span>
        </div>
        <div className="mt-4 flex justify-between">
          {days.map((d, i) => {
            const hit = i < done;
            const today = i === done;
            return (
              <span key={i} className="flex flex-col items-center gap-1.5">
                <span
                  className={[
                    'flex h-8 w-8 items-center justify-center rounded-full transition-[background-color,color,transform] duration-normal ease-enter',
                    hit && active ? 'scale-100 bg-brand text-brand-fg' : '',
                    hit && !active ? 'scale-90 bg-bg-input text-transparent' : '',
                    today ? 'border-2 border-dashed border-brand/60 text-transparent' : '',
                    !hit && !today ? 'bg-bg-input' : '',
                  ].join(' ')}
                  style={{ transitionDelay: active && hit ? `${120 + i * 70}ms` : '0ms' }}
                >
                  {hit && <Check size={14} strokeWidth={3} />}
                </span>
                <span className={`text-micro font-semibold ${today ? 'text-brand' : 'text-text-muted'}`}>{d}</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
