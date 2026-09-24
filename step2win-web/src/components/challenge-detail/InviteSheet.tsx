import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, Share2 } from 'lucide-react';
import QR from 'qrcode';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { Capacitor } from '@capacitor/core';
import { canShare, canvasToBlob, saveOrShareImage, shareContent } from '../../lib/share';

const isNativePlatform = () => Capacitor.isNativePlatform();

interface InviteSheetProps {
  open: boolean;
  onClose: () => void;
  inviteCode: string;
  challengeName: string;
}

function InviteBody({ inviteCode, challengeName }: { inviteCode: string; challengeName: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const [qrFailed, setQrFailed] = useState(false);
  const shareAvailable = canShare();

  useEffect(() => {
    if (!canvasRef.current) return;
    // QR codes stay dark-on-light in both themes so every scanner can read them.
    QR.toCanvas(canvasRef.current, inviteCode, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 200,
      color: { dark: '#000000', light: '#FFFFFF' },
    }).catch((error: unknown) => {
      console.error('QR code generation error:', error);
      setQrFailed(true);
    });
  }, [inviteCode]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      showToast({ message: 'Invite code copied', type: 'success' });
    } catch {
      showToast({ message: 'Couldn’t copy the code. Select it and copy manually.', type: 'error' });
    }
  };

  const shareCode = async () => {
    // Include the QR image so friends can scan it straight from the chat.
    const file = canvasRef.current && !qrFailed
      ? await canvasToBlob(canvasRef.current).then((blob) => ({ blob, name: `step2win-invite-${inviteCode}.png` })).catch(() => undefined)
      : undefined;
    const result = await shareContent({
      title: challengeName,
      text: `Join my Step2Win challenge "${challengeName}" with invite code ${inviteCode}.`,
      file,
      dialogTitle: 'Share invite',
    });
    if (result === 'copied') showToast({ message: 'Invite copied — paste it to a friend.', type: 'success' });
    if (result === 'failed') showToast({ message: 'Couldn’t open sharing. Copy the code instead.', type: 'error' });
  };

  const downloadQr = async () => {
    if (!canvasRef.current) return;
    try {
      const blob = await canvasToBlob(canvasRef.current);
      const result = await saveOrShareImage({ blob, name: `challenge-${inviteCode}.png` }, `Invite QR for ${challengeName}`);
      if (result === 'failed') showToast({ message: 'Couldn’t save the QR image.', type: 'error' });
      else if (!isNativePlatform()) showToast({ message: 'QR code saved', type: 'success' });
    } catch {
      showToast({ message: 'Couldn’t save the QR image.', type: 'error' });
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow mb-2">Invite code</p>
        <div className="flex items-center gap-2">
          <output
            className="num flex h-14 min-w-0 flex-1 select-all items-center justify-center rounded-control bg-bg-input text-title tracking-[0.2em] text-text-primary"
            aria-label={`Invite code ${inviteCode.split('').join(' ')}`}
          >
            {inviteCode}
          </output>
          <Button
            variant="outline"
            className="h-14 w-14 shrink-0 !px-0"
            onClick={copyCode}
            aria-label={copied ? 'Invite code copied' : 'Copy invite code'}
          >
            {copied ? <Check size={20} className="text-success" aria-hidden /> : <Copy size={20} aria-hidden />}
          </Button>
        </div>
        <p className="mt-2 text-caption text-text-muted">Friends enter this code in the Challenges tab to join.</p>
      </div>

      <div className="flex flex-col items-center gap-3 rounded-card border border-border-light p-4">
        <p className="eyebrow">Or scan</p>
        {qrFailed ? (
          <p className="py-8 text-callout text-text-muted">QR code unavailable — share the code instead.</p>
        ) : (
          <canvas ref={canvasRef} className="block h-[200px] w-[200px] rounded-xl" aria-label={`QR code for invite code ${inviteCode}`} role="img" />
        )}
        {!qrFailed && (
          <Button variant="ghost" size="sm" leftIcon={<Download size={16} aria-hidden />} onClick={() => void downloadQr()}>
            {isNativePlatform() ? 'Save or share QR image' : 'Save QR image'}
          </Button>
        )}
      </div>

      {shareAvailable && (
        <Button fullWidth size="lg" leftIcon={<Share2 size={18} aria-hidden />} onClick={() => void shareCode()}>
          Share invite
        </Button>
      )}
    </div>
  );
}

export function InviteSheet({ open, onClose, inviteCode, challengeName }: InviteSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Invite friends" description="Anyone with the code can join while there are open spots." size="sm">
      <InviteBody inviteCode={inviteCode} challengeName={challengeName} />
    </Sheet>
  );
}

export default InviteSheet;
