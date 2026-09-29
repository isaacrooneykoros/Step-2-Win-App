import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { ErrorState } from '../ui/ErrorState'
import { Input } from '../ui/Input'
import { Skeleton } from '../ui/Skeleton'
import { consoleApi } from '../users/api'
import type { LinkageSettings } from '../users/linkageTypes'

const TOGGLES: Array<{ key: 'holds_enabled' | 'same_challenge_hold' | 'strong_link_paid_hold'; label: string; hint: string }> = [
  { key: 'holds_enabled', label: 'Hold payouts of linked accounts', hint: 'Master switch for the two rules below.' },
  {
    key: 'same_challenge_hold',
    label: 'Several linked accounts in one paid challenge',
    hint: 'Pay the first-registered account; hold the other winners of the group for review.',
  },
  {
    key: 'strong_link_paid_hold',
    label: 'Same phone or payout number as an account already paid',
    hint: 'Hold the new payout for review.',
  },
]

const NUMBERS: Array<{ key: 'paid_lookback_days' | 'behaviour_lookback_days' | 'medium_link_threshold' | 'network_max_accounts' | 'colocation_max_accounts'; label: string; step: number }> = [
  { key: 'paid_lookback_days', label: 'Already-paid look-back (days)', step: 1 },
  { key: 'behaviour_lookback_days', label: 'Walks and step patterns look-back (days)', step: 1 },
  { key: 'medium_link_threshold', label: 'Combined evidence needed to link', step: 0.1 },
  { key: 'network_max_accounts', label: 'Largest network treated as a home', step: 1 },
  { key: 'colocation_max_accounts', label: 'Largest group treated as walking together', step: 1 },
]

/** Linked-account payout policy (apps/linkage settings). Changes are audited. */
export function LinkagePolicyCard() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['admin', 'linkage-settings'], queryFn: () => consoleApi.linkageSettings() })
  // Unsaved edits on top of the server values.
  const [edits, setEdits] = useState<Partial<LinkageSettings>>({})
  const draft: LinkageSettings | null = q.data ? { ...q.data, ...edits } : null
  const setDraft = (next: LinkageSettings) => {
    const { bounds: _ignored, ...rest } = next
    void _ignored
    setEdits(rest)
  }
  const save = useMutation({
    mutationFn: (d: Partial<LinkageSettings>) => consoleApi.updateLinkageSettings(d),
    onSuccess: () => {
      setEdits({})
      void qc.invalidateQueries({ queryKey: ['admin', 'linkage-settings'] })
    },
  })
  const dirty = !!q.data && (Object.keys(edits) as Array<keyof LinkageSettings>).some((k) => edits[k] !== q.data?.[k])

  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink-primary">Linked-account holds</h2>
      <p className="mt-1 text-xs text-ink-secondary">
        Accounts linked by the same phone, the same payout number, or walking and step patterns that match. Links only hold a
        payout for review; they never ban anyone. Families often share a phone or an M-Pesa number: mark them as a known
        household from the user's Evidence tab.
      </p>
      {q.isLoading || !draft ? (
        q.isError ? <ErrorState variant="inline" error={q.error} onRetry={() => void q.refetch()} /> : <Skeleton className="mt-3 h-24 w-full" />
      ) : (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate(edits)
          }}
        >
          <div className="space-y-2">
            {TOGGLES.map((t) => (
              <label key={t.key} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={draft[t.key]}
                  disabled={t.key !== 'holds_enabled' && !draft.holds_enabled}
                  onChange={(e) => setDraft({ ...draft, [t.key]: e.target.checked })}
                />
                <span>
                  <span className="block text-sm text-ink-primary">{t.label}</span>
                  <span className="block text-xs text-ink-muted">{t.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {NUMBERS.map((n) => {
              const [min, max] = q.data?.bounds[n.key] ?? [undefined, undefined]
              return (
                <Input
                  key={n.key}
                  type="number"
                  label={n.label}
                  step={n.step}
                  min={min}
                  max={max}
                  value={String(draft[n.key])}
                  hint={min !== undefined ? `${min} to ${max}` : undefined}
                  onChange={(e) => setDraft({ ...draft, [n.key]: Number(e.target.value) })}
                />
              )
            })}
          </div>
          {save.isError && <p role="alert" className="text-sm text-danger">{save.error instanceof Error ? save.error.message : 'Could not save.'}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={!dirty || save.isPending} onClick={() => setEdits({})}>Reset</Button>
            <Button type="submit" size="sm" disabled={!dirty} loading={save.isPending} loadingText="Saving">Save policy</Button>
          </div>
        </form>
      )}
    </Card>
  )
}
