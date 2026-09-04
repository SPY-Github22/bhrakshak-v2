# 🚨 BhuRakshak Standalone Real-Time Alert & Notification System

This directory contains the **complete, modular, portable Real-Time Emergency Alert & Notification System** extracted from BhuRakshak. You can copy and drop this `standalone-alert-system/` folder into any other project stack (FastAPI + Android Kotlin + React/Next.js).

---

## 🏗 System Architecture & Highlights

1. **Dual-Path Guaranteed Alert Delivery**:
   - **WebSocket Real-Time Broadcast** (`/ws/live`): Instantly pushes emergency JSON alerts to all online clients.
   - **HTTP Active Polling Fallback** (`GET /api/v1/alerts/active`): Mobile devices poll this endpoint every 3 seconds to guarantee heads-up notification delivery even across network handovers or brief socket disconnects.

2. **Android High-Priority System Notifications**:
   - Built with `NotificationChannel` (`IMPORTANCE_HIGH`), `PRIORITY_MAX`, `CATEGORY_ALARM`, custom multi-pulse vibration patterns, and heads-up banner display.
   - Includes Jetpack Compose `ActiveEmergencyBanner` UI component for in-app alert cards.

3. **Web Dashboard Control**:
   - Provides a React/Next.js control widget to trigger synthetic extreme storm injections and All-Clear resets.

---

## 📁 Directory Structure

```
standalone-alert-system/
├── README.md                      # Implementation & transfer guide
├── backend/
│   ├── app.py                     # Self-contained runnable FastAPI server
│   ├── alerts.py                  # Active alerts query endpoint & registry
│   ├── demo_injector.py           # Storm injection & reset endpoints
│   └── websocket_manager.py       # Live WebSocket broadcaster
├── android/
│   ├── LiveAlertService.kt        # System Heads-Up Notification Service
│   ├── EmergencyBannerUI.kt       # Jetpack Compose top alert card UI
│   ├── AndroidManifest_snippet.xml# Required permissions & manifest config
│   └── build.gradle_snippet.kts   # Required Android dependencies
└── dashboard/
    ├── AlertInjectorControl.tsx   # React/Next.js storm injection UI widget
    └── api_client.ts              # API client methods for storm trigger & polling
```

---

## 🚀 Quickstart Guide

### 1. Backend Integration (FastAPI / Python)

- **Install dependencies**:
  ```bash
  pip install fastapi uvicorn pydantic
  ```

- **Run the Standalone API Backend**:
  ```bash
  python -m standalone_alert_system.backend.app
  ```
  *The API will start listening on `http://0.0.0.0:8000`.*

- **Endpoints Provided**:
  - `GET  /api/v1/alerts/active` — Active emergency alerts list (polled by mobile app).
  - `POST /api/v1/demo/inject-rainfall-storm` — Triggers Level 4 storm & broadcasts alerts.
  - `POST /api/v1/demo/reset-storm` — Clears all storms & sends All-Clear signal.
  - `WS   /ws/live` — Live WebSocket connection.

---

### 2. Android App Integration (Kotlin)

1. Copy `LiveAlertService.kt` and `EmergencyBannerUI.kt` into your Android project source path.
2. Add permissions from `AndroidManifest_snippet.xml` to your project's `AndroidManifest.xml`:
   ```xml
   <uses-permission android:name="android.permission.INTERNET" />
   <uses-permission android:name="android.permission.VIBRATE" />
   <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
   ```
3. In your `MainActivity.kt`, start the 3-second alert polling loop:
   ```kotlin
   lifecycleScope.launch(Dispatchers.IO) {
       while (isActive) {
           runCatching {
               val alerts = apiService.getActiveAlerts()
               if (alerts.isNotEmpty()) {
                   val top = alerts[0]
                   LiveAlertService.showHeadUpAlert(
                       context = this@MainActivity,
                       title = top.name,
                       message = top.message
                   )
               }
           }
           delay(3000)
       }
   }
   ```

---

### 3. Web Dashboard Integration (React / Next.js)

1. Import `AlertInjectorControl.tsx` into your Next.js page or dashboard UI:
   ```tsx
   import { AlertInjectorControl } from "./dashboard/AlertInjectorControl";

   export default function DashboardPage() {
     return (
       <div>
         <h1>Command Center</h1>
         <AlertInjectorControl />
       </div>
     );
   }
   ```

---

## 🧪 End-to-End Verification

1. Start the backend (`uvicorn app:app --host 0.0.0.0 --port 8000`).
2. Run your Android app on device or emulator.
3. Click **⛈ Inject Rain** on the web dashboard (or send a `POST` request to `http://localhost:8000/api/v1/demo/inject-rainfall-storm`).
4. **Result**: Within 3 seconds, a heads-up system notification with vibration and sound pops up on the Android phone, and the top red Emergency Alert banner displays in-app.
