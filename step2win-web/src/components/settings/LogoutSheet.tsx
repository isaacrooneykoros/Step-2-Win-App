import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';

interface LogoutSheetProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  username?: string;
}

/** Confirmation before logging out of this device. */
export function LogoutSheet({ open, onClose, onConfirm, username }: LogoutSheetProps) {
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dismissible={!pending}
      size="sm"
      title="Log out?"
      description="You’ll need to sign in again to use Step2Win on this device. Your steps, challenges and wallet stay on your account."
      footer={
        <div className="flex gap-3 pb-3">
          <Button variant="secondary" fullWidth onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" fullWidth onClick={confirm} isLoading={pending} loadingText="Logging out" leftIcon={<LogOut size={18} aria-hidden />}>
            Log out
          </Button>
        </div>
      }
    >
      {username ? <p className="text-callout text-text-secondary">Signed in as <span className="font-semibold text-text-primary">{username}</span></p> : null}
    </Sheet>
  );
}

export default LogoutSheet;
