import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

interface AuthInputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode;
  error?: string;
  hint?: string;
}

export const AuthInput = forwardRef<HTMLInputElement, AuthInputProps>(({ icon, error, hint, ...props }, ref) => (
  <div className="relative mb-4">
    {icon && (
      <div className="absolute left-3.5 top-1/2 -translate-y-1/2 opacity-40 pointer-events-none">{icon}</div>
    )}
    <input
      ref={ref}
      {...props}
      className={`w-full py-3 pr-4 text-sm rounded-xl outline-none transition-colors ${icon ? 'pl-10' : 'pl-4'}`}
      style={{
        background: '#13161F',
        border: `1px solid ${error ? '#F06060' : '#21263A'}`,
        color: '#F0F2F8',
        fontFamily: 'DM Sans, sans-serif',
      }}
      onFocus={(event) => {
        event.currentTarget.style.borderColor = error ? '#F06060' : '#7C6FF7';
      }}
      onBlur={(event) => {
        event.currentTarget.style.borderColor = error ? '#F06060' : '#21263A';
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
