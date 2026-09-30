import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Crown, Flag, Globe, Lock, LogOut, Pencil, RefreshCw, Shield, ShieldOff, Trash2, UserMinus, Users } from 'lucide-react';
import { IconButton, ScreenHeader } from '../../components/ui/ScreenHeader';
import Button from '../../components/ui/Button';
import { Input, TextArea } from '../../components/ui/Input';
import { EmptyState } from '../../components/ui/EmptyState';
import { LoadError } from '../../components/ui/ErrorState';
import { ListGroup, ListRow } from '../../components/ui/ListRow';
import { IconTile, Pill } from '../../components/ui/Pill';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatTile } from '../../components/ui/StatTile';
import { useToast } from '../../components/ui/Toast';
import { apiErrorMessage } from '../../components/settings/apiError';
import { FriendCodeCard } from '../../components/social/FriendCodeCard';
import { RankRow } from '../../components/social/RankList';
import { ReportSheet } from '../../components/social/ReportSheet';
import { socialService, type TeamDetail, type TeamMemberRow, type TeamVisibility } from '../../services/api/social';
import { formatSteps } from '../../lib/format';
import { socialKeys } from '../../components/social/socialUtils';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

type Confirm =
  | { kind: 'leave' }
  | { kind: 'disband' }
  | { kind: 'remove'; member: TeamMemberRow }
  | { kind: 'transfer'; member: TeamMemberRow }
  | null;

export default function TeamDetailScreen() {
  const { id = '' } = useParams();
  const teamId = Number(id);
  const [params] = useSearchParams();
  const code = params.get('code') ?? undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [member, setMember] = useState<TeamMemberRow | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [edit, setEdit] = useState<{ name: string; description: string; visibility: TeamVisibility }>({ name: '', description: '', visibility: 'public' });
  const [editError, setEditError] = useState<string | null>(null);

  const query = useQuery({ queryKey: socialKeys.team(teamId), queryFn: () => socialService.team(teamId, code), enabled: Number.isFinite(teamId), staleTime: 60_000 });
  const team = query.data;
  const role = team?.my_role ?? null;
  const canManage = role === 'owner' || role === 'admin';

  const onTeam = (next: TeamDetail) => {
    queryClient.setQueryData(socialKeys.team(teamId), next);
    queryClient.invalidateQueries({ queryKey: ['social', 'teams'] });
    queryClient.invalidateQueries({ queryKey: ['social', 'ranking'] });
  };
  const fail = (error: unknown) => showToast({ message: apiErrorMessage(error, 'That didn’t work. Please try again.'), type: 'error' });

  const join = useMutation({
    mutationFn: () => socialService.teamAction(teamId, 'join', code ? { code } : {}),
    onSuccess: (t) => {
      onTeam(t);
      showToast({ message: `Welcome to ${t.name}!`, type: 'success' });
    },
    onError: fail,
  });

  const run = useMutation({
    mutationFn: async (c: NonNullable<Confirm>) => {
      if (c.kind === 'leave') return socialService.teamAction(teamId, 'leave');
      if (c.kind === 'disband') {
        await socialService.disbandTeam(teamId);
        return null;
      }
      if (c.kind === 'remove') return socialService.memberAction(teamId, c.member.user.id, 'remove');
      return socialService.teamAction(teamId, 'transfer', { user_id: c.member.user.id });
    },
    onSuccess: (res, c) => {
      setConfirm(null);
      if (c.kind === 'leave' || c.kind === 'disband') {
        queryClient.invalidateQueries({ queryKey: socialKeys.all });
        showToast({ message: c.kind === 'disband' ? 'Team deleted.' : 'You left the team.', type: 'success' });
        navigate('/social?tab=teams', { replace: true });
        return;
      }
      if (res) onTeam(res);
      showToast({ message: c.kind === 'remove' ? `${c.member.user.username} was removed.` : `${c.member.user.username} is now the owner.`, type: 'success' });
    },
    onError: fail,
  });

  const setRole = useMutation({
    mutationFn: ({ userId, next }: { userId: number; next: 'admin' | 'member' }) => socialService.memberAction(teamId, userId, 'role', { role: next }),
    onSuccess: (t) => {
      onTeam(t);
      setMember(null);
    },
    onError: fail,
  });

  const save = useMutation({
    mutationFn: () => socialService.updateTeam(teamId, { name: edit.name.trim(), description: edit.description.trim(), visibility: edit.visibility }),
    onSuccess: (t) => {
      onTeam(t);
      setEditOpen(false);
      showToast({ message: 'Team updated.', type: 'success' });
    },
    onError: (error) => setEditError(apiErrorMessage(error, 'Couldn’t save the changes.')),
  });

  const resetCode = useMutation({
    mutationFn: () => socialService.teamAction(teamId, 'reset-code'),
    onSuccess: (t) => {
      onTeam(t);
      showToast({ message: 'New team code created. The old one no longer works.', type: 'success' });
    },
    onError: fail,
  });

  const me = team?.members.find((m) => m.is_me);
  const canActOn = (m: TeamMemberRow) =>
    !m.is_me && (role === 'owner' ? m.role !== 'owner' : role === 'admin' ? m.role === 'member' : false);

  return (
    <div className="pb-nav">
      <ScreenHeader
        title={team?.name ?? 'Team'}
        back="/social?tab=teams"
        actions={
          team && !team.is_disabled ? (
            canManage ? (
              <IconButton
                label="Edit team"
                onClick={() => {
                  setEdit({ name: team.name, description: team.description, visibility: team.visibility });
                  setEditError(null);
                  setEditOpen(true);
                }}
              >
                <Pencil size={19} aria-hidden />
              </IconButton>
            ) : (
              <IconButton label="Report team" onClick={() => setReportOpen(true)}>
                <Flag size={19} aria-hidden />
              </IconButton>
            )
          ) : undefined
        }
      />
      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 pb-8 pt-2">
        {query.isLoading ? (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-24 rounded-card" />
            <Skeleton className="h-64 rounded-card" />
          </div>
        ) : query.isError || !team ? (
          (query.error as { response?: { status?: number } } | null)?.response?.status === 404 ? (
            <EmptyState icon={Users} title="Team not found" description="It may have been deleted, or it’s invite only." action={{ label: 'Back to teams', onClick: () => navigate('/social?tab=teams') }} />
          ) : (
            <LoadError resource="this team" onRetry={() => query.refetch()} isRetrying={query.isFetching} />
          )
        ) : (
          <>
            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="neutral" icon={team.visibility === 'public' ? Globe : Lock}>{team.visibility === 'public' ? 'Public' : 'Invite only'}</Pill>
                {role && <Pill tone={role === 'owner' ? 'brand' : 'neutral'}>{ROLE_LABEL[role]}</Pill>}
                {team.is_disabled && <Pill tone="warning">Paused by moderators</Pill>}
              </div>
              {team.description && <p className="text-callout text-text-secondary">{team.description}</p>}
              {team.is_disabled && team.disabled_reason && (
                <p className="rounded-card bg-warning-soft p-3 text-callout text-text-primary">{team.disabled_reason}</p>
              )}
              <div className="grid grid-cols-3 gap-2">
                <StatTile variant="card" className="!p-3" label="This week" value={formatSteps(team.week_steps)} hint="team steps" />
                <StatTile variant="card" className="!p-3" label="Members" value={String(team.member_count)} />
                <StatTile variant="card" className="!p-3" label="Your rank" value={me?.rank ? `#${me.rank}` : '—'} hint="in team" />
              </div>
            </section>

            {!role && !team.is_disabled && (
              <Button fullWidth isLoading={join.isPending} loadingText="Joining…" onClick={() => join.mutate()}>
                Join team
              </Button>
            )}

            {team.members.length > 0 && (
              <section aria-label="Members this week">
                <h2 className="eyebrow mb-2 px-1">Members this week</h2>
                <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card">
                  {team.members.map((m) => (
                    <RankRow
                      key={m.user.id}
                      rank={m.steps ? m.rank : null}
                      name={m.user.username}
                      photo={m.user.profile_picture_url}
                      steps={m.steps}
                      highlight={m.is_me}
                      subtitle={m.role === 'member' ? undefined : ROLE_LABEL[m.role]}
                      onClick={canActOn(m) ? () => setMember(m) : undefined}
                    />
                  ))}
                </div>
                <p className="mt-2 px-1 text-caption text-text-muted">Bragging rights only: no money or prizes.</p>
              </section>
            )}

            {role && !team.is_disabled && (
              <ListGroup>
                {team.invite_code && (
                  <ListRow leading={<IconTile icon={Users} tone="brand" size="sm" />} title="Invite friends" subtitle="Share the team code or QR" onClick={() => setInviteOpen(true)} chevron />
                )}
                {canManage && (
                  <ListRow leading={<IconTile icon={RefreshCw} tone="neutral" size="sm" />} title="New team code" subtitle="The old code stops working" onClick={() => resetCode.mutate()} disabled={resetCode.isPending} />
                )}
                <ListRow leading={<IconTile icon={LogOut} tone="neutral" size="sm" />} title="Leave team" onClick={() => setConfirm({ kind: 'leave' })} />
                {role === 'owner' && (
                  <ListRow leading={<IconTile icon={Trash2} tone="danger" size="sm" />} title="Delete team" destructive onClick={() => setConfirm({ kind: 'disband' })} />
                )}
              </ListGroup>
            )}
            {canManage && (
              <button type="button" className="mx-auto block min-h-touch text-caption font-semibold text-text-muted" onClick={() => setReportOpen(true)}>
                Report this team
              </button>
            )}
          </>
        )}
      </div>

      {/* Member actions */}
      <Sheet open={member !== null} onClose={() => setMember(null)} title={member?.user.username}>
        {member && (
          <ListGroup>
            {role === 'owner' && member.role === 'member' && (
              <ListRow leading={<IconTile icon={Shield} tone="brand" size="sm" />} title="Make admin" subtitle="Can edit the team and remove members" onClick={() => setRole.mutate({ userId: member.user.id, next: 'admin' })} disabled={setRole.isPending} />
            )}
            {role === 'owner' && member.role === 'admin' && (
              <ListRow leading={<IconTile icon={ShieldOff} tone="neutral" size="sm" />} title="Remove admin role" onClick={() => setRole.mutate({ userId: member.user.id, next: 'member' })} disabled={setRole.isPending} />
            )}
            {role === 'owner' && (
              <ListRow leading={<IconTile icon={Crown} tone="brand" size="sm" />} title="Make owner" subtitle="You become an admin" onClick={() => { setConfirm({ kind: 'transfer', member }); setMember(null); }} />
            )}
            <ListRow leading={<IconTile icon={UserMinus} tone="danger" size="sm" />} title="Remove from team" destructive onClick={() => { setConfirm({ kind: 'remove', member }); setMember(null); }} />
          </ListGroup>
        )}
      </Sheet>

      {/* Confirmations */}
      <Sheet
        open={confirm !== null}
        onClose={() => !run.isPending && setConfirm(null)}
        title={
          confirm?.kind === 'leave' ? 'Leave this team?' : confirm?.kind === 'disband' ? 'Delete this team?' : confirm?.kind === 'remove' ? `Remove ${confirm.member.user.username}?` : confirm?.kind === 'transfer' ? `Make ${confirm.member.user.username} the owner?` : ''
        }
        description={
          confirm?.kind === 'leave'
            ? role === 'owner'
              ? 'As the owner, make someone else the owner first (tap a member). If you’re the last member, the team is deleted.'
              : 'You can join again later if there’s room.'
            : confirm?.kind === 'disband'
              ? 'Everyone is removed and the team’s history is deleted. This can’t be undone.'
              : confirm?.kind === 'remove'
                ? 'They can rejoin a public team, or with the code.'
                : confirm?.kind === 'transfer'
                  ? 'They get full control of the team. You stay on as an admin.'
                  : undefined
        }
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)} disabled={run.isPending}>
              Cancel
            </Button>
            <Button variant={confirm?.kind === 'transfer' ? 'primary' : 'danger'} isLoading={run.isPending} onClick={() => confirm && run.mutate(confirm)}>
              {confirm?.kind === 'leave' ? 'Leave' : confirm?.kind === 'disband' ? 'Delete' : confirm?.kind === 'remove' ? 'Remove' : 'Confirm'}
            </Button>
          </div>
        }
      >
        <span />
      </Sheet>

      <Sheet open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite to team" description="Friends enter this code in Teams > Join with code.">
        {team?.invite_code && <FriendCodeCard kind="team" code={team.invite_code} title={team.name} />}
      </Sheet>

      <Sheet
        open={editOpen}
        onClose={() => !save.isPending && setEditOpen(false)}
        title="Edit team"
        footer={
          <Button fullWidth isLoading={save.isPending} disabled={edit.name.trim().length < 3} onClick={() => { setEditError(null); save.mutate(); }}>
            Save
          </Button>
        }
      >
        <Input label="Team name" value={edit.name} maxLength={40} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
        <TextArea label="Description" value={edit.description} maxLength={160} rows={2} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
        <p className="label">Who can join?</p>
        <Segmented<TeamVisibility>
          label="Who can join"
          value={edit.visibility}
          onChange={(v) => setEdit({ ...edit, visibility: v })}
          options={[
            { value: 'public', label: 'Anyone' },
            { value: 'invite_only', label: 'With code' },
          ]}
        />
        {editError && <p className="mt-3 text-caption font-medium text-danger" role="alert">{editError}</p>}
      </Sheet>

      <ReportSheet open={reportOpen} onClose={() => setReportOpen(false)} target={team ? { type: 'team', id: team.id, name: team.name } : null} />
    </div>
  );
}
