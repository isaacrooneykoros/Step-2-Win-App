import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Share2, MapPin, Flame, Footprints, Timer } from 'lucide-react';
import { stepsService } from '../services/api/steps';
import type { DayDetail, HourlyStep } from '../types';
import { StepsDayMap } from '../components/StepsDayMap';

export default function StepsDayDetailScreen() {
  const { date } = useParams<{ date: string }>();
  const navigate = useNavigate();

  const {
    data,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['steps', 'day', date],
    queryFn: () => stepsService.getDayDetail(date!),
    enabled: !!date,
  });

  // ── Header ──────────────────────────────────────────────────────────────
  const formattedDate = date
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
    : '';

  const handleShare = () => {
    if (!data) return;
    if (navigator.share) {
      navigator.share({
        title: `My steps on ${formattedDate}`,
        text: `I walked ${data.total_steps.toLocaleString()} steps (${data.total_km} km) on ${formattedDate}! 🚶‍♂️ #Step2Win`,
      });
    }
  };

  // ── Loading ──────────────────────────────────────────────────────────────
  if (isLoading)
    return (
      <div className="min-h-screen flex flex-col" style={{ background: '#F8F9FB' }}>
        <DayDetailHeader date={formattedDate} onBack={() => navigate(-1)} onShare={handleShare} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-[#4F9CF9] border-t-transparent animate-spin" />
            <p className="text-[#6B7280] text-sm">Loading your day...</p>
          </div>
        </div>
      </div>
    );

  if (isError || !data)
    return (
      <div className="min-h-screen flex flex-col" style={{ background: '#F8F9FB' }}>
        <DayDetailHeader date={formattedDate} onBack={() => navigate(-1)} onShare={handleShare} />
        <div className="flex-1 flex items-center justify-center px-8">
          <div className="text-center">
            <p className="text-[#111827] font-bold mb-2">No data for this day</p>
            <p className="text-[#6B7280] text-sm">No steps were recorded on {formattedDate}.</p>
          </div>
        </div>
      </div>
    );

  return (
    <div className="min-h-screen pb-10" style={{ background: '#F8F9FB' }}>
      {/* ── Header ── */}
      <DayDetailHeader date={formattedDate} onBack={() => navigate(-1)} onShare={handleShare} />

      {/* ── Goal Banner ── */}
      {data.goal_achieved && (
        <div
          className="mx-4 mb-4 rounded-2xl px-4 py-3 flex items-center gap-3"
          style={{ background: 'linear-gradient(135deg, #34D399 0%, #10B981 100%)' }}
        >
          <span className="text-2xl">🏆</span>
          <div>
            <p className="text-white text-sm font-bold">Daily Goal Achieved!</p>
            <p className="text-green-100 text-xs">
              {data.total_steps.toLocaleString()} / {data.goal.toLocaleString()} steps
            </p>
          </div>
        </div>
      )}

      {/* ── Stat Chips ── */}
      <StatChips data={data} />

      {/* ── Hourly Chart ── */}
      <SectionCard
        title="Hourly Breakdown"
        subtitle={
          data.peak_hour !== null
            ? `Peak at ${formatHour(data.peak_hour)} · ${data.peak_steps.toLocaleString()} steps`
            : 'No activity recorded'
        }
      >
        <HourlyBarChart hourly={data.hourly} peakHour={data.peak_hour} />
      </SectionCard>

      {/* ── Hour-by-Hour List ── */}
      <SectionCard title="Hour by Hour" subtitle="Active hours only">
        <HourList hourly={data.hourly} peakHour={data.peak_hour} />
      </SectionCard>

      {/* ── Location Map ── */}
      <SectionCard
        title="Movement Map"
        subtitle={
          data.waypoints.length > 0
            ? `${data.waypoints.length} GPS points recorded`
            : 'No GPS data for this day'
        }
      >
        {data.waypoints.length > 0 ? <StepsDayMap waypoints={data.waypoints} /> : <NoMapState />}
      </SectionCard>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DayDetailHeader({
  date,
  onBack,
  onShare,
}: {
  date: string;
  onBack: () => void;
  onShare: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 pt-6 pb-4">
      <button
        onClick={onBack}
        className="w-9 h-9 rounded-xl flex items-center justify-center"
        style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}
      >
        <ChevronLeft size={20} color="#111827" />
      </button>
      <div className="text-center">
        <h1 className="text-[#111827] text-base font-bold">{date}</h1>
        <p className="text-[#9CA3AF] text-xs">Step Activity</p>
      </div>
      <button
        onClick={onShare}
        className="w-9 h-9 rounded-xl flex items-center justify-center"
        style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}
      >
        <Share2 size={16} color="#111827" />
      </button>
    </div>
  );
}

function StatChips({ data }: { data: DayDetail }) {
  const chips = [
    {
      icon: <Footprints size={14} />,
      value: data.total_steps.toLocaleString(),
      label: 'steps',
      color: '#4F9CF9',
      tint: '#EFF6FF',
    },
    {
      icon: <MapPin size={14} />,
      value: `${data.total_km}`,
      label: 'km',
      color: '#34D399',
      tint: '#ECFDF5',
    },
    {
      icon: <Flame size={14} />,
      value: data.total_calories.toLocaleString(),
      label: 'kcal',
      color: '#FBBF24',
      tint: '#FFFBEB',
    },
    {
      icon: <Timer size={14} />,
      value: data.active_minutes.toString(),
      label: 'min',
      color: '#A78BFA',
      tint: '#F5F3FF',
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-2 px-4 mb-4">
      {chips.map((chip) => (
        <div
          key={chip.label}
          className="rounded-2xl p-3 flex flex-col items-center gap-1"
          style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}
        >
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: chip.tint, color: chip.color }}
          >
            {chip.icon}
          </div>
          <p className="text-[#111827] text-sm font-bold leading-tight">{chip.value}</p>
          <p className="text-[#9CA3AF] text-xs">{chip.label}</p>
        </div>
      ))}
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="mx-4 mb-4 rounded-2xl overflow-hidden"
      style={{ background: '#FFFFFF', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}
    >
      <div className="px-4 pt-4 pb-3">
        <p className="text-[#111827] text-sm font-bold">{title}</p>
        <p className="text-[#9CA3AF] text-xs mt-0.5">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

// ── Hourly Bar Chart ──────────────────────────────────────────────────────────

function HourlyBarChart({ hourly, peakHour }: { hourly: HourlyStep[]; peakHour: number | null }) {
  // Build a map of hour → steps for all 24 hours
  const stepsByHour: Record<number, number> = {};
  hourly.forEach((h) => {
    stepsByHour[h.hour] = h.steps;
  });
  const maxSteps = Math.max(...hourly.map((h) => h.steps), 1);

  // Show hours 5AM–11PM (hours 5–23) — typical waking hours
  const displayHours = Array.from({ length: 19 }, (_, i) => i + 5);

  const [selectedHour, setSelectedHour] = useState<number | null>(peakHour);
  const selectedSteps = selectedHour !== null ? stepsByHour[selectedHour] || 0 : null;

  return (
    <div className="px-4 pb-4">
      {/* Selected hour tooltip */}
      {selectedHour !== null && (
        <div className="flex items-center gap-2 mb-3 px-1">
          <div className="w-2 h-2 rounded-full" style={{ background: '#4F9CF9' }} />
          <p className="text-[#111827] text-sm font-bold">{formatHour(selectedHour)}</p>
          <p className="text-[#6B7280] text-sm">{(selectedSteps || 0).toLocaleString()} steps</p>
          {selectedHour === peakHour && (
            <span
              className="text-xs font-bold px-2 py-0.5 rounded-full"
              style={{ background: '#EFF6FF', color: '#4F9CF9' }}
            >
              Peak
            </span>
          )}
        </div>
      )}

      {/* Bar chart */}
      <div className="flex items-end gap-0.5 h-28">
        {displayHours.map((hour) => {
          const steps = stepsByHour[hour] || 0;
          const heightPct = steps > 0 ? Math.max(8, (steps / maxSteps) * 100) : 3;
          const isSelected = hour === selectedHour;
          const isPeak = hour === peakHour;
          const hasSteps = steps > 0;

          return (
            <button
              key={hour}
              onClick={() => setSelectedHour(hour)}
              className="flex-1 flex flex-col items-center justify-end gap-0.5 h-full"
              style={{ minWidth: 0 }}
            >
              <div
                className="w-full rounded-t-sm transition-all duration-200"
                style={{
                  height: `${heightPct}%`,
                  background: isSelected
                    ? '#4F9CF9'
                    : isPeak
                      ? '#93C5FD'
                      : hasSteps
                        ? '#BFDBFE'
                        : '#F3F4F6',
                  transform: isSelected ? 'scaleY(1.03)' : 'scaleY(1)',
                  transformOrigin: 'bottom',
                }}
              />
            </button>
          );
        })}
      </div>

      {/* X-axis labels — show every 3 hours */}
      <div className="flex items-end gap-0.5 mt-1">
        {displayHours.map((hour) => (
          <div key={hour} className="flex-1 flex justify-center" style={{ minWidth: 0 }}>
            {hour % 3 === 0 && (
              <span className="text-[#9CA3AF]" style={{ fontSize: '9px' }}>
                {hour === 12 ? '12P' : hour > 12 ? `${hour - 12}P` : `${hour}A`}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Hour-by-Hour List ─────────────────────────────────────────────────────────

function HourList({ hourly, peakHour }: { hourly: HourlyStep[]; peakHour: number | null }) {
  const activeHours = hourly.filter((h) => h.steps > 0).sort((a, b) => a.hour - b.hour);
  const maxSteps = Math.max(...activeHours.map((h) => h.steps), 1);

  if (activeHours.length === 0) {
    return (
      <div className="px-4 pb-4 text-center">
        <p className="text-[#9CA3AF] text-sm">No active hours recorded</p>
      </div>
    );
  }

  return (
    <div className="pb-2">
      {activeHours.map((h, i) => {
        const barWidth = Math.max(4, (h.steps / maxSteps) * 100);
        const isPeak = h.hour === peakHour;

        return (
          <div
            key={h.hour}
            className={`flex items-center gap-3 px-4 py-3 ${
              i < activeHours.length - 1 ? 'border-b border-[#F3F4F6]' : ''
            }`}
          >
            {/* Hour label */}
            <div className="w-10 flex-shrink-0">
              <p className="text-[#6B7280] text-xs font-medium text-right">{formatHour(h.hour)}</p>
            </div>

            {/* Bar */}
            <div className="flex-1 relative h-6 flex items-center">
              <div className="w-full h-2 rounded-full" style={{ background: '#F3F4F6' }}>
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${barWidth}%`,
                    background: isPeak ? '#4F9CF9' : '#BFDBFE',
                  }}
                />
              </div>
            </div>

            {/* Steps + peak badge */}
            <div className="w-24 flex-shrink-0 flex items-center gap-1.5 justify-end">
              <p className="text-[#111827] text-xs font-bold">{h.steps.toLocaleString()}</p>
              {isPeak && (
                <span
                  className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{ background: '#EFF6FF', color: '#4F9CF9' }}
                >
                  peak
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── No Map State ──────────────────────────────────────────────────────────────

function NoMapState() {
  return (
    <div className="px-4 pb-4 pt-2 text-center">
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
        style={{ background: '#EFF6FF' }}
      >
        <MapPin size={20} color="#4F9CF9" />
      </div>
      <p className="text-[#6B7280] text-sm">No location data for this day</p>
      <p className="text-[#9CA3AF] text-xs mt-1">
        Enable location access in settings to track your route
      </p>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatHour(hour: number): string {
  if (hour === 0) return '12AM';
  if (hour === 12) return '12PM';
  if (hour < 12) return `${hour}AM`;
  return `${hour - 12}PM`;
}
