export function AuthDivider({ label }: { label: string }) {
  return (
    <div className="my-5 flex items-center gap-3" role="separator">
      <div className="h-px flex-1 bg-surface-border" />
      <span className="text-xs text-ink-muted">{label}</span>
      <div className="h-px flex-1 bg-surface-border" />
    </div>
  );
}
