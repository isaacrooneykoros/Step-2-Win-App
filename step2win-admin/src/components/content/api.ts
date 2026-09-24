import { http } from '../system/http'

export type LegalDocType = 'privacy_policy' | 'terms_and_conditions' | 'cookie_policy' | 'refund_policy' | 'other'

export interface LegalDoc {
  id: number
  document_type: LegalDocType
  title: string
  slug: string
  /** What users see now (only when status is published). */
  content_html: string
  /** Unpublished edits; empty when there are none. */
  draft_html: string
  has_unpublished_changes: boolean
  uploaded_file: string | null
  file_type: string
  version: number
  version_label: string
  status: 'draft' | 'published' | 'archived'
  notify_users: boolean
  change_summary: string
  last_edited_by: number | null
  last_edited_by_username: string | null
  published_at: string | null
  created_at: string
  updated_at: string
  history_count: number
}

export interface LegalVersion {
  id: number
  version: number
  version_label: string
  content_html: string
  published_by: number | null
  published_by_username: string
  published_at: string
  change_summary: string
}

export const DOC_TYPE_LABEL: Record<LegalDocType, string> = {
  privacy_policy: 'Privacy Policy',
  terms_and_conditions: 'Terms and Conditions',
  cookie_policy: 'Cookie Policy',
  refund_policy: 'Refund Policy',
  other: 'Other',
}

const base = '/api/legal/admin/documents'

export const legalApi = {
  list: () => http<LegalDoc[]>(`${base}/`),
  create: (document_type: LegalDocType, title: string) => http<LegalDoc>(`${base}/create/`, { body: { document_type, title } }),
  /** Saves into the draft (the backend never writes live content from here). Empty string discards the draft. */
  saveDraft: (id: number, html: string) => http<LegalDoc>(`${base}/${id}/`, { method: 'PATCH', body: { content_html: html } }),
  upload: (id: number, file: File) => {
    const form = new FormData()
    form.append('uploaded_file', file)
    return http<LegalDoc>(`${base}/${id}/`, { method: 'PATCH', body: form })
  },
  publish: (id: number, change_summary: string, notify_users: boolean) =>
    http<{ published: boolean; version: number; version_label: string; notify_users: boolean; published_at: string }>(
      `${base}/${id}/publish/`, { body: { change_summary, notify_users } },
    ),
  history: (id: number) => http<{ document: string; current_version: string; history: LegalVersion[] }>(`${base}/${id}/history/`),
  restore: (id: number, versionId: number) =>
    http<{ restored: boolean; from_version: string; message: string }>(`${base}/${id}/restore/${versionId}/`, { method: 'POST' }),
}

/** The version label the next publish will get (mirrors LegalDocument.publish). */
export function nextVersionLabel(doc: LegalDoc, history: LegalVersion[] | undefined): string {
  const taken = doc.status === 'published' || (history ?? []).some((h) => h.version === doc.version)
  return `1.${taken ? doc.version + 1 : doc.version}`
}

/** Typography matching the customer app's `.legal-content`, built from admin tokens. */
export const DOC_TYPOGRAPHY = [
  'text-[15px] leading-[1.7] text-ink-secondary',
  '[&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:tracking-[-0.01em] [&_h1]:text-ink-primary',
  '[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-ink-primary',
  '[&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-ink-secondary',
  '[&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1',
  '[&_li>p]:mb-0 [&_strong]:text-ink-primary [&_a]:text-brand-text [&_a]:underline',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-surface-strong [&_blockquote]:pl-3 [&_blockquote]:italic',
  '[&_hr]:my-5 [&_hr]:border-surface-border',
  '[&_table]:my-3 [&_table]:w-full [&_td]:border [&_td]:border-surface-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-surface-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
  '[&>*:first-child]:mt-0',
].join(' ')
