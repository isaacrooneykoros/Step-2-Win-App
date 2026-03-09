import { MapPin, Flame, Zap } from 'lucide-react';

interface Props {
  distance?: number | null;
  calories?: number | null;
  activeMins?: number | null;
}

export function StepStatChips({ distance, calories, activeMins }: Props) {
  const stats = [
    {
      Icon: MapPin,
      value: distance ? `${distance.toFixed(1)} km` : '— km',
      label: 'Distance',
    },
    {
      Icon: Flame,
      value: calories ? `${calories.toLocaleString()} kcal` : '— kcal',
      label: 'Calories',
    },
    {
      Icon: Zap,
      value: activeMins ? `${activeMins} min` : '— min',
      label: 'Active',
    },
  ];

  return (
    <div className="mt-3 w-full overflow-x-auto">
      <div className="flex gap-2 min-w-max pr-1">
        {stats.map(({ Icon, value, label }) => (
          <div
            key={label}
            className="min-w-[100px] bg-bg-input rounded-xl px-2 py-2.5 flex flex-col items-center gap-0.5"
          >
            <Icon className="w-4 h-4 text-text-muted" />
            <span className="text-text-primary text-xs font-bold">{value}</span>
            <span className="text-text-muted text-xs">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
