# bhrakshak-nearby-peers

**Rescuer ⇄ citizen proximity discovery.** A field rescuer opens the app and sees
the citizens around them who run the same app and opted in — sorted by distance,
with bearing, SOS flags, battery and last-seen. Works **two ways**, exactly the
two scenarios that matter in a landslide:

| Scenario | Transport | Range | Needs network? |
|---|---|---|---|
| Rescuer has Wi-Fi / any data link | `wifi` — GPS announce + geo-query against a rendezvous API | configurable radius (50 m – 10 km, default 500 m) | any IP link (Wi-Fi, hotspot, data) |
| Rescuer walks right up to survivors, everything is down | `ble` — passive scan of the Bhrakshak beacon frame | ~30–70 m (phone-class radios) | **none** |

This folder is **fully portable**: the core library imports nothing from
Bhrakshak, the API router is DB-free with pluggable auth, and the React panels
are drop-in with inline styles + theme-variable fallbacks. Copy the folder into
any other project and follow [Porting](#porting-to-another-project).

```
nearby-peers/
├── src/
│   ├── config.ts                  every tunable in one place
│   ├── types.ts                   shared types (PeerInfo, transports)
│   ├── geo.ts                     haversine · bearing · RSSI→m · formatting
│   ├── frame.ts                   21-byte BLE beacon frame codec (source of truth)
│   ├── identity.ts                ephemeral rotating peer id + alias
│   ├── consent.ts                 consent / SOS flags (the feature kill-switch)
│   ├── peerStore.ts               TTL peer registry, distance-sorted, subscribable
│   ├── nearbyService.ts           orchestrator: GPS + announce/query loops + BLE
│   ├── transports/
│   │   ├── rendezvousTransport.ts  Wi-Fi/data announce+query client
│   │   └── bleTransport.ts         Web Bluetooth scanning (Chrome/Edge Android)
│   ├── components/
│   │   ├── PeopleNearbyPanel.tsx   rescuer UI — who's around me?
│   │   └── CitizenBeaconPanel.tsx  citizen UI — consent + "be visible" + SOS
│   └── index.ts                   public surface
├── server/nearby_router.py        FastAPI rendezvous (RAM-only, DB-free, pluggable auth)
├── android/BhrakshakBeacon.kt     native BLE advertise+scan (same frame format)
├── tests/
│   ├── selfcheck.ts               node --experimental-strip-types tests/selfcheck.ts
│   ├── test_nearby_router.py      pytest, no DB required
│   └── e2e_nearby.sh              live curl flow against a running API
├── package.json / tsconfig.json   standalone typecheck + selfcheck scripts
└── README.md                      this file
```

## Privacy model (designed-in, not bolted on)

* **Consent is the kill-switch.** A citizen is invisible until they press
  *“Be visible to rescuers”*. Turning it off stops announce/advertise AND calls
  `DELETE /nearby/{peer_id}` so the server drops the last sighting immediately.
* **No identity linkage.** The peer id is 4 random bytes shown as `C-XXXX`,
  rotated every 24 h. No phone number, MAC, IMEI, or account is ever attached —
  a rescuer can't build a movement history, and a lost phone reveals nothing.
* **Server amnesia.** Coordinates live in process RAM with a 10-minute TTL.
  No DB table, no log line, no backup. Restart = empty world.
* **The server never maps people.** `GET /nearby/stats` reports counts only.
* **BLE beacons never include the device name** (`setIncludeDeviceName(false)`).


## The BLE beacon frame (v1, 21 bytes)

Carried as **manufacturer-specific data**, company id `0xFFFF` (Bluetooth SIG
reserved id for internal/test use). Little-endian. `src/frame.ts` is the source
of truth; `android/BhrakshakBeacon.kt` implements the same layout.

```
byte 0      magic 0xB8 ("Bh")
byte 1      version 0x01
byte 2      flags — bit0 has_gps · bit1 needs_help (SOS) · bit2 consent_ok
byte 3..4   seq (uint16 LE, dedupe repeats)
byte 5..8   peer_id (4 random bytes → 8 hex chars, rotates daily)
byte 9      role (0 citizen · 1 field · 2 relay)
byte 10     battery % (0xFF = unknown)
byte 11..14 lat  int32 LE = round(lat * 1e7)   [when has_gps]
byte 15..18 lon  int32 LE = round(lon * 1e7)
byte 19     GPS accuracy, whole meters clamped 0..255 (0 = unknown)
byte 20     CRC-8 poly 0x07 over bytes 0..19   ← corrupted/foreign frames rejected
```

The codec round-trips at 1e-7° precision (~1 cm) and validates CRC on decode.

## Rendezvous API (`server/nearby_router.py`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/nearby/announce` | Upsert one ephemeral peer (1 req/s flood guard, 5000-peer cap) |
| `POST` | `/nearby/query` | Live peers within radius of me — nearest first, SOS first, self excluded |
| `DELETE` | `/nearby/{peer_id}` | Consent revoked — purge now (idempotent) |
| `GET` | `/nearby/stats` | Counts only, never coordinates |

Everything is RAM + TTL (10 min), mirroring the codebase's `mesh.py` pattern.

## Porting to another project

1. **Copy the folder.** That's the feature.
2. **UI panels** — `react` is a peer dependency:
   ```tsx
   // rescuer app
   import { PeopleNearbyPanel } from "…/nearby-peers/src/components/PeopleNearbyPanel";
   <PeopleNearbyPanel apiUrl="https://your-api" token={jwt} />

   // citizen app
   import { CitizenBeaconPanel } from "…/nearby-peers/src/components/CitizenBeaconPanel";
   <CitizenBeaconPanel apiUrl="https://your-api" token={jwt} />
   ```
   If the module lives outside your app root, Vite dev needs
   `server: { fs: { allow: [".."] } }` in `vite.config.ts` (already added here).
3. **Server** — mount the factory with *your* auth dependency:
   ```python
   from nearby_router import make_nearby_router
   app.include_router(make_nearby_router(get_principal=my_jwt_dependency))
   ```
   (`get_principal=None` = open demo mode: bearer required but unverified.)
4. **Offline BLE advertising** — a browser can't advertise; drop
   `android/BhrakshakBeacon.kt` into your Android shell (zero project-specific
   imports; permissions listed in the file header). iOS has no Web Bluetooth —
   the rescuer panel degrades to Wi-Fi mode with a clear status line.
5. **Validate** — `npm run selfcheck` (node ≥22), `npm run typecheck`,
   `pytest tests/test_nearby_router.py`.
## Guided navigation (the "walk me to them" HUD)

Tap any peer in the rescuer's **People Nearby** list → full-screen `PeerNavigator`:

* **Big arrow that points AT the person** — combines the GPS bearing to the peer with the phone's own magnetometer heading (`deviceorientationabsolute` / `webkitCompassHeading`), Google-Maps-compass-style. If no compass is available the arrow falls back to absolute bearing with "top of phone = North".
* **Distance countdown** + plain-language guidance ("Straight ahead · 120 m", "Turn around · 1.5 km").
* **Vibration sonar** — buzzes on a 1.2 s cadence, pulse length grows as you close in, double-pulse under 25 m (works when you can't stare at the screen). Toggleable; the screen is kept awake via `WakeLock`.
* **Radar view** — rescuer at center, peer as a blip at the live bearing. When the peer has no GPS fix (buried/indoor), shows an RSSI-derived range ring instead of a point.
* **RSSI warm/cold meter** — "🔥 WARMER / ❄ COLDER" trend between advertisements, the hot/cold cue for zero-GPS-fix peers.
* **Signal-lost banner** — holds the last-known bearing if the peer is TTL-swept mid-search.
* **Map handoff** (only when exact coords exist) — "🗺 OSM pin" opens an OpenStreetMap pin; "📍 Maps app" fires a `geo:` intent to the native maps app. No map tiles, no routing engine, no new dependencies — it works fully offline.


## How it is wired into Bhrakshak v2

* `apps/api/app/api/v1/nearby.py` — 20-line adapter: loads the portable router
  via importlib and injects the platform JWT dependency. Registered in `main.py`.
* `apps/field-pwa/src/App.tsx` — `PeopleNearbyPanel` on the Home tab (below
  Crowd Density). Uses the stored field JWT.
* `apps/citizen-pwa/src/App.tsx` — `CitizenBeaconPanel` below Safe Check-in.
  Falls back to the demo citizen login when no token exists (same pattern as
  `MeshRelayPanel`).
* `vite.config.ts` of both PWAs — `fs.allow` so dev servers can import the
  module from the sibling folder. The `node_modules` symlinks mirror the
  existing `field-pwa/node_modules` symlink pattern used by this repo.
* `tests/e2e_nearby.sh` — live curl flow: citizen login → announce ×2 →
  field login → query (SOS-first, bearing/distance correct) → stats → forget.

## Known limits (honest list)

* Browser citizens can't BLE-advertise (platform restriction, not ours) — the
  Wi-Fi transport covers them; the Kotlin beacon covers offline advertising.
* RSSI→distance is a log-path-loss estimate (±2× error typical) — good enough
  to walk a bearing, not a ruler. GPS haversine is used whenever both sides
  share coordinates (Wi-Fi mode and GPS-carrying beacons).
* The rendezvous needs one reachable IP path; with zero infrastructure AND no
  native app, proximity discovery degrades to the existing anonymous
  `BleCrowdPanel` counts (that limitation is why both features coexist).
