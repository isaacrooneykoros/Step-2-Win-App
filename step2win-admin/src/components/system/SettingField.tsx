import { useId, useState, type KeyboardEvent } from 'react'
import { Check, CircleDot, Plus, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'
import { Input, Select, Textarea } from '../ui/Input'
import { display, TICKET_CATEGORIES, type CategoryMap, type FieldDef, type FormValue } from './fields'

export interface StaffOption { id: number; username: string; is_active: boolean }

interface SettingFieldProps {
  def: FieldDef
  value: FormValue
  saved: FormValue
  changed: boolean
  error?: string
  /** Where the backend reads this setting; undefined = stored only. */
  enforcedBy?: string
  /** Staff accounts for 'staff' and 'categoryMap' fields. */
  staff?: StaffOption[]
  onChange: (value: FormValue) => void
}

/** One setting: control, what it affects, and what it was before this edit. */
export function SettingField({ def, value, saved, changed, error, enforcedBy, staff = [], onChange }: SettingFieldProps) {
  const id = useId()
  const staffName = (uid: number) => staff.find((u) => u.id === uid)?.username ?? `#${uid}`
  const effect = (
    <p className={cn('mt-1.5 flex items-start gap-1.5 text-2xs', enforcedBy ? 'text-ink-secondary' : 'text-ink-muted')}>
      <CircleDot size={11} className={cn('mt-px shrink-0', enforcedBy ? 'text-success' : 'text-ink-disabled')} aria-hidden />
      <span>{enforcedBy ? <>Used by: {enforcedBy}</> : 'Stored only. The backend does not act on this setting yet.'}</span>
    </p>
  )
  const was = changed && (
    <p className="mt-1 text-2xs font-medium text-warning">Unsaved · was {display(def, saved, staffName)}</p>
  )

  if (def.kind === 'bool') {
    const on = value === true
    return (
      <div className={cn('flex items-start justify-between gap-4 rounded-md border px-3 py-2.5', changed ? 'border-warning-line bg-warning-soft/40' : 'border-surface-border')}>
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium text-ink-primary">{def.label}</label>
          {def.hint && <p className="mt-0.5 text-xs text-ink-muted">{def.hint}</p>}
          {effect}
          {was}
        </div>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => onChange(!on)}
          className={cn(
            'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
            on ? 'border-transparent bg-brand' : 'border-surface-strong bg-surface-sunken',
          )}
        >
          <span className="sr-only">{on ? 'On' : 'Off'}</span>
          <span aria-hidden className={cn('inline-block h-3.5 w-3.5 rounded-full shadow-card transition-transform', on ? 'translate-x-[18px] bg-surface-card' : 'translate-x-[3px] bg-ink-muted')} />
        </button>
      </div>
    )
  }

  if (def.kind === 'milestones') {
    return (
      <div className={cn('rounded-md border px-3 py-2.5 sm:col-span-2', changed ? 'border-warning-line bg-warning-soft/40' : 'border-surface-border')}>
        <p id={id} className="text-sm font-medium text-ink-primary">{def.label}</p>
        {def.hint && <p className="mt-0.5 text-xs text-ink-muted">{def.hint}</p>}
        <MilestoneEditor labelledBy={id} value={value as number[]} onChange={onChange} invalid={!!error} />
        {error && <p className="mt-1.5 text-xs text-danger" role="alert">{error}</p>}
        {effect}
        {changed && <p className="mt-1 text-2xs font-medium text-warning">Unsaved · was {(saved as number[]).length} options</p>}
      </div>
    )
  }

  if (def.kind === 'select') {
    return (
      <div>
        <Select label={def.label} value={String(value)} onChange={(e) => onChange(e.target.value)} hint={def.hint} error={error}
          className={changed && !error ? 'border-warning' : undefined}>
          {def.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        {effect}
        {was}
      </div>
    )
  }

  if (def.kind === 'staff') {
    const selected = value as number[]
    const active = staff.filter((u) => u.is_active || selected.includes(u.id))
    const toggle = (uid: number) => onChange(selected.includes(uid) ? selected.filter((x) => x !== uid) : [...selected, uid].sort((a, b) => a - b))
    return (
      <div className={cn('rounded-md border px-3 py-2.5 sm:col-span-2', changed ? 'border-warning-line bg-warning-soft/40' : 'border-surface-border')}>
        <p id={id} className="text-sm font-medium text-ink-primary">{def.label}</p>
        {def.hint && <p className="mt-0.5 text-xs text-ink-muted">{def.hint}</p>}
        <div role="group" aria-labelledby={id} className="mt-2 flex flex-wrap gap-1.5">
          {active.length === 0 && <span className="text-xs text-ink-muted">No staff accounts.</span>}
          {active.map((u) => {
            const on = selected.includes(u.id)
            return (
              <button key={u.id} type="button" aria-pressed={on} onClick={() => toggle(u.id)}
                className={cn('inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors',
                  on ? 'border-brand bg-brand-soft text-brand-text' : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface-elevated')}>
                {on && <Check size={12} aria-hidden />}
                {u.username}
              </button>
            )
          })}
        </div>
        {error && <p className="mt-1.5 text-xs text-danger" role="alert">{error}</p>}
        {effect}
        {was}
      </div>
    )
  }

  if (def.kind === 'categoryMap') {
    const map = value as CategoryMap
    const set = (cat: string, uid: string) => {
      const next = { ...map }
      if (uid) next[cat] = Number(uid)
      else delete next[cat]
      onChange(next)
    }
    return (
      <div className={cn('rounded-md border px-3 py-2.5 sm:col-span-2', changed ? 'border-warning-line bg-warning-soft/40' : 'border-surface-border')}>
        <p id={id} className="text-sm font-medium text-ink-primary">{def.label}</p>
        {def.hint && <p className="mt-0.5 text-xs text-ink-muted">{def.hint}</p>}
        <div role="group" aria-labelledby={id} className="mt-2 grid gap-2 sm:grid-cols-3">
          {TICKET_CATEGORIES.map((c) => (
            <Select key={c.value} size="sm" label={c.label} value={map[c.value] ? String(map[c.value]) : ''} onChange={(e) => set(c.value, e.target.value)}>
              <option value="">Agents in turn</option>
              {staff.filter((u) => u.is_active || map[c.value] === u.id).map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
            </Select>
          ))}
        </div>
        {error && <p className="mt-1.5 text-xs text-danger" role="alert">{error}</p>}
        {effect}
        {was}
      </div>
    )
  }

  if (def.kind === 'text') {
    return (
      <div className="sm:col-span-2">
        <Textarea
          label={def.label}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          maxLength={1000}
          hint={def.hint}
          error={error}
          className={changed ? 'border-warning' : undefined}
        />
        {effect}
        {was}
      </div>
    )
  }

  return (
    <div>
      <Input
        label={def.label}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        type={def.kind === 'email' ? 'email' : 'text'}
        inputMode={def.kind === 'int' ? 'numeric' : def.kind === 'email' ? 'email' : 'decimal'}
        hint={def.hint}
        error={error}
        className={cn(def.kind !== 'email' && 'num', changed && !error && 'border-warning')}
        rightSlot={def.unit ? <span className="pointer-events-none pr-2 text-xs text-ink-muted">{def.unit}</span> : undefined}
      />
      {effect}
      {was}
    </div>
  )
}

function MilestoneEditor({ value, onChange, labelledBy, invalid }: { value: number[]; onChange: (v: number[]) => void; labelledBy: string; invalid: boolean }) {
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const inputId = useId()
  const add = () => {
    const n = Number(draft.replace(/[,\s_]/g, ''))
    if (!Number.isInteger(n) || n <= 0) { setErr('Enter a whole number of steps.'); return }
    if (value.includes(n)) { setErr(`${n.toLocaleString('en-KE')} is already an option.`); return }
    onChange([...value, n].sort((a, b) => a - b))
    setDraft('')
    setErr(null)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); add() }
  }
  return (
    <div className="mt-2">
      <ul aria-labelledby={labelledBy} className={cn('flex flex-wrap gap-1.5', invalid && 'rounded-md outline outline-1 outline-danger')}>
        {value.map((m) => (
          <li key={m} className="num inline-flex h-7 items-center gap-1 rounded-md border border-surface-border bg-surface-elevated pl-2 pr-1 text-xs text-ink-primary">
            {m.toLocaleString('en-KE')}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== m))} aria-label={`Remove ${m.toLocaleString('en-KE')} steps`}
              className="flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-surface-card hover:text-ink-primary">
              <X size={12} />
            </button>
          </li>
        ))}
        {value.length === 0 && <li className="text-xs text-ink-muted">No milestones.</li>}
      </ul>
      <div className="mt-2 flex items-start gap-2">
        <Input
          id={inputId}
          size="sm"
          aria-label="Add milestone (steps)"
          placeholder="Add steps, e.g. 35000"
          inputMode="numeric"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setErr(null) }}
          onKeyDown={onKey}
          error={err ?? undefined}
          containerClassName="w-48"
          className="num"
        />
        <Button size="sm" variant="secondary" leftIcon={<Plus size={13} />} onClick={add} disabled={!draft.trim()}>Add</Button>
      </div>
    </div>
  )
}
