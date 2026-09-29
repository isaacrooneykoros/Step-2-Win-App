import { CarFront, CheckCircle2, Footprints, Route, Smartphone, type LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Sheet } from '../ui/Sheet';
import Button from '../ui/Button';
import { IconTile } from '../ui/Pill';

function Point({ icon, title, children }: { icon: LucideIcon; title: string; children: string }) {
  return (
    <li className="flex gap-3">
      <IconTile icon={icon} tone="neutral" size="sm" />
      <div className="min-w-0">
        <p className="text-callout font-semibold text-text-primary">{title}</p>
        <p className="mt-0.5 text-callout text-text-secondary">{children}</p>
      </div>
    </li>
  );
}

/** Plain-language explainer: what counts toward goals and what counts toward challenges. */
export function HowVerifiedSheet({ open, onClose, showBreakdownLink = false }: { open: boolean; onClose: () => void; showBreakdownLink?: boolean }) {
  const navigate = useNavigate();
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="How steps are verified"
      description="Every step you take counts toward your goals, streaks and XP. Challenges use verified steps, so everyone competes fairly."
      footer={
        <div className="flex flex-col gap-2">
          <Button fullWidth size="lg" leftIcon={<Footprints size={18} aria-hidden />} onClick={() => go('/walk')}>
            Start a walk
          </Button>
          {showBreakdownLink && (
            <Button fullWidth variant="ghost" onClick={() => go('/steps')}>
              See today’s breakdown
            </Button>
          )}
        </div>
      }
    >
      <ul className="space-y-4">
        <Point icon={Smartphone} title="Your phone checks the motion">
          Your phone’s motion sensors check that steps look like walking.
        </Point>
        <Point icon={Route} title="Walks with GPS verify a route">
          When you start a walk in Step2Win, GPS records the route, and those steps count toward challenges.
        </Point>
        <Point icon={CarFront} title="Some steps only count for goals">
          Steps counted in a vehicle or from the phone being shaken don’t count toward challenges, but they still count for your goals.
        </Point>
        <Point icon={CheckCircle2} title="Nothing you need to do">
          Just walk as you normally would. Starting a walk is optional and a simple way to make sure a walk counts.
        </Point>
      </ul>
    </Sheet>
  );
}

export default HowVerifiedSheet;
