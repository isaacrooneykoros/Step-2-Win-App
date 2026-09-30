import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input, Select, Textarea } from '../ui/Input'
import { formatNumber } from '../../lib/format'
import { consoleApi } from './api'
import { formatDay } from './utils'

/** Set / void / clear one user-day's steps (Steps page). Raw evidence is never changed. */
export function StepCorrectionModal({ target, onClose, onDone }: {
  target: { userId: number; username: string; date: string; steps: number } | null
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<'set' | 'void' | 'clear'>('set')
  const [steps, setSteps] = useState(target ? String(target.steps) : '')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const n = Number(steps)
  const valid = reason.trim().length >= 5 && (kind !== 'set' || (steps.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 150000))
  const m = useMutation({
    mutationFn: () => consoleApi.correctSteps(target!.userId, { date: target!.date, kind, steps: kind === 'set' ? n : undefined, reason: reason.trim() }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'steps'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'step-logs'] })
      onDone(`${target?.username} · ${formatDay(res.date)}: ${formatNumber(res.steps.old)} → ${formatNumber(res.steps.new)} steps. Live challenges, totals and rankings recomputed.`)
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Request failed'),
  })
  return (
    <Modal open={!!target} onClose={() => !m.isPending && onClose()} size="sm"
      title={target ? `Correct ${target.username} · ${formatDay(target.date)}` : 'Correct steps'}
      description="Saved as a correction on top of the synced day; sync evidence is never changed. Live challenges covering the day, lifetime totals and weekly rankings are recomputed. Days in settled challenges can't be changed."
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={m.isPending}>Cancel</Button>
        <Button variant={kind === 'set' ? 'primary' : 'danger'} loading={m.isPending} disabled={!valid} onClick={() => m.mutate()}>Save correction</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">Currently <span className="num font-medium text-ink-primary">{formatNumber(target?.steps ?? 0)}</span> steps</p>
        <Select label="Correction" value={kind} onChange={(e) => setKind(e.target.value as 'set' | 'void' | 'clear')}>
          <option value="set">Set the day's steps</option>
          <option value="void">Void the day (0 steps)</option>
          <option value="clear">Remove an earlier correction</option>
        </Select>
        {kind === 'set' && <Input label="Steps for the day" inputMode="numeric" value={steps} onChange={(e) => setSteps(e.target.value)} />}
        <Textarea label="Reason (kept in the audit log)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
