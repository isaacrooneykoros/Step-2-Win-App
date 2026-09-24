import { useId, useState, type KeyboardEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Tag, X } from 'lucide-react'
import { errorMessage } from '../../lib/errors'
import { supportApi } from './api'
import { TAGS_KEY, useTags } from './queries'


/** Tags on one ticket: remove with the chip button, add by typing (existing tags are suggested). Saves immediately. */
export function TagEditor({ ticketId, tags, onChanged }: { ticketId: number; tags: string[]; onChanged: () => void }) {
  const qc = useQueryClient()
  const all = useTags()
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const listId = useId()
  const inputId = useId()

  const save = useMutation({
    mutationFn: (next: string[]) => supportApi.setTags(ticketId, next),
    onSuccess: () => {
      setErr(null)
      void qc.invalidateQueries({ queryKey: TAGS_KEY })
      onChanged()
    },
    onError: (e) => setErr(errorMessage(e) ?? 'Could not save tags.'),
  })

  const add = () => {
    const name = draft.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40)
    if (!name) return
    setDraft('')
    if (tags.includes(name)) return
    save.mutate([...tags, name])
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() }
  }
  const suggestions = (all.data?.results ?? []).filter((t) => !tags.includes(t.name))

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <Tag size={12} className="text-ink-muted" aria-hidden />
      <span className="sr-only">Tags</span>
      {tags.length === 0 && <span className="text-2xs text-ink-muted">No tags</span>}
      {tags.map((t) => (
        <span key={t} className="inline-flex h-6 items-center gap-0.5 rounded border border-surface-border bg-surface-elevated pl-1.5 pr-0.5 text-2xs font-medium text-ink-secondary">
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} disabled={save.isPending}
            onClick={() => save.mutate(tags.filter((x) => x !== t))}
            className="flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-surface-card hover:text-ink-primary">
            <X size={11} />
          </button>
        </span>
      ))}
      <label htmlFor={inputId} className="sr-only">Add tag</label>
      <input
        id={inputId}
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        maxLength={40}
        disabled={save.isPending || tags.length >= 10}
        placeholder={tags.length >= 10 ? 'Tag limit reached' : 'Add tag'}
        className="h-6 w-28 rounded border border-surface-strong bg-surface-input px-1.5 text-2xs text-ink-primary outline-none placeholder:text-ink-muted focus:border-brand"
      />
      <datalist id={listId}>
        {suggestions.map((t) => <option key={t.id} value={t.name} />)}
      </datalist>
      {draft.trim() && (
        <button type="button" onClick={add} className="inline-flex h-6 items-center gap-0.5 rounded px-1 text-2xs font-medium text-brand-text hover:underline">
          <Plus size={11} aria-hidden />Add
        </button>
      )}
      {err && <span role="alert" className="text-2xs text-danger">{err}</span>}
    </div>
  )
}
