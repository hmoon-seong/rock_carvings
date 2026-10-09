// Where posting to the shared wall is allowed. Browsing works from anywhere.

export const SITE = {
  name: "반구대 암각화",
  // TODO: verify viewing deck coordinates (반구대 암각화 전망대). Approximate, from public maps.
  lat: 35.6087,
  lon: 129.1774,
  /** Posting is allowed within this distance of the point, in metres. Generous on purpose (GPS drift, the museum path). */
  radiusM: 1500,
};

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
