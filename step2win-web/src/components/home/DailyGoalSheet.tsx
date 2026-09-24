import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sheet } from '../ui/Sheet';
import { Segmented } from '../ui/Segmented';
import Input from '../ui/Input';
import Button from '../ui/Button';
import { usersService } from '../../services/api/users';
import { useAuthStore } from '../../store/authStore';
import { formatSteps } from '../../lib/format';

const PRESETS = [5000, 8000, 10000, 12000, 15000] as const;
const MIN_GOAL = 1000;
const MAX_GOAL = 60000;

type PresetValue = `${(typeof PRESETS)[number]}` | 'custom';

interface DailyGoalSheetProps {
  open: boolean;
  onClose: () => void;
  currentGoal: number;
}

/** Edit the personal daily step goal (separate from challenge milestones). */
export function DailyGoalSheet({ open, onClose, currentGoal }: DailyGoalSheetProps) {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const [value, setValue] = useState(String(currentGoal));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<number>();

  // Reset the form each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setValue(String(currentGoal));
    setError('');
    setSaved(false);
  }, [open]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const parsed = parseInt(value, 10);
  const preset: PresetValue = (PRESETS as readonly number[]).includes(parsed) ? (String(parsed) as PresetValue) : 'custom';
  const unchanged = parsed === currentGoal;

  const save = async () => {
    if (Number.isNaN(parsed) || parsed < MIN_GOAL || parsed > MAX_GOAL) {
      setError(`Enter a goal between ${formatSteps(MIN_GOAL)} and ${formatSteps(MAX_GOAL)} steps.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await usersService.updateDailyGoal(parsed);
      if (user) updateUser({ ...user, daily_goal: parsed });
      queryClient.setQueryData(['profile'], (prev: unknown) =>
        prev && typeof prev === 'object' ? { ...(prev as object), daily_goal: parsed } : prev,
      );
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      setSaved(true);
      closeTimer.current = window.setTimeout(onClose, 900);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Could not update your goal. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dismissible={!saving}
      size="sm"
      title="Daily step goal"
      description="Your personal target for each day. Challenge milestones are tracked separately."
      footer={
        <Button
          fullWidth
          size="lg"
          onClick={save}
          isLoading={saving}
          loadingText="Saving"
          isSuccess={saved}
          successText="Goal updated"
          disabled={!value || (unchanged && !saved)}
        >
          {unchanged ? 'Current goal' : `Set goal to ${Number.isNaN(parsed) ? '—' : formatSteps(parsed)} steps`}
        </Button>
      }
    >
      <Segmented<PresetValue>
        label="Goal presets"
        value={preset}
        onChange={(next) => {
          setError('');
          setSaved(false);
          if (next === 'custom') {
            inputRef.current?.focus();
            return;
          }
          setValue(next);
        }}
        options={[
          ...PRESETS.map((p) => ({ value: String(p) as PresetValue, label: `${p / 1000}K` })),
          { value: 'custom' as PresetValue, label: 'Other' },
        ]}
      />
      <Input
        ref={inputRef}
        containerClassName="mt-5 !mb-1"
        label="Steps per day"
        type="number"
        inputMode="numeric"
        min={MIN_GOAL}
        max={MAX_GOAL}
        step={500}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError('');
          setSaved(false);
        }}
        error={error || undefined}
        helperText={`Between ${formatSteps(MIN_GOAL)} and ${formatSteps(MAX_GOAL)}. Current goal: ${formatSteps(currentGoal)}.`}
        trailing={<span className="pr-3 text-callout text-text-muted">steps</span>}
        className="num"
      />
    </Sheet>
  );
}

export default DailyGoalSheet;
