import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceStepCounter, type PermissionState } from '../plugins/deviceStepCounter';
import { useToast } from '../components/ui/Toast';
import { openAppSettings } from '../plugins/appSystem';
import { hasNativeStepCounter, isIOSApp, permissionCopy } from '../utils/platform';

export interface PermissionStatus {
  activityRecognition: PermissionState;
}

export type PermissionCheckResult = 'granted' | 'denied' | 'unavailable' | 'unknown';

/**
 * Global hook to manage and track device permissions across the app.
 * Provides permission status, request, and grant checking.
 */
export function usePermissionStatus() {
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus>({
    activityRecognition: 'prompt',
  });
  // True in the Android and iOS apps (native step counter); false on the web.
  const [hasStepCounter, setHasStepCounter] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  // False until the first real check returns: the initial 'prompt' is a placeholder, and UI that
  // nags about a missing permission must not flash on every launch before the answer is known.
  const [hasChecked, setHasChecked] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const lastCheckTimeRef = useRef(0);
  const permissionStatusRef = useRef(permissionStatus);
  const { showToast } = useToast();

  useEffect(() => {
    permissionStatusRef.current = permissionStatus;
  }, [permissionStatus]);

  useEffect(() => {
    setHasStepCounter(hasNativeStepCounter());
  }, []);

  const checkPermissions = useCallback(async (skipCache = false) => {
    if (!hasNativeStepCounter()) {
      setHasStepCounter(false);
      setPermissionStatus({ activityRecognition: 'unavailable' });
      setHasChecked(true);
      return { activityRecognition: 'unavailable' };
    }

    setHasStepCounter(true);

    // Skip frequent checks (cache for 5 seconds)
    const now = Date.now();
    if (!skipCache && now - lastCheckTimeRef.current < 5000) {
      return permissionStatusRef.current;
    }

    setIsChecking(true);
    try {
      const status = await DeviceStepCounter.checkPermissions();
      setPermissionStatus(status);
      setHasChecked(true);
      lastCheckTimeRef.current = now;
      return status;
    } catch (error) {
      console.error('Failed to check permissions:', error);
      return { activityRecognition: 'unknown' };
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkPermissions(true);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkPermissions(true);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [checkPermissions]);

  const requestPermissions = useCallback(async () => {
    if (!hasNativeStepCounter()) {
      return { activityRecognition: 'unavailable' };
    }

    setIsRequesting(true);
    try {
      // iOS never shows the Motion & Fitness prompt twice: once denied, only Settings can fix it.
      if (isIOSApp() && permissionStatusRef.current.activityRecognition === 'denied') {
        const opened = await openAppSettings();
        showToast({ message: opened ? permissionCopy().motionOpenedSettingsHint : permissionCopy().motionBlockedHint, type: 'info' });
        return permissionStatusRef.current;
      }
      const status = await DeviceStepCounter.requestPermissions();
      setPermissionStatus(status);
      setHasChecked(true);
      lastCheckTimeRef.current = Date.now();

      // Check result
      if (status.activityRecognition === 'granted') {
        showToast({
          message: 'Step tracking permission granted!',
          type: 'success',
        });
      } else if (status.activityRecognition === 'denied') {
        showToast({
          message: isIOSApp()
            ? 'Step tracking permission denied. Turn on Motion & Fitness in Settings › Step2Win.'
            : 'Step tracking permission denied. You can enable it in Settings → Permissions.',
          type: 'warning',
        });
      }

      return status;
    } catch (error) {
      console.error('Failed to request permissions:', error);
      showToast({
        message: 'Could not request permission. Please try again.',
        type: 'error',
      });
      return { activityRecognition: 'unknown' };
    } finally {
      setIsRequesting(false);
    }
  }, [showToast]);

  const isGranted = useCallback(() => {
    return permissionStatus.activityRecognition === 'granted';
  }, [permissionStatus]);

  const isUnavailable = useCallback(() => {
    return permissionStatus.activityRecognition === 'unavailable';
  }, [permissionStatus]);

  // Get permission state as boolean (for UI)
  const getPermissionState = useCallback(
    (): 'granted' | 'denied' | 'unavailable' => {
      const state = permissionStatus.activityRecognition;
      if (state === 'granted') return 'granted';
      if (state === 'unavailable') return 'unavailable';
      return 'denied';
    },
    [permissionStatus]
  );

  return {
    permissionStatus,
    hasChecked,
    hasStepCounter,
    isChecking,
    isRequesting,
    checkPermissions,
    requestPermissions,
    isGranted,
    isUnavailable,
    getPermissionState,
  };
}

/**
 * Hook for auto-checking permissions when app comes to foreground.
 * Useful for detecting permission changes in system settings.
 */
export function usePermissionCheckOnFocus() {
  const { checkPermissions } = usePermissionStatus();
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setIsVisible(true);
        // Check permissions when app becomes visible
        checkPermissions(true);
      } else {
        setIsVisible(false);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [checkPermissions]);

  return { isVisible };
}
