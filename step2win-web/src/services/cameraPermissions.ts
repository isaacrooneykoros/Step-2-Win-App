import { AppSystem, isNativeAppShell } from '../plugins/appSystem';

export type CameraPermissionState = 'granted' | 'denied' | 'prompt' | 'unavailable';

function fromNative(state: string): CameraPermissionState {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'prompt';
}

function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

export async function checkCameraPermission(): Promise<CameraPermissionState> {
  // Android / iOS app: the real OS permission (the WebView's Permissions API always says "prompt").
  if (isNativeAppShell()) {
    try {
      return fromNative((await AppSystem.checkCameraPermission()).camera);
    } catch {
      // Older native shell: fall through to the web check.
    }
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unavailable';
  }

  try {
    const permissionsApi = navigator.permissions as PermissionStatusApi | undefined;
    if (permissionsApi?.query) {
      const status = await permissionsApi.query({ name: 'camera' as PermissionName });
      if (status.state === 'granted') return 'granted';
      if (status.state === 'denied') return 'denied';
      return 'prompt';
    }
  } catch {
    // Some Android WebViews do not expose camera in Permissions API.
  }

  return 'prompt';
}

export async function requestCameraPermission(): Promise<boolean> {
  if (isNativeAppShell()) {
    try {
      return (await AppSystem.requestCameraPermission()).camera === 'granted';
    } catch {
      // Fall back to asking through the WebView.
    }
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return false;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    stopStream(stream);
    return true;
  } catch {
    return false;
  }
}

type PermissionStatusApi = {
  query?: (descriptor: PermissionDescriptor) => Promise<PermissionStatus>;
};
