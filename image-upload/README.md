# 📸 Standalone Image Upload & Vision Analysis Module

A modular, self-contained, drop-in feature package for capturing geo-tagged disaster/hazard field photos with citizen/responder messages, persisting images with local/cloud swappable storage, analyzing image textures via computer vision (Model V), and presenting live visual evidence with interactive controls on operations dashboards.

Designed to be lifted and added directly into any new or existing project with minimal wiring.

---

## 📁 Package Structure

```
image-upload/
├── backend/
│   ├── storage.py            # LocalImageStore & BaseImageStore (Pillow validation, collision-proof UUIDs)
│   ├── router.py             # FastAPI APIRouter (/images/upload, /images/{filename}, /images/{id}/analyze)
│   └── server.py             # Standalone microservice entrypoint (runs on port 8008)
├── android/
│   └── ImageUploadHelper.kt  # Android camera & gallery intents, client compression, multipart builder
├── dashboard/
│   └── ImageReportCard.tsx   # React/Next.js card with image preview, citizen note, Model V AI metrics, modal zoom
└── README.md                 # Integration & usage guide
```

---

## 🚀 1. Standalone Quickstart (Microservice Mode)

You can run this module as an independent microservice without any external database:

```bash
cd image-upload/backend
pip install fastapi uvicorn pillow python-multipart
python server.py
```

The service will start on `http://localhost:8008`:
- Swagger API Docs: `http://localhost:8008/docs`
- Upload Endpoint: `POST http://localhost:8008/api/v1/images/upload`
- Image Retrieval: `GET http://localhost:8008/api/v1/images/{filename}`

---

## 🔌 2. Backend Integration (FastAPI)

To mount this feature inside an existing FastAPI application:

```python
from fastapi import FastAPI
from image_upload.backend.router import router as images_router

app = FastAPI()
app.include_router(images_router, prefix="/api/v1")
```

### Storage Configuration
Set the `IMAGE_UPLOAD_DIR` environment variable to configure the directory where uploaded photos are saved:
```bash
export IMAGE_UPLOAD_DIR="/var/data/uploads/images"
```
If unset, it defaults to `data/uploads/images/` relative to the application working directory.

### Swapping Storage to S3 / MinIO
Subclass `BaseImageStore` in `image-upload/backend/storage.py` and implement:
- `save(data, filename_hint, prefix) -> StoredImage`
- `get_path(filename) -> Path | None`
- `read_bytes(filename) -> bytes | None`
- `delete(filename) -> bool`

---

## 📱 3. Android Integration (Kotlin)

Copy `image-upload/android/ImageUploadHelper.kt` into your Android app's source directory.

### Launch Camera or Gallery
```kotlin
// Camera
val cameraIntent = ImageUploadHelper.createCameraIntent()
cameraLauncher.launch(cameraIntent)

// Gallery Picker
val galleryIntent = ImageUploadHelper.createGalleryIntent()
galleryLauncher.launch(galleryIntent)
```

### Client Compression (NER / Low-Bandwidth Valley Resilience)
Avoid network timeouts by downsampling large camera photos before sending:
```kotlin
val compressedFile = ImageUploadHelper.compressImage(rawPhotoFile, targetFile, maxDimension = 1280, quality = 85)
```

### Multipart Upload
```kotlin
val part = MultipartBody.Part.createFormData(
    "photo", compressedFile.name,
    compressedFile.readBytes().toRequestBody("image/jpeg".toMediaTypeOrNull())
)
val response = api.uploadImageReport(
    photo = part,
    description = "Large tension cracks on cut slope".toRequestBody("text/plain".toMediaTypeOrNull()),
    category = "crack".toRequestBody("text/plain".toMediaTypeOrNull()),
    lat = "24.8812".toRequestBody("text/plain".toMediaTypeOrNull()),
    lon = "93.7235".toRequestBody("text/plain".toMediaTypeOrNull()),
    token = "Bearer $jwtToken"
)
```

---

## 💻 4. Dashboard Integration (React / Next.js)

Copy `image-upload/dashboard/ImageReportCard.tsx` into your web dashboard:

```tsx
import { ImageReportCard } from "@/components/reports/ImageReportCard";

export function IncidentInbox({ reports }) {
  const handleVerify = async (id, decision) => {
    await fetch(`/api/v1/reports/${id}/verify?decision=${decision}`, { method: "PATCH" });
  };

  const handleReanalyze = async (id) => {
    await fetch(`/api/v1/images/${id}/analyze`, { method: "POST" });
  };

  return (
    <div className="space-y-4">
      {reports.map((report) => (
        <ImageReportCard
          key={report.id}
          report={report}
          apiBaseUrl={process.env.NEXT_PUBLIC_API_URL}
          onVerify={handleVerify}
          onReanalyze={handleReanalyze}
        />
      ))}
    </div>
  );
}
```

### Features included in the Card:
- **Direct Image Thumbnail**: Previews the real uploaded photo.
- **Interactive Lightbox Modal**: Click-to-enlarge modal with dark backdrop.
- **Citizen / Field Note Card**: Highlights user's custom observation message.
- **Model V Computer Vision Breakdown**:
  - Verdict pill (`POSITIVE` | `POSSIBLE` | `NEGATIVE`) with probability %.
  - Fresh-soil fraction, scarp horizontal edge energy, vegetation coverage metrics.
  - EXIF GPS cross-verification flag (detects provenance mismatch >300m).
- **Interactive Actions**:
  - DC Verify / Reject toggle.
  - Re-analyze button with animated spinner.

---

## 📡 5. API Endpoints Reference

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/v1/images/upload` | Multipart upload of photo + message + GPS coordinates. Computes vision analysis and persists report. |
| `GET` | `/api/v1/images/{filename}` | Serves the persisted image with caching headers. |
| `POST` | `/api/v1/images/{report_id}/analyze` | Re-runs vision model on an existing report's stored image. |
