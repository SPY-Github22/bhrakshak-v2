import json
import uuid
from datetime import datetime, timezone

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.api.deps import OPS_ROLES, STAFF_ROLES, get_current_user
from app.core.config import settings
from app.models import Role, User
from app.api.v1.ws import broadcast_event

router = APIRouter(prefix="/chat", tags=["chat"])

# Ordered oldest -> newest. GET returns at most the last 50 in that order;
# POST appends and broadcasts over WS with type=chat_message.
MAX_HISTORY = 50

# Role display names so the web/mobile both render a consistent identity.
ROLE_LABELS = {
    Role.admin: "DC Command Center",
    Role.district_admin: "District Control Room",
    Role.field_official: "Field Official",
    Role.citizen: "Citizen Reporter",
}


class ChatMessageIn(BaseModel):
    message: str
    # Kept optional for backward compatibility with older clients, but the
    # server derives identity from the JWT instead of trusting these.
    sender_name: str | None = None
    location: str | None = None
    role: str | None = None


class ChatMessageOut(BaseModel):
    id: str
    sender_name: str
    location: str
    message: str
    role: str
    timestamp: str


def _redis():
    return aioredis.from_url(settings.redis_url, decode_responses=True)


async def _load_messages(r) -> list[dict]:
    """Oldest -> newest, last MAX_HISTORY messages."""
    try:
        raw = await r.lrange("bhrakshak:chat", -MAX_HISTORY, -1)
        return [json.loads(x) for x in raw]
    except Exception:
        return []


async def _append_message(r, msg: dict) -> None:
    await r.rpush("bhrakshak:chat", json.dumps(msg))
    # Keep the list bounded; trim from the head (oldest).
    await r.ltrim("bhrakshak:chat", -MAX_HISTORY, -1)


def _seed_messages() -> list[dict]:
    """Context messages used only when the Redis history is empty (first boot)."""
    now = datetime.now(timezone.utc).isoformat()
    return [
        {
            "id": "00000000-0000-0000-0000-000000000301",
            "sender_name": "SDRF QRT Commander",
            "location": "Tupul Station Yard (Noney)",
            "message": "HQ, QRT Team 1 in position at NH-37 choke point. Satellite comms active.",
            "role": "field_official",
            "timestamp": now,
        },
        {
            "id": "00000000-0000-0000-0000-000000000302",
            "sender_name": "DC Control Room",
            "location": "Aizawl HQ",
            "message": "Copy QRT 1. Ramping rainfall expected. Keep evacuation channels open.",
            "role": "admin",
            "timestamp": now,
        },
    ]


@router.get("/messages", response_model=list[ChatMessageOut])
async def get_messages(user: User = Depends(get_current_user)):
    """Chat history, oldest -> newest.

    Requires a valid access token (any role). Reads from Redis so history
    survives restarts and is consistent across workers.
    """
    r = _redis()
    try:
        msgs = await _load_messages(r)
    finally:
        try:
            await r.aclose()
        except Exception:
            pass
    if not msgs:
        msgs = _seed_messages()
    return [ChatMessageOut(**m) for m in msgs]


@router.post("/send", response_model=ChatMessageOut, status_code=201)
async def send_message(
    body: ChatMessageIn,
    user: User = Depends(get_current_user),
):
    """Send a chat message. Identity is derived from the JWT, never the body.

    Only staff roles (admin / district_admin / field_official) may post to the
    emergency channel; the mobile app and dashboard both hold real tokens.
    """
    if user.role not in STAFF_ROLES:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only admin / district_admin / field_official may post to the emergency chat",
        )
    txt = (body.message or "").strip()
    if not txt:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "message must not be empty")
    if len(txt) > 1000:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "message too long (max 1000 chars)")

    role_label = ROLE_LABELS.get(user.role, str(user.role))
    msg = {
        "id": str(uuid.uuid4()),
        # Identity comes from the token; a client cannot spoof the sender.
        "sender_name": role_label,
        "location": (body.location or "").strip() or "Unspecified location",
        "message": txt,
        "role": user.role.value if hasattr(user.role, "value") else str(user.role),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    r = _redis()
    try:
        await _append_message(r, msg)
    finally:
        try:
            await r.aclose()
        except Exception:
            pass

    await broadcast_event({**msg, "type": "chat_message"})
    return msg