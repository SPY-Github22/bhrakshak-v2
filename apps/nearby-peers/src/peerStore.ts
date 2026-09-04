/* On-device peer registry. Transports push sightings in; the UI subscribes to
   a live, TTL-swept, distance-sorted snapshot. Pure logic — no DOM APIs — so
   the same class is exercised by tests/selfcheck.ts under plain node. */

import { CLIENT_PEER_TTL_MS } from "./config.ts";
import { bearingDeg, haversineMeters, rssiToMeters } from "./geo.ts";
import type { PeerInfo, PeerRole, PeerSighting } from "./types.ts";

const ROLE_DEFAULTS: Record<PeerRole, string> = { citizen: "citizen", field: "field", relay: "relay" };

export class PeerStore {
  private peers = new Map<string, PeerInfo>();
  private listeners = new Set<(peers: PeerInfo[]) => void>();
  private ttlMs: number;
  private self: { lat: number; lon: number } | null = null;

  constructor(ttlMs: number = CLIENT_PEER_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** The rescuer's own position — distance/bearing are computed against it. */
  setSelfPos(lat: number, lon: number): void {
    this.self = { lat, lon };
  }

  get selfPos(): { lat: number; lon: number } | null {
    return this.self;
  }

  upsert(s: PeerSighting, now: number = Date.now()): PeerInfo {
    const seen = s.lastSeen ?? now;
    const existing = this.peers.get(s.peerId);
    // stale sighting for an already-fresher entry (e.g. slow BLE event)
    if (existing && seen < existing.lastSeen) return existing;

    const lat = s.lat ?? existing?.lat ?? null;
    const lon = s.lon ?? existing?.lon ?? null;
    const rssi = s.rssi ?? existing?.rssi ?? null;

    let distanceM: number | null = null;
    let bearing: number | null = null;
    if (this.self && lat != null && lon != null) {
      distanceM = haversineMeters(this.self, { lat, lon });
      bearing = bearingDeg(this.self, { lat, lon });
    } else if (rssi != null) {
      distanceM = rssiToMeters(rssi);
    }

    const info: PeerInfo = {
      peerId: s.peerId,
      alias: s.alias ?? existing?.alias ?? `C-${s.peerId.slice(0, 4).toUpperCase()}`,
      role: s.role ?? existing?.role ?? "citizen",
      source: s.source,
      lat,
      lon,
      accuracyM: s.accuracyM ?? existing?.accuracyM ?? null,
      rssi,
      distanceM,
      bearingDeg: bearing,
      needsHelp: s.needsHelp ?? existing?.needsHelp ?? false,
      batteryPct: s.batteryPct ?? existing?.batteryPct ?? null,
      lastSeen: seen,
      firstSeen: existing?.firstSeen ?? seen,
    };
    this.peers.set(s.peerId, info);
    this.notify();
    return info;
  }

  forget(peerId: string): void {
    if (this.peers.delete(peerId)) this.notify();
  }

  /** Drop peers silent past the TTL; also prunes stale BLE-only rows when a
      fresher Wi-Fi sighting exists. Returns number removed. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > this.ttlMs) {
        this.peers.delete(id);
        removed++;
      }
    }
    if (removed) this.notify();
    return removed;
  }

  /** Distance-sorted snapshot; peers needing help float to the top. */
  snapshot(): PeerInfo[] {
    return [...this.peers.values()].sort((a, b) => {
      if (a.needsHelp !== b.needsHelp) return a.needsHelp ? -1 : 1;
      const da = a.distanceM ?? Number.POSITIVE_INFINITY;
      const db = b.distanceM ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return b.lastSeen - a.lastSeen;
    });
  }

  count(): number {
    return this.peers.size;
  }

  subscribe(fn: (peers: PeerInfo[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}

/** Normalized role label for badges (guards against unknown wire values). */
export function roleLabel(role: PeerRole | string): string {
  return ROLE_DEFAULTS[role as PeerRole] ?? role;
}
