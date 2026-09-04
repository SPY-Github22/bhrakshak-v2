/* Runtime self-check for the dependency-free core (geo, frame codec, store).
   Runs under plain node — no test framework, no build step:
       node --experimental-strip-types tests/selfcheck.ts
   Exits 0 with a summary, or throws on the first failed expectation. */

import { bearingDeg, compassArrow, formatDistance, haversineMeters, rssiToMeters } from "../src/geo.ts";
import { encodeBeaconFrame, tryDecodeBeaconFrame } from "../src/frame.ts";
import { PeerStore } from "../src/peerStore.ts";

function expect(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  ok — ${label}`);
}

/* ---- geo ---- */
const A = { lat: 24.8105, lon: 93.6820 }; // Tupul, Noney
const B = { lat: 24.8150, lon: 93.6820 };
expect(Math.abs(haversineMeters(A, B) - 500) < 15, `haversine ~500 m (${haversineMeters(A, B).toFixed(1)} m)`);
expect(Math.abs(bearingDeg(A, B)) < 1, `bearing due north (${bearingDeg(A, B).toFixed(2)}°)`);
expect(compassArrow(10) === "↑" && compassArrow(95) === "→" && compassArrow(190) === "↓", "compass arrows 8-point");
expect(rssiToMeters(-59) === 1 && rssiToMeters(-81) > 8 && rssiToMeters(-81) < 14, `rssi model (-81 → ${rssiToMeters(-81).toFixed(1)} m)`);
expect(formatDistance(320.4) === "320 m" && formatDistance(1234) === "1.2 km", "formatDistance");

/* ---- frame round-trip ---- */
const frame = encodeBeaconFrame({
  peerId: "a1b2c3d4", role: "citizen", seq: 7, needsHelp: true,
  batteryPct: 64, lat: 24.8105, lon: 93.6820, accuracyM: 9,
});
expect(frame.length === 21, "frame is 21 bytes");
const back = tryDecodeBeaconFrame(frame);
expect(!!back && back.peerId === "a1b2c3d4" && back.role === "citizen" && back.seq === 7, "frame round-trip id/role/seq");
expect(back!.needsHelp === true && back!.batteryPct === 64, "frame round-trip flags/battery");
expect(Math.abs(back!.lat! - 24.8105) < 1e-6 && Math.abs(back!.lon! - 93.6820) < 1e-6, "frame round-trip lat/lon at 1e-7 precision");

/* corruption is rejected */
const bad = frame.slice();
bad[5] ^= 0xff;
expect(tryDecodeBeaconFrame(bad) === null, "CRC rejects corrupted frame");

const truncated = frame.slice(0, 15);
expect(tryDecodeBeaconFrame(truncated) === null, "short frame rejected");

const noGps = tryDecodeBeaconFrame(encodeBeaconFrame({ peerId: "ffffffff", role: "field", seq: 1, needsHelp: false, batteryPct: null, lat: null, lon: null, accuracyM: null }));
expect(noGps!.lat === null && noGps!.lon === null && noGps!.accuracyM === null, "no-gps frame decodes with null coords");

/* ---- peer store ---- */
const store = new PeerStore(60_000);
store.setSelfPos(A.lat, A.lon);
const t0 = 1_000_000;
store.upsert({ peerId: "aaaa0001", alias: "C-FAR", lat: B.lat, lon: B.lon, source: "wifi" }, t0);
store.upsert({ peerId: "aaaa0002", alias: "C-SOS", rssi: -81, needsHelp: true, source: "ble" }, t0 + 1);
let snap = store.snapshot();
expect(snap.length === 2 && snap[0].peerId === "aaaa0002", "SOS peer sorts first");
expect(Math.abs(snap[1].distanceM! - 500) < 15, "wifi peer distance from GPS");
expect(Math.abs(snap[0].distanceM! - rssiToMeters(-81)) < 0.01, "ble peer distance from RSSI");

/* fresher sighting wins */
store.upsert({ peerId: "aaaa0001", lat: A.lat, lon: A.lon, source: "wifi" }, t0 + 5_000);
snap = store.snapshot();
expect(snap.find((p) => p.peerId === "aaaa0001")!.distanceM! < 1, "updated sighting recomputes distance");

/* subscription fires */
let fired = 0;
const unsub = store.subscribe(() => fired++);
store.upsert({ peerId: "aaaa0003", source: "wifi", lat: 1, lon: 1 }, t0 + 6_000);
expect(fired >= 2, `subscribe notified on upsert (${fired})`);
unsub();

/* TTL sweep */
store.upsert({ peerId: "aaaa0004", source: "wifi", lat: 2, lon: 2 }, t0);
store.sweep(t0 + 61_000);
snap = store.snapshot();
// 0004 (t0) and 0002 (t0+1ms) both age past the 60s TTL; 0001/0003 survive
expect(store.count() === 2 && !snap.some((p) => p.peerId === "aaaa0004" || p.peerId === "aaaa0002"), "sweep drops only peers past TTL");

/* coordinate-free store check: BLE sighting without self position → distance via RSSI */
const store2 = new PeerStore();
store2.upsert({ peerId: "aaaa0005", rssi: -70, source: "ble" }, t0);
expect(store2.snapshot()[0].distanceM != null, "rssi-only distance without GPS");

console.log("\nnearby-peers selfcheck: ALL PASSED");
