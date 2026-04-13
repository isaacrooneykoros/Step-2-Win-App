import { lazy, Suspense, useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Edit3, LogIn, QrCode, Copy, Download, X } from 'lucide-react';
import { challengesService } from '../services/api';
import { useToast } from '../components/ui/Toast';
import { useAuthStore } from '../store/authStore';
import { BaseModal } from '../components/ui/BaseModal';
import { checkCameraPermission, requestCameraPermission } from '../services/cameraPermissions';
import type { Challenge } from '../types';
import { formatKES } from '../utils/currency';

const ChallengesLobbyScreen = lazy(() => import('./ChallengesLobbyScreen'));
const ChallengesMineSection = lazy(() => import('./challenges/ChallengesMineSection'));

type QrScanner = {
  start: (
    cameraIdOrConfig: string | MediaTrackConstraints,
    configuration: { fps: number; qrbox: { width: number; height: number }; aspectRatio: number; disableFlip: boolean },
    onSuccess: (decodedText: string) => void,
    onError?: (error: unknown) => void,
  ) => Promise<null>;
  stop: () => Promise<void>;
  clear: () => void;
};

type Tab = 'Active' | 'Mine' | 'Completed';

export default function ChallengesScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const user = useAuthStore((state) => state.user);
  const [tab, setTab] = useState<'mine' | 'discover'>('mine');
  const [activeTab, setActiveTab] = useState<Tab>('Active');
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [joinTab, setJoinTab] = useState<'manual' | 'qr'>('manual');
  const [inviteCode, setInviteCode] = useState('');
  const [createForm, setCreateForm] = useState({
    name: '',
    milestone: '50000',
    entry_fee: '100',
    max_participants: '20',
    is_public: true,
    duration: '7',
    win_condition: 'proportional',
    theme_emoji: '',
  });
  const [createdChallenge, setCreatedChallenge] = useState<any>(null);
  const scannerRef = useRef<QrScanner | null>(null);

  const { data: myChallenges = [], isLoading: loadingMy } = useQuery({
    queryKey: ['challenges', 'my'],
    queryFn: challengesService.getMyChallenges,
    retry: 1,
  });

  const joinMutation = useMutation({
    mutationFn: (code: string) => challengesService.join({ invite_code: code }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      setShowJoinModal(false);
      setInviteCode('');
      showToast({ message: 'Successfully joined challenge!', type: 'success' });
    },
    onError: (error: any) => {
      showToast({ message: error.response?.data?.error || 'Failed to join challenge', type: 'error' });
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => challengesService.create(data),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      setCreatedChallenge(data);
      setCreateForm({
        name: '',
        milestone: '50000',
        entry_fee: '100',
        max_participants: '20',
        is_public: true,
        duration: '7',
        win_condition: 'proportional',
        theme_emoji: '',
      });
      showToast({ message: 'Challenge created successfully!', type: 'success' });
    },
    onError: (error: any) => {
      console.error('Challenge creation error:', error.response?.data);
      const errorData = error.response?.data;
      let errorMsg = 'Failed to create challenge';
      
      if (errorData?.errors) {
        // DRF validation errors
        const fieldErrors = Object.entries(errorData.errors)
          .map(([field, msgs]: [string, any]) => {
            const message = Array.isArray(msgs) ? msgs[0] : msgs;
            return `${field}: ${message}`;
          })
          .join(', ');
        errorMsg = fieldErrors;
      } else if (errorData?.error) {
        // Custom error message (includes balance check)
        errorMsg = errorData.error;
      }
      
      console.log('Showing error toast:', errorMsg);
      showToast({ message: errorMsg, type: 'error' });
    },
  });

  const getMilestoneMeta = (milestone: number) => {
    if (milestone === 50000) return { 
      name: '50K Steps', 
      bg: '#ECFDF5', 
      color: '#059669'
    };
    if (milestone === 70000) return { 
      name: '70K Steps', 
      bg: '#EFF6FF', 
      color: '#2563EB'
    };
    return { 
      name: '90K Steps', 
      bg: '#F5F3FF', 
      color: '#7C3AED'
    };
  };

  const filteredChallenges =
    activeTab === 'Active'
      ? (Array.isArray(myChallenges) ? myChallenges : []).filter((c: Challenge) => {
          const isActiveOrPending = c.status === 'active' || c.status === 'pending';
          
          // If I'm the creator, only show if there are 2 or more participants
          if (c.creator === user?.id) {
            return isActiveOrPending && c.current_participants >= 2;
          }
          
          // If I joined it (not the creator), show it
          return isActiveOrPending;
        })
      : activeTab === 'Mine'
      ? (Array.isArray(myChallenges) ? myChallenges : []).filter((c: Challenge) => c.status !== 'completed')
      : (Array.isArray(myChallenges) ? myChallenges : []).filter((c: Challenge) => c.status === 'completed');

  const isLoading = loadingMy;
  const mineCount = (Array.isArray(myChallenges) ? myChallenges : []).filter((c: Challenge) => c.status !== 'completed').length;

  const handleJoin = () => {
    if (inviteCode.length === 8) {
      joinMutation.mutate(inviteCode.toUpperCase());
    } else {
      showToast({ message: 'Invite code must be 8 characters', type: 'error' });
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

  const clearScanner = () => {
    if (scannerRef.current) {
      try {
        scannerRef.current.clear();
      } catch (error) {
        console.warn('Error clearing scanner:', error);
      } finally {
        scannerRef.current = null;
      }
    }
  };

  const ensureCameraAccess = async () => {
    try {
      const initial = await checkCameraPermission();
      if (initial === 'granted') return true;

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
    try {
      const result = await joinMutation.mutateAsync(code.toUpperCase());
      clearScanner();
      setShowJoinModal(false);
      setInviteCode('');
      navigate(`/challenges/${result.challenge.id}`);
    } catch {
      // joinMutation already surfaces the error toast
    }
  };

  const downloadQRCode = () => {
    const canvas = document.getElementById('challenge-qr-canvas') as HTMLCanvasElement;
    if (canvas) {
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `challenge-${createdChallenge.invite_code}.png`;
      link.click();
    }
  };

  const copyInviteCode = () => {
    navigator.clipboard.writeText(createdChallenge.invite_code);
    showToast({ message: 'Invite code copied!', type: 'success' });
  };

  const handleCreate = () => {
    createMutation.mutate({
      name: createForm.name,
      milestone: parseInt(createForm.milestone, 10),
      entry_fee: parseFloat(createForm.entry_fee),
      max_participants: parseInt(createForm.max_participants, 10),
      is_public: createForm.is_public,
      duration_days: parseInt(createForm.duration, 10),
      win_condition: createForm.is_public ? 'proportional' : createForm.win_condition,
      theme_emoji: createForm.theme_emoji,
    });
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

            scannerRef.current = new Html5Qrcode(
              'qr-scanner',
            );

            await scannerRef.current.start(
              { facingMode: { exact: 'environment' } },
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
              }
            );
          }
        } catch (error) {
          console.error('QR Scanner error:', error);
          showToast({ message: 'Camera access denied', type: 'error' });
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

  // QR Code generation effect
  useEffect(() => {
    if (createdChallenge) {
      const generateQR = async () => {
        try {
          const canvas = document.getElementById('challenge-qr-canvas') as HTMLCanvasElement;
          if (canvas) {
            const { default: QR } = await import('qrcode');
            await QR.toCanvas(canvas, createdChallenge.invite_code, {
              errorCorrectionLevel: 'H',
              margin: 2,
              width: 260,
              color: {
                dark: '#000000',
                light: '#FFFFFF',
              },
            });
          }
        } catch (error) {
          console.error('QR Code generation error:', error);
        }
      };
      generateQR();
    }
  }, [createdChallenge]);

  useEffect(() => {
    const joinCode = (location.state as { joinCode?: string } | null)?.joinCode;
    if (joinCode) {
      setInviteCode(joinCode);
      setShowJoinModal(true);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  return (
    <div className="screen-enter pb-nav bg-bg-page">
      {/*  HEADER  */}
      <div className="pt-safe px-4 pt-6 pb-4">
        <h1 className="text-text-primary text-2xl font-bold mb-1">Challenges</h1>
        <p className="text-text-muted text-sm">Compete and win prizes</p>
      </div>

      <div className="mx-4 mb-4">
        <div className="flex rounded-2xl p-1 bg-bg-input border border-border-light">
          {[
            { key: 'mine', label: 'My Challenges' },
            { key: 'discover', label: ' Discover' },
          ].map((section) => (
            <button
              key={section.key}
              onClick={() => setTab(section.key as 'mine' | 'discover')}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all"
              style={{
                background: tab === section.key ? 'hsl(var(--bg-elevated))' : 'transparent',
                color: tab === section.key ? 'hsl(var(--text-primary))' : 'hsl(var(--text-muted))',
                boxShadow: tab === section.key ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              {section.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'discover' && (
        <Suspense fallback={<div className="px-4 pb-4"><div className="skeleton h-40 rounded-3xl" /></div>}>
          <ChallengesLobbyScreen embedded />
        </Suspense>
      )}

      {tab === 'mine' && (
        <Suspense fallback={<div className="px-4 pb-4"><div className="skeleton h-40 rounded-3xl" /></div>}>
          <ChallengesMineSection
            isLoading={isLoading}
            activeTab={activeTab}
            mineCount={mineCount}
            filteredChallenges={filteredChallenges}
            onActiveTabChange={setActiveTab}
            onOpenCreateModal={() => setShowCreateModal(true)}
            onOpenActionMenu={() => setShowActionMenu(true)}
            onViewChallenge={(id: number) => navigate(`/challenges/${id}`)}
            getMilestoneMeta={getMilestoneMeta}
          />
        </Suspense>
      )}

      {/*  ACTION MENU MODAL  */}
      <BaseModal open={showActionMenu} onClose={() => setShowActionMenu(false)}>
        <h2 className="text-2xl font-black text-text-primary mb-1">Choose Action</h2>
        <p className="text-sm text-text-muted mb-6">What would you like to do?</p>
        
        <div className="space-y-3">
          {/* Create Challenge Button */}
          <button
            onClick={() => {
              setShowActionMenu(false);
              setShowCreateModal(true);
            }}
            className="w-full flex items-center gap-4 p-4 rounded-2xl bg-tint-blue/50 hover:bg-tint-blue transition-colors active:scale-95"
          >
            <div className="w-12 h-12 rounded-lg bg-accent-blue flex items-center justify-center flex-shrink-0">
              <Edit3 size={20} className="text-white" />
            </div>
            <div className="text-left flex-1">
              <p className="font-bold text-text-primary">Create Challenge</p>
              <p className="text-xs text-text-muted mt-0.5">Start a new competition</p>
            </div>
          </button>

          {/* Join Challenge Button */}
          <button
            onClick={() => {
              setShowActionMenu(false);
              setShowJoinModal(true);
            }}
            className="w-full flex items-center gap-4 p-4 rounded-2xl bg-tint-green/50 hover:bg-tint-green transition-colors active:scale-95"
          >
            <div className="w-12 h-12 rounded-lg bg-accent-green flex items-center justify-center flex-shrink-0">
              <LogIn size={20} className="text-white" />
            </div>
            <div className="text-left flex-1">
              <p className="font-bold text-text-primary">Join Challenge</p>
              <p className="text-xs text-text-muted mt-0.5">Enter invite code</p>
            </div>
          </button>
        </div>
      </BaseModal>

      {/*  JOIN MODAL  */}
      <BaseModal open={showJoinModal} onClose={() => {
        setShowJoinModal(false);
        setJoinTab('manual');
        clearScanner();
      }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-black text-text-primary">Join Challenge</h2>
          <button
            onClick={() => {
              setShowJoinModal(false);
              setJoinTab('manual');
              clearScanner();
            }}
            className="text-text-muted hover:text-text-primary"
          >
            <X size={24} />
          </button>
        </div>

        {/* Join Tabs */}
        <div className="flex gap-2 mb-6 bg-bg-input p-1 rounded-xl">
          <button
            onClick={() => setJoinTab('manual')}
            className={`flex-1 px-4 py-2.5 rounded-lg font-semibold transition-colors ${
              joinTab === 'manual'
                ? 'bg-accent-blue text-white'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Code
          </button>
          <button
            onClick={() => setJoinTab('qr')}
            className={`flex-1 px-4 py-2.5 rounded-lg font-semibold transition-colors flex items-center justify-center gap-1.5 ${
              joinTab === 'qr'
                ? 'bg-accent-blue text-white'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <QrCode size={16} />
            Scan
          </button>
        </div>

        {joinTab === 'manual' ? (
          <>
            <p className="text-sm text-text-muted mb-4">Enter the 8-character invite code</p>
            <input
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="ABCD1234"
              maxLength={8}
              className="input-field w-full mb-6 text-center text-lg font-mono tracking-widest"
            />
            <div className="flex gap-3">
              <button
                onClick={() => setShowJoinModal(false)}
                className="flex-1 btn-secondary py-3 rounded-2xl"
              >
                Cancel
              </button>
              <button
                onClick={handleJoin}
                disabled={inviteCode.length !== 8 || joinMutation.isPending}
                className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40"
              >
                {joinMutation.isPending ? 'Joining...' : 'Join'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-text-muted mb-4">Point your camera at the QR code</p>
            <div id="qr-scanner" className="mb-6 rounded-2xl overflow-hidden bg-black" style={{ height: '300px' }} />
            <div className="flex gap-3">
              <button
                onClick={() => setShowJoinModal(false)}
                className="flex-1 btn-secondary py-3 rounded-2xl"
              >
                Cancel
              </button>
              {inviteCode && (
                <button
                  onClick={() => void joinWithCode(inviteCode)}
                  disabled={joinMutation.isPending}
                  className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40"
                >
                  {joinMutation.isPending ? 'Joining...' : 'Join'}
                </button>
              )}
            </div>
          </>
        )}
      </BaseModal>

      {/*  CREATE SUCCESS MODAL (with QR code)  */}
      {createdChallenge && (
        <BaseModal
          open={true}
          onClose={() => {
            setCreatedChallenge(null);
            setShowCreateModal(false);
          }}
        >
          <div className="text-center">
            <h2 className="text-2xl font-black text-text-primary mb-2">Challenge Created! </h2>
            <p className="text-sm text-text-muted mb-8">{createdChallenge.name}</p>

            {/* QR Code Box */}
            <div className="bg-tint-blue rounded-3xl p-6 mb-6 inline-block">
              <div id="challenge-qr" className="bg-bg-elevated p-3 rounded-xl inline-block border border-border-light">
                <canvas
                  id="challenge-qr-canvas"
                  style={{ display: 'block', margin: '0 auto' }}
                />
              </div>
            </div>

            {/* Invite Code Display */}
            <div className="mb-6 p-4 bg-bg-input rounded-2xl">
              <p className="text-xs text-text-muted mb-2">Invite Code</p>
              <p className="text-2xl font-mono font-bold text-text-primary mb-4">{createdChallenge.invite_code}</p>
              <button
                onClick={copyInviteCode}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-accent-blue text-white rounded-lg font-semibold hover:opacity-90 transition-opacity"
              >
                <Copy size={16} />
                Copy Code
              </button>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3">
              <button
                onClick={downloadQRCode}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-tint-blue text-accent-blue font-semibold hover:opacity-80 transition-opacity"
              >
                <Download size={16} />
                Download
              </button>
              <button
                onClick={() => {
                  setCreatedChallenge(null);
                  setShowCreateModal(false);
                }}
                className="flex-1 btn-primary py-3 rounded-2xl"
              >
                Done
              </button>
            </div>
          </div>
        </BaseModal>
      )}

      {/*  CREATE MODAL  */}
      <BaseModal open={showCreateModal && !createdChallenge} onClose={() => setShowCreateModal(false)}>
        <h2 className="text-2xl font-black text-text-primary mb-2">Create Challenge</h2>
        <p className="text-sm text-text-muted mb-4">Set up a new competition</p>
        
        {/* Balance Display */}
        <div className="mb-6 p-3 rounded-xl bg-tint-blue border border-border-light">
          <p className="text-xs text-text-muted">Available Balance</p>
          <p className="text-lg font-bold text-accent-blue">
            {formatKES(user?.wallet_balance || '0')}
          </p>
        </div>
        
        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-semibold text-text-secondary mb-2">Challenge Name</label>
            <input
              type="text"
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              placeholder="Weekend Warriors"
              className="input-field w-full"
            />
          </div>
          
          <div>
            <label className="block text-sm font-semibold text-text-secondary mb-2">Milestone Goal</label>
            <select
              value={createForm.milestone}
              onChange={(e) => setCreateForm({ ...createForm, milestone: e.target.value })}
              className="input-field w-full"
            >
              <option value="50000">50,000 steps</option>
              <option value="70000">70,000 steps</option>
              <option value="90000">90,000 steps</option>
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold text-text-secondary mb-2">Entry Fee (KSh)</label>
              <input
                type="number"
                value={createForm.entry_fee}
                onChange={(e) => setCreateForm({ ...createForm, entry_fee: e.target.value })}
                className="input-field w-full font-mono"
                min={createForm.is_public ? '100' : '50'}
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-text-secondary mb-2">Max Players</label>
              <input
                type="number"
                value={createForm.max_participants}
                onChange={(e) => setCreateForm({ ...createForm, max_participants: e.target.value })}
                className="input-field w-full font-mono"
                min="2"
              />
            </div>
          </div>

          {/* Visibility Toggle */}
          <div>
            <label className="block text-sm font-semibold text-text-secondary mb-3">Challenge Visibility</label>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 p-3 rounded-xl border-2 cursor-pointer transition-all" 
                style={{
                  borderColor: createForm.is_public ? 'rgb(59, 130, 246)' : 'var(--color-border-light)',
                  backgroundColor: createForm.is_public ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                }}>
                <input
                  type="radio"
                  name="visibility"
                  checked={createForm.is_public}
                  onChange={() => setCreateForm({ ...createForm, is_public: true })}
                  className="w-4 h-4"
                />
                <span className="font-semibold text-text-primary">Public</span>
                <span className="text-xs text-text-muted">Anyone can join</span>
              </label>
              <label className="flex items-center gap-2 p-3 rounded-xl border-2 cursor-pointer transition-all" 
                style={{
                  borderColor: !createForm.is_public ? 'rgb(246, 113, 113)' : 'var(--color-border-light)',
                  backgroundColor: !createForm.is_public ? 'rgba(246, 113, 113, 0.1)' : 'transparent',
                }}>
                <input
                  type="radio"
                  name="visibility"
                  checked={!createForm.is_public}
                  onChange={() => setCreateForm({ ...createForm, is_public: false })}
                  className="w-4 h-4"
                />
                <span className="font-semibold text-text-primary">Private</span>
                <span className="text-xs text-text-muted">Link only</span>
              </label>
            </div>
          </div>

          {/* Duration Selection */}
          <div>
            <label className="block text-sm font-semibold text-text-secondary mb-2">Challenge Duration</label>
            <select
              value={createForm.duration}
              onChange={(e) => setCreateForm({ ...createForm, duration: e.target.value })}
              className="input-field w-full"
            >
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="21">21 days</option>
              <option value="30">30 days</option>
            </select>
          </div>

          {!createForm.is_public && (
            <>
              <div>
                <label className="block text-sm font-semibold text-text-secondary mb-2">Win Condition</label>
                <select
                  value={createForm.win_condition}
                  onChange={(e) => setCreateForm({ ...createForm, win_condition: e.target.value })}
                  className="input-field w-full"
                >
                  <option value="proportional">Proportional Split</option>
                  <option value="winner_takes_all">Winner Takes All</option>
                  <option value="qualification_only">Qualification Only</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-text-secondary mb-2">Theme Emoji</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {['', '', '', ''].map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setCreateForm({ ...createForm, theme_emoji: emoji })}
                      className={`py-2 rounded-xl border-2 text-xl ${createForm.theme_emoji === emoji ? 'border-accent-blue bg-tint-blue' : 'border-border-light'}`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        
        <div className="flex gap-3">
          <button
            onClick={() => setShowCreateModal(false)}
            className="flex-1 btn-secondary py-3 rounded-2xl"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!createForm.name || createMutation.isPending}
            className="flex-1 btn-primary py-3 rounded-2xl disabled:opacity-40"
          >
            {createMutation.isPending ? 'Creating...' : 'Create'}
          </button>
        </div>
      </BaseModal>
    </div>
  );
}


