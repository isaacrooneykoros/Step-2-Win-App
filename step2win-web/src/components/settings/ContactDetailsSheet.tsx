import { useState } from 'react';
import { Camera, Mail, Phone } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import type { User } from '../../types';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { useProfileUpdate } from './useProfileUpdate';

interface ContactDetailsSheetProps {
  open: boolean;
  onClose: () => void;
  profile: User | undefined;
  /** Switches to the photo editor. */
  onChangePhoto: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ContactDetailsSheet({ open, onClose, profile, onChangePhoto }: ContactDetailsSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Edit profile" description="How we reach you about your account.">
      {/* Sheet unmounts its children when closed, so the form starts fresh on every open. */}
      <ContactForm profile={profile} onClose={onClose} onChangePhoto={onChangePhoto} />
    </Sheet>
  );
}

function ContactForm({ profile, onClose, onChangePhoto }: { profile: User | undefined; onClose: () => void; onChangePhoto: () => void }) {
  const [email, setEmail] = useState(profile?.email ?? '');
  const [phone, setPhone] = useState(profile?.phone_number ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const { save, isSaving, saved, error } = useProfileUpdate({ successMessage: 'Contact details saved.', onDone: onClose });

  const submit = () => {
    setFieldError(null);
    if (!email || !EMAIL_RE.test(email.trim())) {
      setFieldError('Enter a valid email address.');
      return;
    }
    save({ email: email.trim(), phone_number: phone.trim() });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className="mb-5 flex items-center gap-3 rounded-card bg-bg-sunken p-3">
        <Avatar name={profile?.username} src={profile?.profile_picture_url} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-semibold text-text-primary">{profile?.username ?? '—'}</p>
          <p className="text-caption text-text-muted">Username can’t be changed</p>
        </div>
        <Button variant="outline" size="sm" className="!h-11 shrink-0" leftIcon={<Camera size={16} aria-hidden />} onClick={onChangePhoto}>
          Photo
        </Button>
      </div>
      <Input
        label="Email address"
        type="email"
        inputMode="email"
        autoComplete="email"
        leading={<Mail size={18} />}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fieldError ?? undefined}
      />
      <Input
        label="Phone number"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        leading={<Phone size={18} />}
        placeholder="2547XXXXXXXX"
        helperText="Pre-filled when you withdraw to M-Pesa."
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
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

export default ContactDetailsSheet;
