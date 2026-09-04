"""Feature — Nearby Peers (rescuer ⇄ citizen proximity discovery).

Thin adapter ONLY: the canonical implementation lives in the portable folder
`apps/nearby-peers/` (loaded below via importlib) so the whole feature can be
lifted into another project untouched. This file just injects the platform's
real JWT auth into the router factory.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_NEARBY_SERVER = (
    Path(__file__).resolve().parents[3].parent / "nearby-peers" / "server" / "nearby_router.py"
)

_spec = importlib.util.spec_from_file_location("bh_nearby_router", _NEARBY_SERVER)
if _spec is None or _spec.loader is None:  # pragma: no cover
    raise ImportError(f"portable nearby router not found at {_NEARBY_SERVER}")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

from app.api.deps import get_current_user  # noqa: E402

# Real JWT verification; announce/query/forget all require any authenticated
# account (citizens announce their own beacon, rescuers query nearby peers).
router = _mod.make_nearby_router(get_principal=get_current_user)
