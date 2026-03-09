import React, { ReactNode } from 'react';

interface BaseModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export const BaseModal: React.FC<BaseModalProps> = ({ open, onClose, title, children }) => {
  if (!open) return null;

  return (
    <div 
      className="fixed inset-0 z-[100] flex items-end bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div 
        className="w-full max-w-lg mx-auto rounded-t-4xl p-6 pb-10 bg-white shadow-modal screen-enter"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="w-10 h-1 bg-border rounded-full mx-auto mb-6" />
        
        {title && <h2 className="text-text-primary text-xl font-black mb-5">{title}</h2>}
        
        {children}
      </div>
    </div>
  );
};
