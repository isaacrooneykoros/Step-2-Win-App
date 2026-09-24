import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'brand' | 'reward' | 'success' | 'warning' | 'danger' | 'info';

export const toneClasses: Record<Tone, { soft: string; text: string; solid: string; dot: string }> = {
  neutral: { soft: 'bg-bg-input', text: 'text-text-secondary', solid: 'bg-text-primary text-text-inverse', dot: 'bg-text-muted' },
  brand: { soft: 'bg-brand-soft', text: 'text-brand', solid: 'bg-brand text-brand-fg', dot: 'bg-brand' },
  reward: { soft: 'bg-reward-soft', text: 'text-reward-ink', solid: 'bg-reward text-text-primary', dot: 'bg-reward' },
  success: { soft: 'bg-success-soft', text: 'text-success', solid: 'bg-success text-white', dot: 'bg-success' },
  warning: { soft: 'bg-warning-soft', text: 'text-warning', solid: 'bg-warning text-white', dot: 'bg-warning' },
  danger: { soft: 'bg-danger-soft', text: 'text-danger', solid: 'bg-danger text-white', dot: 'bg-danger' },
  info: { soft: 'bg-info-soft', text: 'text-info', solid: 'bg-info text-white', dot: 'bg-info' },
};

interface PillProps {
  children: ReactNode;
  tone?: Tone;
  icon?: LucideIcon;
  /** Leading status dot. `live` pulses gently (disabled under reduced motion). */
  dot?: boolean | 'live';
  size?: 'sm' | 'md';
  solid?: boolean;
  className?: string;
}

/** Compact status label. Always carries text so meaning never relies on colour alone. */
export function Pill({ children, tone = 'neutral', icon: Icon, dot, size = 'sm', solid = false, className = '' }: PillProps) {
  const t = toneClasses[tone];
  return (
    <span
      className={[
        'inline-flex max-w-full items-center gap-1 rounded-full font-semibold whitespace-nowrap',
        size === 'sm' ? 'h-6 px-2 text-micro' : 'h-7 px-2.5 text-caption',
        solid ? t.solid : `${t.soft} ${t.text}`,
        className,
      ].join(' ')}
    >
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${solid ? 'bg-current' : t.dot} ${dot === 'live' ? 'live-dot' : ''}`} aria-hidden />}
      {Icon && <Icon size={size === 'sm' ? 12 : 14} strokeWidth={2.25} aria-hidden className="shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

export default Pill;

interface IconTileProps {
  icon: LucideIcon;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Soft-tinted square holding an icon — leading element for rows and metrics. */
export function IconTile({ icon: Icon, tone = 'neutral', size = 'md', className = '' }: IconTileProps) {
  const t = toneClasses[tone];
  const dims = size === 'sm' ? 'h-8 w-8 rounded-[10px]' : size === 'lg' ? 'h-12 w-12 rounded-2xl' : 'h-10 w-10 rounded-xl';
  const iconSize = size === 'sm' ? 16 : size === 'lg' ? 22 : 18;
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${dims} ${t.soft} ${tone === 'neutral' ? 'text-text-secondary' : t.text} ${className}`} aria-hidden>
      <Icon size={iconSize} strokeWidth={2} />
    </span>
  );
}
