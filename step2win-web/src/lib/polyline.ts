/** [latitude, longitude] */
export type LatLng = [number, number];

/** Decodes a Google encoded polyline (precision 5). Invalid input yields the points read so far. */
export function decodePolyline(encoded: string | null | undefined): LatLng[] {
  const text = String(encoded || '');
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= text.length) return null;
      byte = text.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < text.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) break;
    lat += dLat;
    lng += dLng;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
