import { Moon, Sun } from 'lucide-react'
import { resolveTheme, useThemeStore } from '../lib/theme'
import { IconButton } from './ui/Button'

/**
 * Light/dark switch for the top bar. The choice persists in localStorage.
 * "Match system" is available from the command palette (Ctrl/Cmd+K).
 */
export function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference)
  const setPreference = useThemeStore((s) => s.setPreference)
  const current = resolveTheme(preference)
  const next = current === 'dark' ? 'light' : 'dark'
  return (
    <IconButton label={`Switch to ${next} theme`} onClick={() => setPreference(next)}>
      {current === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </IconButton>
  )
}
