/* Pure geo math — no DOM, no React. Runs under node type-stripping for tests. */

import { PATH_LOSS_EXPONENT, TX_POWER_AT_1M } from "./config.ts";

const EARTH_RADIUS_M = 6_371_000;
const RAD = Math.PI / 180;

/** Great-circle distance in meters. */
export function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a → b, degrees clockwise from true north, [0, 360). */
export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const φ1 = a.lat * RAD, φ2 = b.lat * RAD;
  const Δλ = (b.lon - a.lon) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const COMPASS = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"] as const;

/** 8-point arrow for a bearing (0 = "straight ahead" ↑ = north). */
export function compassArrow(bearing: number | null): string {
  if (bearing == null || !Number.isFinite(bearing)) return "•";
  return COMPASS[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
}

export function cardinal(bearing: number | null): string {
  if (bearing == null || !Number.isFinite(bearing)) return "—";
  const pts = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return pts[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
}

/** Log-distance path-loss estimate. Phones advertise at wildly different
    power levels — treat this as an order-of-magnitude hint, not a ruler. */
export function rssiToMeters(rssi: number): number {
  return Math.max(1, Math.pow(10, (TX_POWER_AT_1M - rssi) / (10 * PATH_LOSS_EXPONENT)));
}

/** "320 m" / "1.2 km" / "?" */
export function formatDistance(m: number | null): string {
  if (m == null || !Number.isFinite(m) || m < 0) return "?";
  if (m < 950) return `${Math.round(m / 5) * 5} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** "just now" / "12s" / "1m 04s" */
export function formatAge(msAgo: number): string {
  if (msAgo < 4_000) return "just now";
  const s = Math.round(msAgo / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s ago`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
