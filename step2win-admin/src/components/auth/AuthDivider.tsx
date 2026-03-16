export function AuthDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 my-5">
      <div className="flex-1 h-px" style={{ background: '#21263A' }} />
      <span className="text-[11px]" style={{ color: '#3D4260' }}>
        {label}
      </span>
      <div className="flex-1 h-px" style={{ background: '#21263A' }} />
    </div>
  );
}
