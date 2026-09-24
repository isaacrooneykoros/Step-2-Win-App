import { useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, FileText, FileUp, History, Monitor, PenLine, Plus, RefreshCw, RotateCcw, Save, Send, Smartphone, Trash2 } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import { ConfirmModal } from '../components/ConfirmModal'
import { Panel } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, Select, Textarea } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { SegmentedControl, Tabs } from '../components/ui/Tabs'
import { EmptyState } from '../components/ui/EmptyState'
import { ErrorState } from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { LegalEditor } from '../components/content/LegalEditor'
import { DOC_TYPE_LABEL, DOC_TYPOGRAPHY, legalApi, nextVersionLabel, type LegalDoc, type LegalDocType, type LegalVersion } from '../components/content/api'
import { sanitizeHtml, stripHtml } from '../utils/sanitize'
import { cn } from '../lib/cn'
import { formatDateTime, formatNumber, formatRelative } from '../lib/format'
import { errorMessage } from '../lib/errors'

type Tab = 'edit' | 'preview' | 'history'

function docState(d: LegalDoc): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (d.status === 'published') return d.has_unpublished_changes ? { label: 'Live · unpublished edits', tone: 'warning' } : { label: 'Live', tone: 'success' }
  if (d.status === 'archived') return { label: 'Archived', tone: 'neutral' }
  return { label: 'Draft, never published', tone: 'neutral' }
}

function wordCount(html: string): number {
  const text = stripHtml(html).replace(/\s+/g, ' ').trim()
  return text ? text.split(' ').length : 0
}

export default function LegalDocumentsPage() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const docsQ = useQuery({ queryKey: ['legal', 'docs'], queryFn: legalApi.list })
  const docs = useMemo(() => docsQ.data ?? [], [docsQ.data])
  const selectedId = Number(params.get('doc')) || docs[0]?.id || null
  const doc = docs.find((d) => d.id === selectedId) ?? null

  const [dirty, setDirty] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const select = (id: number) => {
    if (id === selectedId) return
    if (dirty) { setPendingSwitch(id); return }
    const next = new URLSearchParams(params)
    next.set('doc', String(id))
    setParams(next, { replace: true })
  }
  const missingTypes = (Object.keys(DOC_TYPE_LABEL) as LegalDocType[]).filter((t) => !docs.some((d) => d.document_type === t))

  return (
    <div className="space-y-5">
      <PageHeader
        title="Legal documents"
        description="Edit policies as drafts, preview them as users will see them, and publish new versions."
        actions={
          <>
            <Button size="sm" variant="secondary" leftIcon={<RefreshCw size={13} />} loading={docsQ.isFetching && !docsQ.isLoading}
              disabled={dirty} title={dirty ? 'Save or discard your edits first' : undefined}
              onClick={() => void qc.invalidateQueries({ queryKey: ['legal'] })}>Refresh</Button>
            {missingTypes.length > 0 && (
              <Button size="sm" variant="primary" leftIcon={<Plus size={13} />} onClick={() => setCreateOpen(true)}>New document</Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start">
        <Panel padding="none" title="Documents" description={docsQ.data ? `${formatNumber(docs.length)} documents` : undefined} className="lg:sticky lg:top-20">
          {docsQ.isLoading ? (
            <div className="space-y-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} height={40} label={i === 0 ? 'Loading documents' : undefined} />)}</div>
          ) : docsQ.error ? (
            <ErrorState size="compact" error={docsQ.error} onRetry={() => void docsQ.refetch()} />
          ) : docs.length === 0 ? (
            <EmptyState size="compact" icon={FileText} title="No legal documents yet" description="Create the privacy policy and terms first."
              action={<Button size="sm" variant="primary" leftIcon={<Plus size={13} />} onClick={() => setCreateOpen(true)}>New document</Button>} />
          ) : (
            <ul className="divide-y divide-[var(--border)]" aria-label="Legal documents">
              {docs.map((d) => {
                const st = docState(d)
                const active = d.id === selectedId
                return (
                  <li key={d.id}>
                    <button type="button" aria-current={active ? 'true' : undefined} onClick={() => select(d.id)}
                      className={cn('relative block w-full px-4 py-3 text-left transition-colors', active ? 'bg-brand-soft' : 'hover:bg-surface-elevated')}>
                      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-brand" />}
                      <span className="block truncate text-sm font-medium text-ink-primary">{d.title}</span>
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        {d.status === 'published' ? <>v{d.version_label} · published {formatRelative(d.published_at)}</> : 'Not published'}
                      </span>
                      <StatusBadge size="sm" className="mt-1.5" tone={st.tone} label={st.label} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        {doc ? (
          <DocWorkspace key={doc.id} doc={doc} onDirtyChange={setDirty} />
        ) : !docsQ.isLoading && !docsQ.error && docs.length > 0 ? (
          <Panel><EmptyState title="Select a document" /></Panel>
        ) : docsQ.isLoading ? (
          <Panel><Skeleton height={480} /></Panel>
        ) : null}
      </div>

      <ConfirmModal
        open={pendingSwitch !== null}
        onClose={() => setPendingSwitch(null)}
        onConfirm={() => {
          const id = pendingSwitch!
          setPendingSwitch(null); setDirty(false)
          const next = new URLSearchParams(params); next.set('doc', String(id)); setParams(next, { replace: true })
        }}
        variant="warning"
        title="Leave without saving?"
        message="You have edits in this document that are not saved as a draft. They will be lost."
        confirmLabel="Discard edits"
        cancelLabel="Keep editing"
      />
      {createOpen && <CreateDialog types={missingTypes} onClose={() => setCreateOpen(false)} onCreated={(id) => { setCreateOpen(false); select(id) }} />}
    </div>
  )
}

function DocWorkspace({ doc, onDirtyChange }: { doc: LegalDoc; onDirtyChange: (d: boolean) => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('edit')
  const [revision, setRevision] = useState(0)
  const [html, setHtml] = useState('')
  const [baseline, setBaseline] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const historyQ = useQuery({ queryKey: ['legal', 'history', doc.id], queryFn: () => legalApi.history(doc.id) })
  const history = historyQ.data?.history

  const dirty = baseline !== null && html !== baseline
  const setDirtyBoth = (v: boolean) => onDirtyChange(v)
  const hasDraft = doc.has_unpublished_changes || (doc.status !== 'published' && !!doc.draft_html)
  const editorSource = doc.draft_html || doc.content_html

  const afterMutation = async (text: string) => {
    await qc.invalidateQueries({ queryKey: ['legal'] })
    setBaseline(null)
    setRevision((r) => r + 1)
    setDirtyBoth(false)
    setBanner({ tone: 'success', text })
  }
  const fail = (err: unknown) => setBanner({ tone: 'danger', text: errorMessage(err) ?? 'Request failed.' })

  const saveDraft = useMutation({
    mutationFn: () => legalApi.saveDraft(doc.id, sanitizeHtml(html)),
    onSuccess: () => afterMutation('Draft saved. Users still see the published version.'),
    onError: fail,
  })
  const discard = useMutation({
    mutationFn: () => legalApi.saveDraft(doc.id, ''),
    onSuccess: () => { setDiscardOpen(false); return afterMutation('Draft discarded. The editor shows the published version again.') },
    onError: (e) => { setDiscardOpen(false); fail(e) },
  })
  const upload = useMutation({
    mutationFn: (f: File) => legalApi.upload(doc.id, f),
    onSuccess: (_d, f) => { setUploadFile(null); return afterMutation(`Converted ${f.name} into the draft. Review it before publishing.`) },
    onError: (e) => { setUploadFile(null); fail(e) },
  })

  const onEditorChange = (v: string) => {
    setHtml(v)
    setDirtyBoth(baseline !== null && v !== baseline)
  }
  const words = wordCount(html || editorSource)

  return (
    <div className="min-w-0 space-y-3">
      <Panel padding="none">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-ink-primary">{doc.title}</h2>
              <StatusBadge size="sm" tone={docState(doc).tone} label={docState(doc).label} />
              {dirty && <StatusBadge size="sm" tone="warning" label="Unsaved edits" />}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only"
              aria-label="Upload a DOCX or PDF" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setUploadFile(f) }} />
            <Button size="sm" variant="ghost" leftIcon={<FileUp size={13} />} onClick={() => fileRef.current?.click()} loading={upload.isPending} loadingText="Converting…">Import DOCX/PDF</Button>
            {hasDraft && !dirty && doc.status === 'published' && (
              <Button size="sm" variant="ghost" leftIcon={<Trash2 size={13} />} onClick={() => setDiscardOpen(true)}>Discard draft</Button>
            )}
            <Button size="sm" variant={dirty ? 'primary' : 'secondary'} leftIcon={<Save size={13} />} disabled={!dirty} loading={saveDraft.isPending} loadingText="Saving…" onClick={() => saveDraft.mutate()}>
              Save draft
            </Button>
            <Button size="sm" variant={dirty ? 'secondary' : 'primary'} leftIcon={<Send size={13} />}
              disabled={!(hasDraft || dirty) && doc.status === 'published'}
              title={!(hasDraft || dirty) && doc.status === 'published' ? 'No changes since the live version' : undefined}
              onClick={() => setPublishOpen(true)}>
              Publish…
            </Button>
          </div>
        </div>
          <p className="-mt-1 flex flex-wrap gap-x-1.5 px-4 pb-3 text-xs text-ink-muted">
            <span>{DOC_TYPE_LABEL[doc.document_type]}</span><span aria-hidden>·</span>
            <span className="mono">/legal/{doc.slug}</span><span aria-hidden>·</span>
            {doc.status === 'published'
              ? <span>Live v{doc.version_label} since <time dateTime={doc.published_at ?? undefined} title={formatDateTime(doc.published_at)}>{formatDateTime(doc.published_at)}</time></span>
              : <span>Not visible to users</span>}
            <span aria-hidden>·</span>
            <span>Last edit {formatRelative(doc.updated_at)}{doc.last_edited_by_username ? ` by ${doc.last_edited_by_username}` : ''}</span>
          </p>
        {banner && (
          <div role={banner.tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-center gap-2 border-t px-4 py-2 text-xs font-medium', banner.tone === 'success' ? 'border-success-line bg-success-soft text-success' : 'border-danger-line bg-danger-soft text-danger')}>
            <span className="flex-1">{banner.text}</span>
            <button type="button" className="underline" onClick={() => setBanner(null)}>Dismiss</button>
          </div>
        )}
        <div className="border-t border-surface-border px-4 pt-2">
          <Tabs label="Document views" value={tab} onChange={setTab} idPrefix={`legal-${doc.id}`}
            items={[
              { value: 'edit', label: <span className="inline-flex items-center gap-1.5"><PenLine size={13} aria-hidden />Edit draft</span> },
              { value: 'preview', label: <span className="inline-flex items-center gap-1.5"><Eye size={13} aria-hidden />Preview</span> },
              { value: 'history', label: <span className="inline-flex items-center gap-1.5"><History size={13} aria-hidden />Versions</span>, count: history?.length },
            ]} className="border-b-0" />
        </div>
      </Panel>

      {/* Editor stays mounted (hidden) while previewing so unsaved edits survive tab switches. */}
      <div role="tabpanel" id={`legal-${doc.id}-panel-edit`} aria-labelledby={`legal-${doc.id}-tab-edit`} hidden={tab !== 'edit'}>
        <p className="mb-2 text-xs text-ink-muted">
          {doc.status === 'published'
            ? hasDraft ? 'Editing the unpublished draft. Users keep seeing the live version until you publish.' : 'Editing starts a draft from the live version. Users see nothing until you publish.'
            : 'This document has never been published. Users cannot see it yet.'}
          <span className="num"> · {formatNumber(words)} words</span>
        </p>
        <LegalEditor
          key={revision}
          label={`${doc.title} content`}
          initialHtml={editorSource}
          onReady={(v) => { setBaseline(v); setHtml(v) }}
          onChange={onEditorChange}
        />
      </div>
      {tab === 'preview' && (
        <div role="tabpanel" id={`legal-${doc.id}-panel-preview`} aria-labelledby={`legal-${doc.id}-tab-preview`}>
          <Preview doc={doc} draftHtml={html || editorSource} hasDraft={hasDraft || dirty} />
        </div>
      )}
      {tab === 'history' && (
        <div role="tabpanel" id={`legal-${doc.id}-panel-history`} aria-labelledby={`legal-${doc.id}-tab-history`}>
          <Versions doc={doc} q={historyQ} editorDirty={dirty} onRestored={(label) => { setTab('edit'); void afterMutation(`Content from v${label} restored into the draft. The live version is unchanged until you publish.`) }} />
        </div>
      )}

      {publishOpen && (
        <PublishDialog doc={doc} history={history} html={html} dirty={dirty}
          onClose={() => setPublishOpen(false)}
          onPublished={(label) => { setPublishOpen(false); void afterMutation(`Published v${label}. It is now live in the app.`) }} />
      )}
      <ConfirmModal
        open={discardOpen} onClose={() => setDiscardOpen(false)} onConfirm={() => discard.mutate()} loading={discard.isPending}
        variant="warning" title="Discard the draft?" confirmLabel="Discard draft"
        message="The unpublished edits are deleted. The live version stays as it is."
        details={[{ label: 'Document', value: doc.title }, { label: 'Live version', value: `v${doc.version_label}` }]}
      />
      <ConfirmModal
        key={uploadFile?.name ?? 'none'}
        open={!!uploadFile} onClose={() => setUploadFile(null)} onConfirm={() => uploadFile && upload.mutate(uploadFile)} loading={upload.isPending}
        variant="warning" title="Replace the draft with this file?" confirmLabel="Import file"
        message="The file is converted to formatted text and replaces the current draft. The live version is not changed."
        details={[{ label: 'File', value: uploadFile?.name }, { label: 'Size', value: uploadFile ? `${formatNumber(uploadFile.size / 1024, 0)} KB` : '' }]}
        consequence={dirty ? 'Your unsaved edits in the editor will be lost.' : undefined}
      />
    </div>
  )
}

function Preview({ doc, draftHtml, hasDraft }: { doc: LegalDoc; draftHtml: string; hasDraft: boolean }) {
  const canLive = doc.status === 'published' && !!doc.content_html
  const [which, setWhich] = useState<'draft' | 'live'>(hasDraft || !canLive ? 'draft' : 'live')
  const [device, setDevice] = useState<'phone' | 'wide'>('phone')
  const src = which === 'live' ? doc.content_html : draftHtml
  const clean = useMemo(() => sanitizeHtml(src), [src])
  return (
    <Panel
      title="Preview"
      description="Rendered with the same sanitising and typography as the customer app."
      actions={
        <div className="flex flex-wrap gap-2">
          <SegmentedControl label="Version to preview" value={which} onChange={setWhich}
            items={[{ value: 'draft', label: 'Draft' }, { value: 'live', label: 'Live', disabled: !canLive }]} />
          <SegmentedControl label="Preview width" value={device} onChange={setDevice}
            items={[{ value: 'phone', label: <span className="inline-flex items-center gap-1"><Smartphone size={12} aria-hidden />Phone</span> }, { value: 'wide', label: <span className="inline-flex items-center gap-1"><Monitor size={12} aria-hidden />Wide</span> }]} />
        </div>
      }
    >
      {which === 'draft' && (
        <p className="mb-3 rounded-md border border-warning-line bg-warning-soft px-3 py-2 text-xs text-warning">
          Draft preview. Users do not see this until it is published.
        </p>
      )}
      <div className="flex justify-center rounded-md bg-surface-sunken p-4 sm:p-6">
        <article className={cn('w-full overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card', device === 'phone' ? 'max-w-[390px]' : 'max-w-[760px]')}>
          <header className="border-b border-surface-border px-5 py-4">
            <h1 className="text-lg font-bold text-ink-primary">{doc.title}</h1>
            <p className="mt-0.5 text-xs text-ink-muted">
              {which === 'live' ? `Version ${doc.version_label} · Updated ${formatDateTime(doc.published_at)}` : 'Unpublished draft'}
            </p>
            {which === 'live' && doc.notify_users && doc.change_summary && (
              <p className="mt-2 rounded-md bg-surface-elevated px-3 py-2 text-xs text-ink-secondary"><span className="font-semibold text-ink-primary">What changed: </span>{doc.change_summary}</p>
            )}
          </header>
          {clean.trim() ? (
            <div className={cn('px-5 py-5', DOC_TYPOGRAPHY)} dangerouslySetInnerHTML={{ __html: clean }} />
          ) : (
            <EmptyState size="compact" title="Nothing to show" description="This version has no content yet." />
          )}
        </article>
      </div>
    </Panel>
  )
}

function Versions({ doc, q, editorDirty, onRestored }: {
  doc: LegalDoc
  q: ReturnType<typeof useQuery<{ history: LegalVersion[] }>>
  editorDirty: boolean
  onRestored: (label: string) => void
}) {
  const [viewing, setViewing] = useState<LegalVersion | null>(null)
  const [restoring, setRestoring] = useState<LegalVersion | null>(null)
  const restore = useMutation({
    mutationFn: (v: LegalVersion) => legalApi.restore(doc.id, v.id),
    onSuccess: (_r, v) => { setRestoring(null); onRestored(v.version_label) },
  })
  const rows = q.data?.history ?? []
  return (
    <Panel padding="none" title="Published versions" description="Each publish is kept. Restoring copies a version into the draft; nothing goes live until you publish.">
      {q.isLoading ? (
        <div className="space-y-3 p-4">{[0, 1].map((i) => <Skeleton key={i} height={44} label={i === 0 ? 'Loading versions' : undefined} />)}</div>
      ) : q.error ? (
        <ErrorState size="compact" error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState size="compact" icon={History} title="Not published yet" description="Versions appear here each time the document is published." />
      ) : (
        <ol className="divide-y divide-[var(--border)]">
          {rows.map((v) => {
            const live = doc.status === 'published' && v.version === doc.version
            return (
              <li key={v.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <span className="mono mt-0.5 w-12 shrink-0 text-sm font-semibold text-ink-primary">v{v.version_label}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm text-ink-primary">
                    {v.change_summary || <span className="text-ink-muted">No change summary</span>}
                    {live && <StatusBadge size="sm" tone="success" label="Live" />}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Published by <span className="text-ink-secondary">{v.published_by_username}</span> ·{' '}
                    <time dateTime={v.published_at}>{formatDateTime(v.published_at)}</time> ({formatRelative(v.published_at)}) · {formatNumber(wordCount(v.content_html))} words
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" leftIcon={<Eye size={13} />} onClick={() => setViewing(v)}>View</Button>
                  <Button size="sm" variant="secondary" leftIcon={<RotateCcw size={13} />} onClick={() => setRestoring(v)}>Restore to draft</Button>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      <Modal open={!!viewing} onClose={() => setViewing(null)} size="lg" title={viewing ? `${doc.title} · v${viewing.version_label}` : ''}
        description={viewing ? `Published ${formatDateTime(viewing.published_at)} by ${viewing.published_by_username}` : undefined}
        footer={<Button variant="secondary" onClick={() => setViewing(null)}>Close</Button>}>
        {viewing && <div className={DOC_TYPOGRAPHY} dangerouslySetInnerHTML={{ __html: sanitizeHtml(viewing.content_html) }} />}
      </Modal>
      <ConfirmModal
        key={restoring?.id ?? 'none'}
        open={!!restoring} onClose={() => setRestoring(null)} onConfirm={() => restoring && restore.mutate(restoring)} loading={restore.isPending}
        variant="warning" title={`Restore v${restoring?.version_label ?? ''} into the draft?`} confirmLabel="Restore to draft"
        message="The draft is replaced with this version's content. The live version stays online until you review and publish."
        details={[{ label: 'Document', value: doc.title }, { label: 'Restoring', value: `v${restoring?.version_label ?? ''}` }, { label: 'Live now', value: doc.status === 'published' ? `v${doc.version_label}` : 'Nothing' }]}
        consequence={editorDirty ? 'Your unsaved edits in the editor will be lost.' : undefined}
      >
        {restore.error && <p className="text-sm text-danger">{errorMessage(restore.error)}</p>}
      </ConfirmModal>
    </Panel>
  )
}

function PublishDialog({ doc, history, html, dirty, onClose, onPublished }: {
  doc: LegalDoc; history?: LegalVersion[]; html: string; dirty: boolean; onClose: () => void; onPublished: (label: string) => void
}) {
  const first = doc.status !== 'published'
  const [summary, setSummary] = useState('')
  const [notify, setNotify] = useState(!first)
  const next = nextVersionLabel(doc, history)
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty) await legalApi.saveDraft(doc.id, sanitizeHtml(html))
      return legalApi.publish(doc.id, summary.trim(), notify)
    },
    onSuccess: (r) => onPublished(r.version_label),
  })
  const ok = summary.trim().length >= 5
  return (
    <Modal
      open onClose={onClose} dismissible={!publish.isPending} role="alertdialog" size="md"
      title={first ? `Publish ${doc.title}` : `Publish v${next} of ${doc.title}`}
      description={first ? 'The document becomes visible in the app and on the sign-up screens.' : 'The draft replaces the live version for every user straight away.'}
      icon={<span className="flex h-8 w-8 items-center justify-center rounded-md bg-warning-soft text-warning"><Send size={16} aria-hidden /></span>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={publish.isPending}>Cancel</Button>
          <Button variant="primary" onClick={() => publish.mutate()} disabled={!ok} loading={publish.isPending} loadingText="Publishing…">Publish v{next}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="divide-y divide-[var(--border)] rounded-md border border-surface-border text-sm">
          <div className="flex justify-between gap-4 px-3 py-2"><dt className="text-xs text-ink-muted">Live now</dt><dd className="font-medium text-ink-primary">{first ? 'Nothing' : `v${doc.version_label}, since ${formatDateTime(doc.published_at)}`}</dd></div>
          <div className="flex justify-between gap-4 px-3 py-2"><dt className="text-xs text-ink-muted">After publishing</dt><dd className="font-medium text-ink-primary">v{next}</dd></div>
          <div className="flex justify-between gap-4 px-3 py-2"><dt className="text-xs text-ink-muted">Length</dt><dd className="num text-ink-primary">{formatNumber(wordCount(html || doc.draft_html || doc.content_html))} words</dd></div>
        </dl>
        {dirty && <p className="text-xs text-warning">Your unsaved edits are saved and included in this version.</p>}
        <Textarea label="What changed" required rows={3} maxLength={500} value={summary} onChange={(e) => setSummary(e.target.value)}
          placeholder="e.g. Added a data retention section and clarified payout timing."
          hint={notify ? 'Shown to users with the update notice. At least 5 characters.' : 'Kept in the version history. At least 5 characters.'} />
        <label className="flex items-start gap-2.5 rounded-md border border-surface-border px-3 py-2.5 text-sm">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
          <span>
            <span className="font-medium text-ink-primary">Tell users about this update</span>
            <span className="mt-0.5 block text-xs text-ink-muted">Users who have not read v{next} see an "Updated" badge and the summary above until they open it.</span>
          </span>
        </label>
        {publish.error && <p role="alert" className="text-sm text-danger">{errorMessage(publish.error)}</p>}
      </div>
    </Modal>
  )
}

function CreateDialog({ types, onClose, onCreated }: { types: LegalDocType[]; onClose: () => void; onCreated: (id: number) => void }) {
  const qc = useQueryClient()
  const [type, setType] = useState<LegalDocType>(types[0])
  const [title, setTitle] = useState(DOC_TYPE_LABEL[types[0]])
  const create = useMutation({
    mutationFn: () => legalApi.create(type, title.trim()),
    onSuccess: async (d) => { await qc.invalidateQueries({ queryKey: ['legal', 'docs'] }); onCreated(d.id) },
  })
  return (
    <Modal open onClose={onClose} dismissible={!create.isPending} size="sm" title="New legal document"
      description="Starts as an empty draft. Nothing is visible to users until you publish."
      footer={<><Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button><Button variant="primary" onClick={() => create.mutate()} disabled={!title.trim()} loading={create.isPending}>Create draft</Button></>}>
      <div className="space-y-4">
        <Select label="Type" value={type} onChange={(e) => { const t = e.target.value as LegalDocType; setType(t); setTitle(DOC_TYPE_LABEL[t]) }} hint="One document per type.">
          {types.map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}
        </Select>
        <Input label="Title shown to users" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        {create.error && <p role="alert" className="text-sm text-danger">{errorMessage(create.error)}</p>}
      </div>
    </Modal>
  )
}
