import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, BarChart3, Trash2, Upload } from 'lucide-react'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { Skeleton } from '../ui/Skeleton'
import { ErrorState } from '../ui/ErrorState'
import { ConfirmModal } from '../ConfirmModal'
import { http } from '../system/http'
import { formatNumber } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import type { LegalDoc } from './api'
import { usePermissions } from '../../lib/permissions'

interface AckStats {
  current_version: number
  current_version_label: string
  active_customers: number
  acknowledged_current: number
  acknowledged_current_pct: number | null
  by_version: Array<{ version: number; version_label: string; count: number }>
}

const base = '/api/legal/admin/documents'
const api = {
  archive: (id: number) => http<LegalDoc>(`${base}/${id}/archive/`, { method: 'POST', body: {} }),
  unarchive: (id: number) => http<LegalDoc>(`${base}/${id}/unarchive/`, { method: 'POST', body: {} }),
  remove: (id: number) => http<void>(`${base}/${id}/`, { method: 'DELETE' }),
  acks: (id: number) => http<AckStats>(`${base}/${id}/acks/`),
}

/** Customers must always be able to read these; publish a new version instead. */
const NEVER_ARCHIVE = new Set(['terms_and_conditions', 'privacy_policy'])

/** Archive / put back online / delete draft and acceptance stats for one legal document. */
export function LegalLifecycle({ doc, onMessage }: { doc: LegalDoc; onMessage: (tone: 'success' | 'danger', text: string) => void }) {
  const qc = useQueryClient()
  const [, setParams] = useSearchParams()
  const [confirm, setConfirm] = useState<null | 'archive' | 'unarchive' | 'delete'>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const stats = useQuery({ queryKey: ['legal', 'acks', doc.id], queryFn: () => api.acks(doc.id), enabled: statsOpen })

  const run = useMutation({
    mutationFn: async (kind: 'archive' | 'unarchive' | 'delete') => {
      if (kind === 'archive') await api.archive(doc.id)
      else if (kind === 'unarchive') await api.unarchive(doc.id)
      else await api.remove(doc.id)
      return kind
    },
    onSuccess: async (kind) => {
      setConfirm(null)
      if (kind === 'delete') setParams(new URLSearchParams(), { replace: true })
      await qc.invalidateQueries({ queryKey: ['legal'] })
      onMessage('success', kind === 'archive' ? 'Archived. Customers can no longer open it; its history and acceptances are kept.'
        : kind === 'unarchive' ? `Back online at v${doc.version_label}.` : 'Draft deleted.')
    },
    onError: (e) => { setConfirm(null); onMessage('danger', errorMessage(e) ?? 'Request failed.') },
  })

  const { can } = usePermissions()
  const canEdit = can('content.legal')
  const canArchive = canEdit && doc.status === 'published' && !NEVER_ARCHIVE.has(doc.document_type)
  const canDelete = canEdit && doc.status === 'draft' && !doc.published_at && doc.history_count === 0

  return (
    <>
      {doc.status !== 'draft' && (
        <Button size="sm" variant="ghost" leftIcon={<BarChart3 size={13} />} onClick={() => setStatsOpen(true)}>
          Read by {formatNumber(doc.acknowledged_current ?? 0)}
        </Button>
      )}
      {canArchive && <Button size="sm" variant="ghost" leftIcon={<Archive size={13} />} onClick={() => setConfirm('archive')}>Archive</Button>}
      {canEdit && doc.status === 'archived' && <Button size="sm" variant="ghost" leftIcon={<Upload size={13} />} onClick={() => setConfirm('unarchive')}>Put back online</Button>}
      {canDelete && <Button size="sm" variant="ghost" leftIcon={<Trash2 size={13} />} onClick={() => setConfirm('delete')}>Delete draft</Button>}

      <ConfirmModal open={confirm === 'archive'} onClose={() => setConfirm(null)} onConfirm={() => run.mutate('archive')} loading={run.isPending}
        variant="warning" title="Archive (unpublish) this document?" confirmLabel="Archive"
        message="Customers can no longer open it in the app. Its versions and who accepted them are kept, and you can put it back online later."
        details={[{ label: 'Document', value: doc.title }, { label: 'Live version', value: `v${doc.version_label}` }]} />
      <ConfirmModal open={confirm === 'unarchive'} onClose={() => setConfirm(null)} onConfirm={() => run.mutate('unarchive')} loading={run.isPending}
        variant="info" title="Put this document back online?" confirmLabel="Put back online"
        message={`Customers can open v${doc.version_label} again. No new version is created.`} />
      <ConfirmModal open={confirm === 'delete'} onClose={() => setConfirm(null)} onConfirm={() => run.mutate('delete')} loading={run.isPending}
        variant="danger" title="Delete this draft?" confirmLabel="Delete draft"
        message="It was never published, so no customer has seen or accepted it." consequence="This cannot be undone."
        details={[{ label: 'Document', value: doc.title }]} />

      <Modal open={statsOpen} onClose={() => setStatsOpen(false)} title={`Who has read ${doc.title}`}
        description="Accounts that opened the document to the end in the app (acknowledgements), by version."
        footer={<Button variant="secondary" onClick={() => setStatsOpen(false)}>Close</Button>}>
        {stats.isLoading ? <Skeleton height={80} /> : stats.error ? <ErrorState size="compact" error={stats.error} onRetry={() => void stats.refetch()} /> : stats.data && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-primary">
              <span className="num font-semibold">{formatNumber(stats.data.acknowledged_current)}</span> of <span className="num">{formatNumber(stats.data.active_customers)}</span> active customers have read the current version (v{stats.data.current_version_label})
              {stats.data.acknowledged_current_pct !== null && <span className="text-ink-muted"> · {stats.data.acknowledged_current_pct}%</span>}.
            </p>
            {stats.data.by_version.length ? (
              <table className="w-full text-sm">
                <caption className="sr-only">Acknowledgements by version</caption>
                <thead><tr className="border-b border-surface-border text-left text-xs text-ink-muted"><th scope="col" className="py-1.5 font-medium">Version last read</th><th scope="col" className="py-1.5 text-right font-medium">Accounts</th></tr></thead>
                <tbody>
                  {stats.data.by_version.map((r) => (
                    <tr key={r.version} className="border-b border-surface-border last:border-b-0">
                      <td className="py-1.5">v{r.version_label}{r.version >= stats.data!.current_version && <span className="ml-1.5 text-xs text-success">current</span>}</td>
                      <td className="num py-1.5 text-right">{formatNumber(r.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-ink-muted">Nobody has acknowledged this document yet.</p>}
          </div>
        )}
      </Modal>
    </>
  )
}
