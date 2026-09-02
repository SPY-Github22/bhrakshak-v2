package com.bhrakshak.field.live

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.bhrakshak.field.MainActivity
import com.bhrakshak.field.data.Api
import com.bhrakshak.field.data.ApiConfig
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * Live alert channel: connects to /ws/live and raises a heads-up
 * notification for every alert / ndrf_message event. Reconnects with
 * backoff; the socket is cheap (server heartbeats every 15 s) and the
 * messages are tiny JSON envelopes.
 *
 * Event envelope: {"type": "alert" | "risk_diff" | "allclear" | "heartbeat"
 *                  | "sensor" | "ndrf_message" | "ndrf_checkin", ...payload}
 */
class LiveAlertService : LifecycleService() {

    private var socket: WebSocket? = null
    private var retry = 0

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            retry = 0
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching {
                val obj = JSONObject(text)
                when (obj.optString("type")) {
                    "alert" -> notify(
                        "⚠ L${obj.optInt("level", 0)} ${obj.optString("name")}",
                        obj.optString("message"),
                        notifId = obj.optString("zone_code").hashCode(),
                    )
                    "ndrf_message" -> notify(
                        "NDRF: ${obj.optString("from_station")}",
                        obj.optString("text"),
                        notifId = obj.optString("message_id").hashCode(),
                    )
                    "chat_message" -> notify(
                        "💬 ${obj.optString("sender_name")}",
                        obj.optString("message"),
                        notifId = obj.optString("id").hashCode(),
                    )
                    // heartbeat / risk_diff / sensor: silent
                }
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            scheduleReconnect()
        }
    }

    private fun connect() {
        val request = Request.Builder().url(ApiConfig.wsUrl).build()
        socket = Api.wsClient.newWebSocket(request, listener)
    }

    private fun scheduleReconnect() {
        if (retry > 10) return // give up after ~1 h of backoff; relaunch reconnects
        val delayMs = 1000L shl retry.coerceAtMost(10)
        retry += 1
        lifecycleScope.launch {
            delay(delayMs)
            connect()
        }
    }

    private fun persistentNotification(): android.app.Notification =
        NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setSmallIcon(android.R.drawable.ic_dialog_map)
            .setContentTitle("BhuRakshak live")
            .setContentText("Listening for landslide alerts near you")
            .setOngoing(true)
            .build()

    private fun notify(title: String, body: String, notifId: Int) {
        val intent = Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(this).notify(notifId, notification) }
    }

    override fun onCreate() {
        super.onCreate()
        runCatching {
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ALERTS, "Landslide alerts", NotificationManager.IMPORTANCE_HIGH,
                ),
            )
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ONGOING, "Live connection", NotificationManager.IMPORTANCE_MIN,
                ),
            )
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                startForeground(
                    ONGOING_ID,
                    persistentNotification(),
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                startForeground(ONGOING_ID, persistentNotification())
            }
        }
        connect()
    }

    override fun onDestroy() {
        socket?.close(1000, "app stopped")
        socket = null
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ALERTS = "alerts"
        private const val CHANNEL_ONGOING = "live_ongoing"
        private const val ONGOING_ID = 1001

        fun start(ctx: android.content.Context) {
            runCatching {
                ContextCompat.startForegroundService(
                    ctx, Intent(ctx, LiveAlertService::class.java),
                )
            }
        }
    }
}
