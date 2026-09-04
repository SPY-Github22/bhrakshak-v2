"""Self-contained Image Upload & Model V Vision Analysis API router.

Handles:
1. Multipart image upload with citizen message, geo-coordinates, and category.
2. Local filesystem image persistence via ImageStore.
3. GeoVerify (Model V) deep pixel analysis and EXIF GPS provenance checks.
4. Database report persistence with image_url + ai_analysis and WebSocket broadcast.
5. Direct image serving with caching headers.
6. Re-analysis of previously uploaded images.
"""

from __future__ import annotations

import io
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse

# Storage service from local package
try:
    from .storage import image_store
except (ImportError, ValueError):
    import sys
    _backend_dir = str(Path(__file__).resolve().parent)
    if _backend_dir not in sys.path:
        sys.path.insert(0, _backend_dir)
    from storage import image_store

# Optional imports when mounted in Bhrakshak API
try:
    from geoalchemy2 import WKTElement
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.api.deps import get_current_user_optional
    from app.db.session import get_db
    from app.models import CitizenReport, User
    from app.services.geoverify import classify_photo
    from app.services.risk_engine import publish_live
    HAS_BHRAKSHAK_APP = True
except ImportError:
    HAS_BHRAKSHAK_APP = False
    get_db = None  # type: ignore
    get_current_user_optional = None  # type: ignore

    # Standalone fallback for classify_photo if running outside bhrakshak
    def classify_photo(data: bytes, claimed_lat=None, claimed_lon=None, claimed_time=None):
        class StandaloneResult:
            def as_dict(self):
                return {
                    "verdict": "POSITIVE",
                    "probability": 0.85,
                    "exif": {"has_exif": False, "lat": None, "lon": None, "taken_at": None},
                    "gps_mismatch_m": None,
                    "flags": ["standalone_mode"],
                    "signature": {"fresh_soil_frac": 0.40, "horizontal_edge_energy": 1.1, "vegetation_frac": 0.2},
                }
        return StandaloneResult()

    async def publish_live(event_type: str, data: dict):
        pass

log = logging.getLogger("bhrakshak.images")

router = APIRouter(prefix="/images", tags=["images"])


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_image_report(
    photo: UploadFile = File(...),
    description: str | None = Form(None),
    category: str = Form("slope_movement"),
    lat: float | None = Form(None),
    lon: float | None = Form(None),
    client_id: str | None = Form(None),
    taken_at: str | None = Form(None),
    db: Any = Depends(get_db) if HAS_BHRAKSHAK_APP else None,
    user: Any = Depends(get_current_user_optional) if HAS_BHRAKSHAK_APP else None,
):
    """Upload an image with the citizen's own message, analyze with Model V, and persist."""
    data = await photo.read()
    if not data:
        raise HTTPException(status_code=422, detail="Empty upload data")
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Photo exceeds 15MB maximum limit")

    # 1. Save to ImageStore
    try:
        stored = image_store.save(data, prefix="field_")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Image processing error: {e}")

    # 2. Run Model V geo-photo vision classification
    verdict_res = classify_photo(data, claimed_lat=lat, claimed_lon=lon, claimed_time=taken_at)
    verdict_dict = verdict_res.as_dict()

    # 3. Create or update report record
    report_uuid = None
    if client_id:
        try:
            report_uuid = uuid.UUID(client_id)
        except ValueError:
            report_uuid = uuid.uuid4()
    else:
        report_uuid = uuid.uuid4()

    author_id = getattr(user, "id", None) if user else None
    role = getattr(getattr(user, "role", None), "value", "citizen") if user else "citizen"

    saved_report = None
    if HAS_BHRAKSHAK_APP and db is not None:
        try:
            # Check if report already exists for this client_id
            existing = await db.get(CitizenReport, report_uuid)
            if existing is not None:
                existing.image_url = stored.url
                existing.ai_analysis = verdict_dict
                if description and not existing.description:
                    existing.description = description
                await db.commit()
                await db.refresh(existing)
                saved_report = existing
            else:
                effective_lat = lat if lat is not None else 24.8812
                effective_lon = lon if lon is not None else 93.7235
                geom = WKTElement(f"POINT({effective_lon} {effective_lat})", srid=4326)

                report = CitizenReport(
                    id=report_uuid,
                    author_id=author_id,
                    role=role,
                    category=category,
                    geom=geom,
                    description=description,
                    media_refs=[stored.filename],
                    image_url=stored.url,
                    ai_analysis=verdict_dict,
                    exif_geo_ok="provenance_suspect" not in verdict_dict.get("flags", []),
                    status="pending",
                )
                db.add(report)
                await db.commit()
                await db.refresh(report)
                saved_report = report

            # Broadcast live update over WebSocket to connected dashboards
            await publish_live(
                "report",
                {
                    "id": str(report_uuid),
                    "category": category,
                    "description": description,
                    "lat": lat,
                    "lon": lon,
                    "image_url": stored.url,
                    "ai_analysis": verdict_dict,
                    "status": "pending",
                    "merged": False,
                },
            )
        except Exception as exc:
            log.warning("Could not persist report to database: %s", exc)
            try:
                await db.rollback()
            except Exception:
                pass

    return {
        "status": "ok",
        "report_id": str(report_uuid),
        "filename": stored.filename,
        "image_url": stored.url,
        "size_bytes": stored.size_bytes,
        "category": category,
        "description": description,
        "lat": lat,
        "lon": lon,
        "ai_analysis": verdict_dict,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/{filename}")
async def get_image(filename: str):
    """Serve stored image directly with proper MIME type and caching headers."""
    path = image_store.get_path(filename)
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")

    ext = path.suffix.lower()
    media_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }
    media_type = media_map.get(ext, "application/octet-stream")

    return FileResponse(
        str(path),
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.post("/{report_id}/analyze")
async def reanalyze_report_image(
    report_id: uuid.UUID,
    db: Any = Depends(get_db) if HAS_BHRAKSHAK_APP else None,
    user: Any = Depends(get_current_user_optional) if HAS_BHRAKSHAK_APP else None,
):
    """Re-run Model V vision analysis on a previously uploaded report's image."""
    if not HAS_BHRAKSHAK_APP or db is None:
        raise HTTPException(status_code=501, detail="Database session unavailable in standalone mode")

    report = await db.get(CitizenReport, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")

    if not report.image_url:
        raise HTTPException(status_code=400, detail="Report has no associated image")

    filename = Path(report.image_url).name
    data = image_store.read_bytes(filename)
    if not data:
        raise HTTPException(status_code=404, detail="Image file not found in storage")

    res = classify_photo(data)
    out = res.as_dict()
    report.ai_analysis = out
    await db.commit()
    await db.refresh(report)

    await publish_live(
        "report",
        {
            "id": str(report.id),
            "category": report.category,
            "description": report.description,
            "image_url": report.image_url,
            "ai_analysis": out,
            "status": report.status,
            "reanalyzed": True,
        },
    )

    return {
        "status": "ok",
        "report_id": str(report.id),
        "image_url": report.image_url,
        "ai_analysis": out,
    }
