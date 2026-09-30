import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Tag } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Input'
import { consoleB, type RiskLabel } from '../consoleb/api'
import { cn } from '../../lib/cn'
import { errorMessage } from '../../lib/errors'
import { usePermissions } from '../../lib/permissions'

const LABELS: Array<{ value: RiskLabel; label: string; hint: string }> = [
  { value: 'cheat', label: 'Cheating', hint: 'The steps on these days were not real walking.' },
  { value: 'honest', label: 'Honest', hint: 'Real activity, even if it looked unusual.' },
  { value: 'unsure', label: 'Unsure', hint: 'Not enough evidence either way.' },
]

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Label the case's user-days for the shadow risk model (POST /api/admin/risk-ml/labels/).
 * Labels train and evaluate the model only; they never change steps, trust or payouts.
 */
export function RiskLabelPanel(props: { userId: number; username: string; date: string | null }) {
  if (!usePermissions().can('trust.act')) return null
  return <RiskLabelForm {...props} />
}

function RiskLabelForm({ userId, username, date }: { userId: number; username: string; date: string | null }) {
  const qc = useQueryClient()
  const [label, setLabel] = useState<RiskLabel | null>(null)
  const [start, setStart] = useState(date ?? today())
  const [end, setEnd] = useState(date ?? today())
  const [notes, setNotes] = useState('')
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const save = useMutation({
    mutationFn: () => consoleB.labelUserDays({ user_id: userId, date_start: start, date_end: end, label: label!, notes: notes.trim() }),
    onSuccess: () => {
      setMsg({ tone: 'success', text: `Labelled ${username} ${start === end ? start : `${start} to ${end}`} as ${LABELS.find((l) => l.value === label)?.label.toLowerCase()}.` })
      void qc.invalidateQueries({ queryKey: ['admin', 'user-risk', userId] })
    },
    onError: (e) => setMsg({ tone: 'danger', text: errorMessage(e) ?? 'Not saved.' }),
  })
  return (
    <section aria-labelledby={`risk-label-${userId}`} className="rounded-md border border-surface-border p-3">
      <h3 id={`risk-label-${userId}`} className="flex items-center gap-1.5 text-sm font-semibold text-ink-primary">
        <Tag size={14} aria-hidden /> Label for the risk model
      </h3>
      <p className="mt-0.5 text-xs text-ink-muted">Teaches the shadow model what cheating looks like. It does not change steps, trust or payouts; use the decision buttons for that.</p>
      <div role="radiogroup" aria-label="Label" className="mt-2 grid gap-1.5 sm:grid-cols-3">
        {LABELS.map((l) => (
          <button key={l.value} type="button" role="radio" aria-checked={label === l.value} onClick={() => setLabel(l.value)}
            className={cn('rounded-md border px-2.5 py-1.5 text-left transition-colors',
              label === l.value ? 'border-brand bg-brand-soft' : 'border-surface-border hover:bg-surface-elevated')}>
            <span className="block text-sm font-medium text-ink-primary">{l.label}</span>
            <span className="block text-2xs text-ink-muted">{l.hint}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Input size="sm" type="date" label="From" value={start} max={today()} onChange={(e) => setStart(e.target.value)} />
        <Input size="sm" type="date" label="To" value={end} max={today()} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <Textarea className="mt-2" label="Notes (optional)" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      {msg && <p role={msg.tone === 'danger' ? 'alert' : 'status'} className={cn('mt-2 text-xs', msg.tone === 'danger' ? 'text-danger' : 'text-success')}>{msg.text}</p>}
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="secondary" disabled={!label || !start || end < start} loading={save.isPending} onClick={() => save.mutate()}>Save label</Button>
      </div>
    </section>
  )
}
