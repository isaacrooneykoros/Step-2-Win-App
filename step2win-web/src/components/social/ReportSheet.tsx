import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import { TextArea } from '../ui/Input';
import { useToast } from '../ui/Toast';
import { ToggleRow } from '../settings/Switch';
import { apiErrorMessage } from '../settings/apiError';
import { socialService, type ReportReason } from '../../services/api/social';
import { socialKeys } from './socialUtils';

const REASONS: Array<{ value: ReportReason; label: string }> = [
  { value: 'offensive_name', label: 'Offensive name or photo' },
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'spam', label: 'Spam or fake account' },
  { value: 'cheating', label: 'I think they’re not counting real steps' },
  { value: 'other', label: 'Something else' },
];

interface ReportSheetProps {
  open: boolean;
  onClose: () => void;
  target: { type: 'user'; id: number; name: string } | { type: 'team'; id: number; name: string } | null;
}

/** Report a person or team to the Step2Win team. Optional block in the same step. */
export function ReportSheet({ open, onClose, target }: ReportSheetProps) {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(false);

  useEffect(() => {
    if (open) {
      setReason(null);
      setDetails('');
      setAlsoBlock(false);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      socialService.report({
        target_type: target!.type,
        ...(target!.type === 'user' ? { user_id: target!.id, block: alsoBlock } : { team_id: target!.id }),
        reason: reason!,
        details: details.trim() || undefined,
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: socialKeys.all });
      showToast({
        message: res.blocked ? 'Thanks. We’ll review it, and you won’t see each other any more.' : 'Thanks. Our team will review it.',
        type: 'success',
      });
      onClose();
    },
    onError: (error) => showToast({ message: apiErrorMessage(error, 'Couldn’t send the report. Please try again.'), type: 'error' }),
  });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={target ? `Report ${target.name}` : 'Report'}
      description="Reports are private. The person or team isn’t told who reported them."
      footer={
        <Button fullWidth disabled={!reason} isLoading={mutation.isPending} loadingText="Sending…" onClick={() => mutation.mutate()}>
          Send report
        </Button>
      }
    >
      <fieldset>
        <legend className="eyebrow mb-2">What’s wrong?</legend>
        <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light">
          {REASONS.map((r) => (
            <label key={r.value} className="flex min-h-[52px] cursor-pointer items-center gap-3 px-4 text-body text-text-primary">
              <input
                type="radio"
                name="report-reason"
                value={r.value}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
                className="h-5 w-5 accent-[hsl(var(--brand))]"
              />
              {r.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4">
        <TextArea
          label="Anything else we should know? (optional)"
          value={details}
          maxLength={500}
          rows={3}
          onChange={(e) => setDetails(e.target.value)}
        />
      </div>
      {target?.type === 'user' && (
        <div className="overflow-hidden rounded-card border border-border-light">
          <ToggleRow title="Also block them" subtitle="You won’t see each other anywhere in Step2Win" checked={alsoBlock} onChange={setAlsoBlock} />
        </div>
      )}
    </Sheet>
  );
}

export default ReportSheet;
