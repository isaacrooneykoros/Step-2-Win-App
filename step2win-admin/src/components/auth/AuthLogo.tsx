import { BrandMark } from '../BrandMark';

export function AuthLogo() {
  return (
    <div className="mb-5 flex items-center justify-center gap-2.5">
      <BrandMark size={32} />
      <div className="leading-tight">
        <p className="text-base font-semibold tracking-[-0.01em] text-ink-primary">Step2Win</p>
        <p className="text-xs text-ink-muted">Operations console</p>
      </div>
    </div>
  );
}
