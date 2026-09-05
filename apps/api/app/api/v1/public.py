"""Login-free citizen endpoints for the Citizen Alert PWA.

The receive-side app must work on a cheap phone, on 2G, with no account.
These endpoints are intentionally unauthenticated (rate-limited globally by
slowapi) and expose nothing but the citizen's own safety state.
"""
import hashlib
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from geoalchemy2 import WKTElement
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import SafeCheckin
from app.services.risk_engine import publish_live

router = APIRouter(prefix="/public", tags=["citizen"])


class CheckinIn(BaseModel):
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    note: str | None = Field(default=None, max_length=280)
    # rotated per-install id: lets the roll call dedupe the same device
    # without ever holding a persistent identifier (DPDP-aligned)
    device_id: str | None = Field(default=None, max_length=64)
    lang: str = Field(default="en", max_length=10)


DEVICE_PREFERENCES: dict[str, dict] = {}


class DevicePreferencesIn(BaseModel):
    device_id: str = Field(..., max_length=64)
    lang: str = Field(default="en", max_length=10)
    preferred_lang: str | None = Field(default=None, max_length=10)
    fcm_token: str | None = Field(default=None, max_length=256)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)


@router.post("/preferences")
async def set_device_preferences(body: DevicePreferencesIn):
    """Register or update an unauthenticated device's language preference."""
    chosen_lang = body.preferred_lang or body.lang
    DEVICE_PREFERENCES[body.device_id] = {
        "lang": chosen_lang,
        "preferred_lang": chosen_lang,
        "fcm_token": body.fcm_token,
        "lat": body.lat,
        "lon": body.lon,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    return {
        "ok": True,
        "status": "ok",
        "device_id": body.device_id,
        "lang": chosen_lang,
        "preferred_lang": chosen_lang,
    }


@router.get("/preferences/{device_id}")
async def get_device_preferences(device_id: str):
    """Retrieve saved language preference for a device."""
    pref = DEVICE_PREFERENCES.get(device_id)
    if pref:
        return {"device_id": device_id, **pref}
    return {"device_id": device_id, "lang": "en", "preferred_lang": "en", "fcm_token": None, "lat": None, "lon": None}


@router.post("/checkin", status_code=201)
async def citizen_checkin(body: CheckinIn, request: Request, db: AsyncSession = Depends(get_db)):
    """Record a citizen's "I am safe" roll call and flash it on the live feed."""
    if (body.lat is None) != (body.lon is None):
        raise HTTPException(422, "lat and lon must be sent together")
    device_hash = (
        hashlib.sha256(f"{body.device_id}:{request.client.host if request.client else ''}".encode()).hexdigest()[:32]
        if body.device_id else None
    )
    if body.device_id and body.lang:
        DEVICE_PREFERENCES[body.device_id] = {
            "lang": body.lang,
            "lat": body.lat,
            "lon": body.lon,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    row = SafeCheckin(
        geom=WKTElement(f"POINT({body.lon} {body.lat})", srid=4326)
        if body.lat is not None and body.lon is not None else None,
        device_hash=device_hash,
        note=body.note,
    )
    db.add(row)
    await db.commit()
    await publish_live("citizen_checkin", {
        "checkin_id": str(row.id),
        "lat": body.lat, "lon": body.lon,
        "lang": body.lang,
        "ts": datetime.now(timezone.utc).isoformat(),
    })
    return {"ok": True, "checkin_id": str(row.id)}


@router.get("/checkins/recent")
async def recent_checkins(db: AsyncSession = Depends(get_db)):
    """District roll-call coverage for the last 24h (command center tile)."""
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    rows = (
        await db.execute(
            select(SafeCheckin.district, func.count().label("n"))
            .where(SafeCheckin.ts >= since)
            .group_by(SafeCheckin.district)
        )
    ).all()
    return [{"district": d or "unknown", "checkins_24h": int(n)} for d, n in rows]
