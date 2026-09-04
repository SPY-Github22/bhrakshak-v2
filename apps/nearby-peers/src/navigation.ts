/* Pure navigation math for walking to a peer. No DOM, no React — exercised by
   tests/selfcheck.ts. Deliberately no map routing: in a debris field the
   compass arrow + distance + vibration sonar is what gets you there. */

import { bearingDeg, clamp, haversineMeters, rssiToMeters } from "./geo.ts";
import type { PeerInfo } from "./types.ts";

export type GuidanceSector =
  | "ahead" | "slightly-right" | "right" | "behind-right"
  | "behind" | "behind-left" | "left" | "slightly-left";

export interface RelativeBearing {
  /** Degrees to rotate the arrow clockwise from the device's top edge when
      headingKnown; otherwise clockwise from true North. */
  relativeDeg: number;
  sector: GuidanceSector;
  headingKnown: boolean;
}

/** 8 sectors centered on the cardinal diagonals. */
export function sectorFor(deg: number): GuidanceSector {
  const d = ((deg % 360) + 360) % 360;
  if (d < 22.5 || d >= 337.5) return "ahead";
  if (d < 67.5) return "slightly-right";
  if (d < 112.5) return "right";
  if (d < 157.5) return "behind-right";
  if (d < 202.5) return "behind";
  if (d < 247.5) return "behind-left";
  if (d < 292.5) return "left";
  return "slightly-left";
}

export const SECTOR_TEXT: Record<GuidanceSector, string> = {
  "ahead": "Straight ahead",
  "slightly-right": "Slightly right",
  "right": "Turn right",
  "behind-right": "Behind you, right",
  "behind": "Turn around",
  "behind-left": "Behind you, left",
  "left": "Turn left",
  "slightly-left": "Slightly left",
};

/** Arrow rotation for the HUD.
    targetBearing: degrees clockwise from North to the peer (GPS) — may be null
    for RSSI-only BLE peers with no coords.
    deviceHeading: degrees clockwise from North the phone is facing (magnetometer). */
export function relativeBearing(
  targetBearing: number | null,
  deviceHeading: number | null,
): RelativeBearing {
  if (targetBearing == null) return { relativeDeg: 0, sector: "ahead", headingKnown: false };
  if (deviceHeading == null) {
    // No compass: arrow shows absolute bearing, "top of phone = North".
    return { relativeDeg: targetBearing, sector: sectorFor(targetBearing), headingKnown: false };
  }
  const rel = ((targetBearing - deviceHeading) % 360 + 360) % 360;
  return { relativeDeg: rel, sector: sectorFor(rel), headingKnown: true };
}

/** Fresh bearing/distance for a peer, recomputed against the rescuer's
    CURRENT position (the store's values are per-sighting and can be stale). */
export function bearingTo(self: { lat: number; lon: number } | null, peer: PeerInfo): number | null {
  if (self && peer.lat != null && peer.lon != null) return bearingDeg(self, { lat: peer.lat, lon: peer.lon });
  return peer.bearingDeg; // last store-computed value (may be stale — still useful)
}

export function distanceTo(self: { lat: number; lon: number } | null, peer: PeerInfo): number | null {
  if (self && peer.lat != null && peer.lon != null) return haversineMeters(self, { lat: peer.lat, lon: peer.lon });
  return peer.distanceM ?? (peer.rssi != null ? rssiToMeters(peer.rssi) : null);
}

export function guidanceText(rel: RelativeBearing, distanceM: number | null): string {
  const dist = distanceM == null ? "" : ` · ${distanceM < 950 ? `${Math.round(distanceM / 5) * 5} m` : `${(distanceM / 1000).toFixed(1)} km`}`;
  return `${SECTOR_TEXT[rel.sector]}${dist}`;
}

export type Warmth = "unknown" | "colder" | "same" | "warmer";

/** RSSI trend between consecutive advertisements — the "hot/cold" cue when
    the target phone has no GPS fix (buried, indoor). */
export function rssiWarmth(prev: number | null, curr: number | null): Warmth {
  if (prev == null || curr == null) return "unknown";
  if (curr > prev + 2) return "warmer";
  if (curr < prev - 2) return "colder";
  return "same";
}

/** Vibration duration for the sonar pulse — closer = longer/stronger buzz.
    null distance (no fix at all) → 0 (silent). */
export function sonarPulseMs(distanceM: number | null): number {
  if (distanceM == null) return 0;
  return Math.round(clamp(300 - distanceM * 2, 25, 300));
}

/* ---- External map handoff (used only when the peer has GPS coords) ------- */

/** OpenStreetMap pin — works in any browser with a data connection. */
export function osmPinUrl(lat: number, lon: number, zoom = 18): string {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=${zoom}/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

/** Android geo: intent — hands off to the phone's native maps app. */
export function geoIntentUrl(lat: number, lon: number): string {
  return `geo:${lat.toFixed(6)},${lon.toFixed(6)}?q=${lat.toFixed(6)},${lon.toFixed(6)}(${encodeURIComponent("Survivor")})`;
}
