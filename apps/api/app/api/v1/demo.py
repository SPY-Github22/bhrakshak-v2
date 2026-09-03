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
from app.services.risk_engine import evaluate_all_zones

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
    """Synthetic extreme-rainfall ramp over a district's zones, then run the REAL
    recompute pipeline (thresholds + hysteresis + alerts). Flagged demo-only."""
    district_coords = {
        "Noney": (24.88, 93.72),
        "East Khasi Hills": (25.27, 91.73),
        "Aizawl": (23.73, 92.72),
        "Gangtok": (27.33, 88.61),
        "Imphal West": (24.80, 93.94),
    }
    lat, lon = district_coords.get(body.district, (24.88, 93.72))
    alert_event = {
        "type": "alert",
        "level": 4,
        "name": f"Extreme Monsoon Storm — {body.district}",
        "district": body.district,
        "zone_code": f"{body.district[:3].upper()}-STORM",
        "lat": lat,
        "lon": lon,
        "message": f"🚨 EMERGENCY (L4): Extreme monsoon cell injected ({body.peak_mm_h} mm/h) over {body.district}! Evacuate steep slopes immediately.",
    }
    try:
        await broadcast_event(alert_event)
    except Exception:
        pass

    try:
        if db is None:
            raise ValueError("PostgreSQL offline in demo mode")
        zones = (await db.execute(select(Zone).where(Zone.district == body.district))).scalars().all()
        if not zones:
            return {"error": "unknown district", "known": ["Aizawl", "East Khasi Hills", "Noney", "Imphal West", "Gangtok"]}

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
