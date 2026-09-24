import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';

export interface LoginDeviceInfo {
  device_type: 'android' | 'ios' | 'web' | 'unknown';
  device_name: string;
  app_version: string;
}

/** Device details sent with every sign-in, so Settings › Active sessions can list this device. */
export async function getLoginDeviceInfo(): Promise<LoginDeviceInfo> {
  const app_version = import.meta.env.VITE_APP_VERSION || '1.0.0';
  if (!Capacitor.isNativePlatform()) {
    return { device_type: 'web', device_name: 'Web Browser', app_version };
  }
  try {
    const info = await Device.getInfo();
    return {
      device_type: info.platform === 'ios' ? 'ios' : 'android',
      device_name: `${info.manufacturer} ${info.model}`.trim(),
      app_version,
    };
  } catch (e) {
    console.error('Failed to get device info:', e);
    return { device_type: Capacitor.getPlatform() === 'ios' ? 'ios' : 'android', device_name: '', app_version };
  }
}
