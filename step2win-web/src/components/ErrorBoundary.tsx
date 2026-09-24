import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorFallback } from './ui/ErrorState';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/** Last-resort boundary so a render error shows a recoverable screen instead of a blank app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[100dvh] bg-bg-page pt-safe">
          <ErrorFallback resetErrorBoundary={() => window.location.reload()} />
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
