import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Trash2 } from 'lucide-react';
import { usersService } from '../../services/api/users';
import type { User } from '../../types';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import { Avatar } from '../ui/Avatar';
import { ImageCropper } from '../ui/ImageCropper';
import { useToast } from '../ui/Toast';
import { apiErrorMessage } from './apiError';

interface ProfilePhotoSheetProps {
  open: boolean;
  onClose: () => void;
  profile: User | undefined;
}

export function ProfilePhotoSheet({ open, onClose, profile }: ProfilePhotoSheetProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [cropSource, setCropSource] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingUrl, setPendingUrl] = useState('');
  const [saved, setSaved] = useState(false);

  // Preview URL for the cropped image; revoked when replaced or on unmount.
  useEffect(() => {
    if (!pendingFile) {
      setPendingUrl('');
      return;
    }
    const url = URL.createObjectURL(pendingFile);
    setPendingUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  const reset = () => {
    setCropSource('');
    setPendingFile(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const upload = useMutation({
    mutationFn: (file: Blob) => usersService.uploadProfilePicture(file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      setSaved(true);
      showToast({ message: 'Profile photo updated.', type: 'success' });
      window.setTimeout(() => {
        setSaved(false);
        close();
      }, 800);
    },
    onError: (error: unknown) => {
      showToast({ message: apiErrorMessage(error, 'We couldn’t upload your photo. Please try again.'), type: 'error' });
    },
  });

  const remove = useMutation({
    mutationFn: () => usersService.deleteProfilePicture(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      reset();
      showToast({ message: 'Profile photo removed.', type: 'success' });
    },
    onError: (error: unknown) => {
      showToast({ message: apiErrorMessage(error, 'We couldn’t remove your photo. Please try again.'), type: 'error' });
    },
  });

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow picking the same file again later.
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast({ message: 'Please choose an image file.', type: 'error' });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast({ message: 'Choose an image smaller than 5 MB.', type: 'error' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setCropSource(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const onCropComplete = (cropped: Blob) => {
    setPendingFile(new File([cropped], 'profile-picture.jpg', { type: 'image/jpeg' }));
    setCropSource('');
  };

  const hasPhoto = Boolean(profile?.profile_picture_url);
  const busy = upload.isPending || remove.isPending;

  return (
    <>
      <Sheet
        open={open}
        onClose={close}
        dismissible={!busy}
        title="Profile photo"
        description="Shown on your profile."
        size="sm"
      >
        <input ref={inputRef} type="file" accept="image/*" onChange={onFileChange} className="hidden" aria-hidden tabIndex={-1} />

        <div className="flex flex-col items-center pb-2 pt-1">
          {pendingUrl ? (
            <img src={pendingUrl} alt="New profile photo preview" className="h-28 w-28 rounded-full object-cover ring-2 ring-brand ring-offset-2 ring-offset-bg-elevated" />
          ) : (
            <Avatar name={profile?.username} src={profile?.profile_picture_url} size="xl" className="!h-28 !w-28 !text-title-lg" />
          )}
          <p className="mt-3 text-caption text-text-muted" aria-live="polite">
            {pendingUrl ? 'Looks good? Save to use this photo.' : hasPhoto ? 'Your current photo' : 'No photo yet — we show your initials.'}
          </p>
        </div>

        <div className="mt-4 space-y-3">
          {pendingFile ? (
            <>
              <Button fullWidth onClick={() => upload.mutate(pendingFile)} isLoading={upload.isPending} loadingText="Uploading" isSuccess={saved} successText="Saved">
                Save photo
              </Button>
              <Button variant="secondary" fullWidth onClick={() => inputRef.current?.click()} disabled={busy}>
                Choose a different photo
              </Button>
            </>
          ) : (
            <Button fullWidth leftIcon={<ImagePlus size={18} aria-hidden />} onClick={() => inputRef.current?.click()} disabled={busy}>
              {hasPhoto ? 'Choose a new photo' : 'Choose a photo'}
            </Button>
          )}
          {hasPhoto && !pendingFile && (
            <Button
              variant="danger-soft"
              fullWidth
              leftIcon={<Trash2 size={18} aria-hidden />}
              onClick={() => remove.mutate()}
              isLoading={remove.isPending}
              loadingText="Removing"
              disabled={upload.isPending}
            >
              Remove photo
            </Button>
          )}
          <p className="text-center text-caption text-text-muted">Any image up to 5 MB. You’ll crop it to a square next.</p>
        </div>
      </Sheet>

      {cropSource && <ImageCropper imageSrc={cropSource} onCropComplete={onCropComplete} onCancel={() => setCropSource('')} aspectRatio={1} />}
    </>
  );
}

export default ProfilePhotoSheet;
