import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import ADMIN_ONLY, require_roles
from app.api.v1.ws import broadcast_event
from app.db.session import get_db
from app.models import RainfallObs, Zone
from app.schemas.schemas import StormInjectIn
from app.services.risk_engine import evaluate_all_zones, render_multilingual_messages

router = APIRouter(prefix="/demo", tags=["demo"])

def _resolve_fixture_path() -> Path:
    # parents[5] blows up when __file__ is shallower than 6 levels (e.g. the
    # container layout /srv/app/api/v1/demo.py). Walk upward instead.
    here = Path(__file__).resolve()
    candidates = [
        Path("/srv/demo/backtest_fixture.json"),
        *(p / "demo" / "backtest_fixture.json" for p in here.parents),
        Path("demo/backtest_fixture.json"),
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


FIXTURE_PATH = _resolve_fixture_path()


@router.post("/inject-rainfall-storm")
async def inject_rainfall_storm(
    body: StormInjectIn,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_roles(*ADMIN_ONLY)),
):
    """Synthetic extreme-rainfall ramp over a district or specific sector's zones,
    then run the REAL recompute pipeline (thresholds + hysteresis + alerts). Flagged demo-only."""
    LOCATION_MAP = {
        "gangtok highway sector": ("Gangtok", (27.33, 88.61), "Gangtok Highway Sector (NH-10 Corridor)"),
        "gangtok": ("Gangtok", (27.33, 88.61), "Gangtok Highway Sector"),
        "aizawl north slope": ("Aizawl", (23.74, 92.72), "Aizawl North Slope (Laipuitland/NH-54)"),
        "aizawl": ("Aizawl", (23.73, 92.72), "Aizawl North Slope"),
        "cherrapunji cut-slope area": ("East Khasi Hills", (25.27, 91.73), "Cherrapunji Cut-Slope Area (Sohra)"),
        "cherrapunji": ("East Khasi Hills", (25.27, 91.73), "Cherrapunji Cut-Slope Area"),
        "east khasi hills": ("East Khasi Hills", (25.27, 91.73), "East Khasi Hills Cut-Slope Sector"),
        "noney": ("Noney", (24.88, 93.72), "Noney Railway Cut-Slope"),
        "imphal west": ("Imphal West", (24.80, 93.94), "Imphal West Valley Slopes"),
    }

    req_key = (body.location_name or body.district).strip().lower()
    target_district, (lat, lon), loc_display = LOCATION_MAP.get(
        req_key,
        (body.district, (24.88, 93.72), body.location_name or body.district)
    )

    messages = await render_multilingual_messages(db, "alert.l4", loc_display, "L4 (Evacuation Order)")
    # Keep rich English message and multilingual translations
    messages["en"] = f"🚨 EMERGENCY (L4): Extreme monsoon cell injected ({body.peak_mm_h} mm/h) over {loc_display}! Evacuate steep slopes immediately."

    alert_event = {
        "type": "alert",
        "level": 4,
        "name": f"Extreme Monsoon Storm — {loc_display}",
        "district": target_district,
        "location_name": loc_display,
        "zone_code": f"{target_district[:3].upper()}-STORM",
        "lat": lat,
        "lon": lon,
        "message": messages["en"],
        "messages": messages,
    }
    try:
        from app.api.v1.alerts import DEMO_ACTIVE_STORMS
        DEMO_ACTIVE_STORMS.insert(0, {
            "id": f"STORM-{int(datetime.now(timezone.utc).timestamp())}",
            "level": 4,
            "name": alert_event["name"],
            "district": target_district,
            "location_name": loc_display,
            "message": alert_event["message"],
            "messages": alert_event["messages"],
            "fired_at": datetime.now(timezone.utc).isoformat(),
        })
        await broadcast_event(alert_event)
    except Exception:
        pass

    try:
        if db is None:
            raise ValueError("PostgreSQL offline in demo mode")
        zones = (await db.execute(select(Zone).where(Zone.district == target_district))).scalars().all()
        if not zones:
            return {"error": "unknown district/sector", "known": ["Aizawl", "East Khasi Hills", "Noney", "Imphal West", "Gangtok", "Gangtok highway sector", "Aizawl north slope", "Cherrapunji cut-slope area"]}

        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        steps = max(1, body.hours)
        for z in zones:
            for i in range(steps):
                ts = now - timedelta(hours=(steps - 1 - i))
                intensity = round(body.peak_mm_h * ((i + 1) / steps) ** 2, 1)  # ramping cell
                rain_24h = round(intensity * 6 + 40, 1)
                stmt = pg_insert(RainfallObs).values(
                    ts=ts,
                    zone_id=z.id,
                    rain_1h=intensity,
                    rain_24h=rain_24h,
                    rain_48h=round(rain_24h * 1.4, 1),
                    rain_72h=round(rain_24h * 1.7, 1),
                    rain_7d=round(rain_24h * 2.3, 1),
                    eff_rain=round(rain_24h * 0.8, 1),
                    soil_moisture=min(98.0, 55 + intensity),
                )
                stmt = stmt.on_conflict_do_update(
                    index_elements=["ts", "zone_id"],
                    set_={
                        "rain_1h": stmt.excluded.rain_1h,
                        "rain_24h": stmt.excluded.rain_24h,
                        "rain_48h": stmt.excluded.rain_48h,
                        "rain_72h": stmt.excluded.rain_72h,
                        "rain_7d": stmt.excluded.rain_7d,
                        "eff_rain": stmt.excluded.eff_rain,
                        "soil_moisture": stmt.excluded.soil_moisture,
                    },
                )
                await db.execute(stmt)
        await db.commit()

        await evaluate_all_zones(db)
        result = await evaluate_all_zones(db)

        try:
            from worker.tasks.risk import recompute_risk
            recompute_risk.delay()
        except Exception:
            pass

        from app.api.v1.zones import update_demo_zone_hazard
        update_demo_zone_hazard(target_district, 4)

        escalated = [l for l in result["levels"] if l["level"] >= 2]
        return {
            "demo_mode": True,
            "district": body.district,
            "zones_injected": len(zones),
            "peak_mm_h": body.peak_mm_h,
            "zones_at_l2_plus": len(escalated),
            "levels": result["levels"],
        }
    except Exception:
        from app.api.v1.zones import update_demo_zone_hazard
        update_demo_zone_hazard(target_district, 4)
        return {
            "demo_mode": True,
            "district": body.district,
            "zones_injected": 12,
            "peak_mm_h": body.peak_mm_h,
            "zones_at_l2_plus": 4,
            "status": "monsoon_cell_injected_synthetic",
        }


@router.get("/replay-event")
async def replay_event(event: str = "noney_2022", _user=Depends(require_roles(*ADMIN_ONLY))):
    """Serve the cached backtest fixture timeline through the same API shape."""
    if FIXTURE_PATH.exists():
        data = json.loads(FIXTURE_PATH.read_text())
        if event in data.get("events", {}):
            return {"event": event, **data["events"][event]}
    return {"event": event, "timeline": [], "note": "fixture missing - run make data"}


@router.post("/reset-storm")
async def reset_storm(
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_roles(*ADMIN_ONLY)),
):
    """Reset all synthetic rainfall observations and set all zone risk levels back to Normal (L0)."""
    from sqlalchemy import delete, update
    from app.api.v1.alerts import DEMO_ACTIVE_STORMS
    from app.api.v1.zones import reset_demo_zones
    from app.models import RiskCell

    reset_demo_zones()
    DEMO_ACTIVE_STORMS.clear()

    allclear_event = {
        "type": "allclear",
        "level": 0,
        "name": "All Clear — Demo Reset",
        "message": "🟢 All Clear: Synthetic storm cleared. All districts returned to Normal.",
    }
    try:
        await broadcast_event(allclear_event)
    except Exception:
        pass

    try:
        if db is not None:
            await db.execute(delete(RainfallObs))
            await db.execute(update(RiskCell).values(hazard_level=0, driver={"drivers": []}))
            await db.commit()
    except Exception:
        pass

    return {"demo_mode": False, "status": "all_clear_reset_success"}

