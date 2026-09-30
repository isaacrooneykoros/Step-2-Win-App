import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Eye, EyeOff, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { Panel } from '../components/ui/Card'
import { Button, IconButton } from '../components/ui/Button'
import { Input, SearchInput, Select, Textarea } from '../components/ui/Input'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { Modal } from '../components/ui/Modal'
import { StatusBadge } from '../components/StatusBadge'
import { SlideOver } from '../components/SlideOver'
import { ConfirmModal } from '../components/ConfirmModal'
import { SafeText } from '../components/consoleb/SafeText'
import { plainText } from '../components/consoleb/text'
import { consoleB, type HelpArticle, type HelpCategory } from '../components/consoleb/api'
import { ApiError } from '../components/system/http'
import { cn } from '../lib/cn'
import { formatRelative } from '../lib/format'
import { errorMessage } from '../lib/errors'
import { usePermissions } from '../lib/permissions'

const move = <T,>(list: T[], i: number, dir: -1 | 1): T[] => {
  const j = i + dir
  if (j < 0 || j >= list.length) return list
  const next = [...list]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

export function HelpCentrePage() {
  const qc = useQueryClient()
  const { can } = usePermissions()
  const canEdit = can('content.announcements')
  const cats = useQuery({ queryKey: ['admin', 'help', 'categories'], queryFn: consoleB.helpCategories })
  const [selected, setSelected] = useState<number | null>(null)
  const categories = useMemo(() => cats.data?.results ?? [], [cats.data])
  const catId = selected ?? categories[0]?.id ?? null
  const cat = categories.find((c) => c.id === catId) ?? null
  const arts = useQuery({ queryKey: ['admin', 'help', 'articles', catId], queryFn: () => consoleB.helpArticles(catId!), enabled: catId !== null })
  const [search, setSearch] = useState('')
  const articles = (arts.data?.results ?? []).filter((a) => !search.trim() || `${a.title} ${a.body}`.toLowerCase().includes(search.trim().toLowerCase()))

  const [catModal, setCatModal] = useState<HelpCategory | 'new' | null>(null)
  const [catForm, setCatForm] = useState({ title: '', description: '' })
  const [editing, setEditing] = useState<HelpArticle | 'new' | null>(null)
  const [form, setForm] = useState({ title: '', body: '', category: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<null | { kind: 'article'; a: HelpArticle } | { kind: 'category'; c: HelpCategory }>(null)
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  useEffect(() => {
    if (msg?.tone !== 'success') return
    const t = window.setTimeout(() => setMsg(null), 5000)
    return () => window.clearTimeout(t)
  }, [msg])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'help'] })
  }
  const onErr = (err: unknown) => {
    if (err instanceof ApiError) setErrors(err.fields)
    setMsg({ tone: 'danger', text: errorMessage(err) ?? 'Something went wrong.' })
  }

  const saveCat = useMutation({
    mutationFn: () => (catModal === 'new' ? consoleB.createHelpCategory(catForm) : consoleB.updateHelpCategory((catModal as HelpCategory).id, catForm)),
    onSuccess: (c) => { setCatModal(null); setSelected(c.id); setErrors({}); refresh(); setMsg({ tone: 'success', text: 'Category saved.' }) },
    onError: onErr,
  })
  const toggleCat = useMutation({
    mutationFn: (c: HelpCategory) => consoleB.updateHelpCategory(c.id, { is_published: !c.is_published }),
    onSuccess: (c) => { refresh(); setMsg({ tone: 'success', text: c.is_published ? 'Category shown to customers.' : 'Category hidden from customers.' }) },
    onError: onErr,
  })
  const reorderCats = useMutation({
    mutationFn: (ids: number[]) => consoleB.reorderHelpCategories(ids),
    onSuccess: refresh, onError: onErr,
  })
  const saveArt = useMutation({
    mutationFn: (publish?: boolean) => {
      const body: Partial<HelpArticle> = { title: form.title, body: form.body, category: Number(form.category) }
      if (publish !== undefined) body.is_published = publish
      return editing === 'new' ? consoleB.createHelpArticle(body) : consoleB.updateHelpArticle((editing as HelpArticle).id, body)
    },
    onSuccess: (a) => {
      setEditing(null); setErrors({}); setSelected(a.category); refresh()
      setMsg({ tone: 'success', text: a.is_published ? 'Article saved and visible in the app’s Help.' : 'Article saved as a draft.' })
    },
    onError: onErr,
  })
  const toggleArt = useMutation({
    mutationFn: (a: HelpArticle) => consoleB.updateHelpArticle(a.id, { is_published: !a.is_published }),
    onSuccess: refresh, onError: onErr,
  })
  const reorderArts = useMutation({
    mutationFn: (ids: number[]) => consoleB.reorderHelpArticles(catId!, ids),
    onSuccess: refresh, onError: onErr,
  })
  const remove = useMutation({
    mutationFn: async () => {
      if (!confirm) return
      if (confirm.kind === 'article') await consoleB.deleteHelpArticle(confirm.a.id)
      else await consoleB.deleteHelpCategory(confirm.c.id)
    },
    onSuccess: () => {
      if (confirm?.kind === 'category') setSelected(null)
      setConfirm(null); setEditing(null); refresh(); setMsg({ tone: 'success', text: 'Deleted.' })
    },
    onError: (e) => { setConfirm(null); onErr(e) },
  })

  const openArticle = (a: HelpArticle | 'new') => {
    setEditing(a); setErrors({})
    setForm(a === 'new' ? { title: '', body: '', category: String(catId ?? '') } : { title: a.title, body: a.body, category: String(a.category) })
  }
  const fullList = arts.data?.results ?? []

  return (
    <div className="space-y-5">
      <PageHeader
        title="Help centre"
        description="Questions and answers customers see under Profile > Help centre. Group them in categories, order them, and publish when ready."
        actions={canEdit && <Button size="sm" variant="primary" leftIcon={<Plus size={13} />} disabled={!categories.length} onClick={() => openArticle('new')}>New article</Button>}
      />
      {msg && (
        <div role={msg.tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-center gap-3 rounded-md border px-3 py-2 text-sm',
          msg.tone === 'success' ? 'border-success-line bg-success-soft text-success' : 'border-danger-line bg-danger-soft text-danger')}>
          <span className="flex-1 font-medium">{msg.text}</span>
          <button type="button" className="text-xs underline" onClick={() => setMsg(null)}>Dismiss</button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Panel title="Categories" padding="none"
          actions={canEdit && <Button size="sm" variant="secondary" leftIcon={<FolderPlus size={13} />} onClick={() => { setCatModal('new'); setCatForm({ title: '', description: '' }); setErrors({}) }}>Add</Button>}>
          {cats.isLoading ? <div className="space-y-2 p-4"><Skeleton height={32} /><Skeleton height={32} /><Skeleton height={32} /></div>
            : cats.error ? <ErrorState size="compact" error={cats.error} onRetry={() => void cats.refetch()} />
              : categories.length === 0 ? <EmptyState size="compact" title="No categories yet" description="Add one, e.g. Wallet and M-Pesa, Steps, Challenges." />
                : (
                  <ul className="divide-y divide-[var(--border)]">
                    {categories.map((c, i) => (
                      <li key={c.id} className={cn('flex items-center gap-1 px-2 py-1.5', c.id === catId && 'bg-brand-soft')}>
                        <button type="button" onClick={() => setSelected(c.id)} aria-current={c.id === catId}
                          className="min-w-0 flex-1 rounded px-1.5 py-1 text-left">
                          <span className={cn('block truncate text-sm font-medium', c.id === catId ? 'text-brand-text' : 'text-ink-primary')}>{c.title}</span>
                          <span className="block text-2xs text-ink-muted">
                            {c.published_count}/{c.article_count} published{!c.is_published && ' · hidden'}
                          </span>
                        </button>
                        <IconButton size="sm" label={`Move ${c.title} up`} disabled={i === 0 || reorderCats.isPending} onClick={() => reorderCats.mutate(move(categories, i, -1).map((x) => x.id))}><ArrowUp size={13} /></IconButton>
                        <IconButton size="sm" label={`Move ${c.title} down`} disabled={i === categories.length - 1 || reorderCats.isPending} onClick={() => reorderCats.mutate(move(categories, i, 1).map((x) => x.id))}><ArrowDown size={13} /></IconButton>
                      </li>
                    ))}
                  </ul>
                )}
        </Panel>

        <Panel padding="none"
          title={cat ? cat.title : 'Articles'}
          description={cat ? (cat.description || 'No description.') : undefined}
          actions={cat && canEdit && (
            <span className="flex items-center gap-1.5">
              <StatusBadge size="sm" tone={cat.is_published ? 'success' : 'neutral'} label={cat.is_published ? 'Shown' : 'Hidden'} />
              <IconButton size="sm" label={cat.is_published ? 'Hide category' : 'Show category'} onClick={() => toggleCat.mutate(cat)}>{cat.is_published ? <EyeOff size={13} /> : <Eye size={13} />}</IconButton>
              <IconButton size="sm" label="Edit category" onClick={() => { setCatModal(cat); setCatForm({ title: cat.title, description: cat.description }); setErrors({}) }}><Pencil size={13} /></IconButton>
              <IconButton size="sm" label="Delete category" disabled={cat.article_count > 0} title={cat.article_count > 0 ? 'Move or delete its articles first' : 'Delete category'}
                onClick={() => setConfirm({ kind: 'category', c: cat })}><Trash2 size={13} /></IconButton>
            </span>
          )}>
          {cat && (
            <div className="border-b border-surface-border px-4 py-2.5">
              <SearchInput size="sm" value={search} onChange={setSearch} placeholder="Search this category" />
            </div>
          )}
          {!cat ? <EmptyState size="compact" title="Pick or add a category" />
            : arts.isLoading ? <div className="space-y-2 p-4"><Skeleton height={40} /><Skeleton height={40} /></div>
              : arts.error ? <ErrorState size="compact" error={arts.error} onRetry={() => void arts.refetch()} />
                : articles.length === 0 ? (
                  <EmptyState size="compact" title={search ? 'No matching articles' : 'No articles in this category'}
                    action={!search && <Button size="sm" variant="secondary" leftIcon={<Plus size={13} />} onClick={() => openArticle('new')}>Write the first one</Button>} />
                ) : (
                  <ul className="divide-y divide-[var(--border)]">
                    {articles.map((a) => {
                      const i = fullList.findIndex((x) => x.id === a.id)
                      return (
                        <li key={a.id} className="flex items-center gap-2 px-4 py-2.5">
                          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openArticle(a)}>
                            <span className="block truncate text-sm font-medium text-ink-primary">{a.title}</span>
                            <span className="block truncate text-xs text-ink-muted">{plainText(a.body)}</span>
                          </button>
                          <StatusBadge size="sm" tone={a.is_published ? 'success' : 'neutral'} label={a.is_published ? 'Published' : 'Draft'} />
                          <span className="hidden w-20 text-right text-2xs text-ink-muted md:block">{formatRelative(a.updated_at)}</span>
                          <IconButton size="sm" label={a.is_published ? 'Unpublish' : 'Publish'} onClick={() => toggleArt.mutate(a)}>{a.is_published ? <EyeOff size={13} /> : <Eye size={13} />}</IconButton>
                          <IconButton size="sm" label={`Move ${a.title} up`} disabled={search !== '' || i <= 0 || reorderArts.isPending} onClick={() => reorderArts.mutate(move(fullList, i, -1).map((x) => x.id))}><ArrowUp size={13} /></IconButton>
                          <IconButton size="sm" label={`Move ${a.title} down`} disabled={search !== '' || i >= fullList.length - 1 || reorderArts.isPending} onClick={() => reorderArts.mutate(move(fullList, i, 1).map((x) => x.id))}><ArrowDown size={13} /></IconButton>
                        </li>
                      )
                    })}
                  </ul>
                )}
        </Panel>
      </div>

      <Modal open={catModal !== null} onClose={() => setCatModal(null)} dismissible={!saveCat.isPending}
        title={catModal === 'new' ? 'New category' : 'Edit category'}
        footer={<><Button variant="secondary" onClick={() => setCatModal(null)} disabled={saveCat.isPending}>Cancel</Button>
          <Button variant="primary" loading={saveCat.isPending} onClick={() => saveCat.mutate()} disabled={!catForm.title.trim()}>Save</Button></>}>
        <div className="space-y-3">
          <Input label="Name" value={catForm.title} maxLength={80} onChange={(e) => setCatForm({ ...catForm, title: e.target.value })} error={errors.title} />
          <Input label="Short description (optional)" value={catForm.description} maxLength={200} onChange={(e) => setCatForm({ ...catForm, description: e.target.value })} error={errors.description} />
        </div>
      </Modal>

      <SlideOver open={editing !== null} onClose={() => setEditing(null)} width={600}
        title={editing === 'new' ? 'New help article' : 'Edit help article'}
        subtitle={editing && editing !== 'new' ? `Updated ${formatRelative(editing.updated_at)}${editing.updated_by ? ` by ${editing.updated_by}` : ''}` : 'Customers only see published articles in shown categories.'}
        headerAside={editing && editing !== 'new' && <StatusBadge size="sm" tone={editing.is_published ? 'success' : 'neutral'} label={editing.is_published ? 'Published' : 'Draft'} />}
        footer={<>
          {editing && editing !== 'new' && <Button variant="danger-soft" onClick={() => setConfirm({ kind: 'article', a: editing })}>Delete</Button>}
          <Button variant="secondary" loading={saveArt.isPending && saveArt.variables === undefined} onClick={() => saveArt.mutate(undefined)}>Save</Button>
          {(editing === 'new' || (editing && !editing.is_published)) && (
            <Button variant="primary" loading={saveArt.isPending && saveArt.variables === true} onClick={() => saveArt.mutate(true)}>Save and publish</Button>
          )}
        </>}>
        <div className="space-y-4">
          <Select label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} error={errors.category}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </Select>
          <Input label="Question or title" value={form.title} maxLength={160} onChange={(e) => setForm({ ...form, title: e.target.value })} error={errors.title} />
          <Textarea label="Answer" rows={10} maxLength={10000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} error={errors.body}
            hint="Plain text. **bold**, [label](https://…) or [label](/wallet) links, and lines starting with “- ” for lists." />
          <section aria-label="Preview" className="rounded-lg border border-surface-border bg-surface-base p-3">
            <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Preview</p>
            <p className="text-sm font-semibold text-ink-primary">{form.title || 'Question'}</p>
            {form.body.trim() ? <SafeText text={form.body} className="mt-1 text-sm text-ink-secondary" /> : <p className="mt-1 text-sm text-ink-muted">The answer appears here.</p>}
          </section>
        </div>
      </SlideOver>

      <ConfirmModal open={confirm !== null} onClose={() => setConfirm(null)} onConfirm={() => remove.mutate()} loading={remove.isPending}
        variant="danger" confirmLabel="Delete"
        title={confirm?.kind === 'category' ? 'Delete category' : 'Delete article'}
        message={confirm?.kind === 'category' ? 'The category is empty. It disappears from the app’s Help.' : 'Customers will no longer see this answer. Unpublish it instead if you might need it again.'}
        details={confirm ? [{ label: confirm.kind === 'category' ? 'Category' : 'Article', value: confirm.kind === 'category' ? confirm.c.title : confirm.a.title }] : []}
        consequence="This cannot be undone." />
    </div>
  )
}
