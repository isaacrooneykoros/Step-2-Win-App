import { useEffect, useId, useRef, useState } from 'react';
import { CameraOff } from 'lucide-react';
import { checkCameraPermission, requestCameraPermission } from '../../services/cameraPermissions';
import { openAppSettings } from '../../plugins/appSystem';
import { permissionCopy } from '../../utils/platform';

type Scanner = {
  start: (
    camera: MediaTrackConstraints,
    config: { fps: number; qrbox: { width: number; height: number }; aspectRatio: number; disableFlip: boolean },
    onSuccess: (text: string) => void,
    onError?: (error: unknown) => void,
  ) => Promise<null>;
  stop: () => Promise<void>;
  clear: () => void;
  isScanning: boolean;
};

interface QrScannerViewProps {
  /** Return true when the text was accepted (scanning then stops). */
  onScan: (text: string) => boolean;
  hint?: string;
}

/**
 * Camera viewfinder that reads QR codes. Same library, permission flow and camera
 * settings as the challenge invite scanner (html5-qrcode, loaded on demand; rear camera;
 * 10 fps). The camera is released as soon as a code is accepted or the view unmounts.
 */
export function QrScannerView({ onScan, hint = 'Point your camera at a Step2Win QR code.' }: QrScannerViewProps) {
  const elementId = `qr-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const scannerRef = useRef<Scanner | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const release = () => {
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (!scanner) return;
      const clear = () => {
        try {
          scanner.clear();
        } catch {
          // already cleared
        }
      };
      if (scanner.isScanning) scanner.stop().then(clear).catch(clear);
      else clear();
    };

    const start = async () => {
      try {
        const state = await checkCameraPermission();
        if (state === 'denied') {
          const opened = await openAppSettings();
          if (!cancelled) {
            setProblem(opened ? permissionCopy().openedSettingsFor('Camera') : `Camera is blocked. Allow it in ${permissionCopy().settingsName}, or type the code instead.`);
          }
          return;
        }
        if (state !== 'granted' && !(await requestCameraPermission())) {
          if (!cancelled) setProblem('Camera access is needed to scan. You can type the code instead.');
          return;
        }
        if (cancelled) return;
        const { Html5Qrcode } = await import('html5-qrcode');
        if (cancelled) return;
        const scanner = new Html5Qrcode(elementId) as unknown as Scanner;
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1, disableFlip: true },
          (text) => {
            if (onScanRef.current(text)) release();
          },
          () => {
            // keep scanning until a valid code appears
          },
        );
        if (cancelled) release();
      } catch {
        scannerRef.current = null;
        if (!cancelled) setProblem('Couldn’t start the camera. You can type the code instead.');
      }
    };

    void start();
    return () => {
      cancelled = true;
      release();
    };
  }, [elementId]);

  return (
    <div>
      {problem ? (
        <div className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-card border border-border-light bg-bg-sunken p-6 text-center">
          <CameraOff size={28} className="text-text-muted" aria-hidden />
          <p className="text-callout text-text-secondary">{problem}</p>
        </div>
      ) : (
        <div id={elementId} className="aspect-square w-full overflow-hidden rounded-card border border-border-light bg-bg-sunken" aria-label="Camera viewfinder" />
      )}
      {!problem && <p className="mt-2 text-caption text-text-muted">{hint}</p>}
    </div>
  );
}

export default QrScannerView;
