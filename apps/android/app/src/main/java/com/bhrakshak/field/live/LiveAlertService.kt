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

    private fun isAlertNearUser(obj: JSONObject): Boolean {
        if (!obj.has("lat") || !obj.has("lon")) return true
        val alat = obj.optDouble("lat", 0.0)
        val alon = obj.optDouble("lon", 0.0)
        if (alat == 0.0 && alon == 0.0) return true

        val prefs = getSharedPreferences("bhrakshak_cache", MODE_PRIVATE)
        val isSimulated = prefs.getBoolean("is_location_simulated", false)
        val rawLoc = prefs.getString("last_location", null) ?: return true
        val parts = rawLoc.split(",")
        if (parts.size < 2) return true
        val dlat = parts[0].toDoubleOrNull() ?: return true
        val dlon = parts[1].toDoubleOrNull() ?: return true

        val r = 6371.0
        val dLat = Math.toRadians(alat - dlat)
        val dLon = Math.toRadians(alon - dlon)
        val a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(Math.toRadians(dlat)) * Math.cos(Math.toRadians(alat)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2)
        val c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
        val distKm = r * c

        // Always allow if within 150 km, or if simulated location is active
        return isSimulated || distKm <= 150.0
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            retry = 0
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching {
                val obj = JSONObject(text)
                when (obj.optString("type")) {
                    "alert" -> {
                        if (isAlertNearUser(obj)) {
                            notify(
                                "⚠ L${obj.optInt("level", 0)} ${obj.optString("name")}",
                                obj.optString("message"),
                                notifId = obj.optString("zone_code").hashCode(),
                            )
                        }
                    }
                    "allclear" -> {
                        notify(
                            "🟢 ${obj.optString("name", "All Clear")}",
                            obj.optString("message", "All clear issued for district"),
                            notifId = "allclear".hashCode(),
                        )
                    }
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
        socket?.close(1000, "reconnecting")
        val request = Request.Builder().url(ApiConfig.wsUrl).build()
        socket = Api.wsClient.newWebSocket(request, listener)
    }

    private fun scheduleReconnect() {
        val delayMs = minOf(1000L shl retry.coerceAtMost(5), 30000L)
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
        postAlertNotification(this, title, body, notifId)
    }

    override fun onCreate() {
        super.onCreate()
        runCatching {
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            val alertChannel = NotificationChannel(
                CHANNEL_ALERTS, "Landslide alerts", NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Emergency landslide warnings and evacuation alerts"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 500, 200, 500)
            }
            manager.createNotificationChannel(alertChannel)
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
        const val CHANNEL_ALERTS = "alerts"
        const val CHANNEL_ONGOING = "live_ongoing"
        private const val ONGOING_ID = 1001

        fun start(ctx: android.content.Context) {
            runCatching {
                ContextCompat.startForegroundService(
                    ctx, Intent(ctx, LiveAlertService::class.java),
                )
            }
        }

        fun postAlertNotification(ctx: android.content.Context, title: String, body: String, notifId: Int = title.hashCode()) {
            runCatching {
                val manager = ctx.getSystemService(NOTIFICATION_SERVICE) as? NotificationManager
                if (manager != null && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    val alertChannel = NotificationChannel(
                        CHANNEL_ALERTS, "Landslide alerts", NotificationManager.IMPORTANCE_HIGH,
                    ).apply {
                        description = "Emergency landslide warnings and evacuation alerts"
                        enableVibration(true)
                        vibrationPattern = longArrayOf(0, 500, 200, 500)
                    }
                    manager.createNotificationChannel(alertChannel)
                }

                val intent = Intent(ctx, MainActivity::class.java)
                val pending = PendingIntent.getActivity(
                    ctx, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val notification = NotificationCompat.Builder(ctx, CHANNEL_ALERTS)
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                    .setContentIntent(pending)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setDefaults(NotificationCompat.DEFAULT_ALL)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setVibrate(longArrayOf(0, 500, 200, 500))
                    .setAutoCancel(true)
                    .build()

                NotificationManagerCompat.from(ctx).notify(notifId, notification)
            }
        }
    }
}
