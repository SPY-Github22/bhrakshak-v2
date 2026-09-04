import io
import uuid
import httpx
import pytest
from PIL import Image

from app.main import app


def _make_test_image(color="brown", size=(200, 200)) -> bytes:
    """Generate in-memory test JPEG image simulating soil / terrain."""
    buf = io.BytesIO()
    img = Image.new("RGB", size, color=color)
    img.save(buf, format="JPEG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_image_upload_and_retrieve():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        image_bytes = _make_test_image(color=(140, 90, 40))  # soil brown
        client_id = str(uuid.uuid4())

        files = {
            "photo": ("tension_crack.jpg", image_bytes, "image/jpeg"),
        }
        data = {
            "description": "Noticeable tension fracture near road shoulder after heavy rain",
            "category": "crack",
            "lat": "24.8812",
            "lon": "93.7235",
            "client_id": client_id,
        }

        # 1. Upload image + citizen message
        res = await ac.post("/api/v1/images/upload", files=files, data=data)
        assert res.status_code == 201, res.text
        body = res.json()

        assert body["status"] == "ok"
        assert body["report_id"] == client_id
        assert body["description"] == "Noticeable tension fracture near road shoulder after heavy rain"
        assert body["category"] == "crack"
        assert "image_url" in body
        assert "filename" in body
        assert "ai_analysis" in body
        assert "verdict" in body["ai_analysis"]

        filename = body["filename"]
        image_url = body["image_url"]

        # 2. Retrieve image directly
        get_res = await ac.get(f"/api/v1/images/{filename}")
        assert get_res.status_code == 200
        assert get_res.headers["content-type"] == "image/jpeg"
        assert len(get_res.content) == len(image_bytes)


@pytest.mark.asyncio
async def test_image_upload_invalid_data():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        # Empty upload
        res = await ac.post("/api/v1/images/upload", files={"photo": ("empty.jpg", b"", "image/jpeg")})
        assert res.status_code == 422

        # Invalid non-image file
        res = await ac.post(
            "/api/v1/images/upload",
            files={"photo": ("fake.jpg", b"not-a-valid-image-bytes", "image/jpeg")},
        )
        assert res.status_code == 400
        assert "Invalid image file" in res.text


@pytest.mark.asyncio
async def test_image_not_found():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/images/nonexistent_image_12345.jpg")
        assert res.status_code == 404
