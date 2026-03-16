import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trophy, Activity, CheckCircle, Clock, Eye, XCircle, Users } from 'lucide-react'
import { StatCard } from '../components/StatCard'
import { PageHeader } from '../components/PageHeader'
import { AdminTable } from '../components/AdminTable'
import { StatusBadge } from '../components/StatusBadge'
import { ConfirmModal } from '../components/ConfirmModal'
import { SlideOver } from '../components/SlideOver'
import { DetailRow } from '../components/DetailRow'
import api from '../services/api/client'
import { format, formatDistanceToNow } from 'date-fns'

type ChallengeStatus = 'pending' | 'active' | 'completed' | 'cancelled' | 'inactive'

interface Challenge {
  id: string
  name: string
  status: ChallengeStatus
  challenge_type: 'public' | 'private' | string
  participant_count: number
  entry_fee: number
  prize_pool: number
  milestone_steps: number
  start_date: string
  end_date: string
  created_by_username: string
}

interface ChallengesData {
  results: Challenge[]
  total: number
}

interface ChallengeStats {
  total: number
  active: number
  pending: number
  total_pool: number
  growth_pct: number
  active_spark: number[]
}

interface ActionBtnProps {
  icon: React.ElementType
  color: string
  title: string
  onClick: () => void
}

export function ChallengesPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('all')
  const [type, setType] = useState('all')
  const [selected, setSelected] = useState<Challenge | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState<Challenge | null>(null)

  const { data, isLoading } = useQuery<ChallengesData>({
    queryKey: ['admin', 'challenges', { search, page, status, type }],
    queryFn: async (): Promise<ChallengesData> => {
      const response = await api.get<ChallengesData>('/api/admin/challenges/', {
        params: { search, page, status, type },
      })
      return response.data
    },
  })

  const { data: stats } = useQuery<ChallengeStats>({
    queryKey: ['admin', 'challenge-stats'],
    queryFn: async (): Promise<ChallengeStats> => {
      const response = await api.get<ChallengeStats>('/api/admin/challenges/stats/')
      return response.data
    },
  })

  const cancelMut = useMutation({
    mutationFn: async (challenge: Challenge) => {
      const response = await api.post(`/api/admin/challenges/${challenge.id}/cancel/`)
      return response.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'challenges'] })
      setConfirmCancel(null)
    },
  })

  const columns = [
    {
      key: 'name', label: 'Challenge', sortable: true,
      render: (challenge: Challenge) => (
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(124,111,247,0.12)' }}>
            <Trophy size={15} color="#7C6FF7" />
          </div>
          <div>
            <p className="text-ink-primary text-sm font-semibold">{challenge.name}</p>
            <p className="text-ink-muted text-xs">
              {challenge.challenge_type} · {challenge.milestone_steps?.toLocaleString()} steps
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: (challenge: Challenge) => <StatusBadge variant={challenge.status} />,
    },
    {
      key: 'type', label: 'Type',
      render: (challenge: Challenge) => (
        <StatusBadge variant={challenge.challenge_type === 'public' ? 'public' : 'private'} />
      ),
    },
    {
      key: 'participants', label: 'Participants',
      render: (challenge: Challenge) => (
        <div className="flex items-center gap-1.5">
          <Users size={12} color="#7B82A0" />
          <span className="text-ink-secondary text-sm">{challenge.participant_count ?? 0}</span>
        </div>
      ),
    },
    {
      key: 'pool', label: 'Prize Pool', sortable: true,
      render: (challenge: Challenge) => (
        <span className="text-ink-primary text-sm font-mono font-semibold">
          KSh {Number(challenge.prize_pool ?? 0).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'start_date', label: 'Dates', sortable: true,
      render: (challenge: Challenge) => (
        <div>
          <p className="text-ink-secondary text-xs">
            {challenge.start_date ? format(new Date(challenge.start_date), 'MMM d') : '—'}
            {' → '}
            {challenge.end_date ? format(new Date(challenge.end_date), 'MMM d') : '—'}
          </p>
          {challenge.status === 'active' && challenge.end_date && (
            <p className="text-up text-[10px] mt-0.5">
              Ends {formatDistanceToNow(new Date(challenge.end_date), { addSuffix: true })}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'actions', label: 'Actions',
      render: (challenge: Challenge) => (
        <div className="flex items-center gap-1">
          <ActionBtn
            icon={Eye}
            color="#4F9CF9"
            title="View details"
            onClick={() => {
              setSelected(challenge)
              setDrawerOpen(true)
            }}
          />
          {challenge.status === 'active' && (
            <ActionBtn
              icon={XCircle}
              color="#F06060"
              title="Cancel challenge"
              onClick={() => setConfirmCancel(challenge)}
            />
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6 fade-in">
      <PageHeader
        title="Challenges"
        subtitle={`${data?.total ?? 0} total challenges`}
        actions={
          <div className="flex items-center gap-2">
            <select
              value={status}
              onChange={event => setStatus(event.target.value)}
              className="px-3 py-2 rounded-xl text-xs text-ink-secondary outline-none"
              style={{ background: '#13161F', border: '1px solid #21263A' }}>
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select
              value={type}
              onChange={event => setType(event.target.value)}
              className="px-3 py-2 rounded-xl text-xs text-ink-secondary outline-none"
              style={{ background: '#13161F', border: '1px solid #21263A' }}>
              <option value="all">All Types</option>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </div>
        }
      />

      <div className="grid grid-cols-4 gap-4">
        <StatCard title="Total Challenges" value={stats?.total ?? 0} icon={Trophy} color="purple" trend={stats?.growth_pct} />
        <StatCard title="Active Now" value={stats?.active ?? 0} icon={Activity} color="teal" sparkData={stats?.active_spark} />
        <StatCard title="Pending Start" value={stats?.pending ?? 0} icon={Clock} color="amber" />
        <StatCard title="Total Prize Pool" value={stats?.total_pool ?? 0} icon={CheckCircle} color="blue" prefix="KSh " isMoney />
      </div>

      <AdminTable
        title="All Challenges"
        columns={columns}
        data={data?.results ?? []}
        isLoading={isLoading}
        rowKey={(challenge: Challenge) => challenge.id}
        onRowClick={(challenge: Challenge) => {
          setSelected(challenge)
          setDrawerOpen(true)
        }}
        searchValue={search}
        onSearchChange={value => {
          setSearch(value)
          setPage(1)
        }}
        searchPlaceholder="Search challenges..."
        pagination={{ page, total: data?.total ?? 0, pageSize: 20, onPage: setPage }}
      />

      <SlideOver
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={selected?.name ?? 'Challenge Details'}
        subtitle={`${selected?.challenge_type ?? 'Unknown'} challenge`}>
        {selected && (
          <div>
            <div className="flex items-center gap-2 mb-5">
              <StatusBadge variant={selected.status} />
              <StatusBadge variant={selected.challenge_type === 'public' ? 'public' : 'private'} />
            </div>
            <h4 className="text-ink-muted text-xs font-semibold uppercase tracking-wider mb-3">Challenge Info</h4>
            <DetailRow label="Challenge ID" value={selected.id} mono />
            <DetailRow label="Milestone" value={`${selected.milestone_steps?.toLocaleString()} steps`} />
            <DetailRow label="Participants" value={selected.participant_count ?? 0} />
            <DetailRow label="Entry Fee" value={`KSh ${Number(selected.entry_fee ?? 0).toLocaleString()}`} mono />
            <DetailRow label="Prize Pool" value={`KSh ${Number(selected.prize_pool ?? 0).toLocaleString()}`} mono />
            <DetailRow label="Platform Fee" value={`KSh ${Number((selected.prize_pool ?? 0) * 0.1).toLocaleString()}`} mono />
            <DetailRow label="Start Date" value={selected.start_date ? format(new Date(selected.start_date), 'MMM d, yyyy') : '—'} />
            <DetailRow label="End Date" value={selected.end_date ? format(new Date(selected.end_date), 'MMM d, yyyy') : '—'} />
            <DetailRow label="Created By" value={selected.created_by_username ?? 'System'} />
          </div>
        )}
      </SlideOver>

      <ConfirmModal
        open={!!confirmCancel}
        onClose={() => setConfirmCancel(null)}
        onConfirm={() => {
          if (confirmCancel) {
            cancelMut.mutate(confirmCancel)
          }
        }}
        loading={cancelMut.isPending}
        title="Cancel Challenge"
        message={`Cancel "${confirmCancel?.name}"? All entry fees will be refunded to participants' wallets.`}
        confirmLabel="Cancel Challenge"
        variant="warning"
      />
    </div>
  )
}

function ActionBtn({ icon: Icon, color, title, onClick }: ActionBtnProps) {
  return (
    <button
      title={title}
      onClick={event => {
        event.stopPropagation()
        onClick()
      }}
      className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
      style={{ color }}
      onMouseEnter={event => (event.currentTarget.style.background = `${color}18`)}
      onMouseLeave={event => (event.currentTarget.style.background = 'transparent')}>
      <Icon size={13} />
    </button>
  )
}
