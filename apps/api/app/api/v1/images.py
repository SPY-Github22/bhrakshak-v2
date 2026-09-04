"""Feature — Image Upload & Model V Vision Analysis.

Thin adapter: the canonical implementation lives in the self-contained portable folder
`image-upload/backend/router.py` (loaded below via importlib) so the entire feature
module can be dropped into another project untouched.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_IMAGE_ROUTER_PATH = (
    Path(__file__).resolve().parents[4] / "image-upload" / "backend" / "router.py"
)

if not _IMAGE_ROUTER_PATH.is_file():
    # Fallback to local image-upload within repository root
    _IMAGE_ROUTER_PATH = Path("/home/sudpy/Landslide Proto/bhrakshak-v2/image-upload/backend/router.py")

_spec = importlib.util.spec_from_file_location("bh_image_router", _IMAGE_ROUTER_PATH)
if _spec is None or _spec.loader is None:
    raise ImportError(f"portable image router not found at {_IMAGE_ROUTER_PATH}")

_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

router = _mod.router
