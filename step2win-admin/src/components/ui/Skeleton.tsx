import type { CSSProperties } from 'react'
import { cn } from '../../lib/cn'

interface SkeletonProps {
  className?: string
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  /** Visually-hidden text for screen readers on the outermost skeleton of a region. */
  label?: string
}

/** Loading placeholder shaped like the content it replaces. */
export function Skeleton({ className, width, height = 12, label }: SkeletonProps) {
  return (
    <span
      className={cn('skeleton block', className)}
      style={{ width, height }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}

/** A few stacked text lines. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  )
}
