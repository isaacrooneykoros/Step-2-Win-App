import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Footprints, Smartphone, Apple, PenLine, MapPin, Flame, Zap, AlertTriangle } from 'lucide-react';
import { stepsService } from '../services/api';
import type { HealthRecord, StepsPeriod } from '../types';

// Time filter options
const PERIODS: { key: StepsPeriod; label: string }[] = [
  { key: '1d', label: '1D' },
  { key: '1w', label: '1W' },
  { key: '1m', label: '1M' },
  { key: '3m', label: '3M' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'All' },
];

export default function StepsHistoryScreen() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<StepsPeriod>('1w');

  // Fetch history
  const { data: history, isLoading } = useQuery({
    queryKey: ['health', 'history', period],
    queryFn: () => stepsService.getHistory(period),
  });

  // Group records by date
  const groupedByDate = groupByDate(history || []);

  return (
    <div className="min-h-screen bg-bg-page pb-8">
      {/* ── HEADER ────────────────────── */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <button
          onClick={() => navigate(-1)}
          className="w-9 h-9 rounded-xl bg-bg-input flex items-center justify-center"
        >
          <ChevronLeft size={20} className="text-text-primary" />
        </button>
        <div>
          <h1 className="text-text-primary text-xl font-bold">Steps History</h1>
          <p className="text-text-muted text-xs">All your recorded step logs</p>
        </div>
      </div>

      {/* ── FILTER BAR ────────────────────── */}
      <div className="px-4 mb-4">
        <div className="bg-bg-input rounded-2xl p-1 flex gap-1">
          {PERIODS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all
                ${
                  period === key
                    ? 'bg-white text-text-primary shadow-card'
                    : 'text-text-muted'
                }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── LOADING STATE ────────────────────── */}
      {isLoading && (
        <div className="px-4">
          <div className="card p-4">
            <div className="skeleton h-16 rounded-xl mb-2" />
            <div className="skeleton h-16 rounded-xl mb-2" />
            <div className="skeleton h-16 rounded-xl" />
          </div>
        </div>
      )}

      {/* ── GROUPED HISTORY LIST ────────────────────── */}
      {!isLoading &&
        Object.keys(groupedByDate).length > 0 &&
        Object.entries(groupedByDate).map(([date, records]) => (
          <div key={date} className="mb-4">
            {/* Date header */}
            <div className="flex items-center justify-between px-4 mb-2">
              <span className="text-text-secondary text-sm font-bold">
                {formatDateHeader(date)}
              </span>
              <span className="text-text-muted text-xs">
                {records.reduce((sum, r) => sum + r.steps, 0).toLocaleString()} total
              </span>
            </div>

            {/* Records for this date */}
            <div className="mx-4 card overflow-hidden">
              {records.map((record, i) => {
                const goalForDate = 10000;

                return (
                  <button
                    key={record.id}
                    onClick={() => navigate(`/steps/history/${record.date}`)}
                    className={`w-full flex items-center gap-3 px-4 py-4 text-left
                      active:bg-bg-input transition-colors
                      ${i === records.length - 1 ? 'border-b-0' : 'border-b border-border-light'}`}
                  >
                    {/* Source icon */}
                    <div className="w-10 h-10 rounded-xl bg-tint-blue flex items-center justify-center flex-shrink-0">
                      {record.source === 'google_fit'
                        ? <Smartphone className="w-5 h-5 text-text-muted" />
                        : record.source === 'apple_health'
                          ? <Apple className="w-5 h-5 text-text-muted" />
                          : <PenLine className="w-5 h-5 text-text-muted" />}
                    </div>

                    {/* Main info */}
                    <div className="flex-1 min-w-0">
                      {/* Step count — bold and prominent */}
                      <div className="flex items-baseline gap-1">
                        <span className="text-text-primary text-base font-bold">
                          {record.steps.toLocaleString()}
                        </span>
                        <span className="text-text-muted text-xs">steps</span>
                        {record.is_suspicious && (
                          <span className="text-xs text-amber-500 ml-1 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> flagged
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 mt-0.5">
                        {record.distance_km && (
                          <span className="text-text-muted text-xs flex items-center gap-1">
                            <MapPin className="w-3 h-3" /> {record.distance_km.toFixed(1)} km
                          </span>
                        )}
                        {record.calories_active && (
                          <span className="text-text-muted text-xs flex items-center gap-1">
                            <Flame className="w-3 h-3" /> {record.calories_active} kcal
                          </span>
                        )}
                        {record.active_minutes && (
                          <span className="text-text-muted text-xs flex items-center gap-1">
                            <Zap className="w-3 h-3" /> {record.active_minutes} min
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs font-medium text-accent-blue">
                          {record.steps >= goalForDate
                            ? '✅ Goal reached!'
                            : `${(goalForDate - record.steps).toLocaleString()} steps to goal`}
                        </span>
                        <span className="text-text-muted text-xs">·</span>
                        <span className="text-text-muted text-xs">
                          {new Date(record.synced_at).toLocaleTimeString('en-US', {
                            hour: 'numeric',
                            minute: '2-digit',
                            hour12: true,
                          })}
                        </span>
                      </div>
                    </div>

                    {/* Chevron */}
                    <ChevronRight size={16} className="text-text-muted flex-shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}

      {/* ── EMPTY STATE ────────────────────── */}
      {!isLoading && Object.keys(groupedByDate).length === 0 && (
        <div className="flex flex-col items-center py-20 px-8">
          <div className="w-16 h-16 rounded-3xl bg-tint-blue flex items-center justify-center mb-4">
            <Footprints size={28} className="text-accent-blue" />
          </div>
          <h3 className="text-text-primary font-bold text-lg mb-2">No Steps Yet</h3>
          <p className="text-text-secondary text-sm text-center leading-relaxed">
            Steps are synced automatically once device health permissions are enabled.
          </p>
        </div>
      )}
    </div>
  );
}

// Helper: Group records by date
function groupByDate(records: HealthRecord[]) {
  return records.reduce(
    (groups, record) => {
      const date = record.date;
      if (!groups[date]) groups[date] = [];
      groups[date].push(record);
      return groups;
    },
    {} as Record<string, HealthRecord[]>
  );
}

// Helper: Format date header
function formatDateHeader(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (dateStr === today.toISOString().split('T')[0]) return 'Today';
  if (dateStr === yesterday.toISOString().split('T')[0]) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}
