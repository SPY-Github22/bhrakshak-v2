import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from geoalchemy2 import functions as gfunc
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import Alert, CitizenReport, RainfallObs, RiskCell, SensorReading, Zone
from app.schemas.schemas import ZoneDossier, ZoneOut
from app.services.priority import flood_index, isolation_score
from app.services.risk_engine import generate_dc_directive

router = APIRouter(prefix="/zones", tags=["zones"])

FIXTURE_PATH = Path("/srv/demo/backtest_fixture.json")


def _historical_events() -> list[dict]:
    """Real event anchors from the backtest fixture until the GSI/COOLR
    inventory loader lands. Rendered as 'nearby history' in the dossier."""
    try:
        fx = json.loads(FIXTURE_PATH.read_text())
        out = []
        for key, ev in fx.get("events", {}).items():
            out.append({
                "event": key, "name": ev["name"], "date": ev["date"],
                "fatalities": ev.get("fatalities"), "zone": ev.get("anchor_zone"),
            })
        return out
    except Exception:
        return []


async def _zone_out(db: AsyncSession, z: Zone) -> ZoneOut:
    cell = await db.get(RiskCell, z.id)
    return ZoneOut(
        id=z.id,
        zone_code=z.zone_code,
        name=z.name,
        district=z.district,
        state=z.state,
        susc_mean=z.susc_mean,
        susc_p90=z.susc_p90,
        population=z.population,
        road_km=z.road_km,
        hazard_level=cell.hazard_level if cell else 0,
        prob_24h=cell.prob_24h if cell else None,
    )


DEMO_PILOT_ZONES = [
    ZoneOut(id=uuid.UUID("00000000-0000-0000-0000-000000000001"), zone_code="MN-NON-001", name="Tupul Station Yard", district="Noney", state="Manipur", susc_mean=82.5, susc_p90=91.0, population=1400, road_km=12.4, hazard_level=4, prob_24h=0.88),
    ZoneOut(id=uuid.UUID("00000000-0000-0000-0000-000000000002"), zone_code="MN-NON-002", name="Noney Bridge 144", district="Noney", state="Manipur", susc_mean=78.0, susc_p90=85.0, population=950, road_km=8.2, hazard_level=3, prob_24h=0.62),
    ZoneOut(id=uuid.UUID("00000000-0000-0000-0000-000000000003"), zone_code="ML-EKH-001", name="Cherrapunji Cut-Slope", district="East Khasi Hills", state="Meghalaya", susc_mean=88.0, susc_p90=94.0, population=2200, road_km=18.5, hazard_level=4, prob_24h=0.92),
    ZoneOut(id=uuid.UUID("00000000-0000-0000-0000-000000000004"), zone_code="ML-EKH-002", name="Sohra Valley Corridor", district="East Khasi Hills", state="Meghalaya", susc_mean=74.0, susc_p90=81.0, population=1800, road_km=14.1, hazard_level=3, prob_24h=0.58),
    ZoneOut(id=uuid.UUID("00000000-0000-0000-0000-000000000005"), zone_code="MZ-AIZ-001", name="Aizawl North Slope", district="Aizawl", state="Mizoram", susc_mean=71.0, susc_p90=79.0, population=3100, road_km=22.0, hazard_level=2, prob_24h=0.42),
    ZoneOut(id=uuid.UUID("00000000-0000-0000-0000-000000000006"), zone_code="SK-GAN-001", name="Gangtok Highway Sector KM 8", district="Gangtok", state="Sikkim", susc_mean=76.0, susc_p90=83.0, population=2500, road_km=16.8, hazard_level=2, prob_24h=0.39),
]

def update_demo_zone_hazard(district: str, level: int = 4):
    for z in DEMO_PILOT_ZONES:
        if z.district and z.district.lower() == district.lower():
            z.hazard_level = level
            z.prob_24h = 0.95 if level >= 4 else 0.50

def reset_demo_zones():
    for z in DEMO_PILOT_ZONES:
        z.hazard_level = 0
        z.prob_24h = 0.05

def _demo_zones(district: str | None = None, level_min: int | None = None) -> list[ZoneOut]:
    res = DEMO_PILOT_ZONES
    if district:
        res = [z for z in res if z.district.lower() == district.lower()]
    if level_min is not None:
        res = [z for z in res if z.hazard_level >= level_min]
    return res


@router.get("", response_model=list[ZoneOut])
async def list_zones(
    bbox: str | None = None,  # minlon,minlat,maxlon,maxlat
    district: str | None = None,
    level_min: int | None = None,
    db: AsyncSession = Depends(get_db),
):
    if db is None:
        return _demo_zones(district, level_min)
    try:
        q = select(Zone)
        if district:
            q = q.where(Zone.district == district)
        if bbox:
            try:
                minlon, minlat, maxlon, maxlat = [float(x) for x in bbox.split(",")]
            except ValueError:
                raise HTTPException(422, "bbox must be minlon,minlat,maxlon,maxlat")
            env = gfunc.ST_MakeEnvelope(minlon, minlat, maxlon, maxlat, 4326)
            q = q.where(gfunc.ST_Intersects(Zone.geom, env))
        zones = (await db.execute(q)).scalars().all()

        cells = {
            c.zone_id: c
            for c in (await db.execute(select(RiskCell))).scalars().all()
        }
        outs = []
        for z in zones:
            cell = cells.get(z.id)
            outs.append(ZoneOut(
                id=z.id,
                zone_code=z.zone_code,
                name=z.name,
                district=z.district,
                state=z.state,
                susc_mean=z.susc_mean,
                susc_p90=z.susc_p90,
                population=z.population,
                road_km=z.road_km,
                hazard_level=cell.hazard_level if cell else 0,
                prob_24h=cell.prob_24h if cell else None,
            ))
        if level_min is not None:
            outs = [o for o in outs if o.hazard_level >= level_min]
        return outs
    except Exception:
        return _demo_zones(district, level_min)


@router.get("/{zone_id}/weather")
async def zone_weather(zone_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Rain-gauge panel for the PWA/dashboard: live accumulations, soil
    moisture, Kohler-Linsley antecedent index, and I-D threshold breach status.

    Reads ONLY measured rainfall_obs rows — no synthetic interpolation, no
    external calls, so it answers instantly and works offline (last known
    values are what a rain gauge actually shows when the link drops).
    """
    from app.services.geotech import check_rainfall_id_exceedance

    zone = await db.get(Zone, zone_id)
    if zone is None:
        raise HTTPException(404, "Zone not found")
    since = datetime.now(timezone.utc) - timedelta(hours=72)
    rows = (
        await db.execute(
            select(RainfallObs)
            .where(RainfallObs.zone_id == zone.id, RainfallObs.ts >= since)
            .order_by(RainfallObs.ts)
        )
    ).scalars().all()
    if not rows:
        return {
            "zone_code": zone.zone_code,
            "district": zone.district,
            "has_data": False,
            "note": "no rainfall observations in the last 72h",
        }
    latest = rows[-1]
    series = [
        {
            "ts": r.ts.isoformat(),
            "rain_1h": r.rain_1h,
            "rain_24h": r.rain_24h,
            "rain_72h": r.rain_72h,
            "eff_rain": r.eff_rain,
            "soil_moisture": r.soil_moisture,
        }
        for r in rows
    ]
    id_check = None
    if latest.rain_1h is not None and latest.rain_24h is not None:
        id_check = check_rainfall_id_exceedance(
            float(latest.rain_1h), float(latest.rain_24h),
            float(latest.rain_72h) if latest.rain_72h is not None else None,
        )
    # gauge-style summary: the numbers a physical rain meter would show
    rain_1h_ago = rows[-2].rain_1h if len(rows) > 1 else None
    trend = None
    if latest.rain_1h is not None and rain_1h_ago is not None:
        trend = "rising" if latest.rain_1h > rain_1h_ago else ("falling" if latest.rain_1h < rain_1h_ago else "steady")
    return {
        "zone_code": zone.zone_code,
        "district": zone.district,
        "has_data": True,
        "current": {
            "ts": latest.ts.isoformat(),
            "rain_1h_mm": latest.rain_1h,
            "rain_24h_mm": latest.rain_24h,
            "rain_48h_mm": latest.rain_48h,
            "rain_72h_mm": latest.rain_72h,
            "rain_7d_mm": latest.rain_7d,
            "eff_rain_mm": latest.eff_rain,
            "soil_moisture_pct": latest.soil_moisture,
            "trend": trend,
        },
        "id_threshold_check": id_check,
        "series": series,
        "n_points": len(series),
    }


@router.get("/{zone_id}/dossier", response_model=ZoneDossier)
async def zone_dossier(zone_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    zone = await db.get(Zone, zone_id)
    if zone is None:
        raise HTTPException(404, "Zone not found")
    out = await _zone_out(db, zone)

    since = datetime.now(timezone.utc) - timedelta(hours=72)
    rain = (
        await db.execute(
            select(RainfallObs).where(RainfallObs.zone_id == zone.id, RainfallObs.ts >= since).order_by(RainfallObs.ts)
        )
    ).scalars().all()

    cell = await db.get(RiskCell, zone.id)
    drivers = (cell.driver or {}).get("drivers", []) if cell else []

    reports = (
        await db.execute(
            select(CitizenReport).order_by(CitizenReport.created_at.desc()).limit(20)
        )
    ).scalars().all()

    alerts = (
        await db.execute(select(Alert).where(Alert.zone_id == zone.id).order_by(Alert.fired_at.desc()).limit(10))
    ).scalars().all()

    sensors = (
        await db.execute(
            select(SensorReading)
            .where(SensorReading.zone_id == zone.id)
            .order_by(SensorReading.ts.desc())
            .limit(10)
        )
    ).scalars().all()

    iso_val = isolation_score(zone.population, zone.road_km, zone.zone_code)
    latest_rain = rain[-1] if rain else None
    out_extra = {
        "flood_level": flood_index(
            getattr(latest_rain, "rain_1h", None),
            getattr(latest_rain, "rain_24h", None),
            getattr(latest_rain, "soil_moisture", None),
        ),
        "isolation": iso_val,
    }

    directive = generate_dc_directive(zone, out.hazard_level, out.prob_24h, drivers, iso_val)

    return ZoneDossier(
        zone=out,
        rainfall_series=[
            {
                "ts": r.ts.isoformat(),
                "rain_1h": r.rain_1h,
                "rain_24h": r.rain_24h,
                "eff_rain": r.eff_rain,
                "soil_moisture": r.soil_moisture,
            }
            for r in rain
        ],
        sensors=[
            {"sensor_id": s.sensor_id, "ts": s.ts.isoformat(), "soil_moisture": s.soil_moisture, "battery_pct": s.battery_pct}
            for s in sensors
        ],
        reports=[{"id": str(r.id), "category": r.category, "status": r.status, "created_at": r.created_at.isoformat()} for r in reports],
        alerts=[{"level": a.level, "fired_at": a.fired_at.isoformat(), "message": a.message_template} for a in alerts],
        drivers=drivers,
        historical_events=_historical_events(),
        dc_directive=directive,
        **out_extra,
    )
