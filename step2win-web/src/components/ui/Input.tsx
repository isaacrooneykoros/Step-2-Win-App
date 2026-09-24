import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  /** Icon or text inside the field, left side. */
  leading?: ReactNode;
  /** Icon, unit or button inside the field, right side. */
  trailing?: ReactNode;
  containerClassName?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helperText, leading, trailing, className = '', containerClassName = '', id, ...props }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    const messageId = `${inputId}-msg`;
    const hasMessage = Boolean(error || helperText);

    return (
      <div className={`mb-4 w-full ${containerClassName}`}>
        {label && (
          <label htmlFor={inputId} className="label">
            {label}
            {props.required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
          </label>
        )}
        <div className="relative">
          {leading && (
            <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-text-muted">{leading}</span>
          )}
          <input
            ref={ref}
            id={inputId}
            aria-invalid={error ? true : undefined}
            aria-describedby={hasMessage ? messageId : undefined}
            className={`input-field ${leading ? 'pl-11' : ''} ${trailing ? 'pr-12' : ''} ${className}`}
            {...props}
          />
          {trailing && <span className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</span>}
        </div>
        {error ? (
          <p id={messageId} className="mt-1.5 text-caption font-medium text-danger" role="alert">
            {error}
          </p>
        ) : helperText ? (
          <p id={messageId} className="mt-1.5 text-caption text-text-muted">
            {helperText}
          </p>
        ) : null}
      </div>
    );
  },
);

Input.displayName = 'Input';

export default Input;
export { Input };

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ label, error, helperText, className = '', id, ...props }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    const messageId = `${inputId}-msg`;
    return (
      <div className="mb-4 w-full">
        {label && (
          <label htmlFor={inputId} className="label">
            {label}
            {props.required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || helperText ? messageId : undefined}
          className={`input-field min-h-[104px] resize-none ${className}`}
          {...props}
        />
        {error ? (
          <p id={messageId} className="mt-1.5 text-caption font-medium text-danger" role="alert">
            {error}
          </p>
        ) : helperText ? (
          <p id={messageId} className="mt-1.5 text-caption text-text-muted">
            {helperText}
          </p>
        ) : null}
      </div>
    );
  },
);

TextArea.displayName = 'TextArea';
