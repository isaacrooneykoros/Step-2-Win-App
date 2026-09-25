import type { ElementType } from 'react'
import {
  AlertTriangle, Ban, CheckCircle2, CircleDot, Flag, FlagOff, KeyRound, LogIn, LogOut, PauseCircle, Pencil,
  Play, PlayCircle, Plus, ScanSearch, Settings, ShieldAlert, ShieldCheck, ShieldOff, Trash2, UserCheck, XCircle,
} from 'lucide-react'
import type { BadgeTone } from '../../lib/status'
import { humanize } from './utils'

/** Human label, tone and icon for every audit action code the backend writes. Unknown codes fall back to a humanised label. */
export const AUDIT_ACTIONS: Record<string, { label: string; tone: BadgeTone; icon: ElementType }> = {
  create: { label: 'Created', tone: 'success', icon: Plus },
  update: { label: 'Updated', tone: 'neutral', icon: Pencil },
  delete: { label: 'Deleted', tone: 'danger', icon: Trash2 },
  login: { label: 'Signed in', tone: 'neutral', icon: LogIn },
  logout: { label: 'Signed out', tone: 'neutral', icon: LogOut },
  ban: { label: 'Banned', tone: 'danger', icon: Ban },
  unban: { label: 'Unbanned', tone: 'success', icon: UserCheck },
  approve: { label: 'Approved', tone: 'success', icon: CheckCircle2 },
  reject: { label: 'Rejected', tone: 'danger', icon: XCircle },
  cancel: { label: 'Cancelled', tone: 'danger', icon: XCircle },
  promote: { label: 'Granted staff', tone: 'warning', icon: ShieldCheck },
  demote: { label: 'Removed staff', tone: 'warning', icon: ShieldOff },
  reset_password: { label: 'Password reset', tone: 'warning', icon: KeyRound },
  account_deleted: { label: 'Account deleted', tone: 'neutral', icon: Trash2 },
  settings_change: { label: 'Settings changed', tone: 'warning', icon: Settings },
  warn: { label: 'Warned', tone: 'warning', icon: AlertTriangle },
  restrict: { label: 'Restricted', tone: 'danger', icon: ShieldAlert },
  suspend: { label: 'Suspended', tone: 'danger', icon: PauseCircle },
  unrestrict: { label: 'Restriction lifted', tone: 'success', icon: ShieldCheck },
  unsuspend: { label: 'Suspension lifted', tone: 'success', icon: PlayCircle },
  dismiss_flag: { label: 'Flag dismissed', tone: 'neutral', icon: FlagOff },
  confirm_flag: { label: 'Flag confirmed', tone: 'danger', icon: Flag },
  session_review: { label: 'Session reviewed', tone: 'info', icon: ScanSearch },
  run_job: { label: 'Job run', tone: 'info', icon: Play },
}

export function auditAction(code: string) {
  return AUDIT_ACTIONS[code] ?? { label: humanize(code), tone: 'neutral' as BadgeTone, icon: CircleDot }
}

