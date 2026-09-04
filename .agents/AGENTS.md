# Project Rules

- **Android APK Downloads**: Whenever the Android APK is compiled or updated, always copy `bhrakshak-field-latest.apk` directly into the user's `~/Downloads` folder (`/home/sudpy/Downloads/bhrakshak-field-latest.apk`) so it is always immediately accessible in their system Downloads folder.

- **Port Occupancy & API Process Verification**: When diagnosing API 404s, unhandled endpoints, or sync failures between the Web Dashboard (`http://localhost:3000`), Backend API (`:8000`), and Mobile Tunnel, ALWAYS inspect port occupancy (`ss -tlpn | grep <port>`) and verify the command line of the PID (`cat /proc/<pid>/cmdline`) BEFORE modifying backend routes. Ensure stale/mock scripts are killed, the real FastAPI backend is running on `0.0.0.0:8000`, and CORS is configured for wildcard (`*`) access across all local and tunnel origins.

