import { ReactNode, useEffect } from 'react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg';
}

export default function Modal({ isOpen, onClose, title, children, maxWidth = 'md' }: ModalProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const maxWidthClasses = {
    sm: 'sm:max-w-sm',
    md: 'sm:max-w-md',
    lg: 'sm:max-w-lg',
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`w-full ${maxWidthClasses[maxWidth]} rounded-t-3xl sm:rounded-3xl p-6 pb-8 bg-white shadow-modal screen-enter`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-border mx-auto mb-6 sm:hidden" />
        <h2 className="text-text-primary text-lg font-bold mb-5">{title}</h2>

        <div>{children}</div>
      </div>
    </div>
  );
}
