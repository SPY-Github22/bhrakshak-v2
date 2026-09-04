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


/* ---- navigation math ---- */
import {
  bearingTo, distanceTo, geoIntentUrl, guidanceText, osmPinUrl,
  relativeBearing, rssiWarmth, sectorFor, sonarPulseMs,
} from "../src/navigation.ts";

// relativeBearing: target straight north, phone facing north → ahead (0°)
expect(relativeBearing(0, 0).relativeDeg === 0 && relativeBearing(0, 0).sector === "ahead" && relativeBearing(0, 0).headingKnown, "rel bearing north/north = ahead");
// target north, phone facing east (90°) → target is to the left (270° rel)
expect(relativeBearing(0, 90).relativeDeg === 270 && relativeBearing(0, 90).sector === "left", "rel bearing north/east = left@270");
// target south (180°), phone north → behind
expect(relativeBearing(180, 0).sector === "behind", "rel bearing south/north = behind");
// no compass → absolute bearing, headingKnown false
expect(relativeBearing(45, null).relativeDeg === 45 && !relativeBearing(45, null).headingKnown, "no compass → absolute bearing");
// null target bearing → ahead, not headingKnown
expect(relativeBearing(null, 30).sector === "ahead" && !relativeBearing(null, 30).headingKnown, "null target → ahead");
// sector boundaries
expect(sectorFor(0) === "ahead" && sectorFor(30) === "slightly-right" && sectorFor(80) === "right" && sectorFor(180) === "behind" && sectorFor(260) === "left" && sectorFor(350) === "ahead", "sectorFor 8-way boundaries");
// guidance text includes distance
expect(guidanceText(relativeBearing(0, 0), 120).includes("120 m") && guidanceText(relativeBearing(0, 0), 120).includes("Straight ahead"), "guidanceText ahead+distance");
expect(guidanceText(relativeBearing(180, 0), 1500).includes("Turn around") && guidanceText(relativeBearing(180, 0), 1500).includes("1.5 km"), "guidanceText behind+km");
// rssi warmth
expect(rssiWarmth(-70, -65) === "warmer" && rssiWarmth(-70, -78) === "colder" && rssiWarmth(-70, -70) === "same" && rssiWarmth(null, -60) === "unknown", "rssiWarmth warmer/colder/same/unknown");
// sonar: closer = longer pulse, null = 0
expect(sonarPulseMs(10) > sonarPulseMs(200) && sonarPulseMs(null) === 0 && sonarPulseMs(0) === 300, "sonarPulseMs monotonic + null=0");
// bearingTo/distanceTo recompute from live self position
const self = { lat: 24.8105, lon: 93.682 };
const peer = { peerId: "x", lat: 24.815, lon: 93.682, bearingDeg: 180, distanceM: 9999, rssi: null, accuracyM: null, source: "wifi" as const, needsHelp: false, batteryPct: null, lastSeen: 0, firstSeen: 0, role: "citizen" as const, alias: "C" };
expect(Math.abs(bearingTo(self, peer) ?? 0) < 1, "bearingTo recomputes north from live self pos");
expect(distanceTo(self, peer) != null && Math.abs(distanceTo(self, peer)! - 500) < 15, "distanceTo recomputes ~500m from live self pos");
// map handoff URLs
expect(osmPinUrl(24.8105, 93.682).includes("openstreetmap.org") && osmPinUrl(24.8105, 93.682).includes("24.8105"), "osmPinUrl valid");
expect(geoIntentUrl(24.8105, 93.682).startsWith("geo:24.8105") && geoIntentUrl(24.8105, 93.682).includes("Survivor"), "geoIntentUrl valid");

/* coordinate-free store check: BLE sighting without self position → distance via RSSI */
const store2 = new PeerStore();
store2.upsert({ peerId: "aaaa0005", rssi: -70, source: "ble" }, t0);
expect(store2.snapshot()[0].distanceM != null, "rssi-only distance without GPS");

console.log("\nnearby-peers selfcheck: ALL PASSED");
