/**
 * Error State Components
 *
 * User-friendly error states that explain what went wrong
 * and provide clear recovery actions.
 */

import {
  AlertCircle,
  WifiOff,
  RefreshCw,
  ShieldOff,
  ServerOff,
  AlertTriangle,
  XCircle,
  LucideIcon,
} from 'lucide-react';

interface ErrorStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  isRetrying?: boolean;
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

// Base error state component
export function ErrorState({
  icon: Icon = AlertCircle,
  title,
  description,
  onRetry,
  retryLabel = 'Try Again',
  isRetrying = false,
  secondaryAction,
  className = ''
}: ErrorStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-10 px-6 text-center ${className}`} role="alert">
      <div className="w-14 h-14 rounded-2xl bg-danger-soft text-danger flex items-center justify-center mb-4" aria-hidden>
        <Icon size={26} strokeWidth={1.75} />
      </div>
      <h3 className="text-headline text-text-primary mb-1.5">{title}</h3>
      {description && (
        <p className="text-callout text-text-secondary max-w-[280px] mb-5">{description}</p>
      )}
      <div className="flex gap-3">
        {onRetry && (
          <button
            onClick={onRetry}
            disabled={isRetrying}
            type="button"
            className="btn-primary h-11 px-5 rounded-control text-callout flex items-center gap-2"
          >
            <RefreshCw size={16} className={isRetrying ? 'animate-spin' : ''} />
            {isRetrying ? 'Retrying...' : retryLabel}
          </button>
        )}
        {secondaryAction && (
          <button
            onClick={secondaryAction.onClick}
            type="button"
            className="btn-secondary h-11 px-5 rounded-control text-callout"
          >
            {secondaryAction.label}
          </button>
        )}
      </div>
    </div>
  );
}

// Pre-built contextual error states

export function NetworkError({
  onRetry,
  isRetrying = false,
  className = ''
}: {
  onRetry?: () => void;
  isRetrying?: boolean;
  className?: string;
}) {
  return (
    <ErrorState
      icon={WifiOff}
      title="No internet connection"
      description="Please check your connection and try again. Some features may be unavailable offline."
      onRetry={onRetry}
      retryLabel="Retry Connection"
      isRetrying={isRetrying}
      className={className}
    />
  );
}

export function ServerError({
  onRetry,
  isRetrying = false,
  className = ''
}: {
  onRetry?: () => void;
  isRetrying?: boolean;
  className?: string;
}) {
  return (
    <ErrorState
      icon={ServerOff}
      title="Something went wrong"
      description="We're having trouble connecting to our servers. Please try again in a moment."
      onRetry={onRetry}
      isRetrying={isRetrying}
      className={className}
    />
  );
}

export function UnauthorizedError({
  onLogin,
  className = ''
}: {
  onLogin?: () => void;
  className?: string;
}) {
  return (
    <ErrorState
      icon={ShieldOff}
      title="Session expired"
      description="Your session has expired. Please log in again to continue."
      onRetry={onLogin}
      retryLabel="Log In"
      className={className}
    />
  );
}

export function NotFoundError({
  message = "The page or resource you're looking for doesn't exist.",
  onGoBack,
  className = ''
}: {
  message?: string;
  onGoBack?: () => void;
  className?: string;
}) {
  return (
    <ErrorState
      icon={XCircle}
      title="Not found"
      description={message}
      onRetry={onGoBack}
      retryLabel="Go Back"
      className={className}
    />
  );
}

export function LoadError({
  resource = 'data',
  onRetry,
  isRetrying = false,
  className = ''
}: {
  resource?: string;
  onRetry?: () => void;
  isRetrying?: boolean;
  className?: string;
}) {
  return (
    <ErrorState
      icon={AlertTriangle}
      title={`Couldn't load ${resource}`}
      description="There was a problem loading this content. Please try again."
      onRetry={onRetry}
      isRetrying={isRetrying}
      className={className}
    />
  );
}

export function ActionError({
  action = 'complete this action',
  message,
  onRetry,
  onDismiss,
  className = ''
}: {
  action?: string;
  message?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <ErrorState
      icon={AlertCircle}
      title={`Unable to ${action}`}
      description={message || 'Something went wrong. Please try again.'}
      onRetry={onRetry}
      retryLabel="Try Again"
      secondaryAction={onDismiss ? { label: 'Dismiss', onClick: onDismiss } : undefined}
      className={className}
    />
  );
}

// Compact inline error
export function ErrorInline({
  message,
  onRetry,
  className = ''
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 py-4 px-4 rounded-2xl bg-danger-soft ${className}`}>
      <AlertCircle size={18} className="text-danger shrink-0" aria-hidden />
      <p className="text-callout text-danger flex-1">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="min-h-touch px-2 text-callout font-semibold text-danger"
        >
          Retry
        </button>
      )}
    </div>
  );
}

// Error banner (for top of screen)
export function ErrorBanner({
  message,
  onDismiss,
  className = ''
}: {
  message: string;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 py-3 px-4 bg-danger-soft rounded-2xl ${className}`}>
      <AlertCircle size={18} className="text-danger shrink-0" aria-hidden />
      <p className="text-callout text-danger flex-1">{message}</p>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-danger"
          aria-label="Dismiss"
        >
          <XCircle size={18} />
        </button>
      )}
    </div>
  );
}

// Try/catch boundary fallback
export function ErrorFallback({
  resetErrorBoundary,
  className = ''
}: {
  resetErrorBoundary?: () => void;
  className?: string;
}) {
  return (
    <div className={`min-h-[50vh] flex items-center justify-center ${className}`}>
      <ErrorState
        icon={AlertTriangle}
        title="Something went wrong"
        description="An unexpected error occurred. Please try refreshing the page."
        onRetry={resetErrorBoundary}
        retryLabel="Refresh"
      />
    </div>
  );
}
