import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

interface ListRowProps {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  /** Navigation target — renders as a link with a chevron. */
  to?: string;
  onClick?: () => void;
  /** Show chevron even for onClick rows (defaults to true when `to` is set). */
  chevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Standard list row (settings, transactions, participants).
 * Group rows inside <ListGroup> to get hairline separators.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  to,
  onClick,
  chevron,
  destructive = false,
  disabled = false,
  className = '',
}: ListRowProps) {
  const showChevron = chevron ?? Boolean(to);
  const interactive = Boolean(to || onClick);
  const body = (
    <>
      {leading}
      <div className="min-w-0 flex-1">
        <div className={`truncate text-body font-medium ${destructive ? 'text-danger' : 'text-text-primary'}`}>{title}</div>
        {subtitle && <div className="mt-0.5 truncate text-caption text-text-muted">{subtitle}</div>}
      </div>
      {trailing && <div className="shrink-0 text-right">{trailing}</div>}
      {showChevron && <ChevronRight size={18} className="shrink-0 text-text-muted" aria-hidden />}
    </>
  );
  const classes = [
    'flex w-full min-h-[56px] items-center gap-3 px-4 py-3 text-left',
    interactive ? 'hover:bg-bg-input/60 active:bg-bg-input active:!scale-100' : '',
    disabled ? 'pointer-events-none opacity-50' : '',
    className,
  ].join(' ');

  if (to) {
    return (
      <Link to={to} className={classes}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes} disabled={disabled}>
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}

interface ListGroupProps {
  children: ReactNode;
  title?: string;
  footer?: ReactNode;
  className?: string;
}

/** Card-like group of rows with hairline dividers, iOS-settings style. */
export function ListGroup({ children, title, footer, className = '' }: ListGroupProps) {
  return (
    <section className={className}>
      {title && <h2 className="eyebrow mb-2 px-1">{title}</h2>}
      <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card">{children}</div>
      {footer && <div className="mt-2 px-1 text-caption text-text-muted">{footer}</div>}
    </section>
  );
}

export default ListRow;
