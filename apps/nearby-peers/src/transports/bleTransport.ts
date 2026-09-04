/* BLE transport (rescuer side): passively scans for the Bhrakshak beacon
   frame (see ../frame.ts) via the Web Bluetooth scanning API.

   Platform reality, documented honestly:
   * Chrome / Edge on Android support `requestLEScan` — full offline discovery.
   * Safari / iOS expose no Web Bluetooth — transport reports unsupported.
   * A *browser* cannot advertise; citizens advertise via the native Android
     shell (android/BhrakshakBeacon.kt in this folder) using the same frame.

   Scans run in a duty cycle (window + rest) to be gentle on battery and to
   respect radio duty-cycle limits. Repeated advertisements from the same
   peer are kept (keepRepeatedDevices) so RSSI/seq refresh live. */

import { BLE_SCAN_REST_MS, BLE_SCAN_WINDOW_MS, NEARBY_MANUFACTURER_ID } from "../config.ts";
import { tryDecodeBeaconFrame, type BeaconPayload } from "../frame.ts";
import type { NearbyTransport } from "../types.ts";

export interface BleTransportOptions {
  onFrame: (p: BeaconPayload, rssi: number | null) => void;
  log?: (m: string) => void;
  scanWindowMs?: number;
  restMs?: number;
}

export function bleScanSupported(): boolean {
  const bt = (navigator as any).bluetooth;
  return typeof bt?.requestLEScan === "function";
}

export class BleTransport implements NearbyTransport {
  readonly kind = "ble" as const;
  private o: BleTransportOptions & { scanWindowMs: number; restMs: number };
  private scan: { stop: () => void | Promise<void> } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private lastSeq = new Map<string, number>();

  constructor(opts: BleTransportOptions) {
    this.o = { scanWindowMs: BLE_SCAN_WINDOW_MS, restMs: BLE_SCAN_REST_MS, ...opts };
  }

  async start(): Promise<void> {
    if (!bleScanSupported()) {
      throw new Error("BLE scanning unavailable — use Chrome/Edge on Android (or the native app)");
    }
    this.stopped = false;
    await this.openWindow();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.scan?.stop(); } catch { /* already stopped */ }
    this.scan = null;
  }

  private async openWindow(): Promise<void> {
    if (this.stopped) return;
    const bt = (navigator as any).bluetooth;
    try {
      this.scan = await bt.requestLEScan({
        acceptAllAdvertisements: true,
        keepRepeatedDevices: true, // we need fresh RSSI/seq per advertisement
      });
      this.onScan = this.onScan.bind(this);
      bt.addEventListener("advertisementreceived", this.onScan);
      this.o.log?.("BLE scan window open");
    } catch (e) {
      this.o.log?.(`BLE scan failed to start: ${(e as Error).message}`);
      return; // do not reschedule on hard failure (permission denied etc.)
    }
    this.timer = setTimeout(() => void this.closeWindow(), this.o.scanWindowMs);
  }

  private async closeWindow(): Promise<void> {
    const bt = (navigator as any).bluetooth;
    try { bt?.removeEventListener?.("advertisementreceived", this.onScan); } catch { /* noop */ }
    try { this.scan?.stop(); } catch { /* noop */ }
    this.scan = null;
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.openWindow(), this.o.restMs);
  }

  private onScan(ev: any): void {
    const md: Map<number, DataView> | undefined = ev.manufacturerData;
    if (!md) return;
    const raw = md.get(NEARBY_MANUFACTURER_ID);
    if (!raw) return;
    const frame = tryDecodeBeaconFrame(raw);
    if (!frame) return;
    // dedupe identical seq repeats within a window
    if (this.lastSeq.get(frame.peerId) === frame.seq) return;
    this.lastSeq.set(frame.peerId, frame.seq);
    if (this.lastSeq.size > 512) this.lastSeq.clear(); // hard bound
    this.o.onFrame(frame, typeof ev.rssi === "number" ? ev.rssi : null);
  }
}
