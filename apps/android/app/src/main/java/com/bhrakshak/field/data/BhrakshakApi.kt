package com.bhrakshak.field.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import com.bhrakshak.field.BuildConfig
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part
import retrofit2.http.Query
import java.util.concurrent.TimeUnit

/** Base URL of the shared FastAPI backend. Same server as dashboard + PWA.
 *
 * Defaults to the emulator loopback (10.0.2.2). On a physical phone the user
 * sets their PC's LAN IP on the login screen; it is persisted and both the
 * REST client and the WebSocket are rebuilt around it.
 */
object ApiConfig {
    @Volatile var baseUrl: String = BuildConfig.API_BASE_URL
        private set
    @Volatile var wsUrl: String = BuildConfig.WS_URL
        private set

    /** Point the whole app at a new backend. Accepts http(s)://host[:port]. */
    fun setUrl(url: String) {
        val trimmed = url.trim().trimEnd('/')
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            baseUrl = trimmed
            wsUrl = (if (trimmed.startsWith("https")) "wss" else "ws") +
                trimmed.removePrefix("http").removePrefix("s") + "/ws/live"
        }
    }

    fun isDefault(): Boolean = baseUrl == BuildConfig.API_BASE_URL
}

// ---------------------------------------------------------------------------
// DTOs — field names verified against the live /openapi.json responses
// ---------------------------------------------------------------------------
@Serializable
data class LoginIn(val email: String, val password: String)

@Serializable
data class TokenOut(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("token_type") val tokenType: String = "bearer",
    val role: String? = null,
)

@Serializable
data class ZoneOut(
    val id: String,
    @SerialName("zone_code") val zoneCode: String,
    val name: String? = null,
    val district: String? = null,
    val state: String? = null,
    @SerialName("susc_mean") val suscMean: Double? = null,
    @SerialName("susc_p90") val suscP90: Double? = null,
    val population: Int? = null,
    @SerialName("road_km") val roadKm: Double? = null,
    @SerialName("hazard_level") val hazardLevel: Int = 0,
    @SerialName("prob_24h") val prob24h: Double? = null,
)

@Serializable
data class ReportItem(
    @SerialName("client_id") val clientId: String,
    val category: String,
    val lat: Double,
    val lon: Double,
    val description: String? = null,
    @SerialName("taken_at") val takenAt: String? = null,
    @SerialName("media_refs") val mediaRefs: List<String> = emptyList(),
    @SerialName("exif_geo_ok") val exifGeoOk: Boolean? = null,
)

@Serializable
data class SyncBatchIn(
    @SerialName("batch_id") val batchId: String,
    val reports: List<ReportItem>,
)

@Serializable
data class SyncBatchOut(
    @SerialName("batch_id") val batchId: String,
    val accepted: Int,
    @SerialName("duplicates_merged") val duplicatesMerged: Int,
    val flagged: Int,
    @SerialName("synced_ids") val syncedIds: List<String>,
)

// --- evacuation / pathway model -------------------------------------------
@Serializable
data class SafeRouteOut(
    val origin: Origin? = null,
    val destination: Destination,
    @SerialName("safety_score") val safetyScore: Double,
    val route: RouteGeometry? = null,
    @SerialName("route_length_km") val routeLengthKm: Double,
    @SerialName("eta_minutes") val etaMinutes: Int,
    @SerialName("mean_hazard_along_route") val meanHazard: Double = 0.0,
    @SerialName("max_hazard_along_route") val maxHazard: Double = 0.0,
    @SerialName("avoided_levels") val avoidedLevels: List<Int> = emptyList(),
    val alternatives: List<AlternativeShelter> = emptyList(),
)

@Serializable
data class Origin(val lat: Double, val lon: Double)

@Serializable
data class Destination(
    val id: String,
    val name: String,
    val district: String? = null,
    val lat: Double,
    val lon: Double,
    val capacity: Int? = null,
    val occupancy: Int? = null,
    @SerialName("has_medical") val hasMedical: Boolean? = null,
    @SerialName("slope_deg") val slopeDeg: Double? = null,
    @SerialName("distance_to_steep_slope_m") val distToSteepM: Double? = null,
)

@Serializable
data class RouteGeometry(val type: String, val coordinates: List<List<Double>>)

@Serializable
data class AlternativeShelter(
    @SerialName("shelter_id") val shelterId: String,
    val safety: Double,
    @SerialName("distance_km") val distanceKm: Double,
)

// --- rain gauge ------------------------------------------------------------
@Serializable
data class WeatherOut(
    @SerialName("zone_code") val zoneCode: String,
    val district: String? = null,
    @SerialName("has_data") val hasData: Boolean,
    val current: CurrentWeather? = null,
    @SerialName("id_threshold_check") val idCheck: IdCheck? = null,
    @SerialName("n_points") val nPoints: Int? = null,
)

@Serializable
data class CurrentWeather(
    val ts: String? = null,
    @SerialName("rain_1h_mm") val rain1h: Double? = null,
    @SerialName("rain_24h_mm") val rain24h: Double? = null,
    @SerialName("rain_48h_mm") val rain48h: Double? = null,
    @SerialName("rain_72h_mm") val rain72h: Double? = null,
    @SerialName("rain_7d_mm") val rain7d: Double? = null,
    @SerialName("eff_rain_mm") val effRain: Double? = null,
    @SerialName("soil_moisture_pct") val soilMoisture: Double? = null,
    val trend: String? = null,
)

@Serializable
data class IdCheck(
    @SerialName("i_1h_observed") val i1hObserved: Double? = null,
    @SerialName("i_1h_critical") val i1hCritical: Double? = null,
    @SerialName("breach_1h") val breach1h: Boolean = false,
    @SerialName("i_24h_mean_observed") val i24hObserved: Double? = null,
    @SerialName("i_24h_critical") val i24hCritical: Double? = null,
    @SerialName("breach_24h") val breach24h: Boolean = false,
    @SerialName("any_breach") val anyBreach: Boolean = false,
)

// --- alerts ------------------------------------------------------------------
@Serializable
data class AlertOut(
    val id: String,
    @SerialName("zone_id") val zoneId: String? = null,
    val level: Int,
    val channels: List<String> = emptyList(),
    val recipients: Int? = null,
    @SerialName("message_template") val message: String? = null,
    @SerialName("ack_at") val ackAt: String? = null,
    @SerialName("fired_at") val firedAt: String? = null,
)

// --- Model V geo-photo AI pre-screen ----------------------------------------
@Serializable
data class PhotoVerdict(
    val verdict: String,           // POSITIVE | POSSIBLE | NEGATIVE
    val probability: Double,
    @SerialName("gps_mismatch_m") val gpsMismatchM: Double? = null,
    val flags: List<String> = emptyList(),
    @SerialName("media_key") val mediaKey: String? = null,
)

@Serializable
data class ChatMessageIn(
    @SerialName("sender_name") val senderName: String,
    val location: String? = null,
    val message: String,
    val role: String? = null,
)

@Serializable
data class ChatMessageOut(
    val id: String,
    @SerialName("sender_name") val senderName: String,
    val location: String,
    val message: String,
    val role: String,
    val timestamp: String,
)

// ---------------------------------------------------------------------------
// Retrofit API
// ---------------------------------------------------------------------------
interface BhrakshakApi {
    @POST("api/v1/auth/login")
    suspend fun login(@Body body: LoginIn): TokenOut

    @GET("api/v1/zones")
    suspend fun zones(
        @Query("bbox") bbox: String? = null,
        @Query("district") district: String? = null,
        @Header("Authorization") token: String? = null,
    ): List<ZoneOut>

    @POST("api/v1/reports/sync")
    suspend fun syncReports(
        @Body batch: SyncBatchIn,
        @Header("Authorization") token: String,
    ): SyncBatchOut

    @GET("api/v1/evacuation/safe-route")
    suspend fun safeRoute(
        @Query("lat") lat: Double,
        @Query("lon") lon: Double,
        @Query("population") population: Int? = null,
    ): SafeRouteOut

    @GET("api/v1/zones/{zoneId}/weather")
    suspend fun zoneWeather(
        @retrofit2.http.Path("zoneId") zoneId: String,
    ): WeatherOut

    @GET("api/v1/alerts")
    suspend fun alerts(
        @Header("Authorization") token: String,
    ): List<AlertOut>

    @Multipart
    @POST("api/v1/reports/analyze-photo")
    suspend fun analyzePhoto(
        @Part photo: okhttp3.MultipartBody.Part,
        @Query("lat") lat: Double? = null,
        @Query("lon") lon: Double? = null,
        @Query("taken_at") takenAt: String? = null,
        @Header("Authorization") token: String,
    ): PhotoVerdict

    @GET("api/v1/chat/messages")
    suspend fun chatMessages(
        @Header("Authorization") token: String,
    ): List<ChatMessageOut>

    @POST("api/v1/chat/send")
    suspend fun sendChatMessage(
        @Body msg: ChatMessageIn,
        @Header("Authorization") token: String,
    ): ChatMessageOut
}

// ---------------------------------------------------------------------------
// Singleton client — rebuilt when the user repoints the server on login
// ---------------------------------------------------------------------------
object Api {
    val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    private fun buildClient(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val req = chain.request().newBuilder()
                .header("Bypass-Tunnel-Remainder", "true")
                .header("User-Agent", "BhuRakshak-AndroidApp/1.0")
                .build()
            chain.proceed(req)
        }
        .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BODY })
        .build()

    val wsClient: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    @Volatile var service: BhrakshakApi = build()
        private set

    private fun build(): BhrakshakApi {
        val contentType = "application/json".toMediaType()
        return Retrofit.Builder()
            .baseUrl(if (ApiConfig.baseUrl.endsWith("/")) ApiConfig.baseUrl else ApiConfig.baseUrl + "/")
            .client(buildClient())
            .addConverterFactory(json.asConverterFactory(contentType))
            .build()
            .create(BhrakshakApi::class.java)
    }

    /** Rebuild Retrofit after ApiConfig.apply(newUrl). */
    fun rebuild() {
        service = build()
    }
}
