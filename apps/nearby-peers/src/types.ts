/* Shared types for the nearby-peers feature module.
   Kept dependency-free so the core library also runs under Node
   (tests/selfcheck.ts strips types with plain node). */

/** Who a discovered peer is. Roles map 1:1 onto the BLE frame role byte. */
export type PeerRole = "citizen" | "field" | "relay";

/** Which transport produced the most recent sighting. */
export type PeerSource = "wifi" | "ble";

export interface LatLng {
  lat: number;
  lon: number;
}

/** A peer as surfaced to the UI — merged across transports. */
export interface PeerInfo {
  /** Ephemeral hex id (8 hex chars from the BLE frame / announce API). Rotates daily. */
  peerId: string;
  /** User-chosen nickname, e.g. "C-3F7A". Never an account identity. */
  alias: string;
  role: PeerRole;
  /** Transport that delivered the latest sighting. */
  source: PeerSource;
  lat: number | null;
  lon: number | null;
  /** GPS accuracy in meters (0 = unknown). */
  accuracyM: number | null;
  /** BLE only: raw RSSI of the last advertisement. */
  rssi: number | null;
  /** Meters from the local device. GPS haversine when both sides share coords, else RSSI estimate. */
  distanceM: number | null;
  /** Degrees clockwise from true north (0 = due north). */
  bearingDeg: number | null;
  /** Citizen pressed "I need help" — render prominently. */
  needsHelp: boolean;
  /** 0–100, null when unknown. */
  batteryPct: number | null;
  /** Client-clock epoch ms of the latest sighting. */
  lastSeen: number;
  firstSeen: number;
}

/** What a consenting device announces to the rendezvous server. */
export interface AnnouncePayload {
  peer_id: string;
  alias: string;
  role: PeerRole;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  needs_help: boolean;
  battery_pct: number | null;
}

/** One peer in a rendezvous query response. */
export interface QueryResult {
  peer_id: string;
  alias: string;
  role: PeerRole;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  needs_help: boolean;
  battery_pct: number | null;
  age_s: number;
}

/** Observation fed into the PeerStore by any transport. */
export interface PeerSighting {
  peerId: string;
  alias?: string;
  role?: PeerRole;
  lat?: number | null;
  lon?: number | null;
  accuracyM?: number | null;
  rssi?: number | null;
  needsHelp?: boolean;
  batteryPct?: number | null;
  source: PeerSource;
  /** Epoch ms; defaults to Date.now(). */
  lastSeen?: number;
}

/** Transport contract — a new radio (LoRa, Wi-Fi-Direct NSD, …) plugs in here. */
export interface NearbyTransport {
  readonly kind: PeerSource;
  start(): Promise<void> | void;
  stop(): void;
}
