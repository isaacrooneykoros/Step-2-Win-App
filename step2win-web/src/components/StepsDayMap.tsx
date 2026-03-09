import { useEffect, useRef } from 'react';
import { LocationWaypoint } from '../types';

interface StepsDayMapProps {
  waypoints: LocationWaypoint[];
}

export function StepsDayMap({ waypoints }: StepsDayMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<any>(null);

  useEffect(() => {
    if (!mapRef.current || waypoints.length === 0) return;

    // Dynamically import Leaflet to avoid SSR issues
    import('leaflet').then((L) => {
      // Fix default marker icon paths (Leaflet webpack issue)
      delete (L.Icon.Default.prototype as any)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      });

      // Destroy existing map if re-rendering
      if (leafletRef.current) {
        leafletRef.current.remove();
      }

      // Calculate map center and bounds
      const lats = waypoints.map((w) => w.latitude);
      const lngs = waypoints.map((w) => w.longitude);
      const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
      const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;

      // Initialize map
      const map = L.map(mapRef.current!, {
        center: [centerLat, centerLng],
        zoom: 15,
        zoomControl: false, // hide default zoom — too bulky on mobile
        attributionControl: false, // hide attribution for cleaner look
      });

      leafletRef.current = map;

      // Add OpenStreetMap tiles
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
      }).addTo(map);

      // Build ordered coordinate array for the route polyline
      const coords: [number, number][] = waypoints
        .slice()
        .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime())
        .map((w) => [w.latitude, w.longitude]);

      // Draw the route line — blue, matches app accent color
      L.polyline(coords, {
        color: '#4F9CF9',
        weight: 4,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(map);

      // Start marker (green circle)
      const startIcon = L.divIcon({
        html: `
          <div style="
            width: 14px; height: 14px;
            background: #34D399;
            border: 3px solid white;
            border-radius: 50%;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          "></div>`,
        className: '',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      L.marker(coords[0], { icon: startIcon })
        .bindTooltip('Start', { permanent: false, direction: 'top' })
        .addTo(map);

      // End marker (accent blue pin)
      const endIcon = L.divIcon({
        html: `
          <div style="
            width: 14px; height: 14px;
            background: #4F9CF9;
            border: 3px solid white;
            border-radius: 50%;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          "></div>`,
        className: '',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      L.marker(coords[coords.length - 1], { icon: endIcon })
        .bindTooltip('End', { permanent: false, direction: 'top' })
        .addTo(map);

      // Activity cluster dots — one per active hour
      // Group waypoints by hour and show a subtle dot at each zone's center
      const hourGroups: Record<number, [number, number][]> = {};
      waypoints.forEach((w) => {
        if (!hourGroups[w.hour]) hourGroups[w.hour] = [];
        hourGroups[w.hour].push([w.latitude, w.longitude]);
      });

      Object.entries(hourGroups).forEach(([hour, pts]) => {
        const lat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const lng = pts.reduce((s, p) => s + p[1], 0) / pts.length;

        const zoneIcon = L.divIcon({
          html: `
            <div style="
              width: 8px; height: 8px;
              background: rgba(79,156,249,0.5);
              border: 1.5px solid #4F9CF9;
              border-radius: 50%;
            "></div>`,
          className: '',
          iconSize: [8, 8],
          iconAnchor: [4, 4],
        });
        L.marker([lat, lng], { icon: zoneIcon })
          .bindTooltip(`${formatHourLabel(Number(hour))}`, {
            permanent: false,
            direction: 'top',
          })
          .addTo(map);
      });

      // Fit map to the route bounds with padding
      const bounds = L.latLngBounds(coords);
      map.fitBounds(bounds, { padding: [30, 30] });
    });

    return () => {
      if (leafletRef.current) {
        leafletRef.current.remove();
        leafletRef.current = null;
      }
    };
  }, [waypoints]);

  return (
    <div className="relative">
      {/* Map container */}
      <div
        ref={mapRef}
        style={{
          height: '240px',
          width: '100%',
          borderRadius: '0 0 16px 16px',
          overflow: 'hidden',
        }}
      />

      {/* Legend overlay */}
      <div
        className="absolute bottom-3 left-3 flex items-center gap-3 px-3 py-1.5 rounded-xl"
        style={{
          background: 'rgba(255,255,255,0.92)',
          boxShadow: '0 1px 6px rgba(0,0,0,0.12)',
          backdropFilter: 'blur(4px)',
        }}
      >
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#34D399' }} />
          <span className="text-[10px] text-[#6B7280] font-medium">Start</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#4F9CF9' }} />
          <span className="text-[10px] text-[#6B7280] font-medium">End</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-8 h-0.5 rounded-full" style={{ background: '#4F9CF9' }} />
          <span className="text-[10px] text-[#6B7280] font-medium">Route</span>
        </div>
      </div>
    </div>
  );
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}
