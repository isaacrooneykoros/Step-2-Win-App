import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, Clock, KeyRound, QrCode, Search, UserPlus } from 'lucide-react';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Segmented } from '../../components/ui/Segmented';
import { Input } from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import { Avatar } from '../../components/ui/Avatar';
import { EmptyState } from '../../components/ui/EmptyState';
import { LoadError } from '../../components/ui/ErrorState';
import { ListGroup } from '../../components/ui/ListRow';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { apiErrorMessage } from '../../components/settings/apiError';
import { FriendCodeCard } from '../../components/social/FriendCodeCard';
import { QrScannerView } from '../../components/social/QrScannerView';
import { socialService, type Person } from '../../services/api/social';
import { extractFriendCode, socialKeys } from '../../components/social/socialUtils';

type Mode = 'search' | 'scan' | 'code';

function useDebounced(value: string, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The action for one person, depending on where you stand with them. */
function PersonAction({ person, onAdd, pending }: { person: Person; onAdd: () => void; pending: boolean }) {
  switch (person.relationship) {
    case 'friends':
      return <span className="inline-flex items-center gap-1 text-caption font-semibold text-success"><Check size={14} aria-hidden />Friends</span>;
    case 'outgoing':
      return <span className="inline-flex items-center gap-1 text-caption font-semibold text-text-muted"><Clock size={14} aria-hidden />Requested</span>;
    case 'self':
      return <span className="text-caption text-text-muted">You</span>;
    case 'blocked':
      return <span className="text-caption text-text-muted">Blocked</span>;
    default:
      return (
        <Button size="sm" onClick={onAdd} isLoading={pending} leftIcon={<UserPlus size={15} aria-hidden />}>
          {person.relationship === 'incoming' ? 'Accept' : 'Add'}
        </Button>
      );
  }
}

function PersonCard({ person, onAdd, pending }: { person: Person; onAdd: () => void; pending: boolean }) {
  return (
    <div className="flex min-h-[64px] items-center gap-3 px-4 py-3">
      <Avatar name={person.username} src={person.profile_picture_url} />
      <p className="min-w-0 flex-1 truncate text-body font-medium text-text-primary">{person.username}</p>
      <PersonAction person={person} onAdd={onAdd} pending={pending} />
    </div>
  );
}

function useSendRequest(onDone?: (p: Person) => void) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  return useMutation({
    mutationFn: (target: { user_id: number } | { code: string }) => socialService.sendRequest(target),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: socialKeys.all });
      showToast({
        message:
          res.status === 'accepted'
            ? `You and ${res.user.username} are now friends.`
            : res.status === 'already_sent'
              ? 'Your request is already waiting.'
              : `Request sent to ${res.user.username}.`,
        type: 'success',
      });
      onDone?.(res.user);
    },
    onError: (error) => showToast({ message: apiErrorMessage(error, 'Couldn’t send the request. Please try again.'), type: 'error' }),
  });
}

export default function AddFriendScreen() {
  const [mode, setMode] = useState<Mode>('search');
  const [q, setQ] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [scanned, setScanned] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Record<number, Person['relationship']>>({});
  const debounced = useDebounced(q.trim().replace(/^@/, ''));
  const searchable = debounced.length >= 3;

  const me = useQuery({ queryKey: socialKeys.me, queryFn: socialService.me, staleTime: 60_000 });
  const results = useQuery({
    queryKey: ['social', 'search', debounced],
    queryFn: () => socialService.search(debounced),
    enabled: mode === 'search' && searchable,
    staleTime: 60_000,
    retry: false,
  });
  const lookupCode = scanned ?? (mode === 'search' ? null : extractFriendCode(codeInput));
  const preview = useQuery({
    queryKey: ['social', 'code', lookupCode],
    queryFn: () => socialService.userByCode(lookupCode!),
    enabled: Boolean(lookupCode),
    retry: false,
  });
  const send = useSendRequest((p) => setSentTo((s) => ({ ...s, [p.id]: p.relationship === 'friends' ? 'friends' : 'outgoing' })));

  const withSent = (p: Person): Person => (sentTo[p.id] ? { ...p, relationship: sentTo[p.id] } : p);

  return (
    <div className="pb-nav">
      <ScreenHeader title="Add friends" back="/social?tab=friends" />
      <div className="mx-auto w-full max-w-2xl space-y-5 px-5 pb-8 pt-2">
        <Segmented<Mode>
          label="How to add"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setScanned(null);
          }}
          options={[
            { value: 'search', label: <span className="inline-flex items-center gap-1.5"><Search size={14} aria-hidden />Search</span> },
            { value: 'scan', label: <span className="inline-flex items-center gap-1.5"><QrCode size={14} aria-hidden />Scan</span> },
            { value: 'code', label: <span className="inline-flex items-center gap-1.5"><KeyRound size={14} aria-hidden />My code</span> },
          ]}
        />

        {mode === 'search' && (
          <>
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Username"
              aria-label="Search by username"
              autoCapitalize="none"
              autoCorrect="off"
              leading={<Search size={18} aria-hidden />}
              helperText="Type at least 3 characters. People who hide from search can still be added with their code."
            />
            {!searchable ? null : results.isLoading ? (
              <Skeleton className="h-32 rounded-card" />
            ) : results.isError ? (
              <LoadError resource="search results" onRetry={() => results.refetch()} isRetrying={results.isFetching} />
            ) : (results.data ?? []).length === 0 ? (
              <EmptyState icon={Search} title="No one found" description="Check the spelling, or ask your friend for their code or QR." />
            ) : (
              <ListGroup>
                {(results.data ?? []).map((p) => (
                  <PersonCard key={p.id} person={withSent(p)} pending={send.isPending && send.variables && 'user_id' in send.variables && send.variables.user_id === p.id ? true : false} onAdd={() => send.mutate({ user_id: p.id })} />
                ))}
              </ListGroup>
            )}
          </>
        )}

        {mode === 'scan' && (
          <>
            {!scanned && (
              <QrScannerView
                hint="Scan the QR on your friend’s “My code” screen."
                onScan={(text) => {
                  const code = extractFriendCode(text);
                  if (code) setScanned(code);
                  return Boolean(code);
                }}
              />
            )}
            {scanned && (
              <Button variant="ghost" fullWidth onClick={() => setScanned(null)}>
                Scan another code
              </Button>
            )}
            {!scanned && (
              <Input
                label="Or type a friend code"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.toUpperCase().slice(0, 64))}
                placeholder="e.g. K7M2QX9P or an invite link"
                autoCapitalize="characters"
                autoComplete="off"
              />
            )}
          </>
        )}

        {mode !== 'search' && lookupCode && (
          preview.isLoading ? (
            <Skeleton className="h-16 rounded-card" />
          ) : preview.isError ? (
            <p className="rounded-card bg-bg-sunken p-4 text-callout text-text-secondary" role="alert">
              We couldn’t find anyone with that code. Check it with your friend.
            </p>
          ) : preview.data ? (
            <ListGroup>
              <PersonCard person={withSent(preview.data)} pending={send.isPending} onAdd={() => send.mutate({ code: lookupCode })} />
            </ListGroup>
          ) : null
        )}

        {mode === 'code' && (
          me.isLoading ? (
            <Skeleton className="h-80 rounded-card" />
          ) : me.data ? (
            <>
              <FriendCodeCard code={me.data.friend_code} />
              <p className="px-1 text-center text-caption text-text-muted">
                Anyone with this code or link can send you a friend request. You can change it any time in Friends settings.
              </p>
            </>
          ) : (
            <LoadError resource="your code" onRetry={() => me.refetch()} isRetrying={me.isFetching} />
          )
        )}
      </div>
    </div>
  );
}

/** Opened from a shared link: /social/add/:code */
export function FriendInviteScreen() {
  const { code: rawCode = '' } = useParams();
  const navigate = useNavigate();
  const code = extractFriendCode(rawCode);
  const [done, setDone] = useState(false);
  const preview = useQuery({
    queryKey: ['social', 'code', code],
    queryFn: () => socialService.userByCode(code!),
    enabled: Boolean(code),
    retry: false,
  });
  const send = useSendRequest(() => setDone(true));
  const person = preview.data;

  return (
    <div className="pb-nav">
      <ScreenHeader title="Friend invite" back="/social?tab=friends" />
      <div className="mx-auto w-full max-w-md px-5 pb-8 pt-6">
        {!code || preview.isError ? (
          <EmptyState icon={UserPlus} title="This invite isn’t valid" description="The code may have been changed. Ask your friend to share it again." action={{ label: 'Find friends', onClick: () => navigate('/social/add') }} />
        ) : preview.isLoading || !person ? (
          <Skeleton className="mx-auto h-48 rounded-card" />
        ) : (
          <div className="flex flex-col items-center gap-4 rounded-card border border-border-light bg-bg-card p-6 text-center shadow-card">
            <Avatar name={person.username} src={person.profile_picture_url} size="xl" />
            <div>
              <h2 className="text-title text-text-primary">{person.username}</h2>
              <p className="mt-1 text-callout text-text-secondary">wants to compare weekly steps with you.</p>
            </div>
            {person.relationship === 'self' ? (
              <p className="text-callout text-text-muted">This is your own invite.</p>
            ) : person.relationship === 'friends' || done ? (
              <Button fullWidth variant="secondary" onClick={() => navigate('/social')}>
                {person.relationship === 'friends' ? 'You’re already friends' : 'Request sent'}
              </Button>
            ) : person.relationship === 'outgoing' ? (
              <p className="text-callout text-text-muted">Your request is waiting for them.</p>
            ) : (
              <Button fullWidth isLoading={send.isPending} leftIcon={<UserPlus size={18} aria-hidden />} onClick={() => send.mutate({ code })}>
                {person.relationship === 'incoming' ? 'Accept friend request' : 'Send friend request'}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
