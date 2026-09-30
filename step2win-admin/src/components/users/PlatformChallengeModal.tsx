import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input, Select, Textarea } from '../ui/Input'
import { formatKES, formatNumber } from '../../lib/format'
import { ApiError, consoleApi } from './api'
import { MILESTONES } from './utils'
import { usePermissions } from '../../lib/permissions'

function inDays(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Create a platform (sponsored) challenge: public, live today, optional platform bonus. */
export function PlatformChallengeModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (msg: string, id: number) => void }) {
  const { can } = usePermissions()
  const [form, setForm] = useState({ name: '', description: '', milestone: '50000', entry_fee: '0', platform_bonus_kes: '0', end_date: inDays(7), max_participants: '200', is_featured: true })
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const bonus = Number(form.platform_bonus_kes) || 0
  const m = useMutation({
    mutationFn: () => consoleApi.createPlatformChallenge({ ...form, milestone: Number(form.milestone), max_participants: Number(form.max_participants) }),
    onSuccess: (c) => onDone(`${c.name} is live${bonus ? ` with a ${formatKES(bonus)} platform bonus` : ''}.`, c.id),
    onError: (e) => { setError(e instanceof Error ? e.message : 'Request failed'); if (e instanceof ApiError) setFields(e.fields) },
  })
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const bonusBlocked = bonus > 0 && !can('finance.adjust')
  return (
    <Modal open={open} onClose={() => !m.isPending && onClose()} size="md" title="New platform challenge"
      description="A public challenge run by Step2Win, live from today. The platform bonus is added to the winners' pool at settlement and paid from platform revenue — only if someone qualifies."
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={m.isPending}>Cancel</Button>
        <Button variant="primary" loading={m.isPending} disabled={form.name.trim().length < 3 || bonusBlocked} onClick={() => m.mutate()}>Create and go live</Button>
      </>}>
      <div className="space-y-3">
        <Input label="Name" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} error={fields.name} />
        <Textarea label="Description (optional)" rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Milestone" value={form.milestone} onChange={(e) => set({ milestone: e.target.value })} error={fields.milestone}>
            {MILESTONES.map((ms) => <option key={ms} value={ms}>{formatNumber(ms)} steps</option>)}
          </Select>
          <Input label="Ends on" type="date" min={inDays(1)} max={inDays(90)} value={form.end_date} onChange={(e) => set({ end_date: e.target.value })} error={fields.end_date} />
          <Input label="Entry fee (KES, 0 = free)" inputMode="decimal" className="mono" value={form.entry_fee} onChange={(e) => set({ entry_fee: e.target.value })} error={fields.entry_fee} />
          <Input label="Platform bonus (KES)" inputMode="decimal" className="mono" value={form.platform_bonus_kes} onChange={(e) => set({ platform_bonus_kes: e.target.value })}
            error={fields.platform_bonus_kes ?? (bonusBlocked ? 'A bonus spends platform money: it needs the finance role too.' : undefined)} />
          <Input label="Max participants" inputMode="numeric" value={form.max_participants} onChange={(e) => set({ max_participants: e.target.value })} error={fields.max_participants} />
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink-secondary">
            <input type="checkbox" className="accent-[var(--brand)]" checked={form.is_featured} onChange={(e) => set({ is_featured: e.target.checked })} /> Feature in discovery
          </label>
        </div>
        {error && !Object.keys(fields).length && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
