import { useState } from 'react';
import { initials } from '../../lib/format';

interface AvatarProps {
  name: string | null | undefined;
  src?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Highlights the current user in lists. */
  highlight?: boolean;
  className?: string;
}

const sizes = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-[11px]',
  md: 'h-10 w-10 text-caption',
  lg: 'h-14 w-14 text-body',
  xl: 'h-20 w-20 text-title',
};

// Restrained, low-saturation tones so avatars never compete with status colours.
const palette = [
  'bg-[hsl(158_30%_88%)] text-[hsl(158_50%_22%)]',
  'bg-[hsl(205_35%_88%)] text-[hsl(205_50%_26%)]',
  'bg-[hsl(35_45%_87%)] text-[hsl(30_55%_28%)]',
  'bg-[hsl(265_22%_89%)] text-[hsl(265_30%_32%)]',
  'bg-[hsl(345_28%_89%)] text-[hsl(345_38%_32%)]',
  'bg-[hsl(190_25%_87%)] text-[hsl(190_45%_24%)]',
];

function toneFor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

export function Avatar({ name, src, size = 'md', highlight = false, className = '' }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const label = name || 'User';
  const ring = highlight ? 'ring-2 ring-brand ring-offset-2 ring-offset-bg-card' : '';

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className={`${sizes[size]} shrink-0 rounded-full object-cover ${ring} ${className}`}
      />
    );
  }

  return (
    <span
      className={`${sizes[size]} ${toneFor(label)} inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ${ring} ${className}`}
      aria-hidden
    >
      {initials(label)}
    </span>
  );
}

export default Avatar;
