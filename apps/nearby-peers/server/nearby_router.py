"""nearby-peers — rendezvous router (portable, DB-free).

Citizens who opted in announce an ephemeral peer-id + coordinates; rescuers
query "who is within R meters of me". Designed to mirror mesh.py: everything
lives in RAM with a short TTL, nothing is persisted, and when the process
restarts the world is empty again — which is exactly the right privacy and
operational posture for a disaster-response overlay.

Portability contract
--------------------
    from nearby_router import make_nearby_router

    app.include_router(make_nearby_router(get_principal=my_auth_dependency))

`get_principal` is any FastAPI dependency returning the authenticated caller
(or None to run in open mode — fine for local demos, never in production).
The router itself never touches a database, an ORM, or an app-specific model.

Privacy model
-------------
* peer_id is an ephemeral client-generated hex id that rotates daily; the
  server never sees an account, MAC, phone number, or IMEI tied to it.
* Coordinates are held in RAM only, TTL 10 minutes, GC'd on every call.
* DELETE /nearby/{peer_id} purges a peer the moment consent is revoked.
* Announces are rate-limited per peer (1 req/s) to stop flooding.
"""

from __future__ import annotations

import math
import re
import time
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

# ---- tuning (mirrors src/config.ts) -----------------------------------------
PEER_TTL_S = 600
DEFAULT_RADIUS_M = 500
MIN_RADIUS_M = 50
MAX_RADIUS_M = 10_000
MAX_PEERS = 5_000
MAX_ALIAS_LEN = 24
EARTH_RADIUS_M = 6_371_000.0

_PEER_ID_RE = re.compile(r"^[0-9a-f]{4,32}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f<>]")

_PEER_ROLE_RE = re.compile(r"^(citizen|field|relay)$")

# peer_id -> record; principal is kept transiently only to report "yours".
_PEERS: dict[str, dict] = {}

GetPrincipal = Callable[[Any], Awaitable[Any]]


class AnnounceIn(BaseModel):
    peer_id: str = Field(min_length=4, max_length=32)
    alias: str = Field(min_length=1, max_length=MAX_ALIAS_LEN)
    role: str = Field(default="citizen")
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0, le=100_000)
    needs_help: bool = False
    battery_pct: int | None = Field(default=None, ge=0, le=100)


class QueryIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius_m: int = Field(default=DEFAULT_RADIUS_M, ge=1, le=1_000_000)
    self_peer_id: str | None = Field(default=None, max_length=32)



def _gc() -> None:
    now = time.time()
    stale = [k for k, v in _PEERS.items() if now - v["ts"] > PEER_TTL_S]
    for k in stale:
        _PEERS.pop(k, None)


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p = math.pi / 180
    dlat = (lat2 - lat1) * p
    dlon = (lon2 - lon1) * p
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p = math.pi / 180
    y = math.sin((lon2 - lon1) * p) * math.cos(lat2 * p)
    x = math.cos(lat1 * p) * math.sin(lat2 * p) - math.sin(lat1 * p) * math.cos(lat2 * p) * math.cos((lon2 - lon1) * p)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def make_nearby_router(
    get_principal: GetPrincipal | None = None,
    prefix: str = "/nearby",
) -> APIRouter:
    """Build the router with a pluggable auth dependency.

    Open-mode (get_principal=None) uses a bearer token as a door-knob only and
    exists so the router boots standalone in tests/demos. Production callers
    MUST inject a real verifier (e.g. the platform's get_current_user).
    """
    if get_principal is not None:
        principal_dep = Depends(get_principal)
    else:
        _bearer = HTTPBearer(auto_error=True)

        async def _open_principal(creds: HTTPAuthorizationCredentials = Depends(_bearer)) -> str:
            return creds.credentials

        principal_dep = Depends(_open_principal)

    router = APIRouter(prefix=prefix, tags=["nearby"])

    @router.post("/announce", status_code=200)
    async def announce(body: AnnounceIn, _principal: Any = principal_dep) -> dict:
        """Store/refresh one ephemeral peer. No DB — RAM + TTL only."""
        _gc()
        if not _PEER_ID_RE.match(body.peer_id):
            raise HTTPException(422, "peer_id must be 4-32 hex chars")
        if not _PEER_ROLE_RE.match(body.role):
            raise HTTPException(422, "role must be citizen|field|relay")
        rec = _PEERS.get(body.peer_id)
        now = time.time()
        if rec is None:
            if len(_PEERS) >= MAX_PEERS:
                raise HTTPException(503, "peer table full — try again shortly")
        else:
            # flood guard: more than 1 announce/sec from the same peer is abuse
            if now - rec["ts"] < 1.0:
                raise HTTPException(429, "announce too frequent")
        _PEERS[body.peer_id] = {
            "peer_id": body.peer_id,
            "alias": _CONTROL_RE.sub("", body.alias)[:MAX_ALIAS_LEN] or "C-Anon",
            "role": body.role,
            "lat": body.lat,
            "lon": body.lon,
            "accuracy_m": body.accuracy_m,
            "needs_help": body.needs_help,
            "battery_pct": body.battery_pct,
            "ts": now,
        }
        return {"accepted": True, "ttl_s": PEER_TTL_S}

    @router.post("/query")
    async def query(body: QueryIn, _principal: Any = principal_dep) -> dict:
        """All live peers within radius of (lat, lon), nearest first."""
        _gc()
        radius = min(max(body.radius_m, MIN_RADIUS_M), MAX_RADIUS_M)
        out = []
        for rec in _PEERS.values():
            if body.self_peer_id and rec["peer_id"] == body.self_peer_id:
                continue  # never show the caller to themselves
            dist = _haversine_m(body.lat, body.lon, rec["lat"], rec["lon"])
            if dist > radius:
                continue
            out.append({
                "peer_id": rec["peer_id"],
                "alias": rec["alias"],
                "role": rec["role"],
                "lat": rec["lat"],
                "lon": rec["lon"],
                "accuracy_m": rec["accuracy_m"],
                "needs_help": rec["needs_help"],
                "battery_pct": rec["battery_pct"],
                "distance_m": round(dist, 1),
                "bearing_deg": round(_bearing_deg(body.lat, body.lon, rec["lat"], rec["lon"]), 1),
                "age_s": round(time.time() - rec["ts"], 1),
            })
        out.sort(key=lambda r: (not r["needs_help"], r["distance_m"]))
        return {
            "generated_at": time.time(),
            "radius_m": radius,
            "n_peers": len(out[:MAX_PEERS]),
            "peers": out[:200],
        }

    @router.delete("/{peer_id}")
    async def forget(peer_id: str, _principal: Any = principal_dep) -> dict:
        """Consent revoked — drop the peer immediately (idempotent)."""
        removed = _PEERS.pop(peer_id, None) is not None
        return {"forgotten": removed}

    @router.get("/stats")
    async def stats(_principal: Any = principal_dep) -> dict:
        """Ops view: how many live peers, never their coordinates."""
        _gc()
        by_role: dict[str, int] = {}
        n_sos = 0
        for rec in _PEERS.values():
            by_role[rec["role"]] = by_role.get(rec["role"], 0) + 1
            n_sos += 1 if rec["needs_help"] else 0
        return {"n_peers": len(_PEERS), "by_role": by_role, "n_needing_help": n_sos, "ttl_s": PEER_TTL_S}

    return router

