interface PageHeaderProps {
  title:     string
  subtitle?: string
  actions?:  React.ReactNode
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div>
        <h1 className="text-ink-primary text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="text-ink-secondary text-sm mt-0.5">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-3">{actions}</div>
      )}
    </div>
  )
}
