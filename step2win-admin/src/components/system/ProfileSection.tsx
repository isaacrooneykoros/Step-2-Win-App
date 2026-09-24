import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImagePlus, Trash2 } from 'lucide-react'
import { Panel } from '../ui/Card'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { Skeleton } from '../ui/Skeleton'
import { StatusBadge } from '../StatusBadge'
import { useAuthStore } from '../../store/authStore'
import { formatDateTime } from '../../lib/format'
import { errorMessage } from '../../lib/errors'
import { ApiError } from './http'
import { systemApi } from './api'

const MAX_BYTES = 10 * 1024 * 1024
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
const EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']

function friendly(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes('not a valid image')) return 'That file is not a valid image. Choose a JPEG, PNG, WebP, HEIC or HEIF photo.'
  if (m.includes('less than')) return 'Image is too large. Choose a photo under 10 MB.'
  if (m.includes('at least 9 digits')) return 'Phone number is too short. Enter at least 9 digits.'
  if (m.includes('email already')) return 'That email is already used by another account.'
  return raw || 'Could not save your profile.'
}

interface Draft { email: string; phone_number: string; first_name: string; last_name: string }

/** The signed-in admin's own account (reached from the account menu as /settings#profile). */
export function ProfileSection() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['admin', 'my-profile'], queryFn: systemApi.profile })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [removePhoto, setRemovePhoto] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const p = q.data
  const base: Draft = { email: p?.email ?? '', phone_number: p?.phone_number ?? '', first_name: p?.first_name ?? '', last_name: p?.last_name ?? '' }
  const cur = draft ?? base
  const dirty = !!p && (JSON.stringify(cur) !== JSON.stringify(base) || !!file || removePhoto)

  const save = useMutation({
    mutationFn: () => {
      const form = new FormData()
      form.append('email', cur.email.trim())
      if (cur.phone_number.trim()) form.append('phone_number', cur.phone_number.trim())
      form.append('first_name', cur.first_name.trim())
      form.append('last_name', cur.last_name.trim())
      if (file) form.append('profile_picture', file)
      if (removePhoto) form.append('remove_profile_picture', 'true')
      return systemApi.saveProfile(form)
    },
    onSuccess: (updated) => {
      qc.setQueryData(['admin', 'my-profile'], updated)
      void qc.invalidateQueries({ queryKey: ['admin', 'profile'] })
      const u = useAuthStore.getState().user
      if (u) useAuthStore.setState({ user: { ...u, email: updated.email, profile_picture_url: updated.profile_picture_url ?? null } })
      setDraft(null); setFile(null); setPreview(null); setRemovePhoto(false)
      if (inputRef.current) inputRef.current.value = ''
      setSaved(true)
      window.setTimeout(() => setSaved(false), 3000)
    },
  })

  const pick = (f: File | undefined) => {
    setFileError(null)
    if (!f) return
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    if (!TYPES.includes(f.type) && !EXTS.includes(ext)) { setFileError('Choose a JPEG, PNG, WebP, HEIC or HEIF image.'); return }
    if (f.size > MAX_BYTES) { setFileError('Image is too large. Choose a photo under 10 MB.'); return }
    setFile(f); setRemovePhoto(false)
    setPreview(URL.createObjectURL(f))
  }

  const fields = save.error instanceof ApiError ? save.error.fields : {}
  const photo = removePhoto ? null : preview ?? p?.profile_picture_url ?? null
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...cur, [k]: e.target.value })

  return (
    <Panel
      id="profile"
      title="My profile"
      description="Your own admin account. Changes apply to you only."
      className="scroll-mt-20"
      footer={p && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {saved && <span role="status" className="mr-auto text-xs font-medium text-success">Profile saved.</span>}
          {save.error && <span role="alert" className="mr-auto text-xs text-danger">{friendly(errorMessage(save.error) ?? '')}</span>}
          <Button size="sm" variant="ghost" disabled={!dirty || save.isPending} onClick={() => { setDraft(null); setFile(null); setPreview(null); setRemovePhoto(false); setFileError(null) }}>Discard</Button>
          <Button size="sm" variant="primary" disabled={!dirty || !cur.email.trim()} loading={save.isPending} loadingText="Saving…" onClick={() => save.mutate()}>Save profile</Button>
        </div>
      )}
    >
      {q.isLoading ? (
        <div className="flex gap-4"><Skeleton width={64} height={64} label="Loading profile" /><div className="flex-1 space-y-2"><Skeleton height={32} /><Skeleton height={32} /></div></div>
      ) : q.error || !p ? (
        <ErrorState size="compact" title="Could not load your profile" error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="grid gap-5 md:grid-cols-[10rem_minmax(0,1fr)]">
          <div className="flex flex-row items-center gap-3 md:flex-col md:items-start">
            <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border border-surface-border bg-surface-elevated text-lg font-semibold text-ink-secondary">
              {photo ? <img src={photo} alt="Your profile photo" className="h-full w-full object-cover" /> : p.username.slice(0, 2).toUpperCase()}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" className="sr-only" id="profile-photo"
                onChange={(e) => pick(e.target.files?.[0])} />
              <Button size="sm" variant="secondary" leftIcon={<ImagePlus size={13} />} onClick={() => inputRef.current?.click()}>
                {p.profile_picture_url || file ? 'Change' : 'Add photo'}
              </Button>
              {(p.profile_picture_url || file) && !removePhoto && (
                <Button size="sm" variant="ghost" leftIcon={<Trash2 size={13} />} onClick={() => { setRemovePhoto(true); setFile(null); setPreview(null) }}>Remove</Button>
              )}
            </div>
            {fileError && <p className="text-xs text-danger">{fileError}</p>}
            {removePhoto && <p className="text-xs text-warning">Photo will be removed when you save.</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Username" value={p.username} disabled hint="Usernames cannot be changed." />
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-ink-secondary">Role</span>
              <div className="flex h-9 items-center gap-2">
                <StatusBadge tone="violet" label={p.is_superuser ? 'Superuser' : 'Staff'} />
                <span className="text-xs text-ink-muted">Last sign-in {formatDateTime(p.last_login)}</span>
              </div>
            </div>
            <Input label="Email" type="email" required value={cur.email} onChange={set('email')} error={fields.email} />
            <Input label="Phone" inputMode="tel" value={cur.phone_number} onChange={set('phone_number')} error={fields.phone_number} className="mono" />
            <Input label="First name" value={cur.first_name} onChange={set('first_name')} error={fields.first_name} />
            <Input label="Last name" value={cur.last_name} onChange={set('last_name')} error={fields.last_name} />
          </div>
        </div>
      )}
    </Panel>
  )
}
