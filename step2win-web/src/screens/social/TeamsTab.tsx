import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Globe, KeyRound, Lock, Plus, Search, Users } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Input, TextArea } from '../../components/ui/Input';
import { EmptyState } from '../../components/ui/EmptyState';
import { LoadError } from '../../components/ui/ErrorState';
import { ListGroup, ListRow } from '../../components/ui/ListRow';
import { IconTile, Pill } from '../../components/ui/Pill';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { apiErrorMessage } from '../../components/settings/apiError';
import { socialService, type TeamSummary, type TeamVisibility } from '../../services/api/social';
import { formatCompact } from '../../lib/format';
import { socialKeys } from '../../components/social/socialUtils';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

function TeamRow({ team, onClick }: { team: TeamSummary; onClick: () => void }) {
  return (
    <ListRow
      leading={<IconTile icon={Users} tone={team.my_role ? 'brand' : 'neutral'} />}
      title={team.name}
      subtitle={`${team.member_count} ${team.member_count === 1 ? 'member' : 'members'} · ${formatCompact(team.week_steps)} this week`}
      trailing={team.my_role ? <Pill tone={team.my_role === 'owner' ? 'brand' : 'neutral'}>{ROLE_LABEL[team.my_role]}</Pill> : team.visibility === 'invite_only' ? <Lock size={14} className="text-text-muted" aria-label="Invite only" /> : undefined}
      onClick={onClick}
      chevron
    />
  );
}

function useDebounced(value: string, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function TeamsTab({ maxTeams }: { maxTeams: number }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<TeamVisibility>('public');
  const [code, setCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim());
  const searchActive = query.length >= 3;

  const mine = useQuery({ queryKey: socialKeys.myTeams, queryFn: socialService.myTeams, staleTime: 60_000 });
  const discover = useQuery({
    queryKey: socialKeys.discover(searchActive ? query : ''),
    queryFn: () => socialService.discoverTeams(searchActive ? query : ''),
    staleTime: 5 * 60_000,
  });

  const create = useMutation({
    mutationFn: () => socialService.createTeam({ name: name.trim(), description: description.trim(), visibility }),
    onSuccess: (team) => {
      queryClient.invalidateQueries({ queryKey: socialKeys.all });
      setCreateOpen(false);
      showToast({ message: `${team.name} is ready. Invite your friends!`, type: 'success' });
      navigate(`/social/teams/${team.id}`);
    },
    onError: (error) => setFormError(apiErrorMessage(error, 'Couldn’t create the team. Please try again.')),
  });

  const join = useMutation({
    mutationFn: () => socialService.joinTeamByCode(code.trim()),
    onSuccess: (team) => {
      queryClient.invalidateQueries({ queryKey: socialKeys.all });
      setJoinOpen(false);
      showToast({ message: `You joined ${team.name}.`, type: 'success' });
      navigate(`/social/teams/${team.id}`);
    },
    onError: (error) => setFormError(apiErrorMessage(error, 'Couldn’t join with that code.')),
  });

  const myTeams = mine.data ?? [];
  const atLimit = myTeams.length >= maxTeams;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2">
        <Button
          leftIcon={<Plus size={16} className="shrink-0" aria-hidden />}
          disabled={atLimit}
          onClick={() => {
            setName('');
            setDescription('');
            setVisibility('public');
            setFormError(null);
            setCreateOpen(true);
          }}
        >
          Create team
        </Button>
        <Button
          variant="outline"
          leftIcon={<KeyRound size={16} className="shrink-0" aria-hidden />}
          disabled={atLimit}
          onClick={() => {
            setCode('');
            setFormError(null);
            setJoinOpen(true);
          }}
        >
          Join by code
        </Button>
      </div>
      {atLimit && <p className="-mt-3 px-1 text-caption text-text-muted">You can be in up to {maxTeams} teams. Leave one to join another.</p>}

      {mine.isLoading ? (
        <Skeleton className="h-20 rounded-card" />
      ) : mine.isError ? (
        <LoadError resource="your teams" onRetry={() => mine.refetch()} isRetrying={mine.isFetching} />
      ) : myTeams.length > 0 ? (
        <ListGroup title="Your teams">
          {myTeams.map((t) => (
            <TeamRow key={t.id} team={t} onClick={() => navigate(`/social/teams/${t.id}`)} />
          ))}
        </ListGroup>
      ) : null}

      <section>
        <h2 className="eyebrow mb-2 px-1">Find a public team</h2>
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search team names"
          aria-label="Search public teams"
          leading={<Search size={18} aria-hidden />}
          helperText={q.trim().length > 0 && q.trim().length < 3 ? 'Type at least 3 characters.' : undefined}
        />
        {discover.isLoading ? (
          <Skeleton className="h-32 rounded-card" />
        ) : discover.isError ? (
          <LoadError resource="teams" onRetry={() => discover.refetch()} isRetrying={discover.isFetching} />
        ) : (discover.data ?? []).length === 0 ? (
          <EmptyState icon={Users} title={searchActive ? 'No teams found' : 'No public teams yet'} description="Start one and invite your friends, classmates or workmates." />
        ) : (
          <ListGroup>
            {(discover.data ?? []).map((t) => (
              <TeamRow key={t.id} team={t} onClick={() => navigate(`/social/teams/${t.id}`)} />
            ))}
          </ListGroup>
        )}
      </section>

      <Sheet
        open={createOpen}
        onClose={() => !create.isPending && setCreateOpen(false)}
        title="Create a team"
        description="Walk together and see your team’s weekly total. Just for fun: no money involved."
        footer={
          <Button fullWidth disabled={name.trim().length < 3} isLoading={create.isPending} loadingText="Creating…" onClick={() => { setFormError(null); create.mutate(); }}>
            Create team
          </Button>
        }
      >
        <Input label="Team name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Karura Morning Walkers" />
        <TextArea label="Description (optional)" value={description} maxLength={160} rows={2} onChange={(e) => setDescription(e.target.value)} />
        <p className="label">Who can join?</p>
        <Segmented<TeamVisibility>
          label="Who can join"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: 'public', label: <span className="inline-flex items-center gap-1.5"><Globe size={14} aria-hidden />Anyone</span> },
            { value: 'invite_only', label: <span className="inline-flex items-center gap-1.5"><Lock size={14} aria-hidden />With code</span> },
          ]}
        />
        <p className="mt-2 text-caption text-text-muted">
          {visibility === 'public' ? 'Your team appears in search and anyone can join.' : 'Only people with your team code can find and join it.'}
        </p>
        {formError && <p className="mt-3 text-caption font-medium text-danger" role="alert">{formError}</p>}
      </Sheet>

      <Sheet
        open={joinOpen}
        onClose={() => !join.isPending && setJoinOpen(false)}
        title="Join with a code"
        description="Ask a team member for their team code."
        footer={
          <Button fullWidth disabled={code.trim().length < 6} isLoading={join.isPending} loadingText="Joining…" onClick={() => { setFormError(null); join.mutate(); }}>
            Join team
          </Button>
        }
      >
        <Input
          label="Team code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12))}
          placeholder="8 characters"
          autoCapitalize="characters"
          autoComplete="off"
          className="num tracking-[0.2em]"
          error={formError ?? undefined}
        />
      </Sheet>
    </div>
  );
}

export default TeamsTab;
