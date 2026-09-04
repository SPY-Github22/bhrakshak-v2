"""Standalone microservice runner for Image Upload & Vision Analysis feature.

Run directly via:
    python server.py
or
    uvicorn server:app --port 8008 --reload
"""

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from router import router

app = FastAPI(
    title="Standalone Image Upload & Vision AI Service",
    description="Drop-in microservice for citizen/field disaster photo upload and Model V vision analysis",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api/v1")


@app.get("/health")
def health():
    return {"status": "ok", "service": "image-upload-vision"}


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8008, reload=True)
