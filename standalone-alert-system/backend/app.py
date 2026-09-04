import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .alerts import router as alerts_router
from .demo_injector import router as demo_router
from .websocket_manager import manager

app = FastAPI(
    title="BhuRakshak Standalone Notification & Alert System API",
    description="Real-time alert delivery pipeline with WebSocket & HTTP active polling support.",
    version="1.0.0",
)

# Enable open CORS for seamless integration with Web Dashboard & Mobile Apps
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(alerts_router)
app.include_router(demo_router)


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "standalone-alert-system"}


@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep connection open for incoming messages / ping-pong
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


if __name__ == "__main__":
    uvicorn.run("standalone_alert_system.backend.app:app", host="0.0.0.0", port=8000, reload=True)
