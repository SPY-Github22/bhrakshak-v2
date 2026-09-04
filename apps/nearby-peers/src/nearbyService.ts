/* NearbyService — orchestrates transports into one live peer list.

   Rescuer (field) side: start() acquires GPS, polls the rendezvous for
   consenting peers within `radiusM`, and duty-cycle scans BLE beacons; every
   sighting lands in a TTL-swept PeerStore that the UI subscribes to.

   Citizen side: the same class announces the device's position every ~20s
   while consent is granted (announce ticks are skipped when consent is off
   or no GPS fix exists), and BLE advertising is delegated to the native
   Android shell. */

import {
  ANNOUNCE_INTERVAL_MS, ANNOUNCE_JITTER_MS, DEFAULT_RADIUS_M, QUERY_INTERVAL_MS, QUERY_JITTER_MS,
  SWEEP_INTERVAL_MS,
} from "./config.ts";
import { getConsent, getNeedsHelp } from "./consent.ts";
import { getAlias, getOrCreatePeerId, rotatePeerId } from "./identity.ts";
import { PeerStore } from "./peerStore.ts";
import { BleTransport, bleScanSupported } from "./transports/bleTransport.ts";
import { RendezvousTransport } from "./transports/rendezvousTransport.ts";
import type { PeerInfo, PeerRole, QueryResult } from "./types.ts";

export interface NearbyServiceOptions {
  role: PeerRole;
  /** Rendezvous base URL, e.g. "http://localhost:8000". null/undefined disables Wi-Fi mode. */
  apiUrl?: string | null;
  getToken?: () => string | null;
  /** Rescuers scan; citizens usually announce only. */
  scan?: boolean;
  radiusM?: number;
  announceIntervalMs?: number;
  queryIntervalMs?: number;
  /** Battery provider hook (e.g. navigator.getBattery). null → omitted from frame/announce. */
  batteryPct?: () => number | null;
  log?: (m: string) => void;
}

export interface NearbyStatus {
  running: boolean;
  peerId: string;
  bleSupported: boolean;
  bleActive: boolean;
  wifiActive: boolean;
  lastAnnounceOk: boolean | null;
  lastAnnounceAt: number | null;
  lastQueryAt: number | null;
  position: { lat: number; lon: number; accuracyM: number | null } | null;
}

export class NearbyService {
  readonly store = new PeerStore();
  private o: Required<Omit<NearbyServiceOptions, "apiUrl" | "getToken" | "batteryPct">> & Pick<NearbyServiceOptions, "apiUrl" | "getToken" | "batteryPct">;
  private wifi: RendezvousTransport | null = null;
  private ble: BleTransport | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private watchId: number | null = null;
  private running = false;
  private seq = Math.floor(Math.random() * 0xffff);
  private pos: { lat: number; lon: number; accuracyM: number | null } | null = null;
  private lastAnnounceOk: boolean | null = null;
  private lastAnnounceAt: number | null = null;
  private lastQueryAt: number | null = null;

  constructor(opts: NearbyServiceOptions) {
    this.o = {
      role: opts.role,
      apiUrl: opts.apiUrl ?? null,
      getToken: opts.getToken ?? (() => null),
      scan: opts.scan ?? opts.role === "field",
      radiusM: opts.radiusM ?? DEFAULT_RADIUS_M,
      announceIntervalMs: opts.announceIntervalMs ?? ANNOUNCE_INTERVAL_MS,
      queryIntervalMs: opts.queryIntervalMs ?? QUERY_INTERVAL_MS,
      batteryPct: opts.batteryPct,
      log: opts.log ?? (() => {}),
    };
    if (this.o.apiUrl) this.wifi = new RendezvousTransport({ apiUrl: this.o.apiUrl, getToken: this.o.getToken!, log: this.o.log });
  }

  get peerId(): string {
    return getOrCreatePeerId();
  }

  get alias(): string {
    return getAlias();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (typeof navigator !== "undefined" && navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (p) => {
          this.pos = { lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: p.coords.accuracy };
          this.store.setSelfPos(this.pos.lat, this.pos.lon);
        },
        (err) => this.o.log(`GPS: ${err.message}`),
        { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
      );
    } else {
      this.o.log("Geolocation unavailable on this device");
    }

    if (this.wifi && this.o.scan) {
      this.loop("query", this.o.queryIntervalMs, QUERY_JITTER_MS, () => this.queryNow());
    }
    if (this.wifi) {
      this.loop("announce", this.o.announceIntervalMs, ANNOUNCE_JITTER_MS, () => this.announceNow());
    }
    if (this.o.scan && bleScanSupported()) {
      this.ble = new BleTransport({
        onFrame: (f, rssi) => {
          this.store.upsert({
            peerId: f.peerId, alias: `C-${f.peerId.slice(0, 4).toUpperCase()}`, role: f.role,
            lat: f.lat, lon: f.lon, accuracyM: f.accuracyM, rssi,
            needsHelp: f.needsHelp, batteryPct: f.batteryPct, source: "ble",
          });
        },
        log: this.o.log,
      });
      this.ble.start().catch((e) => this.o.log((e as Error).message));
    } else if (this.o.scan) {
      this.o.log("BLE scanning unsupported here — Wi-Fi mode only");
    }

    this.schedule("sweep", SWEEP_INTERVAL_MS, 0, () => { this.store.sweep(); });
  }

  stop(): void {
    this.running = false;
    if (this.watchId != null && typeof navigator !== "undefined") {
      navigator.geolocation?.clearWatch(this.watchId);
      this.watchId = null;
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.ble?.stop();
    this.ble = null;
  }

  /** One announce tick — no-ops without consent or a GPS fix. */
  async announceNow(): Promise<boolean> {
    if (!this.wifi || !this.pos) return false;
    if (!getConsent()) { this.lastAnnounceOk = null; return false; } // hard consent gate
    this.seq = (this.seq + 1) & 0xffff;
    const ok = await this.wifi.announce({
      peer_id: this.peerId,
      alias: this.alias,
      role: this.o.role,
      lat: this.pos.lat,
      lon: this.pos.lon,
      accuracy_m: this.pos.accuracyM == null ? null : Math.round(this.pos.accuracyM),
      needs_help: getNeedsHelp(),
      battery_pct: this.o.batteryPct?.() ?? null,
    });
    this.lastAnnounceOk = ok;
    this.lastAnnounceAt = Date.now();
    return ok;
  }

  /** One query tick — brings nearby peers into the store. */
  async queryNow(): Promise<QueryResult[]> {
    if (!this.wifi || !this.pos) return [];
    const results = await this.wifi.query(this.pos.lat, this.pos.lon, this.o.radiusM, this.peerId);
    this.lastQueryAt = Date.now();
    for (const r of results) {
      this.store.upsert({
        peerId: r.peer_id, alias: r.alias, role: r.role, lat: r.lat, lon: r.lon,
        accuracyM: r.accuracy_m, needsHelp: r.needs_help, batteryPct: r.battery_pct, source: "wifi",
      });
    }
    return results;
  }

  /** Consent revoked: stop announcing and ask the server to drop us now. */
  async revokeConsent(): Promise<void> {
    if (this.wifi) await this.wifi.forget(this.peerId);
    rotatePeerId();
  }

  status(): NearbyStatus {
    return {
      running: this.running,
      peerId: this.peerId,
      bleSupported: bleScanSupported(),
      bleActive: !!this.ble,
      wifiActive: !!this.wifi,
      lastAnnounceOk: this.lastAnnounceOk,
      lastAnnounceAt: this.lastAnnounceAt,
      lastQueryAt: this.lastQueryAt,
      position: this.pos,
    };
  }

  onPeers(cb: (peers: PeerInfo[]) => void): () => void {
    return this.store.subscribe(cb);
  }

  private loop(name: string, interval: number, jitter: number, fn: () => Promise<unknown>): void {
    const tick = async () => {
      if (!this.running) return;
      try { await fn(); } catch (e) { this.o.log(`${name}: ${(e as Error).message}`); }
      this.schedule(name, interval, jitter, tick);
    };
    void tick();
  }

  private schedule(_name: string, interval: number, jitter: number, fn: () => void | Promise<void>): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      void fn();
    }, interval + Math.random() * jitter);
    this.timers.add(id);
  }
}

