import json
import logging
from typing import List
from fastapi import WebSocket

logger = logging.getLogger("alert_websocket")


class ConnectionManager:
    """Manages active WebSocket connections and broadcasts emergency alert events."""

    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket client connected. Total clients: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"WebSocket client disconnected. Total clients: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        """Broadcast JSON payload to all active subscribers."""
        payload = json.dumps(message)
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_text(payload)
            except Exception as e:
                logger.warning(f"Error sending payload to client: {e}")
                disconnected.append(connection)

        for conn in disconnected:
            self.disconnect(conn)


manager = ConnectionManager()


async def broadcast_event(event: dict):
    """Global helper to push real-time alert events to all connected mobile & web clients."""
    await manager.broadcast(event)
