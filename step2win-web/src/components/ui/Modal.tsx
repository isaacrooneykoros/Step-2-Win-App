import type { ReactNode } from 'react';
import { Sheet } from './Sheet';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg';
}

/** Legacy API — renders the shared Sheet. */
export default function Modal({ isOpen, onClose, title, children, maxWidth = 'md' }: ModalProps) {
  return (
    <Sheet open={isOpen} onClose={onClose} title={title} size={maxWidth}>
      {children}
    </Sheet>
  );
}
