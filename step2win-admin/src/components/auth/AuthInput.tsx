import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

interface AuthInputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode;
  error?: string;
  hint?: string;
}

export const AuthInput = forwardRef<HTMLInputElement, AuthInputProps>(({ icon, error, hint, ...props }, ref) => (
  <div className="relative mb-4">
    {icon && (
      <div className="pointer-events-none absolute left-3.5 top-[22px] -translate-y-1/2 opacity-55">{icon}</div>
    )}
    <input
      ref={ref}
      {...props}
      aria-invalid={error ? true : undefined}
      className={`w-full rounded-xl py-3 pr-4 text-sm outline-none transition-all placeholder:text-[#596077] ${icon ? 'pl-10' : 'pl-4'}`}
      style={{
        background: '#11151E',
        border: `1px solid ${error ? '#F06060' : '#21263A'}`,
        color: '#F0F2F8',
        fontFamily: 'DM Sans, sans-serif',
        boxShadow: error ? '0 0 0 3px rgba(240,96,96,0.08)' : 'none',
      }}
      onFocus={(event) => {
        event.currentTarget.style.borderColor = error ? '#F06060' : '#7C6FF7';
        event.currentTarget.style.boxShadow = error
          ? '0 0 0 3px rgba(240,96,96,0.08)'
          : '0 0 0 3px rgba(124,111,247,0.12)';
      }}
      onBlur={(event) => {
        event.currentTarget.style.borderColor = error ? '#F06060' : '#21263A';
        event.currentTarget.style.boxShadow = error ? '0 0 0 3px rgba(240,96,96,0.08)' : 'none';
      }}
    />
    {error && (
      <p className="text-xs mt-1.5 ml-1" style={{ color: '#F06060' }}>
        {error}
      </p>
    )}
    {hint && !error && (
      <p className="text-xs mt-1.5 ml-1 leading-relaxed" style={{ color: '#4A5070' }}>
        {hint}
      </p>
    )}
  </div>
));

AuthInput.displayName = 'AuthInput';
