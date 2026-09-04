import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["ws"])


active_sockets: set[WebSocket] = set()


async def broadcast_event(data: dict):
    """Fan out an event to every connected live client.

    Redis pub/sub is used when available so multiple workers share the same
    feed, but it is NOT required: with Redis down the event still reaches
    every socket connected to THIS process (single-process demo deployments
    are fully functional). A dead Redis must never break notification
    delivery.
    """
    msg_str = json.dumps(data)
    try:
        import redis.asyncio as aioredis

        from app.core.config import settings

        r = aioredis.from_url(settings.redis_url)
        await r.publish("bhrakshak:live", msg_str)
        await r.aclose()
    except Exception:
        pass  # degraded mode: direct fan-out below still runs
    for ws in list(active_sockets):
        try:
            await ws.send_text(msg_str)
        except Exception:
            active_sockets.discard(ws)


@router.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    """Live notification channel (alert / risk_diff / allclear / chat_message
    / ndrf_message / heartbeat).

    Degradation contract: if Redis is unreachable the socket STILL stays
    connected and receives heartbeats + every event published by this
    process (report sync, chat, alert engine). Only cross-worker fan-out is
    lost, never the connection itself.
    """
    await ws.accept()
    active_sockets.add(ws)
    pubsub = None
    try:
        try:
            import redis.asyncio as aioredis

            from app.core.config import settings

            r = aioredis.from_url(settings.redis_url)
            pubsub = r.pubsub()
            await pubsub.subscribe("bhrakshak:live")
        except Exception:
            # Redis down (demo mode / degraded deployment) — keep the socket
            # alive on the direct fan-out path instead of killing the client.
            pubsub = None
        while True:
            msg = None
            if pubsub is not None:
                try:
                    msg = await pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=15.0
                    )
                except Exception:
                    # Redis died mid-stream — degrade to heartbeat-only mode.
                    pubsub = None
            if msg and msg.get("data"):
                await ws.send_text(
                    msg["data"].decode() if isinstance(msg["data"], bytes) else str(msg["data"])
                )
            else:
                await ws.send_text(json.dumps({"type": "heartbeat"}))
                if pubsub is None:
                    # Degraded mode has no blocking Redis wait — pace the
                    # heartbeats ourselves so we don't flood the client.
                    await asyncio.sleep(15.0)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        active_sockets.discard(ws)
        if pubsub:
            try:
                await pubsub.unsubscribe("bhrakshak:live")
                await pubsub.aclose()
            except Exception:
                pass
