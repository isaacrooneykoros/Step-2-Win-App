import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Share2 } from 'lucide-react';
import QR from 'qrcode';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { canShare, canvasToBlob, shareContent } from '../../lib/share';
import { friendLink } from './socialUtils';

interface FriendCodeCardProps {
  code: string;
  /** What the code opens: a friend request (default) or a team. */
  kind?: 'friend' | 'team';
  title?: string;
}

/** A code, its QR and share / copy actions. The QR carries the invite link. */
export function FriendCodeCard({ code, kind = 'friend', title }: FriendCodeCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const [qrFailed, setQrFailed] = useState(false);
  const payload = kind === 'friend' ? friendLink(code) : code;

  useEffect(() => {
    if (!canvasRef.current) return;
    // Dark on light in both themes so every scanner can read it.
    QR.toCanvas(canvasRef.current, payload, { errorCorrectionLevel: 'M', margin: 2, width: 180, color: { dark: '#000000', light: '#FFFFFF' } }).catch(() =>
      setQrFailed(true),
    );
  }, [payload]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(kind === 'friend' ? payload : code);
      setCopied(true);
      showToast({ message: kind === 'friend' ? 'Invite link copied' : 'Team code copied', type: 'success' });
    } catch {
      showToast({ message: 'Couldn’t copy. Select the code and copy it manually.', type: 'error' });
    }
  };

  const share = async () => {
    const file = canvasRef.current && !qrFailed
      ? await canvasToBlob(canvasRef.current).then((blob) => ({ blob, name: `step2win-${kind}-${code}.png` })).catch(() => undefined)
      : undefined;
    const text =
      kind === 'friend'
        ? `Add me on Step2Win and let's compare steps this week. My friend code is ${code}.`
        : `Join my Step2Win team "${title ?? ''}" with code ${code}.`;
    const result = await shareContent({ title: title ?? 'Step2Win', text, url: kind === 'friend' ? payload : undefined, file, dialogTitle: 'Share invite' });
    if (result === 'copied') showToast({ message: 'Invite copied, paste it to a friend.', type: 'success' });
    if (result === 'failed') showToast({ message: 'Couldn’t open sharing. Copy the code instead.', type: 'error' });
  };

  return (
    <div className="flex flex-col items-center gap-4 rounded-card border border-border-light bg-bg-card p-5 shadow-card">
      {qrFailed ? (
        <p className="py-6 text-callout text-text-muted">QR code unavailable. Share the code instead.</p>
      ) : (
        <canvas ref={canvasRef} className="block h-[180px] w-[180px] rounded-xl" role="img" aria-label={`QR code for ${kind} code ${code}`} />
      )}
      <div className="text-center">
        <p className="eyebrow">{kind === 'friend' ? 'Your friend code' : 'Team code'}</p>
        <output className="num mt-1 block text-title tracking-[0.18em] text-text-primary" aria-label={`Code ${code.split('').join(' ')}`}>
          {code}
        </output>
      </div>
      <div className="grid w-full grid-cols-2 gap-2">
        <Button variant="outline" onClick={copy} leftIcon={copied ? <Check size={16} className="text-success" aria-hidden /> : <Copy size={16} aria-hidden />}>
          {copied ? 'Copied' : kind === 'friend' ? 'Copy link' : 'Copy code'}
        </Button>
        <Button variant={canShare() ? 'primary' : 'secondary'} onClick={() => void share()} leftIcon={<Share2 size={16} aria-hidden />}>
          Share
        </Button>
      </div>
    </div>
  );
}

export default FriendCodeCard;
