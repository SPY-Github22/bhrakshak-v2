from datetime import datetime, timezone
from pydantic import BaseModel
from fastapi import APIRouter
from .alerts import DEMO_ACTIVE_STORMS, add_active_storm, clear_active_storms
from .websocket_manager import broadcast_event

router = APIRouter(prefix="/api/v1/demo", tags=["demo-injection"])


class StormInjectPayload(BaseModel):
    district: str = "East Khasi Hills"
    location_name: str = "Cherrapunji cut-slope area"
    peak_mm_h: float = 55.0
    hours: int = 3


@router.post("/inject-rainfall-storm")
async def inject_rainfall_storm(payload: StormInjectPayload):
    """
    Simulates an extreme monsoon rainfall injection trigger from Dashboard.
    1. Populates active emergency storm registry.
    2. Broadcasts emergency alert event over WebSockets to all mobile & web subscribers.
    """
    storm_id = f"STORM-{int(datetime.now(timezone.utc).timestamp())}"
    alert_message = (
        f"🚨 EMERGENCY (L4): Extreme monsoon cell injected ({payload.peak_mm_h} mm/h) over "
        f"{payload.location_name}! Evacuate steep slopes immediately."
    )

    storm_data = {
        "id": storm_id,
        "level": 4,
        "name": f"Extreme Monsoon Storm — {payload.location_name}",
        "district": payload.district,
        "location_name": payload.location_name,
        "message": alert_message,
        "fired_at": datetime.now(timezone.utc).isoformat(),
    }

    add_active_storm(storm_data)

    # Broadcast WebSocket alert event
    await broadcast_event({
        "type": "alert",
        "level": 4,
        "name": storm_data["name"],
        "district": payload.district,
        "location_name": payload.location_name,
        "message": alert_message,
    })

    return {
        "status": "success",
        "demo_mode": True,
        "district": payload.district,
        "location_name": payload.location_name,
        "peak_mm_h": payload.peak_mm_h,
        "active_alert": storm_data,
    }


@router.post("/reset-storm")
async def reset_storm():
    """Clears all active storms and broadcasts an All-Clear signal to clients."""
    clear_active_storms()

    await broadcast_event({
        "type": "allclear",
        "level": 0,
        "name": "All Clear — Demo Reset",
        "message": "🟢 All Clear: Synthetic storm cleared. All districts returned to Normal.",
    })

    return {"status": "success", "demo_mode": False, "message": "All storms cleared"}
