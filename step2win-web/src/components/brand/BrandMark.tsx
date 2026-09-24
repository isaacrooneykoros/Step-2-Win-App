interface BrandMarkProps {
  size?: number;
  className?: string;
  /** `solid`: brand tile with light glyph. `plain`: glyph only, uses currentColor. */
  variant?: 'solid' | 'plain';
  title?: string;
}

/**
 * Step2Win mark: an ascending stair line — steps that climb toward a goal.
 * Pure SVG (no external asset), scales from favicon to splash.
 */
export function BrandMark({ size = 40, className = '', variant = 'solid', title }: BrandMarkProps) {
  const glyph = (
    <path
      d="M11 29h6.5v-6.5H24V16h6.5V9.5"
      fill="none"
      stroke={variant === 'solid' ? 'hsl(var(--brand-fg))' : 'currentColor'}
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {variant === 'solid' && <rect width="40" height="40" rx="11" fill="hsl(var(--brand))" />}
      {glyph}
      <circle cx="30.5" cy="9.5" r="2.6" fill={variant === 'solid' ? 'hsl(var(--reward))' : 'currentColor'} />
    </svg>
  );
}

/** Wordmark: "Step2Win" with the numeral in brand colour. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-bold tracking-[-0.03em] text-text-primary ${className}`}>
      Step<span className="text-brand">2</span>Win
    </span>
  );
}

export default BrandMark;
