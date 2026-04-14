import { useEffect, useMemo, useRef, useState } from 'react';
import { LocationWaypoint } from '../types';

interface StepsDayMapProps {
  waypoints: LocationWaypoint[];
  encodedPolyline?: string | null;
}

type RouteSource = 'encoded' | 'waypoints';

type RoutePoint = {
  latitude: number;
  longitude: number;
  hour?: number;
};

export function StepsDayMap({ waypoints, encodedPolyline }: StepsDayMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<any>(null);
  const leafletLibRef = useRef<any>(null);
  const currentMarkerRef = useRef<any>(null);
  const lastLiveLocationRef = useRef<[number, number] | null>(null);
  const lastLiveUpdateAtRef = useRef(0);
  const [currentLocation, setCurrentLocation] = useState<[number, number] | null>(null);

  const { routePoints, source } = useMemo(() => {
    const decoded = decodePolyline(String(encodedPolyline || ''));
    if (decoded.length >= 2) {
      return { routePoints: decoded, source: 'encoded' as RouteSource };
    }

    const fallback = buildStableRoute(waypoints).map((w) => ({
      latitude: w.latitude,
      longitude: w.longitude,
      hour: w.hour,
    }));
    return { routePoints: fallback, source: 'waypoints' as RouteSource };
  }, [encodedPolyline, waypoints]);

  useEffect(() => {
    if (!navigator.geolocation) {
      return;
    }

    const onSuccess = (position: GeolocationPosition) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const accuracy = Number(position.coords.accuracy || 9999);
      const now = Date.now();

      // Ignore low-confidence GPS fixes that cause visible jumps at high zoom.
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || accuracy > 35) {
        return;
      }

      // Throttle marker updates to reduce flicker during pinch/zoom gestures.
      if (now - lastLiveUpdateAtRef.current < 1200) {
        return;
      }

      const previous = lastLiveLocationRef.current;
      if (previous) {
        const distance = haversineMeters(previous[0], previous[1], lat, lng);

        // Ignore micro-jitter movement while standing still.
        if (distance < 2.5) {
          return;
        }

        // Lightweight smoothing to keep the live dot stable when zoomed in.
        const alpha = 0.35;
        const smoothed: [number, number] = [
          previous[0] + (lat - previous[0]) * alpha,
          previous[1] + (lng - previous[1]) * alpha,
        ];
        lastLiveLocationRef.current = smoothed;
        lastLiveUpdateAtRef.current = now;
        setCurrentLocation(smoothed);
        return;
      }

      const initial: [number, number] = [lat, lng];
      lastLiveLocationRef.current = initial;
      lastLiveUpdateAtRef.current = now;
      setCurrentLocation(initial);
    };

    const onError = () => {
      // Ignore geolocation errors here; map still renders historical route.
    };

    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 30000,
    });

    const watchId = navigator.geolocation.watchPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 20000,
    });

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || routePoints.length === 0) return;

    // Dynamically import Leaflet to avoid SSR issues
    import('leaflet').then((L) => {
      leafletLibRef.current = L;

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
        currentMarkerRef.current = null;
      }

      // Calculate map center and bounds
      const lats = routePoints.map((w) => w.latitude);
      const lngs = routePoints.map((w) => w.longitude);
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
      const coords: [number, number][] = routePoints
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
      if (source === 'waypoints') {
        const hourGroups: Record<number, [number, number][]> = {};
        routePoints.forEach((w) => {
          if (typeof w.hour !== 'number') return;
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
      }

      // Fit map to the route bounds with padding
      const bounds = L.latLngBounds(coords);
      map.fitBounds(bounds, { padding: [30, 30] });
    });

    return () => {
      if (leafletRef.current) {
        leafletRef.current.remove();
        leafletRef.current = null;
      }
      currentMarkerRef.current = null;
    };
  }, [routePoints, source]);

  useEffect(() => {
    const map = leafletRef.current;
    const L = leafletLibRef.current;
    if (!map || !L || !currentLocation) {
      return;
    }

    if (!currentMarkerRef.current) {
      const currentIcon = L.divIcon({
        html: `
          <div style="position: relative; width: 14px; height: 14px;">
            <div style="
              position: absolute;
              inset: -8px;
              background: rgba(52, 211, 153, 0.24);
              border-radius: 50%;
            "></div>
            <div style="
              position: absolute;
              inset: 0;
              width: 14px; height: 14px;
              background: #34D399;
              border: 2px solid white;
              border-radius: 50%;
              box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            "></div>
          </div>`,
        className: '',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });

      currentMarkerRef.current = L.marker(currentLocation, { icon: currentIcon })
        .bindTooltip('You are here now', { permanent: false, direction: 'top' })
        .addTo(map);
      return;
    }

    currentMarkerRef.current.setLatLng(currentLocation);
  }, [currentLocation]);

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
          background: 'hsl(var(--bg-elevated) / 0.92)',
          boxShadow: '0 1px 6px rgba(0,0,0,0.12)',
          backdropFilter: 'blur(4px)',
          border: '1px solid hsl(var(--border-default))',
        }}
      >
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#34D399' }} />
          <span className="text-[10px] text-text-secondary font-medium">Start</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#4F9CF9' }} />
          <span className="text-[10px] text-text-secondary font-medium">End</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-8 h-0.5 rounded-full" style={{ background: '#4F9CF9' }} />
          <span className="text-[10px] text-text-secondary font-medium">Route</span>
        </div>
        {currentLocation && (
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#34D399' }} />
            <span className="text-[10px] text-text-secondary font-medium">Now</span>
          </div>
        )}
      </div>
    </div>
  );
}

function buildStableRoute(waypoints: LocationWaypoint[]): LocationWaypoint[] {
  if (waypoints.length <= 2) {
    return waypoints;
  }

  const ordered = waypoints
    .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
    .slice()
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());

  const accurate = ordered.filter((point) => point.accuracy_m <= 70);
  const base = accurate.length >= 2 ? accurate : ordered;

  const deSpiked: LocationWaypoint[] = [];
  for (const point of base) {
    const prev = deSpiked[deSpiked.length - 1];
    if (!prev) {
      deSpiked.push(point);
      continue;
    }

    const dtSeconds = Math.max(1, (new Date(point.recorded_at).getTime() - new Date(prev.recorded_at).getTime()) / 1000);
    const distance = haversineMeters(prev.latitude, prev.longitude, point.latitude, point.longitude);
    const allowedDistance = Math.max(20, dtSeconds * 8 + (prev.accuracy_m + point.accuracy_m));

    if (distance <= allowedDistance) {
      deSpiked.push(point);
    }
  }

  const simplified: LocationWaypoint[] = [];
  for (const point of deSpiked) {
    const prev = simplified[simplified.length - 1];
    if (!prev) {
      simplified.push(point);
      continue;
    }

    const distance = haversineMeters(prev.latitude, prev.longitude, point.latitude, point.longitude);
    if (distance >= 2) {
      simplified.push(point);
    }
  }

  if (simplified.length >= 3) {
    return applyKalmanSmoothing(simplified);
  }

  return base
    .slice()
    .sort((a, b) => a.accuracy_m - b.accuracy_m)
    .slice(0, Math.min(base.length, 12))
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
}

function applyKalmanSmoothing(points: LocationWaypoint[]): LocationWaypoint[] {
  if (points.length < 3) {
    return points;
  }

  let latEstimate = points[0].latitude;
  let lngEstimate = points[0].longitude;
  let latError = 1;
  let lngError = 1;

  const out: LocationWaypoint[] = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    const measurementNoise = Math.max(1, point.accuracy_m) / 30;

    latError += 0.015;
    const latGain = latError / (latError + measurementNoise);
    latEstimate = latEstimate + latGain * (point.latitude - latEstimate);
    latError = (1 - latGain) * latError;

    lngError += 0.015;
    const lngGain = lngError / (lngError + measurementNoise);
    lngEstimate = lngEstimate + lngGain * (point.longitude - lngEstimate);
    lngError = (1 - lngGain) * lngError;

    out.push({
      ...point,
      latitude: latEstimate,
      longitude: lngEstimate,
    });
  }

  return out;
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function decodePolyline(encoded: string): RoutePoint[] {
  if (!encoded || typeof encoded !== 'string') {
    return [];
  }

  const points: RoutePoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      if (index >= encoded.length) {
        return points;
      }
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dLat;

    result = 0;
    shift = 0;
    do {
      if (index >= encoded.length) {
        return points;
      }
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dLng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dLng;

    points.push({
      latitude: lat / 1e5,
      longitude: lng / 1e5,
    });
  }

  return points.filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}
