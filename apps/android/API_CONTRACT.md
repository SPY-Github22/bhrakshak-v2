# BhuRakshak Android — API contract (what the app consumes)

The Android app is a thin native client over the SAME FastAPI backend as the
web dashboard and the field PWA. Nothing is duplicated server-side.

## Endpoints used

| Endpoint | App usage |
|---|---|
| `POST /api/v1/auth/login` | JWT; access + refresh in EncryptedSharedPreferences, `role` surfaced |
| `GET /api/v1/zones?bbox=…` | risk level around the device location (worst zone in ±0.05°); cached to prefs for offline |
| `POST /api/v1/reports/sync` | offline queue flush; idempotent by client UUID; `media_refs` carry the Model V sha1 key |
| `POST /api/v1/reports/analyze-photo` | Model V pre-screen (multipart `photo` + query `lat`/`lon`/`taken_at`); verdict shown as a toast before the report is queued |
| `GET /api/v1/evacuation/safe-route?lat&lon` | pathway model to the safest shelter; polyline rendered in-app; cached for offline |
| `GET /api/v1/zones/{id}/weather` | rain gauge: accumulations, soil moisture, I-D breach status; cached for offline |
| `GET /api/v1/alerts` | alert history with channels |
| `GET /api/v1/chat/messages` | emergency chat history (JWT required); **oldest → newest**, last 50 |
| `POST /api/v1/chat/send` | post to the emergency chat (JWT required; staff roles only — admin / district_admin / field_official). Identity (sender_name/role) is derived from the token, never the body |
| `WS /ws/live` | live push: `alert`, `ndrf_message`, and `chat_message` events raise heads-up notifications (foreground service, reconnect w/ backoff) |

## Offline contract (identical to PWA)

1. Report written to Room with `client_id = UUID4` + UTC `taken_at` +
   device GPS lat/lon (backend `ReportIn` requires them).
2. `SyncWorker` (WorkManager, 15-min periodic + immediate on connectivity
   via `NetworkCallback.onAvailable`) POSTs `POST /reports/sync` with
   `batch_id = UUID4`.
3. Backend merges by client UUID; 50 m/1 h same-category duplicates are
   merged server-side (`dup_count++`), so retries are always safe.
4. Photo AI pre-screen returns `verdict ∈ {POSITIVE, POSSIBLE, NEGATIVE}` +
   EXIF provenance flags; the sha1 `media_key` is stored on the queued row
   and sent as `media_refs`, letting the backend attach the verdict to the
   synced report by key.
5. `POST /reports/sync` response carries `rejected_ids` alongside
   `synced_ids`: rows the server failed to persist. The SyncWorker must keep
   those in the Room queue and retry — a row is only dropped after it appears
   in `synced_ids`.
6. Chat contract: `GET /chat/messages` returns oldest→newest (render as-is,
   no client-side reversal); `POST /chat/send` requires a Bearer token and
   returns the canonical message (server UUID + timestamp + role label) —
   clients reconcile by `id`, never by locally-fabricated copies.

## Verified live state (2026-09-02)

* 536 zones across 5 NER districts with REAL Open-Meteo hourly rainfall
* Model B v1-real-openmeteo serving calibrated probabilities
* Model A v2 micro-susceptibility on real terrarium DEM (536 zones'
  susc_mean/p90 refreshed from real terrain)
* 8 shelters seeded; safe-route verified bending around an active L4 zone
* 119 API+ML tests green
