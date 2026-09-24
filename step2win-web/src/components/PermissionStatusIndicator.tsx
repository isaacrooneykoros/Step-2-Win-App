import { Footprints, AlertCircle, CheckCircle2, HelpCircle, RefreshCw, type LucideIcon } from 'lucide-react';
import { usePermissionStatus } from '../hooks/usePermissionStatus';
import { IconTile, Pill, type Tone } from './ui/Pill';
import Button from './ui/Button';
import { permissionCopy } from '../utils/platform';

interface Props {
  compact?: boolean;
}

type ActivityState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' | 'unavailable' | string;

interface StatusCopy {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  title: string;
  description: string;
  action?: string;
}

/** Plain-language description of the physical-activity permission. */
function describe(state: ActivityState): StatusCopy {
  switch (state) {
    case 'granted':
      return {
        label: 'Allowed',
        tone: 'success',
        icon: CheckCircle2,
        title: 'Step counting is on',
        description: 'Your phone counts steps in the background and Step2Win syncs them for you.',
      };
    case 'denied':
      return {
        label: 'Blocked',
        tone: 'danger',
        icon: AlertCircle,
        title: 'Step counting is off',
        description: `Step2Win can’t count your steps until you allow ${permissionCopy().motionName}. If nothing happens, allow it in ${permissionCopy().settingsName}.`,
        action: `Allow ${permissionCopy().motionName}`,
      };
    case 'unavailable':
      return {
        label: 'Not available',
        tone: 'neutral',
        icon: AlertCircle,
        title: 'No step sensor found',
        description: 'This phone doesn’t report steps to apps, so Step2Win can’t count them here.',
      };
    default:
      return {
        label: 'Not set',
        tone: 'warning',
        icon: HelpCircle,
        title: 'Set up step counting',
        description: `Allow ${permissionCopy().motionName} so your phone can count steps for challenges.`,
        action: 'Set up step counting',
      };
  }
}

/**
 * Current physical-activity permission. `compact` renders a small status pill (tap to fix);
 * the full variant is a labelled badge with an action. Android and iOS apps only.
 */
export function PermissionStatusIndicator({ compact = true }: Props) {
  const { permissionStatus, hasStepCounter, requestPermissions, isRequesting } = usePermissionStatus();
  const state = permissionStatus.activityRecognition;
  const copy = describe(state);
  const needsAction = Boolean(copy.action);

  if (!hasStepCounter) return null;

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => {
          if (needsAction) void requestPermissions();
        }}
        disabled={isRequesting || !needsAction}
        className="inline-flex min-h-[44px] items-center disabled:cursor-default"
        aria-label={`Step counting: ${copy.label}${needsAction ? '. Tap to allow.' : ''}`}
        title={copy.description}
      >
        <Pill tone={copy.tone} icon={Footprints}>
          {copy.label}
        </Pill>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-control bg-bg-sunken px-3 py-2">
      <IconTile icon={Footprints} tone={copy.tone} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-callout font-semibold text-text-primary">Step counting</p>
        <p className="text-caption text-text-muted">{copy.label}</p>
      </div>
      {needsAction && (
        <Button size="sm" variant="secondary" onClick={() => requestPermissions()} isLoading={isRequesting} loadingText="Asking">
          {state === 'denied' ? 'Allow' : 'Set up'}
        </Button>
      )}
    </div>
  );
}

/**
 * Full physical-activity permission card for Settings.
 */
export function PermissionStatusCard() {
  const { permissionStatus, hasStepCounter, requestPermissions, isRequesting, checkPermissions, isChecking } = usePermissionStatus();

  if (!hasStepCounter) {
    return (
      <div className="flex items-start gap-3 rounded-card bg-bg-sunken p-4">
        <IconTile icon={Footprints} tone="neutral" />
        <div className="min-w-0 flex-1">
          <h3 className="text-callout font-semibold text-text-primary">Step counting needs the Step2Win app</h3>
          <p className="mt-0.5 text-caption text-text-muted">
            Your steps are counted by your phone’s motion sensor. Install Step2Win on your Android phone or iPhone to track them.
          </p>
        </div>
      </div>
    );
  }

  const state = permissionStatus.activityRecognition;
  const copy = describe(state);

  return (
    <div className="rounded-card bg-bg-sunken p-4">
      <div className="flex items-start gap-3">
        <IconTile icon={copy.icon} tone={copy.tone} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-callout font-semibold text-text-primary">{copy.title}</h3>
            <Pill tone={copy.tone}>{copy.label}</Pill>
          </div>
          <p className="mt-1 text-caption leading-relaxed text-text-secondary">{copy.description}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {copy.action && (
          <Button size="md" onClick={() => requestPermissions()} isLoading={isRequesting} loadingText="Asking…" className="flex-1">
            {copy.action}
          </Button>
        )}
        <Button
          size="md"
          variant="ghost"
          onClick={() => checkPermissions(true)}
          disabled={isChecking}
          leftIcon={<RefreshCw size={16} aria-hidden className={isChecking ? 'animate-spin' : ''} />}
        >
          Check again
        </Button>
      </div>
    </div>
  );
}
