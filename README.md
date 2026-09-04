# BhuRakshak v2 (भूरक्षक v2)

> **Repository:** [https://github.com/SPY-Github22/bhrakshak-v2](https://github.com/SPY-Github22/bhrakshak-v2)  
> **Branch:** `main`  
> **Challenge:** AI-Based Early Warning and Landslide Risk Monitoring System in North Eastern Region (NER) — **SIH26001**

*From reactive disaster response to predictive, multi-modal landslide protection.*

---

## 🧭 System Overview

BhuRakshak v2 is a full-stack, enterprise-grade landslide early warning and field rescue ecosystem engineered specifically for the complex terrain, extreme monsoon rainfall, and communication challenges of the North Eastern Region of India.

The system integrates a **4-layer predictive warning pipeline**:
1. **WHERE (Susceptibility)**: High-resolution spatial susceptibility maps computed across complex topography.
2. **WHEN (Dynamic Triggers)**: Rainfall nowcasts combined with Intensity-Duration (I-D) thresholds and calibrated Machine Learning models fused with antecedent soil moisture hysteresis.
3. **IS IT MOVING (Kinematic Creep)**: Sentinel-1 InSAR surface deformation tracking detecting pre-failure slope anomalies.
4. **WHO'S IN THE WAY (Impact & Response)**: Dynamic population exposure indexing, automated rescue priority queuing, route detours, and direct field-to-citizen rescue navigation.

---

## 🌟 Key Capabilities & Modules

### 1. 📸 Self-Contained Image Upload & Vision Analysis (`image-upload/`)
A modular, portable feature package enabling citizens and field officials to submit geo-referenced photographic hazard evidence directly from the Android APK or Field PWA:
- **Field Capture with Custom Message**: Responders and citizens snap photos of slope cracks, retaining wall fissures, or rockfall debris and compose field notes directly in the app.
- **Offline Resilient Storage**: Reports and compressed images are stored locally in Room / Dexie databases when off-grid, automatically synchronizing via `WorkManager` when connectivity returns.
- **FastAPI Storage & Verification**: Dedicated backend router with SHA-256 deduplication, Pillow image verification, EXIF sanitization, and local/S3-compatible MinIO persistence.
- **Automated Model V AI Inference**: Integrates deep learning fissure/texture pre-screening for automated severity scoring.
- **Command Center Lightbox**: Interactive inspection card in the operations dashboard with full-screen zoom, AI metric breakdown, and re-analysis triggers.
- **Zero-Friction Portability**: Self-contained in [`image-upload/`](./image-upload/) with standalone microservice runner (`server.py`) for drop-in use in other disaster response platforms.

### 2. 📡 BLE Proximity Discovery & Tactical Radar Map (`apps/nearby-peers/`)
Disaster-resilient rescuer ⇄ citizen proximity detection operating under total telecommunication grid blackout:
- **Dual-Mode Discovery**:
  - **Online / Mesh Rendezvous**: Low-latency GPS announce and spatial query over Wi-Fi, hotspot, or satellite IP links.
  - **Zero-Infrastructure BLE Beaconing**: 21-byte custom manufacturer beacon frame (`BhrakshakBeacon.kt` native advertiser + Web Bluetooth scanning) transmitting at ~1 cm coordinate resolution ($10^{-7}$ degrees).
- **Dynamic Live Heading & Bearing**: Computes forward azimuth bearing and great-circle Haversine distance dynamically against the rescuer's **live GPS fix** (`selfPos`), compensated by real-time phone magnetometer heading (`deviceorientationabsolute` / `webkitCompassHeading`).
- **Buried Victim Sonar Mode**: For victims buried under landslide mud without GPS lock, activates log-distance RSSI ranging, hot/cold signal trend meters (`🔥 WARMER` / `❄ COLDER`), and haptic vibration sonar pulses that accelerate as rescuers approach.
- **Interactive Multi-Citizen Tactical Map (`NearbyTacticalMap`)**:
  - Renders **all detected survivors simultaneously** on an offline-capable metric vector grid.
  - Draws **active directional bearing vectors** from the rescuer's phone directly to each survivor with real-time distance badges.
  - Features a dynamic rescuer orientation flashlight beam that swivels in real-time as the phone rotates.
  - Concentric metric radar rings (25 m, 50 m, 100 m, 250 m, 500 m) render without requiring internet map tile downloads.
  - Tapping any survivor highlights their telemetry and locks onto them for focused acoustic/haptic navigation.

### 3. 🖥️ Command Center 3D Dashboard (`apps/dashboard`)
Interactive situational awareness web dashboard built with Next.js 14 and MapLibre GL:
- **3D Terrain & Hex-Grid Risk**: Visualizes 5 km hexagonal grid zones color-coded by real-time risk level (Green / Amber / Red).
- **Precipitation Radar & Scrubber**: Time-series slider animating radar nowcasts and antecedent precipitation indices.
- **Explainable AI (SHAP)**: Waterfall feature importance charts explaining *why* a particular slope was upgraded to warning status.
- **District Control Room Access**: Role-based access control (Admin, District Collector, Field Officer, Citizen).

### 4. 📱 Field & Citizen PWAs (`apps/field-pwa`, `apps/citizen-pwa`)
Lightweight, responsive Progressive Web Apps designed for low-power mobile devices:
- Offline hazard reporting with local Dexie storage and automated background synchronization.
- Real-time emergency alerts via WebSockets and push notifications with vibration alerts.
- Multi-language localization support across 8 regional languages.
- Safe check-in button with battery-saving dark tactical UI.

---

## ⚡ Quickstart

### Prerequisites
- Docker & Docker Compose
- Python 3.11+ / 3.12+
- Node.js 20+

### One Command Boot
```bash
cp .env.example .env
make up          # Boots Postgres (PostGIS + TimescaleDB), Redis, Mosquitto MQTT,
                 # MinIO, Martin Tile Server, FastAPI Backend, Celery Workers, Dashboard, and PWA
make migrate     # Runs Alembic migrations including spatial hypertables
make seed        # Seeds pilot districts (Aizawl, East Khasi Hills, Noney, Gangtok)
```

### Key Service URLs
| Service | URL | Description |
|---|---|---|
| **Command Center** | `http://localhost:3000` | Operations Dashboard (MapLibre 3D + ECharts) |
| **Public Dashboard Demo** | `https://bhrakshak-dashboard-demo.loca.lt` | Public tunnel to Command Center |
| **Field PWA** | `http://localhost:5173` | Mobile field responder PWA |
| **Public API Endpoint** | `https://bhrakshak-api-demo.loca.lt` | Public cloud tunnel for mobile devices |
| **FastAPI OpenAPI Docs** | `http://localhost:8000/docs` | Interactive Swagger API documentation |
| **Martin Vector Tiles** | `http://localhost:3001/zones/{z}/{x}/{y}.pbf` | High-performance PostGIS vector tiles |
| **Flower Dashboard** | `http://localhost:5555` | Celery background task monitoring |
| **MinIO Console** | `http://localhost:9001` | Object storage browser |

### Default Credentials
- **Admin**: `admin@bhrakshak.in` / `Admin@123`
- **Citizen**: `citizen@bhrakshak.in` / `Citizen@123`
- *District Collector & Field Officer accounts are seeded automatically per district.*

---

## 📱 Mobile App (Android & PWA)

### Native Android Client
- **Pre-compiled APK**: Located in `/home/sudpy/Downloads/bhrakshak-field-latest.apk`
- **Default API Endpoint**: Configured to connect to `https://bhrakshak-api-demo.loca.lt`
- **Offline Queue**: Backed by Android Room database; automatically synchronizes pending reports via `WorkManager`.
- **Hardware Integrations**: Camera capture, BLE advertising via `BhrakshakBeacon.kt`, fine GPS location, and hardware vibration motors.

### Testing Flow
1. **Login**: Authenticate with `citizen@bhrakshak.in` / `Citizen@123` or your field account.
2. **Hazard Submission & Photo**: Tap **"Report Hazard"** → Snap a slope or crack photo → Enter a description → Tap **"Submit Report"**.
3. **Simulate Blackout / Offline Mode**: Toggle Airplane Mode on your phone. Submit a report or tap **"✅ I'M SAFE"**. The report will queue in the local database. Turn Airplane Mode off: `SyncWorker` flushes the queue immediately.
4. **Proximity Search**: In the Field PWA or APK, open **"People Nearby"** → Switch to **"🗺️ Tactical Map"** to view real-time bearing vectors pointing toward consenting peers.

---

## 🏔️ Disaster Simulations & Demonstrations

### 1. June 2022 Tupul Disaster Historical Replay
Replay the catastrophic Tupul railway yard landslide in Noney district, Manipur:
```bash
python demo/replay_tupul_disaster.py --standalone
```
Simulates 72 hours of antecedent rainfall accumulation and demonstrates the **36-hour automated early warning window** generated prior to slope collapse.

### 2. Live Monsoon Storm Injection
Inject intense synthetic precipitation cells across pilot mountain sectors:
```bash
python demo/storm_injector.py --district "East Khasi Hills" --peak 60 --hours 3
```
*Alternatively, click **"⛈ Inject Monsoon Cell (Demo)"** in the bottom-left corner of the dashboard (`http://localhost:3000`). Target zones escalate Amber → Red, emergency broadcast tickers trigger, SMS warning templates render in 8 regional languages, and road detours update automatically.*

---

## 📁 Repository Structure

```
bhrakshak-v2/
├── image-upload/              # 📸 Standalone, portable image capture, storage & Model V analysis
│   ├── backend/               # FastAPI router, LocalImageStore, standalone microservice runner
│   ├── android/               # ImageUploadHelper.kt camera/gallery intents & compression
│   └── dashboard/             # ImageReportCard.tsx React card with zoom modal & AI metrics
├── apps/
│   ├── api/                   # FastAPI backend, PostGIS/Timescale models, Alembic migrations, auth
│   ├── worker/                # Celery worker/beat: rainfall polling, InSAR kinematics, risk engine
│   ├── dashboard/             # Next.js 14 command center dashboard (MapLibre GL, ECharts, Tailwind)
│   ├── field-pwa/             # Rescuer PWA: offline hazard reports, tactical map, mesh relay
│   ├── citizen-pwa/           # Citizen PWA: safe check-in, alert subscriptions, beacon broadcasting
│   ├── nearby-peers/          # 📡 Portable proximity discovery & tactical multi-citizen radar map
│   │   ├── src/components/    # NearbyTacticalMap.tsx, PeopleNearbyPanel.tsx, PeerNavigator.tsx
│   │   ├── android/           # BhrakshakBeacon.kt native BLE advertiser & scanner
│   │   └── server/            # DB-free in-memory rendezvous router
│   └── android/               # Native Android app (Kotlin, Jetpack Compose, Room, WorkManager)
├── ml/                        # Ingest, feature engineering, ML models (A–E), spatial validation
├── infra/                     # Docker Compose, Mosquitto MQTT, Martin config, MinIO scripts
├── demo/                      # Tupul historical replay, storm injector, sensor simulator
├── scripts/                   # Hexagonal spatial grid seeders, realistic scenario generators
└── docs/                      # Technical runbooks, architecture diagrams, ML model cards
```

---

## 🧪 Verification & Automated Tests

All core components include comprehensive automated test suites:

```bash
# 1. Nearby Peers unit tests (Haversine, bearing, BLE frame CRC, multi-peer tactical projection)
cd apps/nearby-peers && npm run selfcheck

# 2. Nearby Peers TypeScript verification
cd apps/nearby-peers && npm run typecheck

# 3. Field PWA production build verification
cd apps/field-pwa && npm run build

# 4. Proximity Rendezvous Router pytest suite
pytest apps/nearby-peers/tests/test_nearby_router.py

# 5. Image Upload & Computer Vision pipeline pytest suite
pytest apps/api/tests/test_image_upload.py
```

---

## 📜 Pilot Study Districts

| District | State | Zone Code Prefix | Topographic Focus |
|---|---|---|---|
| **Aizawl** | Mizoram | `MZ-AIZ-*` | Urban slope stability & steep shale cut-slopes |
| **East Khasi Hills** | Meghalaya | `ML-EKH-*` | Extreme rainfall intensity & plateau escarpments (Cherrapunji/Sohra) |
| **Noney** | Manipur | `MN-NON-*` | Critical infrastructure corridors & railway construction cuts (Tupul) |
| **Imphal West** | Manipur | `MN-IW-*` | Valley-fringe debris flow and alluvial slope runoff |
| **Gangtok** | Sikkim | `SK-GTK-*` | High-altitude seismic-tectonic active thrust zones |

---

## 📄 License & Team

Built for the **Smart India Hackathon (SIH26001)** by Team BhuRakshak.  
Developed under open, disaster-resilience engineering standards for public safety and disaster mitigation.
