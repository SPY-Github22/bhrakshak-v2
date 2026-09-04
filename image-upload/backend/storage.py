"""Image storage service for Bhrakshak image upload feature.

Provides a robust, local filesystem storage implementation with Pillow validation,
sanitized naming, and an abstract BaseImageStore interface that allows swapping to
MinIO/S3 backends without changing application code.
"""

from __future__ import annotations

import abc
import io
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from PIL import Image


@dataclass
class StoredImage:
    filename: str
    file_path: str
    url: str
    size_bytes: int
    mime_type: str
    width: int
    height: int


class BaseImageStore(abc.ABC):
    """Abstract interface for image storage backends (Local, MinIO, S3, etc.)."""

    @abc.abstractmethod
    def save(
        self,
        data: bytes | BinaryIO,
        filename_hint: str | None = None,
        prefix: str = "img_",
    ) -> StoredImage:
        """Validate and persist image bytes, returning StoredImage metadata."""
        pass

    @abc.abstractmethod
    def get_path(self, filename: str) -> Path | None:
        """Resolve absolute local path for a stored image if accessible on disk."""
        pass

    @abc.abstractmethod
    def read_bytes(self, filename: str) -> bytes | None:
        """Read and return image bytes by filename."""
        pass

    @abc.abstractmethod
    def delete(self, filename: str) -> bool:
        """Delete image by filename."""
        pass


class LocalImageStore(BaseImageStore):
    """Local filesystem image store with PIL integrity check and safe serving path resolution."""

    def __init__(
        self,
        upload_dir: str | Path | None = None,
        base_url_path: str = "/api/v1/images",
    ):
        if upload_dir is None:
            # Default to data/uploads/images under project root or /tmp fallback
            env_dir = os.getenv("IMAGE_UPLOAD_DIR")
            if env_dir:
                self.upload_dir = Path(env_dir).resolve()
            else:
                cwd = Path.cwd().resolve()
                self.upload_dir = (cwd / "data" / "uploads" / "images").resolve()
        else:
            self.upload_dir = Path(upload_dir).resolve()

        self.upload_dir.mkdir(parents=True, exist_ok=True)
        self.base_url_path = base_url_path.rstrip("/")

    def save(
        self,
        data: bytes | BinaryIO,
        filename_hint: str | None = None,
        prefix: str = "img_",
    ) -> StoredImage:
        if isinstance(data, (bytes, bytearray)):
            raw_bytes = bytes(data)
        else:
            raw_bytes = data.read()

        if not raw_bytes:
            raise ValueError("Empty image data provided.")

        # Pillow verification
        try:
            with Image.open(io.BytesIO(raw_bytes)) as img:
                img.verify()
            with Image.open(io.BytesIO(raw_bytes)) as img:
                width, height = img.size
                fmt = (img.format or "JPEG").upper()
        except Exception as exc:
            raise ValueError(f"Invalid image file: {exc}") from exc

        ext_map = {
            "JPEG": ".jpg",
            "JPG": ".jpg",
            "PNG": ".png",
            "WEBP": ".webp",
            "GIF": ".gif",
        }
        ext = ext_map.get(fmt, ".jpg")
        mime_map = {
            ".jpg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }
        mime_type = mime_map.get(ext, "image/jpeg")

        unique_id = uuid.uuid4().hex
        filename = f"{prefix}{unique_id}{ext}"
        target_path = (self.upload_dir / filename).resolve()

        # Prevent directory traversal
        if not str(target_path).startswith(str(self.upload_dir)):
            raise ValueError("Target path escapes upload directory.")

        with open(target_path, "wb") as f:
            f.write(raw_bytes)

        rel_url = f"{self.base_url_path}/{filename}"

        return StoredImage(
            filename=filename,
            file_path=str(target_path),
            url=rel_url,
            size_bytes=len(raw_bytes),
            mime_type=mime_type,
            width=width,
            height=height,
        )

    def get_path(self, filename: str) -> Path | None:
        safe_name = Path(filename).name
        target = (self.upload_dir / safe_name).resolve()
        if not str(target).startswith(str(self.upload_dir)):
            return None
        if target.is_file():
            return target
        return None

    def read_bytes(self, filename: str) -> bytes | None:
        path = self.get_path(filename)
        if path and path.is_file():
            return path.read_bytes()
        return None

    def delete(self, filename: str) -> bool:
        path = self.get_path(filename)
        if path and path.is_file():
            try:
                path.unlink()
                return True
            except OSError:
                return False
        return False


# Default singleton instance
image_store = LocalImageStore()
