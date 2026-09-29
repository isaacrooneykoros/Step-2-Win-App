import { useMemo } from 'react';
import { Route } from 'lucide-react';
import type { LatLng } from '../../lib/polyline';

interface RouteSvgProps {
  points: LatLng[];
  /** Height in px; the width fills the container. */
  height?: number;
  /** Shown when there are fewer than two points. */
  emptyText?: string;
  className?: string;
  label?: string;
}

const VIEW_W = 320;
const PAD = 18;

/**
 * A walk's route as a plain SVG line (no map tiles: works offline, no data use).
 * Equirectangular projection scaled by cos(latitude), fitted to the box, north up.
 */
export function RouteSvg({ points, height = 200, emptyText = 'Your route appears here once GPS finds you.', className = '', label = 'Walk route' }: RouteSvgProps) {
  const viewH = Math.round((VIEW_W * height) / 320);

  const shape = useMemo(() => {
    const valid = points.filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180);
    if (valid.length < 2) return null;
    const midLat = valid.reduce((sum, p) => sum + p[0], 0) / valid.length;
    const kx = Math.cos((midLat * Math.PI) / 180);
    const xy = valid.map(([lat, lng]) => [lng * kx, -lat] as const);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    xy.forEach(([x, y]) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    });
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = Math.min((VIEW_W - PAD * 2) / spanX, (viewH - PAD * 2) / spanY);
    const offX = (VIEW_W - spanX * scale) / 2;
    const offY = (viewH - spanY * scale) / 2;
    const projected = xy.map(([x, y]) => [offX + (x - minX) * scale, offY + (y - minY) * scale] as const);
    return {
      d: projected.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
      start: projected[0],
      end: projected[projected.length - 1],
    };
  }, [points, viewH]);

  if (!shape) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 rounded-card bg-bg-sunken px-6 text-center ${className}`}
        style={{ height }}
      >
        <Route size={22} className="text-text-muted" aria-hidden />
        <p className="text-caption text-text-muted">{emptyText}</p>
      </div>
    );
  }

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${VIEW_W} ${viewH}`}
      preserveAspectRatio="xMidYMid meet"
      className={`block w-full rounded-card bg-bg-sunken ${className}`}
      style={{ height }}
    >
      <polyline
        points={shape.d}
        fill="none"
        className="stroke-brand"
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={shape.start[0]} cy={shape.start[1]} r={6} className="fill-bg-card stroke-brand" strokeWidth={3} />
      <circle cx={shape.end[0]} cy={shape.end[1]} r={6} className="fill-brand" />
    </svg>
  );
}

export default RouteSvg;
