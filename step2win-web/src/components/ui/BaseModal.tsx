import type { ReactNode } from 'react';
import { Sheet } from './Sheet';

interface BaseModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  footer?: ReactNode;
  dismissible?: boolean;
  children: ReactNode;
}

/** Legacy API — renders the shared Sheet. */
export function BaseModal({ open, onClose, title, description, footer, dismissible, children }: BaseModalProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title} description={description} footer={footer} dismissible={dismissible}>
      {children}
    </Sheet>
  );
}

export default BaseModal;
