import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Modal focus management: moves focus into `ref` when `active`, keeps Tab
 * inside it, calls `onEscape` on Escape, and restores focus to the previously
 * focused element on close. Also locks page scroll while active.
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onEscape?: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  const escapeRef = useRef(onEscape)

  useEffect(() => {
    escapeRef.current = onEscape
  }, [onEscape])

  useEffect(() => {
    if (!active) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const node = ref.current
    const focusFirst = () => {
      const target = initialFocus?.current ?? node?.querySelector<HTMLElement>(FOCUSABLE) ?? node
      target?.focus({ preventScroll: true })
    }
    const raf = requestAnimationFrame(focusFirst)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        escapeRef.current?.()
        return
      }
      if (e.key !== 'Tab' || !node) return
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      previouslyFocused?.focus?.({ preventScroll: true })
    }
  }, [active, initialFocus])

  return ref
}
