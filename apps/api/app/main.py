import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.api.v1 import alerts, analytics, auth, ble, briefing, chat, demo, evacuation, incident_command, ingest, logistics, mesh, nearby, public, reports, roads, ws, zones
from app.core.config import settings


def _json_logger():
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(logging.Formatter('{"ts":"%(asctime)s","lvl":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}'))
    root = logging.getLogger()
    root.handlers = [h]
    root.setLevel(logging.INFO)
    return logging.getLogger("bhrakshak")


log = _json_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast: a default/short HMAC key in production means anyone can mint
    # tokens. Demo keeps working; only a non-demo deployment is blocked.
    if not settings.demo_mode and settings.jwt_secret_is_default:
        raise RuntimeError(
            "JWT_SECRET must be overridden with a >=32-char secret when "
            "DEMO_MODE=false — refusing to start with the default key"
        )
    log.info("%s starting (demo_mode=%s)", settings.app_name, settings.demo_mode)
    yield
    log.info("shutdown complete")


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="AI Landslide Early Warning & Risk Intelligence Platform for NER (SIH26001)",
    lifespan=lifespan,
)

limiter = Limiter(key_func=get_remote_address, default_limits=["600/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (auth.router, zones.router, reports.router, alerts.router, roads.router,
          demo.router, analytics.router, briefing.router, ingest.router, logistics.router,
          incident_command.router, evacuation.router, ble.router, mesh.router, nearby.router, public.router, chat.router):
    app.include_router(r, prefix="/api/v1")
app.include_router(ws.router)  # websocket at /ws/live


from fastapi.responses import FileResponse, JSONResponse

_APK_CANDIDATES = (
    "/home/sudpy/Landslide Proto/bhrakshak/bhrakshak-field-latest.apk",
    "/home/sudpy/Landslide Proto/bhrakshak-v2/apps/android/bhrakshak-field-latest.apk",
    "/home/sudpy/Landslide Proto/bhrakshak-v2/bhrakshak-field-latest.apk",
)


@app.get("/download/apk", tags=["ops"])
async def download_apk():
    """Serve the pre-built field APK from whichever copy exists on disk."""
    from pathlib import Path

    for candidate in _APK_CANDIDATES:
        p = Path(candidate)
        if p.is_file():
            return FileResponse(
                str(p), media_type="application/vnd.android.package-archive",
                filename="bhrakshak-field-latest.apk",
            )
    raise HTTPException(status_code=404, detail="no APK artifact found on server")


@app.get("/health", tags=["ops"])
async def health():
    return {"status": "ok", "service": "bhrakshak-api", "demo_mode": settings.demo_mode}


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    log.error("unhandled error on %s: %s", request.url.path, exc)
    return JSONResponse(status_code=500, content={"detail": "internal error"})
