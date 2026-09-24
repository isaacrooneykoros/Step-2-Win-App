import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { hasNativeStepCounter } from '../../utils/platform';
import { Info } from 'lucide-react';
import { authService } from '../../services/api';
import { DeviceStepCounter } from '../../plugins/deviceStepCounter';
import type { User } from '../../types';
import { formatSteps } from '../../lib/format';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Pill } from '../ui/Pill';
import { useToast } from '../ui/Toast';
import { qualityMeta, type CalibrationQuality as Quality } from './calibration';

interface StrideWizardSheetProps {
  open: boolean;
  onClose: () => void;
  connectDevice: (options?: { silent?: boolean }) => Promise<boolean>;
}

/**
 * Two-pass stride calibration: walk a measured distance out and back; the
 * step sensor delta for each pass gives a stride, and the two are averaged.
 */
export function StrideWizardSheet({ open, onClose, connectDevice }: StrideWizardSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Calibrate your stride"
      description="Walk a distance you’ve measured at your normal pace — once out, once back. We count the steps and work out your stride."
    >
      <WizardBody onClose={onClose} connectDevice={connectDevice} />
    </Sheet>
  );
}

function WizardBody({ onClose, connectDevice }: { onClose: () => void; connectDevice: StrideWizardSheetProps['connectDevice'] }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const isAndroid = hasNativeStepCounter(); // Android sensor or iOS Motion & Fitness

  const [distanceM, setDistanceM] = useState(20);
  const [customDistance, setCustomDistance] = useState('20');
  const [running, setRunning] = useState(false);
  const [pass, setPass] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [baselineSteps, setBaselineSteps] = useState<number | null>(null);
  const [currentSteps, setCurrentSteps] = useState(0);
  const [detectedSteps, setDetectedSteps] = useState(0);
  const [passOneStride, setPassOneStride] = useState<number | null>(null);
  const [passTwoStride, setPassTwoStride] = useState<number | null>(null);
  const [estimatedStride, setEstimatedStride] = useState<number | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [variancePct, setVariancePct] = useState<number | null>(null);
  const pollRef = useRef<number | null>(null);

  const saveCalibration = useMutation({
    mutationFn: (data: Partial<User>) => authService.updateProfile(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: () => {
      showToast({ message: 'Your stride was measured but couldn’t be saved yet. Try again when you’re online.', type: 'warning' });
    },
  });

  const stopPolling = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Stop sensor polling when the sheet closes (its body unmounts).
  useEffect(
    () => () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    },
    [],
  );

  const locked = running || passOneStride !== null;

  const onPreset = (value: number) => {
    setDistanceM(value);
    setCustomDistance(String(value));
  };

  const refreshReading = async (baseline?: number) => {
    const reading = await DeviceStepCounter.getTodaySteps();
    const nowSteps = Math.max(0, Math.round(Number(reading.steps) || 0));
    setCurrentSteps(nowSteps);
    const base = baseline ?? baselineSteps ?? nowSteps;
    setDetectedSteps(Math.max(0, nowSteps - base));
    return nowSteps;
  };

  const startPass = async (which: 1 | 2) => {
    if (!isAndroid) {
      showToast({ message: 'Stride calibration needs the Step2Win phone app’s step counter.', type: 'error' });
      return;
    }
    const custom = parseFloat(customDistance);
    const effectiveDistance = Number.isFinite(custom) && custom > 0 ? custom : distanceM;
    if (effectiveDistance < 5 || effectiveDistance > 1000) {
      showToast({ message: 'Use a measured distance between 5 m and 1,000 m.', type: 'error' });
      return;
    }

    setBusy(true);
    try {
      const ok = await connectDevice({ silent: true });
      if (!ok) return;

      const reading = await DeviceStepCounter.getTodaySteps();
      const base = Math.max(0, Math.round(Number(reading.steps) || 0));
      setDistanceM(effectiveDistance);
      setPass(which);
      setBaselineSteps(base);
      setCurrentSteps(base);
      setDetectedSteps(0);

      if (which === 1) {
        setPassOneStride(null);
        setPassTwoStride(null);
        setEstimatedStride(null);
        setQuality(null);
        setVariancePct(null);
      } else {
        setPassTwoStride(null);
      }

      setRunning(true);
      stopPolling();
      pollRef.current = window.setInterval(() => {
        void refreshReading(base);
      }, 1200);
    } catch (error: unknown) {
      showToast({ message: (error as Error)?.message || 'Could not start calibration.', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const finishPass = async () => {
    if (!running) return;
    setBusy(true);
    try {
      const current = await refreshReading();
      const baseline = baselineSteps ?? current;
      const walkedSteps = Math.max(0, current - baseline);

      if (walkedSteps < 12) {
        showToast({ message: 'Too few steps detected. Walk the full distance and try again.', type: 'error' });
        return;
      }

      const rawStride = (distanceM * 100) / walkedSteps;
      const rounded = Number(Math.min(130, Math.max(40, rawStride)).toFixed(1));

      if (pass === 1) {
        setPassOneStride(rounded);
        setRunning(false);
        stopPolling();
        showToast({ message: `Walk out measured: ${rounded} cm. Now turn around for the walk back.`, type: 'info' });
        return;
      }

      const passOne = passOneStride ?? rounded;
      const average = Number(((passOne + rounded) / 2).toFixed(1));
      const variance = Number(((Math.abs(passOne - rounded) / Math.max(average, 0.1)) * 100).toFixed(1));
      const nextQuality: Quality = variance <= 2 ? 'excellent' : variance <= 5 ? 'good' : 'noisy';
      const calibratedAt = new Date().toISOString();

      setPassTwoStride(rounded);
      setEstimatedStride(average);
      setVariancePct(variance);
      setQuality(nextQuality);
      setRunning(false);
      stopPolling();

      saveCalibration.mutate({
        stride_length_cm: average,
        calibration_quality: nextQuality,
        calibration_variance_pct: variance,
        last_calibrated_at: calibratedAt,
      });

      showToast(
        nextQuality === 'noisy'
          ? { message: `Stride set to ${average} cm, but the two walks differed by ${variance}%. Try again for a steadier result.`, type: 'warning' }
          : { message: `Stride set to ${average} cm.`, type: 'success' },
      );
    } catch (error: unknown) {
      showToast({ message: (error as Error)?.message || 'Could not finish calibration.', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const phase: 'ready' | 'walking' | 'return' | 'done' = running
    ? 'walking'
    : passOneStride === null
      ? 'ready'
      : passTwoStride === null
        ? 'return'
        : 'done';

  const stepLabel =
    phase === 'done' ? 'Done' : phase === 'walking' ? `Walk ${pass} of 2 in progress` : phase === 'return' ? 'Walk 2 of 2 · back' : 'Walk 1 of 2 · out';

  return (
    <div className="space-y-5">
      {!isAndroid && (
        <div className="flex gap-3 rounded-control bg-info-soft px-3 py-3 text-callout text-text-primary">
          <Info size={18} className="mt-0.5 shrink-0 text-info" aria-hidden />
          <p>This uses your phone’s step counter, so it only works in the Step2Win app on Android or iPhone.</p>
        </div>
      )}

      <section aria-labelledby="wizard-distance">
        <h3 id="wizard-distance" className="eyebrow mb-2">
          Measured distance
        </h3>
        <div className="mb-3 grid grid-cols-4 gap-2" role="group" aria-label="Distance presets">
          {[10, 20, 50, 100].map((d) => {
            const active = distanceM === d && customDistance === String(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={active}
                onClick={() => onPreset(d)}
                disabled={locked}
                className={[
                  'num h-11 rounded-control border text-callout font-semibold disabled:opacity-50',
                  active ? 'border-brand bg-brand-soft text-brand' : 'border-border bg-bg-card text-text-secondary hover:bg-bg-input',
                ].join(' ')}
              >
                {d} m
              </button>
            );
          })}
        </div>
        <Input
          label="Or enter your own"
          type="number"
          inputMode="decimal"
          min={5}
          max={1000}
          step={1}
          value={customDistance}
          onChange={(e) => setCustomDistance(e.target.value)}
          disabled={locked}
          trailing={<span className="pr-3 text-callout text-text-muted">metres</span>}
          containerClassName="!mb-0"
          className="num"
        />
      </section>

      <section aria-live="polite" className="rounded-card bg-bg-sunken p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="eyebrow">{stepLabel}</p>
          {running && (
            <Pill tone="brand" dot="live">
              Counting
            </Pill>
          )}
        </div>
        <p className="mt-2 text-display leading-none text-text-primary num">{formatSteps(detectedSteps)}</p>
        <p className="mt-1 text-caption text-text-muted">
          steps this walk · sensor total <span className="num">{formatSteps(currentSteps)}</span>
        </p>

        {(passOneStride !== null || passTwoStride !== null) && (
          <dl className="mt-4 divide-y divide-border-light border-t border-border-light text-callout">
            {passOneStride !== null && (
              <div className="flex justify-between py-2">
                <dt className="text-text-secondary">Walk out</dt>
                <dd className="num font-semibold text-text-primary">{passOneStride.toFixed(1)} cm</dd>
              </div>
            )}
            {passTwoStride !== null && (
              <div className="flex justify-between py-2">
                <dt className="text-text-secondary">Walk back</dt>
                <dd className="num font-semibold text-text-primary">{passTwoStride.toFixed(1)} cm</dd>
              </div>
            )}
            {estimatedStride !== null && (
              <div className="flex items-center justify-between py-2">
                <dt className="font-semibold text-text-primary">Your stride (saved)</dt>
                <dd className="num text-headline text-brand">{estimatedStride.toFixed(1)} cm</dd>
              </div>
            )}
          </dl>
        )}

        {quality && variancePct !== null && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Pill tone={qualityMeta[quality].tone}>{qualityMeta[quality].label} accuracy</Pill>
            <span className="text-caption text-text-muted">
              Walks differed by <span className="num">{variancePct}%</span>
              {quality === 'noisy' ? ' — run it again for a steadier result.' : '.'}
            </span>
          </div>
        )}
      </section>

      <div className="flex gap-3">
        <Button variant="secondary" fullWidth onClick={onClose}>
          {phase === 'done' ? 'Done' : 'Close'}
        </Button>
        {phase === 'walking' ? (
          <Button fullWidth onClick={finishPass} isLoading={busy} loadingText="Calculating">
            {pass === 1 ? 'I’ve walked out' : 'I’ve walked back'}
          </Button>
        ) : (
          <Button fullWidth onClick={() => startPass(phase === 'return' ? 2 : 1)} isLoading={busy} loadingText="Preparing">
            {phase === 'return' ? 'Start walk back' : phase === 'done' ? 'Run again' : 'Start walk out'}
          </Button>
        )}
      </div>
    </div>
  );
}

export default StrideWizardSheet;
