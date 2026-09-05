import uuid
import httpx
import pytest
from unittest.mock import AsyncMock
from app.main import app
from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import User, Role
from app.services.risk_engine import (
    SUPPORTED_LANGUAGES,
    DEFAULT_TEMPLATES,
    render_multilingual_messages,
)


@pytest.mark.asyncio
async def test_supported_languages_coverage():
    """Verify all 8 official pilot languages for the North Eastern Region are defined and covered."""
    expected_langs = ["en", "hi", "bn", "as", "ne", "kha", "lus", "mni-Mtei"]
    assert SUPPORTED_LANGUAGES == expected_langs

    # Verify templates exist for every level for every language
    levels = ["alert.l1", "alert.l2", "alert.l3", "alert.l4", "alert.allclear"]
    for lang in expected_langs:
        for lvl in levels:
            assert (lvl, lang) in DEFAULT_TEMPLATES, f"Missing template for ({lvl}, {lang})"


@pytest.mark.asyncio
async def test_render_multilingual_messages():
    """Verify render_multilingual_messages generates messages for all 8 NER languages."""
    messages = await render_multilingual_messages(
        db=None,
        key="alert.l4",
        village="Noney Cut-Slope",
        level_name="L4 (Evacuation Order)",
    )

    assert len(messages) == 8
    for lang in SUPPORTED_LANGUAGES:
        assert lang in messages
        assert len(messages[lang]) > 0
        assert "Noney Cut-Slope" in messages[lang]

    # Verify language-specific contents
    assert "EMERGENCY" in messages["en"]
    assert "आपातकाल" in messages["hi"]
    assert "জরুরি অবস্থা" in messages["bn"]
    assert "জৰুৰীকালীন" in messages["as"]
    assert "आपतकालिन" in messages["ne"]
    assert "JINGMA JUR" in messages["kha"]
    assert "inthiarfihlim" in messages["lus"]
    assert "ꯑꯃꯔꯖꯦꯟꯁꯤ" in messages["mni-Mtei"]


@pytest.mark.asyncio
async def test_public_preferences_api():
    """Test device-level anonymous multilingual preferences storage and retrieval."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        device_id = "test-device-uuid-999"

        # 1. Save preferences with Mizo language
        save_res = await ac.post(
            "/api/v1/public/preferences",
            json={
                "device_id": device_id,
                "preferred_lang": "lus",
                "fcm_token": "fcm-token-abc-123",
            },
        )
        assert save_res.status_code == 200
        save_data = save_res.json()
        assert save_data["status"] == "ok"
        assert save_data["device_id"] == device_id
        assert save_data["preferred_lang"] == "lus"

        # 2. Retrieve preferences
        get_res = await ac.get(f"/api/v1/public/preferences/{device_id}")
        assert get_res.status_code == 200
        get_data = get_res.json()
        assert get_data["device_id"] == device_id
        assert get_data["preferred_lang"] == "lus"
        assert get_data["fcm_token"] == "fcm-token-abc-123"

        # 3. Update preferences with Khasi language
        update_res = await ac.post(
            "/api/v1/public/preferences",
            json={
                "device_id": device_id,
                "preferred_lang": "kha",
            },
        )
        assert update_res.status_code == 200
        assert update_res.json()["preferred_lang"] == "kha"

        # 4. Verify updated retrieval
        get_res2 = await ac.get(f"/api/v1/public/preferences/{device_id}")
        assert get_res2.status_code == 200
        assert get_res2.json()["preferred_lang"] == "kha"


@pytest.mark.asyncio
async def test_alerts_active_multilingual_resolution():
    """Test that GET /api/v1/alerts/active responds with the requested language."""
    admin_user = User(
        id=uuid.uuid4(),
        email="admin@bhrakshak.in",
        full_name="Admin User",
        role=Role.admin,
        hashed_password="fake",
    )
    app.dependency_overrides[get_current_user] = lambda: admin_user

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            # 1. First inject a demo storm
            inject_res = await ac.post(
                "/api/v1/demo/inject-rainfall-storm",
                json={
                    "district": "East Khasi Hills",
                    "location_name": "Cherrapunji Cut-Slope Area",
                    "peak_mm_h": 95.0,
                    "hours": 6,
                },
            )
            assert inject_res.status_code == 200

            # 2. Fetch active alerts in Hindi
            res_hi = await ac.get("/api/v1/alerts/active?lang=hi")
            assert res_hi.status_code == 200
            alerts_hi = res_hi.json()
            assert len(alerts_hi) >= 1
            top_hi = alerts_hi[0]
            assert "messages" in top_hi
            assert top_hi["messages"]["hi"] == top_hi["message"]
            assert "आपातकाल" in top_hi["message"] or "चेतावनी" in top_hi["message"]

            # 3. Fetch active alerts in Bengali
            res_bn = await ac.get("/api/v1/alerts/active?lang=bn")
            assert res_bn.status_code == 200
            alerts_bn = res_bn.json()
            top_bn = alerts_bn[0]
            assert top_bn["messages"]["bn"] == top_bn["message"]
            assert "জরুরি" in top_bn["message"] or "সতর্কতা" in top_bn["message"]

            # 4. Fetch active alerts in Manipuri (Meitei)
            res_mni = await ac.get("/api/v1/alerts/active?lang=mni-Mtei")
            assert res_mni.status_code == 200
            alerts_mni = res_mni.json()
            top_mni = alerts_mni[0]
            assert top_mni["messages"]["mni-Mtei"] == top_mni["message"]
            assert "ꯑꯃꯔꯖꯦꯟꯁꯤ" in top_mni["message"] or "ꯈꯨꯗꯣꯡꯊꯤꯕ" in top_mni["message"]
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_auth_me_language_preference():
    """Test user preferred_lang update via PATCH /api/v1/auth/me and POST /api/v1/auth/language."""
    fake_user = User(
        id=uuid.uuid4(),
        email="rescuer@bhrakshak.in",
        full_name="Rescue Responder",
        role=Role.field_official,
        preferred_lang="en",
        hashed_password="hashed_pw",
    )

    mock_db = AsyncMock()
    mock_db.commit = AsyncMock()
    mock_db.refresh = AsyncMock()

    app.dependency_overrides[get_current_user] = lambda: fake_user
    app.dependency_overrides[get_db] = lambda: mock_db

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            # 1. Update preferred_lang via PATCH /auth/me
            patch_res = await ac.patch(
                "/api/v1/auth/me",
                json={"preferred_lang": "as", "full_name": "Updated Responder", "district": "Kamrup"},
            )
            assert patch_res.status_code == 200
            patch_data = patch_res.json()
            assert patch_data["preferred_lang"] == "as"
            assert patch_data["full_name"] == "Updated Responder"
            assert patch_data["district"] == "Kamrup"
            assert fake_user.preferred_lang == "as"

            # 2. Update preferred_lang via dedicated POST /auth/language
            lang_res = await ac.post(
                "/api/v1/auth/language",
                json={"lang": "ne"},
            )
            assert lang_res.status_code == 200
            lang_data = lang_res.json()
            assert lang_data["ok"] is True
            assert lang_data["preferred_lang"] == "ne"
            assert fake_user.preferred_lang == "ne"
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_db, None)
