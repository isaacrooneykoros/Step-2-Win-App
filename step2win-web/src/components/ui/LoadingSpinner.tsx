import { useEffect, useState } from 'react';
import { Spinner } from './Spinner';
import { BrandMark } from '../brand/BrandMark';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const px = { sm: 16, md: 24, lg: 32 };

export default function LoadingSpinner({ size = 'md', className = '' }: LoadingSpinnerProps) {
  return <Spinner size={px[size]} className={`text-brand ${className}`} label="Loading" />;
}

/**
 * Full-page loading. Renders nothing for the first 250ms so fast loads (cached chunks,
 * restored sessions) don't flash a loader; after that shows a quiet brand mark.
 */
export function PageLoader() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShow(true), 250);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-[60dvh] items-center justify-center bg-bg-page" aria-busy="true">
      {show && (
        <div className="fade-in flex flex-col items-center gap-4" role="status" aria-label="Loading">
          <BrandMark size={44} />
          <Spinner size={18} className="text-text-muted" />
        </div>
      )}
    </div>
  );
}
