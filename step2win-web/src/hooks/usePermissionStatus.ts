import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { DeviceStepCounter, type PermissionState } from '../plugins/deviceStepCounter';
import { useToast } from '../components/ui/Toast';

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
  const [isAndroid, setIsAndroid] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const lastCheckTimeRef = useRef(0);
  const permissionStatusRef = useRef(permissionStatus);
  const { showToast } = useToast();

  useEffect(() => {
    permissionStatusRef.current = permissionStatus;
  }, [permissionStatus]);

  useEffect(() => {
    const platform = Capacitor.getPlatform();
    setIsAndroid(platform === 'android');
  }, []);

  const checkPermissions = useCallback(async (skipCache = false) => {
    const platform = Capacitor.getPlatform();
    if (platform !== 'android') {
      setIsAndroid(false);
      setPermissionStatus({ activityRecognition: 'unavailable' });
      return { activityRecognition: 'unavailable' };
    }

    setIsAndroid(true);

    // Skip frequent checks (cache for 5 seconds)
    const now = Date.now();
    if (!skipCache && now - lastCheckTimeRef.current < 5000) {
      return permissionStatusRef.current;
    }

    setIsChecking(true);
    try {
      const status = await DeviceStepCounter.checkPermissions();
      setPermissionStatus(status);
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
    if (Capacitor.getPlatform() !== 'android') {
      return { activityRecognition: 'unavailable' };
    }

    setIsRequesting(true);
    try {
      const status = await DeviceStepCounter.requestPermissions();
      setPermissionStatus(status);
      lastCheckTimeRef.current = Date.now();

      // Check result
      if (status.activityRecognition === 'granted') {
        showToast({
          message: 'Step tracking permission granted!',
          type: 'success',
        });
      } else if (status.activityRecognition === 'denied') {
        showToast({
          message: 'Step tracking permission denied. You can enable it in Settings → Permissions.',
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
  }, [isAndroid, showToast]);

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
    isAndroid,
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
