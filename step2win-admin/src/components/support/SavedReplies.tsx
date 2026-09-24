import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquareQuote, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { errorMessage } from '../../lib/errors'
import { formatRelative } from '../../lib/format'
import { ApiError } from '../system/http'
import { ConfirmModal } from '../ConfirmModal'
import { StatusBadge } from '../StatusBadge'
import { Button, IconButton } from '../ui/Button'
import { Input, SearchInput, Select, Textarea } from '../ui/Input'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import { supportApi, type ReplyTemplate, type ReplyTemplateInput, type TicketCategory } from './api'
import { CATEGORY_LABEL, TEMPLATE_VARIABLES } from './meta'
import { TEMPLATES_KEY, useTemplates } from './queries'


function matches(t: ReplyTemplate, q: string) {
  if (!q) return true
  const s = q.toLowerCase()
  return t.title.toLowerCase().includes(s) || t.body.toLowerCase().includes(s)
}

/**
 * Composer quick insert: a searchable listbox. Type to filter, Up/Down to move,
 * Enter to insert, Escape to close. Replies for the ticket's category come first.
 */
export function TemplatePicker({ category, onPick, disabled }: { category: TicketCategory; onPick: (t: ReplyTemplate) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const q = useTemplates()
  const listId = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const options = useMemo(() => {
    const rank = (t: ReplyTemplate) => (t.category === category ? 0 : t.category === null ? 1 : 2)
    return (q.data?.results ?? []).filter((t) => matches(t, query.trim())).sort((a, b) => rank(a) - rank(b))
  }, [q.data, query, category])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const close = () => { setOpen(false); setQuery(''); setActive(0); buttonRef.current?.focus() }
  const pick = (t: ReplyTemplate | undefined) => {
    if (!t) return
    onPick(t)
    setOpen(false); setQuery(''); setActive(0)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(options[active]) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  return (
    <div ref={wrapRef} className="relative">
      <Button ref={buttonRef} size="sm" variant="ghost" leftIcon={<MessageSquareQuote size={13} />} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Saved replies
      </Button>
      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-surface-border bg-surface-overlay shadow-float">
          <div className="border-b border-surface-border p-2">
            <input
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={options[active] ? `${listId}-${options[active].id}` : undefined}
              aria-label="Search saved replies"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0) }}
              onKeyDown={onKey}
              placeholder="Search saved replies…"
              className="h-8 w-full rounded-md border border-surface-strong bg-surface-input px-2.5 text-sm text-ink-primary outline-none placeholder:text-ink-muted focus:border-brand"
            />
          </div>
          <ul id={listId} role="listbox" aria-label="Saved replies" className="max-h-72 overflow-y-auto py-1">
            {q.isLoading && <li className="px-3 py-2"><Skeleton height={12} label="Loading saved replies" /></li>}
            {q.error && <li className="px-3 py-2 text-xs text-danger">{errorMessage(q.error) ?? 'Could not load saved replies.'}</li>}
            {!q.isLoading && !q.error && options.length === 0 && (
              <li className="px-3 py-3 text-xs text-ink-muted">{query ? 'No saved reply matches.' : 'No saved replies yet. Add them from the Saved replies panel.'}</li>
            )}
            {options.map((t, i) => (
              <li
                key={t.id}
                id={`${listId}-${t.id}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(t) }}
                className={cn('cursor-pointer px-3 py-2', i === active ? 'bg-brand-soft' : 'hover:bg-surface-elevated')}
              >
                <p className="flex items-center gap-2 text-sm font-medium text-ink-primary">
                  <span className="truncate">{t.title}</span>
                  {t.category && <span className="shrink-0 text-2xs font-normal text-ink-muted">{CATEGORY_LABEL[t.category]}</span>}
                </p>
                <p className="line-clamp-2 text-xs text-ink-muted">{t.body}</p>
              </li>
            ))}
          </ul>
          <p className="border-t border-surface-border px-3 py-1.5 text-2xs text-ink-muted">↑ ↓ to move · Enter to insert · Esc to close</p>
        </div>
      )}
    </div>
  )
}

const EMPTY_FORM: ReplyTemplateInput = { title: '', body: '', category: '' }

/** Create, edit and delete saved replies (Support > Saved replies panel). */
export function TemplatesManager() {
  const qc = useQueryClient()
  const q = useTemplates()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<ReplyTemplate | 'new' | null>(null)
  const [form, setForm] = useState<ReplyTemplateInput>(EMPTY_FORM)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [deleting, setDeleting] = useState<ReplyTemplate | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = () => void qc.invalidateQueries({ queryKey: TEMPLATES_KEY })
  const save = useMutation({
    mutationFn: () => (editing === 'new' || !editing ? supportApi.createTemplate(form) : supportApi.updateTemplate(editing.id, form)),
    onSuccess: () => { setNotice(editing === 'new' ? 'Saved reply added.' : 'Saved reply updated.'); setEditing(null); setFieldErrors({}); refresh() },
    onError: (err) => setFieldErrors(err instanceof ApiError ? err.fields : { body: errorMessage(err) ?? 'Could not save.' }),
  })
  const remove = useMutation({
    mutationFn: (id: number) => supportApi.deleteTemplate(id),
    onSuccess: () => { setNotice('Saved reply deleted.'); setDeleting(null); refresh() },
  })

  const start = (t: ReplyTemplate | 'new') => {
    setEditing(t)
    setFieldErrors({})
    setNotice(null)
    setForm(t === 'new' ? EMPTY_FORM : { title: t.title, body: t.body, category: t.category ?? '' })
  }
  const rows = (q.data?.results ?? []).filter((t) => matches(t, search.trim()))

  if (editing) {
    return (
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
        <Input label="Name" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} required error={fieldErrors.title} autoFocus />
        <Select label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as TicketCategory | '' })}
          hint="Offered first on tickets in this category." error={fieldErrors.category}>
          <option value="">Any category</option>
          {(Object.keys(CATEGORY_LABEL) as TicketCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </Select>
        <Textarea label="Reply" rows={8} maxLength={5000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required error={fieldErrors.body}
          hint={<>Placeholders filled on insert: {TEMPLATE_VARIABLES.map((v) => <code key={v} className="mono mx-0.5 rounded bg-surface-elevated px-1">{v}</code>)}</>} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setEditing(null)} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!form.title.trim() || !form.body.trim()}>
            {editing === 'new' ? 'Add saved reply' : 'Save changes'}
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <SearchInput size="sm" value={search} onChange={setSearch} placeholder="Search saved replies" />
        <Button size="sm" variant="primary" leftIcon={<Plus size={13} />} onClick={() => start('new')}>New</Button>
      </div>
      {notice && <p role="status" className="rounded-md border border-success-line bg-success-soft px-3 py-1.5 text-xs font-medium text-success">{notice}</p>}
      {q.isLoading ? (
        <div className="space-y-2"><Skeleton height={48} label="Loading saved replies" /><Skeleton height={48} /></div>
      ) : q.error ? (
        <ErrorState size="compact" error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState size="compact" icon={MessageSquareQuote} title={search ? 'No saved reply matches' : 'No saved replies yet'}
          description="Save answers you send often, then insert them from the reply box." />
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-surface-border">
          {rows.map((t) => (
            <li key={t.id} className="flex items-start gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink-primary">
                  {t.title}
                  <StatusBadge size="sm" tone="neutral" label={t.category ? CATEGORY_LABEL[t.category] : 'Any category'} />
                </p>
                <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-ink-secondary">{t.body}</p>
                <p className="mt-1 text-2xs text-ink-muted">
                  Used {t.usage_count} time{t.usage_count === 1 ? '' : 's'} · updated {formatRelative(t.updated_at)}{t.created_by ? ` · by ${t.created_by}` : ''}
                </p>
              </div>
              <IconButton label={`Edit ${t.title}`} size="sm" onClick={() => start(t)}><Pencil size={13} /></IconButton>
              <IconButton label={`Delete ${t.title}`} size="sm" onClick={() => setDeleting(t)}><Trash2 size={13} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
        variant="warning"
        title="Delete saved reply"
        message="Staff will no longer be able to insert it. Replies already sent are not affected."
        details={deleting ? [{ label: 'Name', value: deleting.title }] : undefined}
        confirmLabel="Delete"
      />
    </div>
  )
}
