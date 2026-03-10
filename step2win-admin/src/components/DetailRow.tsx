interface DetailRowProps {
  label:    string
  value:    React.ReactNode
  mono?:    boolean
}

export function DetailRow({ label, value, mono }: DetailRowProps) {
  return (
    <div className="flex items-start justify-between py-3"
      style={{ borderBottom: '1px solid #1C1F2E' }}>
      <span className="text-ink-muted text-xs font-medium uppercase tracking-wider
                       shrink-0 mt-0.5 w-36">
        {label}
      </span>
      <span className={`text-ink-primary text-sm text-right flex-1 ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  )
}
