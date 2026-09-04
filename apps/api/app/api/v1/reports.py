import logging
import math
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from geoalchemy2 import WKTElement
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import OPS_ROLES, STAFF_ROLES, get_current_user, require_roles
from app.db.session import get_db
from app.models import CitizenReport, Role, User
from app.schemas.schemas import ReportIn, ReportOut, SyncBatchIn, SyncBatchOut
from app.services.risk_engine import publish_live

log = logging.getLogger("bhrakshak.reports")

router = APIRouter(prefix="/reports", tags=["reports"])

DEDUP_RADIUS_M = 50
DEDUP_WINDOW_H = 1


async def _find_duplicate(db: AsyncSession, lat: float, lon: float, category: str) -> CitizenReport | None:
    """Proximity dedupe using PostGIS: <50m, <1h, same category -> merge into existing report."""
    since = datetime.now(timezone.utc) - timedelta(hours=DEDUP_WINDOW_H)
    pt = WKTElement(f"POINT({lon} {lat})", srid=4326)
    q = (
        select(CitizenReport)
        .where(
            CitizenReport.category == category,
            CitizenReport.created_at >= since,
            func.ST_DWithin(
                func.ST_Transform(CitizenReport.geom, 3857),
                func.ST_Transform(pt, 3857),
                DEDUP_RADIUS_M,
            ),
        )
        .order_by(CitizenReport.created_at.desc())
        .limit(1)
    )
    res = await db.execute(q)
    return res.scalar_one_or_none()


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


@router.post("", response_model=ReportOut, status_code=201)
async def create_report(
    body: ReportIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await _upsert_report(db, body, user)


@router.post("/sync", response_model=SyncBatchOut)
async def sync_reports(
    batch: SyncBatchIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Idempotent offline sync: upsert by client UUID; duplicates merged.

    Honesty contract: `accepted` only counts reports that actually persisted
    (or were deduped into an existing report). A failed DB write is reported
    as rejected in `rejected_ids`, never silently swallowed -- the mobile
    client must be able to trust the response to drop its queued rows.
    """
    accepted, merged, flagged = 0, 0, 0
    synced: list[str] = []
    rejected: list[str] = []
    last_error: str | None = None

    for item in batch.reports:
        try:
            dup = await _find_duplicate(db, item.lat, item.lon, item.category)
            if dup is not None:
                dup.dup_count = (dup.dup_count or 0) + 1
                await db.commit()
                merged += 1
                synced.append(item.client_id)
                await publish_live("report", {
                    "id": str(dup.id),
                    "category": dup.category,
                    "dup_count": dup.dup_count,
                    "merged": True,
                })
                continue
            out = await _upsert_report(db, item, user, sync_batch=batch.batch_id)
            accepted += 1
            synced.append(item.client_id)
            await publish_live("report", {
                "id": str(out.id),
                "category": out.category,
                "description": out.description,
                "lat": out.lat,
                "lon": out.lon,
                "status": out.status,
                "merged": False,
            })
        except Exception as exc:  # surface, don't swallow
            rejected.append(item.client_id)
            last_error = str(exc)
            try:
                await db.rollback()
            except Exception:
                pass

    if rejected and last_error:
        log.warning("reports/sync: %d/%d rejected, last error: %s",
                    len(rejected), len(batch.reports), last_error)

    return SyncBatchOut(
        batch_id=batch.batch_id,
        accepted=accepted,
        duplicates_merged=merged,
        flagged=flagged,
        synced_ids=synced,
        rejected_ids=rejected,
    )


async def _upsert_report(db: AsyncSession, item: ReportIn, user: User, sync_batch: uuid.UUID | None = None) -> ReportOut:
    report = CitizenReport(
        id=item.client_id,
        author_id=user.id,
        role=user.role.value,
        category=item.category,
        geom=WKTElement(f"POINT({item.lon} {item.lat})", srid=4326),
        description=item.description,
        media_refs=item.media_refs or [],
        taken_at=item.taken_at,
        sync_batch=sync_batch,
        exif_geo_ok=item.exif_geo_ok,
        status="pending",
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    out = ReportOut.model_validate(report)
    out.lon = float(item.lon)
    out.lat = float(item.lat)
    return out


DEMO_REPORTS: list[ReportOut] = [
    ReportOut(
        id=uuid.UUID("00000000-0000-0000-0000-000000000201"),
        author_id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
        role="responder",
        category="slope_movement",
        description="Fresh tension cracks (12cm wide) observed above NH-37 Tupul Bypass cutting.",
        status="pending",
        dup_count=0,
        exif_geo_ok=True,
        taken_at=datetime.now(timezone.utc) - timedelta(minutes=20),
        created_at=datetime.now(timezone.utc) - timedelta(minutes=20),
        lat=24.8812,
        lon=93.7235,
    ),
    ReportOut(
        id=uuid.UUID("00000000-0000-0000-0000-000000000202"),
        author_id=uuid.UUID("00000000-0000-0000-0000-000000000002"),
        role="citizen",
        category="water_seepage",
        description="Turbid muddy water springing rapidly from cut-slope base near Sohra Valley.",
        status="pending",
        dup_count=1,
        exif_geo_ok=True,
        taken_at=datetime.now(timezone.utc) - timedelta(hours=1),
        created_at=datetime.now(timezone.utc) - timedelta(hours=1),
        lat=25.2750,
        lon=91.7310,
    ),
]


@router.get("", response_model=list[ReportOut])
async def list_reports(status_filter: str | None = "pending", limit: int = 100,
                       db: AsyncSession = Depends(get_db), user: User = Depends(require_roles(*STAFF_ROLES))):
    if db is None:
        res = DEMO_REPORTS
        if status_filter:
            res = [r for r in res if r.status == status_filter]
        return res[:limit]
    try:
        q = select(
            CitizenReport,
            func.ST_X(CitizenReport.geom),
            func.ST_Y(CitizenReport.geom),
        ).order_by(CitizenReport.created_at.desc()).limit(limit)
        if status_filter:
            q = q.where(CitizenReport.status == status_filter)
        rows = (await db.execute(q)).all()
        outs = []
        for r, lon, lat in rows:
            o = ReportOut.model_validate(r)
            if lon is not None and lat is not None:
                o.lon = float(lon)
                o.lat = float(lat)
            outs.append(o)
        return outs
    except Exception:
        res = DEMO_REPORTS
        if status_filter:
            res = [r for r in res if r.status == status_filter]
        return res[:limit]


@router.post("/analyze-photo", status_code=200)
async def analyze_photo(
    lat: float | None = None,
    lon: float | None = None,
    taken_at: str | None = None,
    photo: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Model V — "is there a landslide in this photo?"

    EXIF GPS + capture time are read from the image itself and cross-checked
    against the claimed coordinates (>300 m = provenance flag). The pixel
    signature (fresh-soil fraction, scarp edge energy, vegetation cover) maps
    to P(landslide visible) with a POSITIVE / POSSIBLE / NEGATIVE verdict.

    The PWA calls this BEFORE queueing the report so the operator sees the
    AI pre-screen attached to the queue entry; the verdict is persisted on
    the report's ai_analysis when the report is later synced with the same
    media.
    """
    import uuid as _uuid

    from app.services.geoverify import classify_photo

    data = await photo.read()
    if not data:
        raise HTTPException(422, "empty upload")
    if len(data) > 12 * 1024 * 1024:
        raise HTTPException(413, "photo exceeds 12MB")

    res = classify_photo(data, claimed_lat=lat, claimed_lon=lon, claimed_time=taken_at)
    out = res.as_dict()

    # Attach the AI verdict to the report if the client already created one
    # with this photo's hash in media_refs (PWA computes sha1 as media key).
    # The lookup is best-effort: with the database unreachable (demo mode /
    # degraded deployment) the verdict must still reach the client — the
    # attachment can happen on a later call once the DB is back.
    import hashlib

    media_key = f"sha1:{hashlib.sha1(data).hexdigest()}"
    try:
        row = (
            await db.execute(
                select(CitizenReport).where(CitizenReport.media_refs.any(media_key)).order_by(
                    CitizenReport.created_at.desc()
                ).limit(1)
            )
        ).scalar_one_or_none()
        if row is not None:
            row.ai_analysis = out
            await db.commit()
    except Exception as exc:  # DB down / write failed — never fail the upload
        log.warning("analyze-photo: verdict attach skipped (db unavailable): %s", exc)

    out["media_key"] = media_key
    return out


@router.patch("/{report_id}/verify", response_model=ReportOut)
async def verify_report(
    report_id: uuid.UUID,
    decision: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_roles(*OPS_ROLES)),
):
    if decision not in ("verified", "rejected"):
        raise HTTPException(422, "decision must be verified|rejected")
    report = await db.get(CitizenReport, report_id)
    if report is None:
        raise HTTPException(404, "Report not found")
    report.status = decision
    report.verified_by = user.id
    report.risk_contribution = 0.05 if decision == "verified" else 0.0
    await db.commit()
    await db.refresh(report)
    return ReportOut.model_validate(report)
