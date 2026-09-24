import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';

/** True while the phone is on mobile data (Android app only). */
export function useCellularConnection(): boolean {
  const [cellular, setCellular] = useState(false);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    Network.getStatus()
      .then((status) => active && setCellular(status.connected && status.connectionType === 'cellular'))
      .catch(() => null);
    const handle = Network.addListener('networkStatusChange', (status) => {
      setCellular(status.connected && status.connectionType === 'cellular');
    });
    return () => {
      active = false;
      handle.then((h) => h.remove()).catch(() => null);
    };
  }, []);

  return cellular;
}
