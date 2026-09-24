import { useState } from 'react';
import { Ruler } from 'lucide-react';
import type { User } from '../../types';
import { formatRelativeTime } from '../../lib/format';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Pill } from '../ui/Pill';
import { useProfileUpdate } from './useProfileUpdate';
import { qualityMeta } from './calibration';

interface BodyCalibrationSheetProps {
  open: boolean;
  onClose: () => void;
  profile: User | undefined;
  /** Opens the two-walk stride wizard. */
  onRunWizard: () => void;
}

export function BodyCalibrationSheet({ open, onClose, profile, onRunWizard }: BodyCalibrationSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Stride & weight"
      description="Used to turn your steps into distance and calories."
    >
      <BodyForm profile={profile} onClose={onClose} onRunWizard={onRunWizard} />
    </Sheet>
  );
}

function BodyForm({ profile, onClose, onRunWizard }: Omit<BodyCalibrationSheetProps, 'open'>) {
  const [stride, setStride] = useState(String(profile?.stride_length_cm || 78));
  const [weight, setWeight] = useState(String(profile?.weight_kg || 70));
  const [strideError, setStrideError] = useState<string | null>(null);
  const [weightError, setWeightError] = useState<string | null>(null);
  const { save, isSaving, saved, error } = useProfileUpdate({ successMessage: 'Stride and weight saved.', onDone: onClose });

  const quality = profile?.calibration_quality ?? null;

  const submit = () => {
    const strideCm = parseFloat(stride);
    const weightKg = parseFloat(weight);
    const strideBad = !Number.isFinite(strideCm) || strideCm < 40 || strideCm > 130;
    const weightBad = !Number.isFinite(weightKg) || weightKg < 30 || weightKg > 220;
    setStrideError(strideBad ? 'Stride must be between 40 and 130 cm.' : null);
    setWeightError(weightBad ? 'Weight must be between 30 and 220 kg.' : null);
    if (strideBad || weightBad) return;
    save({ stride_length_cm: strideCm, weight_kg: weightKg });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className="mb-5 rounded-card bg-bg-sunken p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-callout font-semibold text-text-primary">Measure it instead of guessing</p>
            <p className="mt-0.5 text-caption text-text-muted">
              {profile?.last_calibrated_at
                ? `Last calibrated ${formatRelativeTime(profile.last_calibrated_at)}`
                : 'Two short walks over a measured distance.'}
            </p>
          </div>
          {quality && <Pill tone={qualityMeta[quality].tone}>{qualityMeta[quality].label}</Pill>}
        </div>
        <Button variant="outline" size="md" fullWidth className="mt-3" leftIcon={<Ruler size={16} aria-hidden />} onClick={onRunWizard}>
          Calibrate with a walk
        </Button>
      </div>

      <Input
        label="Stride length"
        type="number"
        inputMode="decimal"
        min={40}
        max={130}
        step={0.5}
        value={stride}
        onChange={(e) => setStride(e.target.value)}
        trailing={<span className="pr-3 text-callout text-text-muted">cm</span>}
        error={strideError ?? undefined}
        helperText="Between 40 and 130 cm."
        className="num"
      />
      <Input
        label="Weight"
        type="number"
        inputMode="decimal"
        min={30}
        max={220}
        step={0.1}
        value={weight}
        onChange={(e) => setWeight(e.target.value)}
        trailing={<span className="pr-3 text-callout text-text-muted">kg</span>}
        error={weightError ?? undefined}
        helperText="Between 30 and 220 kg."
        className="num"
      />
      {error && (
        <p className="mb-3 rounded-control bg-danger-soft px-3 py-2 text-callout text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-3 pt-1">
        <Button variant="secondary" fullWidth onClick={onClose} disabled={isSaving}>
          Cancel
        </Button>
        <Button type="submit" fullWidth isLoading={isSaving} loadingText="Saving" isSuccess={saved} successText="Saved">
          Save
        </Button>
      </div>
    </form>
  );
}

export default BodyCalibrationSheet;
