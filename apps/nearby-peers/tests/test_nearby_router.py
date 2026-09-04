"""Standalone tests for the portable nearby_router — no DB, no app imports.

Run from anywhere:
    pytest tests/test_nearby_router.py
(requires fastapi, httpx, pytest-asyncio)
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from nearby_router import PEER_TTL_S, make_nearby_router  # noqa: E402

TOK = {"Authorization": "Bearer test-token"}


def _app() -> FastAPI:
    async def fake_principal() -> str:
        return "user-stub"

    app = FastAPI()
    app.include_router(make_nearby_router(get_principal=fake_principal))
    return app


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://t")


ANN = {
    "peer_id": "a1b2c3d4",
    "alias": "C-A1B2",
    "role": "citizen",
    "lat": 24.8105,
    "lon": 93.6820,
    "accuracy_m": 12,
    "needs_help": True,
    "battery_pct": 80,
}


@pytest.fixture(autouse=True)
def _isolate_peers():
    """The peer table is module-level RAM state — clear it around each test."""
    import nearby_router as nr
    nr._PEERS.clear()
    yield
    nr._PEERS.clear()


@pytest.mark.asyncio
async def test_announce_requires_auth():
    """Open-mode still demands a bearer token (HTTPBearer auto_error)."""
    app = FastAPI()
    app.include_router(make_nearby_router())  # open mode: bearer required, not verified
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/nearby/announce", json=ANN)
        assert r.status_code in (401, 403)  # missing bearer


@pytest.mark.asyncio
async def test_announce_query_roundtrip():
    async with _client() as c:
        r = await c.post("/nearby/announce", json=ANN, headers=TOK)
        assert r.status_code == 200 and r.json()["accepted"] is True

        q = await c.post("/nearby/query", json={"lat": 24.8105, "lon": 93.6820, "radius_m": 500, "self_peer_id": "ffffffff"}, headers=TOK)
        assert q.status_code == 200
        peers = q.json()["peers"]
        assert len(peers) == 1
        p = peers[0]
        assert p["peer_id"] == "a1b2c3d4"
        assert p["distance_m"] < 5  # same point → ~0 m
        assert p["needs_help"] is True


@pytest.mark.asyncio
async def test_self_exclusion_and_radius_filter():
    # ~5.5 km away: outside 500 m but inside the 10 km max radius
    far = {**ANN, "peer_id": "deadbeef", "alias": "C-FAR", "lat": 24.86, "lon": 93.682, "needs_help": False}
    async with _client() as c:
        await c.post("/nearby/announce", json=ANN, headers=TOK)
        await c.post("/nearby/announce", json=far, headers=TOK)
        q = await c.post("/nearby/query", json={"lat": 24.8105, "lon": 93.6820, "radius_m": 500, "self_peer_id": "a1b2c3d4"}, headers=TOK)
        ids = [p["peer_id"] for p in q.json()["peers"]]
        assert "a1b2c3d4" not in ids  # self excluded
        assert "deadbeef" not in ids  # ~13 km away, outside 500 m

        q2 = await c.post("/nearby/query", json={"lat": 24.8105, "lon": 93.6820, "radius_m": 20000}, headers=TOK)
        assert "deadbeef" in [p["peer_id"] for p in q2.json()["peers"]]
        assert q2.json()["radius_m"] == 10000  # clamped to MAX


@pytest.mark.asyncio
async def test_sos_sorts_first():
    calm = {**ANN, "peer_id": "11112222", "alias": "C-CALM", "needs_help": False}
    async with _client() as c:
        await c.post("/nearby/announce", json=calm, headers=TOK)
        await c.post("/nearby/announce", json=ANN, headers=TOK)  # needs_help=True
        q = await c.post("/nearby/query", json={"lat": 24.8105, "lon": 93.6820, "radius_m": 1000}, headers=TOK)
        peers = q.json()["peers"]
        assert peers[0]["needs_help"] is True


@pytest.mark.asyncio
async def test_validation_and_flood_guard():
    async with _client() as c:
        # valid announce first, then immediate re-announce from same peer → 429
        assert (await c.post("/nearby/announce", json=ANN, headers=TOK)).status_code == 200
        assert (await c.post("/nearby/announce", json=ANN, headers=TOK)).status_code == 429
        bad = {**ANN, "peer_id": "NOT-HEX!"}
        assert (await c.post("/nearby/announce", json=bad, headers=TOK)).status_code == 422
        bad_role = {**ANN, "peer_id": "bbbbaaaa", "role": "superman"}
        assert (await c.post("/nearby/announce", json=bad_role, headers=TOK)).status_code == 422


@pytest.mark.asyncio
async def test_forget_and_ttl(monkeypatch):
    async with _client() as c:
        await c.post("/nearby/announce", json=ANN, headers=TOK)
        assert (await c.delete("/nearby/a1b2c3d4", headers=TOK)).json()["forgotten"] is True
        assert (await c.delete("/nearby/a1b2c3d4", headers=TOK)).json()["forgotten"] is False  # idempotent
        q = await c.post("/nearby/query", json={"lat": 24.8105, "lon": 93.6820, "radius_m": 500}, headers=TOK)
        assert q.json()["peers"] == []

    # TTL expiry via time travel
    import nearby_router as nr
    monkeypatch.setattr(nr, "_PEERS", {})
    async with _client() as c:
        await c.post("/nearby/announce", json={**ANN, "peer_id": "aaaabbbb"}, headers=TOK)
        real_time = time.time
        monkeypatch.setattr(nr.time, "time", lambda: real_time() + PEER_TTL_S + 1)
        q = await c.post("/nearby/query", json={"lat": 24.8105, "lon": 93.6820, "radius_m": 500}, headers=TOK)
        assert q.json()["peers"] == []
        assert nr._PEERS == {}  # gc reclaimed


@pytest.mark.asyncio
async def test_stats_never_leaks_coordinates():
    async with _client() as c:
        await c.post("/nearby/announce", json=ANN, headers=TOK)
        body = (await c.get("/nearby/stats", headers=TOK)).json()
        assert body["n_peers"] == 1 and body["n_needing_help"] == 1
        assert "lat" not in str(body) and "93.68" not in str(body)
