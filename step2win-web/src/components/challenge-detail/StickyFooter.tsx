import type { ReactNode } from 'react';

/**
 * Action bar that stays pinned just above the bottom navigation while the screen
 * scrolls, then settles at the end of the content. Uses `sticky` (not `fixed`) so
 * it works inside the animated route wrapper.
 */
export function StickyFooter({ children }: { children: ReactNode }) {
  return (
    <div
      className="sticky z-20 mt-8 border-t border-border-light bg-bg-page/95 px-5 py-3 backdrop-blur-md"
      style={{ bottom: 'calc(var(--nav-height) + env(safe-area-inset-bottom, 0px))' }}
    >
      {children}
    </div>
  );
}

export default StickyFooter;
