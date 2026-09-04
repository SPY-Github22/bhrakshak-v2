from datetime import datetime, timezone
from typing import List, Dict, Any
from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/alerts", tags=["alerts"])

# Global in-memory list of active emergency storms (used for demo & instant sync)
DEMO_ACTIVE_STORMS: List[Dict[str, Any]] = []


@router.get("/active")
async def get_active_alerts() -> List[Dict[str, Any]]:
    """
    Returns all active high-level emergency alerts.
    Mobile apps poll this endpoint every 3s to guarantee immediate heads-up delivery
    even if WebSockets are temporarily interrupted.
    """
    return DEMO_ACTIVE_STORMS


def add_active_storm(storm_data: Dict[str, Any]):
    """Insert a new emergency storm at the head of active alerts."""
    DEMO_ACTIVE_STORMS.insert(0, storm_data)


def clear_active_storms():
    """Clear all active storms (All-Clear signal)."""
    DEMO_ACTIVE_STORMS.clear()
