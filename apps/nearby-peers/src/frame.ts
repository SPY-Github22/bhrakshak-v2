/* Bhrakshak BLE beacon frame — the single source of truth for the 21-byte
   payload carried in BLE manufacturer-specific data. The native Android
   beacon (android/BhrakshakBeacon.kt) implements this exact layout.

   Frame spec v1 (little-endian, carried as manufacturer data):
     byte 0      magic 0xB8 ("Bh")
     byte 1      version 0x01
     byte 2      flags  — bit0 has_gps, bit1 needs_help, bit2 consent_ok
     byte 3..4   seq (uint16 LE, wraps; receiver uses it to dedupe)
     byte 5..8   peer_id (4 random bytes → 8 hex chars, rotates daily)
     byte 9      role (0 citizen, 1 field, 2 relay)
     byte 10     battery % (0xFF = unknown)
     byte 11..14 lat int32 LE = round(lat * 1e7)   [when has_gps]
     byte 15..18 lon int32 LE = round(lon * 1e7)   [when has_gps]
     byte 19     GPS accuracy, whole meters clamped 0..255 (0 = unknown)
     byte 20     CRC-8 (poly 0x07, init 0x00) over bytes 0..19

   A device only ever *advertises* this frame after explicit in-app consent. */

import { NEARBY_FRAME_LEN, NEARBY_FRAME_MAGIC, NEARBY_FRAME_VERSION } from "./config.ts";
import { clamp } from "./geo.ts";
import type { PeerRole } from "./types.ts";

export const ROLE_CODES: Record<PeerRole, number> = { citizen: 0, field: 1, relay: 2 };
export const CODE_ROLES: Record<number, PeerRole> = { 0: "citizen", 1: "field", 2: "relay" };

export interface BeaconPayload {
  peerId: string; // 8 hex chars
  role: PeerRole;
  seq: number;
  needsHelp: boolean;
  batteryPct: number | null;
  lat: number | null;
  lon: number | null;
  accuracyM: number | null;
}

export function crc8(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function hexTo4Bytes(hex: string): Uint8Array {
  const out = new Uint8Array(4);
  const clean = hex.replace(/[^0-9a-fA-F]/g, "").padStart(8, "0").slice(0, 8);
  for (let i = 0; i < 4; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}

function writeInt32LE(buf: Uint8Array, off: number, value: number): void {
  // clamp to int32 — 1e7-scaled degrees always fit (±180e7 < 2^31)
  const v = clamp(Math.round(value), -2147483648, 2147483647) | 0;
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

function readInt32LE(buf: DataView, off: number): number {
  return (buf.getUint8(off) | (buf.getUint8(off + 1) << 8) | (buf.getUint8(off + 2) << 16) | (buf.getUint8(off + 3) << 24)) | 0;
}


export function encodeBeaconFrame(p: BeaconPayload): Uint8Array {
  const out = new Uint8Array(NEARBY_FRAME_LEN);
  const hasGps = p.lat != null && p.lon != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);
  out[0] = NEARBY_FRAME_MAGIC;
  out[1] = NEARBY_FRAME_VERSION;
  out[2] = (hasGps ? 1 : 0) | (p.needsHelp ? 2 : 0) | 4; // advertising at all implies consent_ok
  out[3] = p.seq & 0xff;
  out[4] = (p.seq >>> 8) & 0xff;
  out.set(hexTo4Bytes(p.peerId), 5);
  out[9] = ROLE_CODES[p.role] ?? 0;
  out[10] = p.batteryPct == null ? 0xff : clamp(Math.round(p.batteryPct), 0, 100);
  if (hasGps) {
    writeInt32LE(out, 11, p.lat! * 1e7);
    writeInt32LE(out, 15, p.lon! * 1e7);
  } else {
    writeInt32LE(out, 11, 0);
    writeInt32LE(out, 15, 0);
  }
  out[19] = p.accuracyM == null ? 0 : clamp(Math.round(p.accuracyM), 0, 255);
  out[20] = crc8(out.subarray(0, 20));
  return out;
}

/** Returns null unless the bytes are a valid Bhrakshak frame (magic, version,
    length, CRC). Intended to be handed raw manufacturer-data bytes. */
export function tryDecodeBeaconFrame(data: Uint8Array | DataView): BeaconPayload | null {
  const len = data instanceof Uint8Array ? data.length : data.byteLength;
  if (len < NEARBY_FRAME_LEN) return null;
  const get = (i: number) => (data instanceof Uint8Array ? data[i] : data.getUint8(i));
  if (get(0) !== NEARBY_FRAME_MAGIC || get(1) !== NEARBY_FRAME_VERSION) return null;
  const bytes = data instanceof Uint8Array ? data.subarray(0, NEARBY_FRAME_LEN) : null;
  const dv = data instanceof DataView ? data : new DataView(data.buffer, data.byteOffset, data.byteLength);
  let computed: number = 0;
  if (bytes) computed = crc8(bytes.subarray(0, 20));
  else {
    const tmp = new Uint8Array(20);
    for (let i = 0; i < 20; i++) tmp[i] = dv.getUint8(i);
    computed = crc8(tmp);
  }
  if (computed !== get(20)) return null;

  const flags = get(2);
  const hasGps = (flags & 1) !== 0;
  let peerId = "";
  for (let i = 5; i < 9; i++) peerId += get(i).toString(16).padStart(2, "0");
  const battery = get(10);
  return {
    peerId,
    role: CODE_ROLES[get(9)] ?? "citizen",
    seq: get(3) | (get(4) << 8),
    needsHelp: (flags & 2) !== 0,
    batteryPct: battery === 0xff ? null : battery,
    lat: hasGps ? readInt32LE(dv, 11) / 1e7 : null,
    lon: hasGps ? readInt32LE(dv, 15) / 1e7 : null,
    accuracyM: hasGps ? get(19) : null,
  };
}
