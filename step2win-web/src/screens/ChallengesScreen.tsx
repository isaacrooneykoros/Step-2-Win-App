import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LoadError } from '../components/ui/ErrorState';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Compass, Copy, Download, KeyRound, Plus, QrCode } from 'lucide-react';
import { challengesService } from '../services/api';
import { useToast } from '../components/ui/Toast';
import { useAuthStore } from '../store/authStore';
import { Sheet } from '../components/ui/Sheet';
import Button from '../components/ui/Button';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { IconTile } from '../components/ui/Pill';
import { Segmented } from '../components/ui/Segmented';
import { checkCameraPermission, requestCameraPermission } from '../services/cameraPermissions';
import type { Challenge, ChallengeDetail, CreateChallengeForm } from '../types';
import { formatKES } from '../lib/format';
import { CreateChallengeSheet } from '../components/challenge/CreateChallengeSheet';
import { challengeToCardModel } from '../components/challenge/challengeUtils';
import ChallengesMineSection, { type MineTab } from './challenges/ChallengesMineSection';
import { openAppSettings } from '../plugins/appSystem';
import { permissionCopy } from '../utils/platform';
import { canvasToBlob, saveOrShareImage } from '../lib/share';

type QrScanner = {
  start: (
    cameraIdOrConfig: string | MediaTrackConstraints,
    configuration: { fps: number; qrbox: { width: number; height: number }; aspectRatio: number; disableFlip: boolean },
    onSuccess: (decodedText: string) => void,
    onError?: (error: unknown) => void,
  ) => Promise<null>;
  stop: () => Promise<void>;
  clear: () => void;
  isScanning: boolean;
};

/** Turn a DRF error payload into one readable sentence. */
function describeCreateError(error: any): string {
  const errorData = error?.response?.data;
  if (errorData?.errors) {
    return Object.entries(errorData.errors)
      .map(([field, msgs]: [string, any]) => {
        const message = Array.isArray(msgs) ? msgs[0] : msgs;
        return `${field.replace(/_/g, ' ')}: ${message}`;
      })
      .join(' ');
  }
  if (errorData?.error) return String(errorData.error);
  if (!error?.response) return "We couldn't reach Step2Win. Check your connection and try again.";
  return 'Something went wrong. Please try again.';
}

function describeJoinError(error: any): string {
  const data = error?.response?.data;
  const fieldMsg = data?.invite_code?.[0] ?? data?.details?.invite_code?.[0];
  if (fieldMsg) return String(fieldMsg);
  if (data?.error && typeof data.error === 'string') return data.error;
  if (typeof data?.message === 'string' && !data.message.startsWith('{')) return data.message;
  if (!error?.response) return "We couldn't reach Step2Win. Check your connection and try again.";
  return 'Failed to join challenge';
}

export default function ChallengesScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const user = useAuthStore((state) => state.user);
  const [tab, setTab] = useState<MineTab>('active');
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createSheetKey, setCreateSheetKey] = useState(0);
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinTab, setJoinTab] = useState<'manual' | 'qr'>('manual');
  const [inviteCode, setInviteCode] = useState('');
  const [createdChallenge, setCreatedChallenge] = useState<ChallengeDetail | null>(null);
  const [showCreated, setShowCreated] = useState(false);
  const [copied, setCopied] = useState(false);
  const scannerRef = useRef<QrScanner | null>(null);

  const {
    data: myChallenges = [],
    isLoading: loadingMy,
    isError: myError,
    isFetching: fetchingMy,
    refetch: refetchMy,
  } = useQuery({
    queryKey: ['challenges', 'my'],
    queryFn: challengesService.getMyChallenges,
    retry: 1,
  });

  const { data: config } = useQuery({
    queryKey: ['challenges', 'config'],
    queryFn: challengesService.getConfig,
    staleTime: 10 * 60_000,
  });

  // Shares the lobby screen's default cache entry (filter all, any goal, featured sort).
  const { data: lobby } = useQuery({
    queryKey: ['challenges', 'lobby', 'all', 'all', 'featured'],
    queryFn: () => challengesService.getLobby({ filter: 'all', sort: 'featured' }),
    staleTime: 30_000,
  });
  const openInLobby = lobby ? lobby.challenges.filter((c) => !c.user_is_joined).length : null;

  const joinMutation = useMutation({
    mutationFn: (code: string) => challengesService.join({ invite_code: code }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      setShowJoinModal(false);
      setInviteCode('');
      showToast({ message: 'Successfully joined challenge!', type: 'success' });
    },
    onError: (error: any) => {
      setJoinError(describeJoinError(error));
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateChallengeForm) => challengesService.create(data),
    onSuccess: (data: ChallengeDetail) => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      setShowCreateModal(false);
      setCreatedChallenge(data);
      setShowCreated(true);
      showToast({ message: 'Challenge created successfully!', type: 'success' });
    },
    onError: (error: any) => {
      setCreateError(describeCreateError(error));
    },
  });

  // ── Partition my challenges ────────────────────────────────────────────────
  const partitions = useMemo(() => {
    const list: Challenge[] = Array.isArray(myChallenges) ? myChallenges : [];
    // A creator's challenge only counts as active once someone else has joined.
    const waiting = (c: Challenge) => c.creator === user?.id && c.current_participants < 2;
    return {
      active: list.filter((c) => c.status === 'active' && !waiting(c)),
      upcoming: list.filter((c) => c.status === 'pending' || (c.status === 'active' && waiting(c))),
      completed: list.filter((c) => c.status === 'completed' || c.status === 'cancelled'),
    };
  }, [myChallenges, user?.id]);

  const counts = {
    active: partitions.active.length,
    upcoming: partitions.upcoming.length,
    completed: partitions.completed.length,
  };
  const cards = partitions[tab].map((c) => challengeToCardModel(c, user?.id));

  const availableBalance = user?.available_balance != null ? Number(user.available_balance) : null;

  // ── Join by code / QR ──────────────────────────────────────────────────────
  const clearScanner = () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (!scanner) return;
    // Stop the stream first (releases the camera / indicator), then clear the viewfinder.
    const clear = () => {
      try {
        scanner.clear();
      } catch (error) {
        console.warn('Error clearing scanner:', error);
      }
    };
    if (scanner.isScanning) {
      scanner.stop().then(clear).catch(clear);
    } else {
      clear();
    }
  };

  const ensureCameraAccess = async () => {
    try {
      const initial = await checkCameraPermission();
      if (initial === 'granted') return true;
      if (initial === 'denied') {
        // Blocked for good: the OS won't ask again, so point to the app's settings.
        const opened = await openAppSettings();
        showToast({
          message: opened ? permissionCopy().openedSettingsFor('Camera') : `Camera is blocked. Allow it in ${permissionCopy().settingsName}, or enter the code.`,
          type: 'info',
        });
        return false;
      }

      const granted = await requestCameraPermission();

      if (!granted) {
        showToast({ message: 'Camera permission is required to scan QR codes.', type: 'error' });
      }

      return granted;
    } catch (error) {
      console.error('Camera permission check failed:', error);
      showToast({ message: 'Unable to access the camera for QR scanning.', type: 'error' });
      return false;
    }
  };

  const joinWithCode = async (code: string) => {
    setJoinError(null);
    try {
      const result = await joinMutation.mutateAsync(code.toUpperCase());
      clearScanner();
      setShowJoinModal(false);
      setInviteCode('');
      navigate(`/challenges/${result.challenge.id}`);
    } catch {
      // joinMutation surfaces the error inline
    }
  };

  const handleJoin = () => {
    if (inviteCode.length === 8) {
      void joinWithCode(inviteCode);
    } else {
      setJoinError('Invite codes are 8 characters long.');
    }
  };

  const handleQRSuccess = (decodedText: string) => {
    // Extract the 8-character code from the QR data
    const codeMatch = decodedText.match(/([A-Z0-9]{8})/);
    const code = codeMatch ? codeMatch[1] : decodedText.toUpperCase();

    if (code.length === 8) {
      setInviteCode(code);
      void joinWithCode(code);
    }
  };

  const closeJoin = () => {
    if (joinMutation.isPending) return;
    setShowJoinModal(false);
    setJoinTab('manual');
    setJoinError(null);
    clearScanner();
  };

  const openJoin = () => {
    setJoinError(null);
    setShowJoinModal(true);
  };

  const openCreate = () => {
    setCreateError(null);
    setCreateSheetKey((k) => k + 1);
    setShowCreateModal(true);
  };

  // ── Created challenge (share) ──────────────────────────────────────────────
  const downloadQRCode = async () => {
    const canvas = document.getElementById('challenge-qr-canvas') as HTMLCanvasElement | null;
    if (!canvas || !createdChallenge) return;
    try {
      const blob = await canvasToBlob(canvas);
      const result = await saveOrShareImage(
        { blob, name: `challenge-${createdChallenge.invite_code}.png` },
        `Invite QR for ${createdChallenge.name}`,
      );
      if (result === 'failed') showToast({ message: 'Couldn’t save the QR image.', type: 'error' });
    } catch {
      showToast({ message: 'Couldn’t save the QR image.', type: 'error' });
    }
  };

  const copyInviteCode = async () => {
    if (!createdChallenge) return;
    try {
      await navigator.clipboard.writeText(createdChallenge.invite_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      showToast({ message: 'Invite code copied!', type: 'success' });
    } catch {
      showToast({ message: "Couldn't copy. Select the code and copy it manually.", type: 'error' });
    }
  };

  const handleCreate = (payload: CreateChallengeForm) => {
    setCreateError(null);
    createMutation.mutate(payload);
  };

  // QR Scanner effect
  useEffect(() => {
    if (joinTab === 'qr' && showJoinModal) {
      const initScanner = async () => {
        try {
          const canScan = await ensureCameraAccess();
          if (!canScan) {
            clearScanner();
            return;
          }

          if (!scannerRef.current) {
            const { Html5Qrcode } = await import('html5-qrcode');

            scannerRef.current = new Html5Qrcode('qr-scanner');

            await scannerRef.current.start(
              // Prefer the rear camera but fall back to any camera (tablets, emulators).
              { facingMode: 'environment' },
              {
                fps: 10,
                qrbox: { width: 250, height: 250 },
                aspectRatio: 1,
                disableFlip: true,
              },
              (decodedText: string) => {
                handleQRSuccess(decodedText);
              },
              () => {
                // Keep scanning until a valid QR is found.
              },
            );
          }
        } catch (error) {
          console.error('QR Scanner error:', error);
          scannerRef.current = null;
          showToast({ message: 'Couldn’t start the camera. You can type the invite code instead.', type: 'error' });
        }
      };

      initScanner();
    }

    return () => {
      if (!showJoinModal || joinTab !== 'qr') {
        clearScanner();
      }
    };
  }, [joinTab, showJoinModal]);

  // QR Code generation effect (the canvas mounts with the success sheet)
  useEffect(() => {
    if (!createdChallenge) return;
    let cancelled = false;
    const generateQR = async (attempt = 0) => {
      try {
        const canvas = document.getElementById('challenge-qr-canvas') as HTMLCanvasElement | null;
        if (!canvas) {
          if (attempt < 10 && !cancelled) window.setTimeout(() => void generateQR(attempt + 1), 50);
          return;
        }
        const { default: QR } = await import('qrcode');
        await QR.toCanvas(canvas, createdChallenge.invite_code, {
          errorCorrectionLevel: 'H',
          margin: 2,
          width: 220,
          color: {
            dark: '#000000',
            light: '#FFFFFF',
          },
        });
      } catch (error) {
        console.error('QR Code generation error:', error);
      }
    };
    void generateQR();
    return () => {
      cancelled = true;
    };
  }, [createdChallenge]);

  // Deep links: open the join sheet with a code, or the create sheet.
  useEffect(() => {
    const state = location.state as { joinCode?: string; openCreate?: boolean } | null;
    if (state?.joinCode) {
      setInviteCode(state.joinCode);
      setJoinError(null);
      setShowJoinModal(true);
      window.history.replaceState({}, document.title);
    } else if (state?.openCreate) {
      setCreateError(null);
      setCreateSheetKey((k) => k + 1);
      setShowCreateModal(true);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  return (
    <div className="pb-nav">
      <ScreenHeader variant="large" title="Challenges" subtitle="Walk with others. Everyone who reaches the goal shares the pool." />

      <div className="space-y-6 px-5">
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={openCreate} leftIcon={<Plus size={18} className="shrink-0" aria-hidden />} fullWidth>
            Create
          </Button>
          <Button variant="outline" onClick={openJoin} leftIcon={<KeyRound size={18} className="shrink-0" aria-hidden />} fullWidth>
            Join with code
          </Button>
        </div>

        <ListGroup>
          <ListRow
            to="/challenges/lobby"
            leading={<IconTile icon={Compass} tone="brand" />}
            title="Discover public challenges"
            subtitle={
              openInLobby === null
                ? 'Browse challenges open to everyone'
                : openInLobby === 0
                  ? 'No open challenges right now'
                  : `${openInLobby} open to join`
            }
          />
        </ListGroup>

        {myError ? (
          <LoadError resource="your challenges" onRetry={() => refetchMy()} isRetrying={fetchingMy} />
        ) : (
        <ChallengesMineSection
          isLoading={loadingMy}
          tab={tab}
          counts={counts}
          challenges={cards}
          onTabChange={setTab}
          onCreate={openCreate}
          onDiscover={() => navigate('/challenges/lobby')}
        />
        )}
      </div>

      {/* JOIN WITH CODE */}
      <Sheet
        open={showJoinModal}
        onClose={closeJoin}
        dismissible={!joinMutation.isPending}
        title="Join with a code"
        description="Use the 8-character code or QR code from the person who invited you."
        footer={
          <div className="flex gap-3 pb-3">
            <Button variant="outline" size="lg" onClick={closeJoin} disabled={joinMutation.isPending}>
              Cancel
            </Button>
            <Button
              fullWidth
              size="lg"
              onClick={joinTab === 'manual' ? handleJoin : () => void joinWithCode(inviteCode)}
              disabled={inviteCode.length !== 8}
              isLoading={joinMutation.isPending}
              loadingText="Joining…"
            >
              Join challenge
            </Button>
          </div>
        }
      >
        <Segmented
          label="How to enter the code"
          value={joinTab}
          onChange={(v) => {
            setJoinTab(v);
            setJoinError(null);
          }}
          options={[
            { value: 'manual', label: 'Type code' },
            {
              value: 'qr',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <QrCode size={16} aria-hidden /> Scan QR
                </span>
              ),
            },
          ]}
        />

        <div className="mt-5">
          {joinTab === 'manual' ? (
            <>
              <label htmlFor="invite-code" className="label">
                Invite code
              </label>
              <input
                id="invite-code"
                type="text"
                value={inviteCode}
                onChange={(e) => {
                  setInviteCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
                  setJoinError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && inviteCode.length === 8) handleJoin();
                }}
                placeholder="ABCD1234"
                maxLength={8}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-invalid={joinError ? true : undefined}
                aria-describedby="invite-code-help"
                className="input-field h-14 text-center font-mono text-title tracking-[0.3em] placeholder:tracking-[0.3em]"
              />
              <p id="invite-code-help" className="num mt-1.5 text-caption text-text-muted">
                {inviteCode.length}/8 characters
              </p>
            </>
          ) : (
            <>
              <div
                id="qr-scanner"
                className="aspect-square w-full overflow-hidden rounded-card border border-border-light bg-bg-sunken"
                aria-label="Camera viewfinder"
              />
              <p className="mt-2 text-caption text-text-muted">
                {inviteCode ? (
                  <>
                    Code found: <span className="font-mono font-semibold text-text-primary">{inviteCode}</span>
                  </>
                ) : (
                  'Point your camera at the challenge QR code.'
                )}
              </p>
            </>
          )}
        </div>

        {joinError && (
          <div className="mt-4 flex items-start gap-3 rounded-card bg-danger-soft p-4" role="alert">
            <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden />
            <div className="min-w-0">
              <p className="text-callout font-semibold text-danger">Couldn't join</p>
              <p className="mt-0.5 text-caption text-text-secondary">{joinError}</p>
            </div>
          </div>
        )}

        <div className="mt-5 rounded-card bg-bg-sunken p-4">
          <p className="text-callout text-text-secondary">
            Joining deducts the challenge's entry contribution from your wallet straight away.
            {availableBalance !== null && (
              <>
                {' '}
                Available now: <span className="num font-semibold text-text-primary">{formatKES(availableBalance)}</span>.
              </>
            )}
          </p>
        </div>
      </Sheet>

      {/* CREATE */}
      <CreateChallengeSheet
        key={createSheetKey}
        open={showCreateModal}
        onClose={() => {
          if (!createMutation.isPending) setShowCreateModal(false);
        }}
        config={config}
        availableBalance={availableBalance}
        isSubmitting={createMutation.isPending}
        error={createError}
        onSubmit={handleCreate}
        onDeposit={() => navigate('/wallet')}
      />

      {/* CREATED: share invite */}
      <Sheet
        open={showCreated}
        onClose={() => setShowCreated(false)}
        title="Challenge created"
        description={createdChallenge ? `${createdChallenge.name} is live. Share the code so others can join.` : undefined}
        footer={
          <div className="flex gap-3 pb-3">
            <Button variant="outline" size="lg" onClick={() => void downloadQRCode()} leftIcon={<Download size={18} aria-hidden />}>
              Save QR
            </Button>
            <Button
              fullWidth
              size="lg"
              onClick={() => {
                const id = createdChallenge?.id;
                setShowCreated(false);
                if (id) navigate(`/challenges/${id}`);
              }}
            >
              View challenge
            </Button>
          </div>
        }
      >
        {createdChallenge && (
          <div className="flex flex-col items-center">
            <div className="rounded-card border border-border-light bg-bg-card p-3">
              <canvas id="challenge-qr-canvas" className="block h-[220px] w-[220px]" aria-label={`QR code for invite code ${createdChallenge.invite_code}`} role="img" />
            </div>
            <p className="eyebrow mt-5">Invite code</p>
            <p className="mt-1 font-mono text-title tracking-[0.25em] text-text-primary">{createdChallenge.invite_code}</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => void copyInviteCode()}
              leftIcon={<Copy size={14} aria-hidden />}
              isSuccess={copied}
              successText="Copied"
            >
              Copy code
            </Button>
            <p className="mt-5 text-center text-caption text-text-muted">
              Your entry of <span className="num font-semibold text-text-secondary">{formatKES(createdChallenge.entry_fee)}</span> is in the pool.
            </p>
          </div>
        )}
      </Sheet>
    </div>
  );
}
