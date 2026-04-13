import { Footprints, AlertCircle, CheckCircle2, HelpCircle } from 'lucide-react';
import { usePermissionStatus } from '../hooks/usePermissionStatus';

interface Props {
  compact?: boolean;
}

/**
 * Displays current device permission status with visual indicators.
 * Shows green (granted), red (denied), or gray (unavailable/unknown).
 */
export function PermissionStatusIndicator({ compact = true }: Props) {
  const { permissionStatus, isAndroid, requestPermissions, isRequesting } = usePermissionStatus();
  const state = permissionStatus.activityRecognition;

  // Determine indicator styling
  let icon = <HelpCircle size={16} />;
  let bgColor = 'bg-gray-200';
  let textColor = 'text-gray-700';
  let label = 'Unknown';
  let tooltipText = 'Permission status unknown';
  let isGranted = false;
  let isDenied = false;

  switch (state) {
    case 'granted':
      icon = <CheckCircle2 size={16} />;
      bgColor = 'bg-green-100';
      textColor = 'text-green-700';
      label = 'Enabled';
      tooltipText = 'Step tracking is enabled';
      isGranted = true;
      break;
    case 'denied':
      icon = <AlertCircle size={16} />;
      bgColor = 'bg-red-100';
      textColor = 'text-red-700';
      label = 'Disabled';
      tooltipText = 'Step tracking is disabled. Tap to enable in Settings.';
      isDenied = true;
      break;
    case 'prompt':
    case 'prompt-with-rationale':
      icon = <HelpCircle size={16} />;
      bgColor = 'bg-yellow-100';
      textColor = 'text-yellow-700';
      label = 'Not set';
      tooltipText = 'Tap to enable step tracking';
      break;
    case 'unavailable':
      icon = <AlertCircle size={16} />;
      bgColor = 'bg-gray-100';
      textColor = 'text-gray-600';
      label = 'Unavailable';
      tooltipText = 'Step tracking is not available on this device';
      break;
  }

  if (!isAndroid) {
    return null;
  }

  // Compact dot indicator (for header)
  if (compact) {
    return (
      <button
        onClick={() => {
          if (isDenied || state === 'prompt' || state === 'prompt-with-rationale') {
            requestPermissions();
          }
        }}
        disabled={isRequesting || state === 'unavailable'}
        className="group relative"
        title={tooltipText}
      >
        <div
          className={`w-3 h-3 rounded-full ${
            isGranted
              ? 'bg-green-500'
              : isDenied
                ? 'bg-red-500'
                : state === 'unavailable'
                  ? 'bg-gray-400'
                  : 'bg-yellow-500'
          } transition-all`}
        />

        {/* Tooltip on hover */}
        <div
          className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-gray-800 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50"
        >
          {tooltipText}
        </div>
      </button>
    );
  }

  // Full badge (for settings page)
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-xl ${bgColor} ${textColor} transition-colors`}
    >
      <Footprints size={16} />
      {icon}
      <span className="text-sm font-medium">{label}</span>

      {isDenied && (
        <button
          onClick={() => requestPermissions()}
          disabled={isRequesting}
          className="ml-auto text-xs font-semibold underline hover:opacity-75 disabled:opacity-50"
        >
          {isRequesting ? 'Requesting...' : 'Enable'}
        </button>
      )}

      {(state === 'prompt' || state === 'prompt-with-rationale') && (
        <button
          onClick={() => requestPermissions()}
          disabled={isRequesting}
          className="ml-auto text-xs font-semibold underline hover:opacity-75 disabled:opacity-50"
        >
          {isRequesting ? 'Requesting...' : 'Set up'}
        </button>
      )}
    </div>
  );
}

/**
 * Full permission status card for settings/profile pages
 */
export function PermissionStatusCard() {
  const { permissionStatus, isAndroid, requestPermissions, isRequesting, checkPermissions } =
    usePermissionStatus();

  if (!isAndroid) {
    return (
      <div className="card p-4 bg-gray-50 border border-gray-200 rounded-2xl">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
            <AlertCircle size={20} className="text-gray-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-text-primary font-semibold text-sm">Device Permissions</h3>
            <p className="text-text-secondary text-xs mt-1">
              Step tracking is only available on Android devices. Please install the app on an Android phone.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const state = permissionStatus.activityRecognition;
  let bgColor = 'bg-blue-50';
  let borderColor = 'border-blue-200';
  let titleColor = 'text-blue-900';
  let descColor = 'text-blue-700';
  let icon = <Footprints size={24} className="text-blue-600" />;
  let statusLabel = 'Permission Status';
  let statusDesc = '';
  let actionButton = null;

  if (state === 'granted') {
    bgColor = 'bg-green-50';
    borderColor = 'border-green-200';
    titleColor = 'text-green-900';
    descColor = 'text-green-700';
    icon = <CheckCircle2 size={24} className="text-green-600" />;
    statusLabel = 'Step Tracking Enabled ✓';
    statusDesc = 'Your device is ready to track steps. Keep the app running in the background for continuous counting.';
  } else if (state === 'denied') {
    bgColor = 'bg-red-50';
    borderColor = 'border-red-200';
    titleColor = 'text-red-900';
    descColor = 'text-red-700';
    icon = <AlertCircle size={24} className="text-red-600" />;
    statusLabel = 'Step Tracking Disabled';
    statusDesc =
      'To count your steps, you need to enable Activity Recognition permission in your device settings.';
    actionButton = (
      <button
        onClick={() => requestPermissions()}
        disabled={isRequesting}
        className="mt-3 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
      >
        {isRequesting ? 'Requesting...' : 'Enable Permission'}
      </button>
    );
  } else if (state === 'unavailable') {
    bgColor = 'bg-gray-50';
    borderColor = 'border-gray-200';
    titleColor = 'text-gray-900';
    descColor = 'text-gray-700';
    icon = <AlertCircle size={24} className="text-gray-600" />;
    statusLabel = 'Not Available';
    statusDesc = 'Step tracking is not available on this device. This usually means the device does not have a step counter sensor.';
  } else {
    // prompt or unknown
    statusDesc = 'Set up step tracking to start counting your steps.';
    actionButton = (
      <button
        onClick={() => requestPermissions()}
        disabled={isRequesting}
        className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
      >
        {isRequesting ? 'Requesting...' : 'Set Up Step Tracking'}
      </button>
    );
  }

  return (
    <div className={`card p-4 border-2 ${bgColor} ${borderColor} rounded-2xl`}>
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-lg bg-white flex items-center justify-center flex-shrink-0">{icon}</div>
        <div className="flex-1">
          <h3 className={`${titleColor} font-bold text-base`}>{statusLabel}</h3>
          <p className={`${descColor} text-sm mt-1 leading-relaxed`}>{statusDesc}</p>
          {actionButton}
          <button
            onClick={() => checkPermissions(true)}
            className="mt-2 text-xs text-gray-500 hover:text-gray-700 underline"
          >
            Refresh status
          </button>
        </div>
      </div>
    </div>
  );
}
