interface BrandMarkProps {
  size?: number
  className?: string
  title?: string
}

/**
 * Step2Win mark (shared with the consumer app): an ascending stair line on the
 * brand tile. The dot is the consumer app's reward amber — the only place the
 * admin uses that colour.
 */
export function BrandMark({ size = 28, className, title }: BrandMarkProps) {
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
      <rect width="40" height="40" rx="10" fill="#14855D" />
      <path d="M11 29h6.5v-6.5H24V16h6.5V9.5" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="30.5" cy="9.5" r="2.6" fill="#F5A30A" />
    </svg>
  )
}
