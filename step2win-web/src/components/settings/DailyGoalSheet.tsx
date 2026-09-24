import { useState } from 'react';
import type { User } from '../../types';
import { formatSteps } from '../../lib/format';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { useProfileUpdate } from './useProfileUpdate';

interface DailyGoalSheetProps {
  open: boolean;
  onClose: () => void;
  profile: User | undefined;
}

const PRESETS = [6000, 8000, 10000, 12000, 15000];
const MIN = 1000;
const MAX = 100000;

export function DailyGoalSheet({ open, onClose, profile }: DailyGoalSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Daily step goal" description="Your ring on Home fills as you walk toward this number.">
      <GoalForm profile={profile} onClose={onClose} />
    </Sheet>
  );
}

function GoalForm({ profile, onClose }: { profile: User | undefined; onClose: () => void }) {
  const [value, setValue] = useState(String(profile?.daily_goal || 10000));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const { save, isSaving, saved, error } = useProfileUpdate({ successMessage: 'Daily goal updated.', onDone: onClose });
  const numeric = parseInt(value.replace(/[^\d]/g, ''), 10);

  const submit = () => {
    setFieldError(null);
    if (!Number.isFinite(numeric) || numeric < MIN || numeric > MAX) {
      setFieldError(`Choose a goal between ${formatSteps(MIN)} and ${formatSteps(MAX)} steps.`);
      return;
    }
    save({ daily_goal: numeric });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Suggested goals">
        {PRESETS.map((preset) => {
          const active = numeric === preset;
          return (
            <button
              key={preset}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setValue(String(preset));
                setFieldError(null);
              }}
              className={[
                'num h-11 rounded-full border px-4 text-callout font-semibold',
                active ? 'border-brand bg-brand-soft text-brand' : 'border-border bg-bg-card text-text-secondary hover:bg-bg-input',
              ].join(' ')}
            >
              {formatSteps(preset)}
            </button>
          );
        })}
      </div>
      <Input
        label="Custom goal"
        type="number"
        inputMode="numeric"
        min={MIN}
        max={MAX}
        step={500}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        trailing={<span className="pr-3 text-callout text-text-muted">steps</span>}
        error={fieldError ?? undefined}
        helperText={`Between ${formatSteps(MIN)} and ${formatSteps(MAX)}.`}
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
          Save goal
        </Button>
      </div>
    </form>
  );
}

export default DailyGoalSheet;
