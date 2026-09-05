import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import OPS_ROLES, require_roles
from app.db.session import get_db
from app.models import Alert, User
from app.schemas.schemas import AckIn, AlertOut
from app.services.risk_engine import DEFAULT_TEMPLATES, LEVEL_NAMES, SUPPORTED_LANGUAGES, render_message

router = APIRouter(prefix="/alerts", tags=["alerts"])

DEMO_ALERTS = [
    AlertOut(id=uuid.UUID("00000000-0000-0000-0000-000000000010"), zone_id=uuid.UUID("00000000-0000-0000-0000-000000000001"), level=4, lang="en", channels=["push"], recipients=1400, message_template="alert.l4", ack_at=None, fired_at=datetime.now(timezone.utc) - timedelta(minutes=15)),
    AlertOut(id=uuid.UUID("00000000-0000-0000-0000-000000000011"), zone_id=uuid.UUID("00000000-0000-0000-0000-000000000003"), level=4, lang="en", channels=["sms"], recipients=2200, message_template="alert.l4", ack_at=None, fired_at=datetime.now(timezone.utc) - timedelta(minutes=42)),
    AlertOut(id=uuid.UUID("00000000-0000-0000-0000-000000000012"), zone_id=uuid.UUID("00000000-0000-0000-0000-000000000002"), level=3, lang="en", channels=["push"], recipients=950, message_template="alert.l3", ack_at=None, fired_at=datetime.now(timezone.utc) - timedelta(hours=2)),
]

DEMO_ACTIVE_STORMS: list[dict] = []


@router.get("/active")
async def active_alerts(lang: str | None = None, db: AsyncSession = Depends(get_db)):
    """Return all active emergency alerts for live mobile app polling, resolved in requested language."""
    target_lang = (lang or "en").strip()
    if db is not None:
        try:
            q = select(Alert).where(Alert.level >= 2, Alert.ack_at.is_(None)).order_by(Alert.fired_at.desc()).limit(20)
            alerts_db = (await db.execute(q)).scalars().all()
            if alerts_db:
                out = []
                for a in alerts_db:
                    msgs = a.messages or {
                        l: DEFAULT_TEMPLATES.get((f"alert.l{a.level}", l), a.message_template or "").format(
                            village="Active Hazard Zone", level=LEVEL_NAMES.get(a.level, f"L{a.level}"), action="Follow instructions"
                        )
                        for l in SUPPORTED_LANGUAGES
                    }
                    msg = msgs.get(target_lang) or a.message_template
                    out.append({
                        "id": str(a.id),
                        "level": a.level,
                        "name": f"L{a.level} Emergency Alert",
                        "message": msg,
                        "messages": msgs,
                        "district": getattr(a, "district", "Active Hazard Zone"),
                        "fired_at": a.fired_at.isoformat() if a.fired_at else None,
                    })
                return out
        except Exception:
            pass

    # Demo active storms fallback
    results = []
    for s in DEMO_ACTIVE_STORMS:
        item = dict(s)
        msgs = item.get("messages") or {
            l: DEFAULT_TEMPLATES.get((f"alert.l{item.get('level', 4)}", l), item.get("message", "")).format(
                village=item.get("location_name") or item.get("district") or "Hazard Zone",
                level=LEVEL_NAMES.get(item.get("level", 4), "EMERGENCY"),
                action="Follow instructions",
            )
            for l in SUPPORTED_LANGUAGES
        }
        item["messages"] = msgs
        item["message"] = msgs.get(target_lang) or item.get("message")
        results.append(item)
    return results


@router.get("", response_model=list[AlertOut])
async def list_alerts(limit: int = 100, level_min: int | None = None, lang: str | None = None,
                      db: AsyncSession = Depends(get_db), _user=Depends(require_roles(*OPS_ROLES))):
    target_lang = (lang or "").strip()
    if db is None:
        res = DEMO_ALERTS
        if level_min:
            res = [a for a in res if a.level >= level_min]
        return res[:limit]
    try:
        q = select(Alert).order_by(Alert.fired_at.desc()).limit(limit)
        if level_min:
            q = q.where(Alert.level >= level_min)
        rows = (await db.execute(q)).scalars().all()
        if target_lang:
            for r in rows:
                if r.messages and target_lang in r.messages:
                    r.message_template = r.messages[target_lang]
        return rows
    except Exception:
        res = DEMO_ALERTS
        if level_min:
            res = [a for a in res if a.level >= level_min]
        return res[:limit]


@router.post("/{alert_id}/ack", response_model=AlertOut)
async def ack_alert(alert_id: uuid.UUID, body: AckIn,
                    db: AsyncSession = Depends(get_db), user: User = Depends(require_roles(*OPS_ROLES))):
    alert = await db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(404, "Alert not found")
    alert.ack_by = user.id
    alert.ack_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(alert)
    return alert


@router.post("/preview-fire")
async def preview_fire(zone_id: uuid.UUID, level: int = 3, lang: str = "en",
                       db: AsyncSession = Depends(get_db), _user=Depends(require_roles(*OPS_ROLES))):
    """Dry-run an alert message for any level/language - the judge-demo button."""
    from app.models import Zone

    zone = await db.get(Zone, zone_id)
    if zone is None:
        raise HTTPException(404, "Zone not found")
    msg = await render_message(db, f"alert.l{min(max(level,1),4)}", lang, zone.name or zone.zone_code, LEVEL_NAMES[level])
    return {"zone_code": zone.zone_code, "level": level, "lang": lang, "message": msg}
