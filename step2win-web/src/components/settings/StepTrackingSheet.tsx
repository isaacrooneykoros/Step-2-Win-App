import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import { PermissionStatusCard } from '../PermissionStatusIndicator';
import { permissionCopy } from '../../utils/platform';

interface StepTrackingSheetProps {
  open: boolean;
  onClose: () => void;
  permissionStatus: 'unknown' | 'granted' | 'denied' | 'unavailable';
  isConnecting: boolean;
  onConnect: () => void;
}

/** Physical-activity permission and the on-device step sensor connection. */
export function StepTrackingSheet({ open, onClose, permissionStatus, isConnecting, onConnect }: StepTrackingSheetProps) {
  const connected = permissionStatus === 'granted';
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Step tracking"
      description="Steps are measured by your phone’s motion sensor and synced to your account."
    >
      <div className="space-y-4">
        <PermissionStatusCard />
        {permissionStatus !== 'unavailable' && !connected && (
          <div>
            <Button fullWidth onClick={onConnect} isLoading={isConnecting} loadingText="Connecting">
              Connect step sensor
            </Button>
            <p className="mt-2 text-center text-caption text-text-muted">
              {permissionCopy().stepSourceDescription}
            </p>
          </div>
        )}
      </div>
    </Sheet>
  );
}

export default StepTrackingSheet;
