type BadgeVariant =
  | 'active' | 'inactive' | 'banned' | 'pending'
  | 'completed' | 'failed' | 'cancelled' | 'success'
  | 'warning' | 'info' | 'admin' | 'user'
  | 'flagged' | 'resolved' | 'reviewing'
  | 'public' | 'private'

const VARIANTS: Record<BadgeVariant, { bg: string; text: string; dot: string }> = {
  active:    { bg: 'rgba(34,211,160,0.12)',  text: '#22D3A0', dot: '#22D3A0' },
  success:   { bg: 'rgba(34,211,160,0.12)',  text: '#22D3A0', dot: '#22D3A0' },
  completed: { bg: 'rgba(34,211,160,0.12)',  text: '#22D3A0', dot: '#22D3A0' },
  resolved:  { bg: 'rgba(34,211,160,0.12)',  text: '#22D3A0', dot: '#22D3A0' },
  inactive:  { bg: 'rgba(123,130,160,0.12)', text: '#7B82A0', dot: '#7B82A0' },
  cancelled: { bg: 'rgba(123,130,160,0.12)', text: '#7B82A0', dot: '#7B82A0' },
  pending:   { bg: 'rgba(245,166,35,0.12)',  text: '#F5A623', dot: '#F5A623' },
  warning:   { bg: 'rgba(245,166,35,0.12)',  text: '#F5A623', dot: '#F5A623' },
  reviewing: { bg: 'rgba(245,166,35,0.12)',  text: '#F5A623', dot: '#F5A623' },
  failed:    { bg: 'rgba(240,96,96,0.12)',   text: '#F06060', dot: '#F06060' },
  banned:    { bg: 'rgba(240,96,96,0.12)',   text: '#F06060', dot: '#F06060' },
  flagged:   { bg: 'rgba(240,96,96,0.12)',   text: '#F06060', dot: '#F06060' },
  info:      { bg: 'rgba(79,156,249,0.12)',  text: '#4F9CF9', dot: '#4F9CF9' },
  public:    { bg: 'rgba(79,156,249,0.12)',  text: '#4F9CF9', dot: '#4F9CF9' },
  admin:     { bg: 'rgba(124,111,247,0.15)', text: '#7C6FF7', dot: '#7C6FF7' },
  private:   { bg: 'rgba(124,111,247,0.12)', text: '#7C6FF7', dot: '#7C6FF7' },
  user:      { bg: 'rgba(123,130,160,0.1)',  text: '#7B82A0', dot: '#7B82A0' },
}

interface StatusBadgeProps {
  variant:  BadgeVariant
  label?:   string     // override display label
  showDot?: boolean    // show animated dot (default: true for active)
  size?:    'sm' | 'md'
}

export function StatusBadge({
  variant, label, showDot, size = 'md'
}: StatusBadgeProps) {
  const v       = VARIANTS[variant] ?? VARIANTS['inactive']
  const display = label ?? variant.charAt(0).toUpperCase() + variant.slice(1)
  const dot     = showDot ?? variant === 'active'
  const pad     = size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${pad}`}
      style={{ background: v.bg, color: v.text }}>
      {dot && (
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: v.dot }} />
      )}
      {display}
    </span>
  )
}
