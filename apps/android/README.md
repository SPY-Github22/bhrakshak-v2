# BhuRakshak Field (Android)

Native Android client for the BhuRakshak early-warning platform (SIH26001).
Talks to the **same FastAPI backend** as the web dashboard and the PWA — no
separate server, same JWT auth, same offline-first sync contract.

## Screens (all real — every one calls the shared backend)

| Screen | What it does | Backend |
|---|---|---|
| **Login** | JWT login for citizen / field official / DC (token persisted in EncryptedSharedPreferences) | `POST /api/v1/auth/login` |
| **Home / Risk Now** | Current hazard level at the device location (geolocated, worst zone within 5 km); cached for offline display | `GET /api/v1/zones?bbox=` |
| **I'M SAFE check-in** | Stored in Room on-device; survives offline | local (Room `checkins`) |
| **Report** | Geo-tagged hazard report + **camera photo with Model V AI pre-screen** (`/reports/analyze-photo` before queueing when online); queued in Room when offline | `POST /api/v1/reports/sync`, `POST /api/v1/reports/analyze-photo` |
| **Safe Route** | Evacuation pathway model — routes AROUND live L3+ cells to the safest flat shelter, with ETA, safety score, flat clearance; polyline drawn in-app; last route cached for offline | `GET /api/v1/evacuation/safe-route` |
| **Rain gauge** | 1h/24h/48h/72h/7d accumulations, effective (antecedent) rainfall, soil moisture, **I-D threshold breach status** for the worst nearby zone; cached for offline | `GET /api/v1/zones/{id}/weather` |
| **Alerts** | Alert history (levels, channels, timestamps) | `GET /api/v1/alerts` |
| **Live push** | Foreground service on the WebSocket raises heads-up notifications for `alert` and `ndrf_message` events (NDRF comms reach the field app directly) | `WS /ws/live` |

## Offline-first (the NER-valley contract)

- Every report is written to a **Room** queue table with a client-generated
  UUID (idempotent sync by contract — the backend merges duplicates by
  `client_id` and 50 m/1 h proximity dedupe).
- A `WorkManager` periodic worker flushes the queue every 15 minutes AND is
  triggered **immediately on connectivity return** (ConnectivityManager
  callback → one-time worker). Nothing is ever lost.
- Risk level, safe-route, and rain-gauge screens fall back to last-known
  cached state with an explicit OFFLINE banner when the network is gone.
- Photos are stored under `files/photos/` until sync; the Model V sha1 media
  key rides on the queued row and is sent as the report's `media_ref`, which
  is how the server attaches the AI verdict to the synced report.

## Pre-built APK

The latest assembled debug APK is saved at:
`~/Downloads/bhrakshak-field-latest.apk`

## Build

```bash
cd apps/android
./gradlew :app:assembleDebug        # Android Studio also fine
adb install app/build/outputs/apk/debug/app-debug.apk
```

The gradle wrapper (8.7) + AGP 8.5.2 + Kotlin 2.0.20 + KSP (Room compiler)
are pinned; JDK 17 required. `gradle.properties` enables AndroidX.

Backend URL defaults to the public cloud tunnel:
```text
https://bhrakshak-api-demo.loca.lt
```

You can repoint to a custom LAN IP (e.g. `http://10.68.3.168:8000`) or production domain directly on the login screen.

## Note on maps

The in-app route view renders the pathway-model polyline on a lightweight
Canvas (no map SDK, no API key, works fully offline). MapLibre Native can be
added later for a slippy map; the route geometry (`LineString` coordinates)
is already in the response payload.
