import type { HTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

export type CardVariant = 'standard' | 'elevated' | 'flat' | 'outline' | 'brand';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const variantClasses: Record<CardVariant, string> = {
  standard: 'bg-bg-card border border-border-light shadow-card',
  elevated: 'bg-bg-elevated border border-border-light shadow-raised',
  flat: 'bg-bg-sunken',
  outline: 'border border-border bg-transparent',
  brand: 'bg-brand text-brand-fg',
};

const paddingClasses: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
};

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> {
  children: ReactNode;
  variant?: CardVariant;
  padding?: CardPadding;
  /** Makes the whole card interactive. Prefer `to` for navigation. */
  onClick?: () => void;
  /** Renders the card as a router link. */
  to?: string;
  /** Legacy prop: equivalent to an interactive standard card. */
  hover?: boolean;
  className?: string;
}

/**
 * Grouping surface. Use sparingly — only when grouping adds meaning.
 * Interactive cards get hover/press feedback and proper semantics.
 */
export default function Card({
  children,
  variant = 'standard',
  padding = 'md',
  onClick,
  to,
  hover = false,
  className = '',
  ...rest
}: CardProps) {
  const interactive = Boolean(onClick || to || hover);
  const classes = [
    'block rounded-card text-left',
    variantClasses[variant],
    paddingClasses[padding],
    interactive ? 'cursor-pointer hover:border-border hover:shadow-card-hover active:scale-[0.99]' : '',
    className,
  ].join(' ');

  if (to) {
    return (
      <Link to={to} className={classes}>
        {children}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div
        {...rest}
        className={classes}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick();
          }
        }}
      >
        {children}
      </div>
    );
  }

  return (
    <div {...rest} className={classes}>
      {children}
    </div>
  );
}

export { Card };

interface CardHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export function CardHeader({ title, subtitle, action }: CardHeaderProps) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-headline text-text-primary">{title}</h3>
        {subtitle && <p className="mt-0.5 text-caption text-text-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: { label: string; to?: string; onClick?: () => void };
  className?: string;
}

/** Heading above a group of content, with an optional "See all" style action. */
export function SectionHeader({ title, subtitle, action, className = '' }: SectionHeaderProps) {
  const actionClasses = 'inline-flex min-h-touch items-center gap-0.5 -my-3 text-callout font-semibold text-brand';
  return (
    <div className={`mb-3 flex items-end justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-headline text-text-primary">{title}</h2>
        {subtitle && <p className="mt-0.5 text-caption text-text-muted">{subtitle}</p>}
      </div>
      {action &&
        (action.to ? (
          <Link to={action.to} className={actionClasses}>
            {action.label}
            <ChevronRight size={16} aria-hidden />
          </Link>
        ) : (
          <button type="button" onClick={action.onClick} className={actionClasses}>
            {action.label}
            <ChevronRight size={16} aria-hidden />
          </button>
        ))}
    </div>
  );
}
