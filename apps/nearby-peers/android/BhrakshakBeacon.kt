/*
 * BhrakshakBeacon.kt — native BLE transport for nearby-peers.
 *
 * A browser cannot BLE-advertise; this Kotlin file gives the Android shell
 * the missing half of the feature. It implements the exact 21-byte frame
 * documented in ../../src/frame.ts, so the field PWA (Web Bluetooth scan)
 * and any other rescuer device decode these advertisements natively.
 *
 * Copy this file into your Android project (e.g. app/src/main/java/.../nearby/)
 * — it has zero project-specific imports and only needs these permissions in
 * AndroidManifest.xml (runtime-request on API 31+):
 *
 *   <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
 *   <uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
 *   <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
 *
 * Usage:
 *   val beacon = BhrakshakBeacon(context)
 *   beacon.startAdvertising(payload)          // citizen consent ON
 *   beacon.stopAdvertising()                  // consent OFF
 *   beacon.startScanning { frame, rssi -> }   // rescuer mode (offline peers)
 *   beacon.stopScanning()
 */
package com.bhrakshak.field.nearby

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.ParcelUuid
import android.os.Build
import androidx.core.content.ContextCompat
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

object BeaconSpec {
    const val MANUFACTURER_ID = 0xFFFF // Bluetooth SIG reserved (internal/demo use)
    const val MAGIC = 0xB8
    const val VERSION = 0x01
    const val FRAME_LEN = 21

    const val ROLE_CITIZEN = 0
    const val ROLE_FIELD = 1
    const val ROLE_RELAY = 2

    fun crc8(bytes: ByteArray, len: Int = bytes.size): Int {
        var crc = 0
        for (i in 0 until len) {
            crc = crc xor (bytes[i].toInt() and 0xFF)
            repeat(8) {
                crc = if (crc and 0x80 != 0) ((crc shl 1) xor 0x07) and 0xFF else (crc shl 1) and 0xFF
            }
        }
        return crc
    }
}

/** Pure data — build it wherever you hold consent/GPS state. */
data class BeaconPayload(
    val peerId: String,          // 8 hex chars, rotates daily (mirror src/identity.ts)
    val role: Int,               // BeaconSpec.ROLE_*
    val seq: Int,
    val needsHelp: Boolean,
    val batteryPct: Int?,        // null → 0xFF unknown
    val lat: Double?,            // null → has_gps flag clear
    val lon: Double?,
    val accuracyM: Int?,
) {
    fun encode(): ByteArray {
        val out = ByteArray(BeaconSpec.FRAME_LEN)
        val hasGps = lat != null && lon != null
        out[0] = BeaconSpec.MAGIC.toByte()
        out[1] = BeaconSpec.VERSION.toByte()
        out[2] = ((if (hasGps) 1 else 0) or (if (needsHelp) 2 else 0) or 4).toByte()

class BhrakshakBeacon(context: Context) {

    private val appContext = context.applicationContext
    private val adapter: BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private var advertiser: android.bluetooth.le.BluetoothLeAdvertiser? = null
    private var advertiseCallback: AdvertiseCallback? = null

    private var scanner: BluetoothLeScanner? = null
    private var scanCallback: ScanCallback? = null

    private fun has(permission: String) =
        ContextCompat.checkSelfPermission(appContext, permission) == PackageManager.PERMISSION_GRANTED

    // ---- advertise (citizen) ------------------------------------------------

    fun startAdvertising(payload: BeaconPayload, onError: ((String) -> Unit)? = null): Boolean {
        if (!has(Manifest.permission.BLUETOOTH_ADVERTISE) && Build.VERSION.SDK_INT >= 31) {
            onError?.invoke("missing BLUETOOTH_ADVERTISE"); return false
        }
        val adv = adapter?.bluetoothLeAdvertiser ?: run { onError?.invoke("advertising unsupported"); return false }
        stopAdvertising()

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(false)
            .setTimeout(0)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false) // privacy: never leak the device name
            .addManufacturerData(BeaconSpec.MANUFACTURER_ID, payload.encode())
            .build()

        val cb = object : AdvertiseCallback() {
            override fun onStartFailure(errorCode: Int) { onError?.invoke("advertise failed: $errorCode") }
        }
        adv.startAdvertising(settings, data, cb)
        advertiser = adv
        advertiseCallback = cb
        return true
    }

    fun stopAdvertising() {
        try { advertiser?.stopAdvertising(advertiseCallback) } catch (_: SecurityException) { }
        advertiseCallback = null
        advertiser = null
    }

    // ---- scan (rescuer, offline) ---------------------------------------------

    /** Frames of nearby consenting peers. Dedupes by (peerId, seq). */
    fun startScanning(onFrame: (BeaconPayload, rssi: Int) -> Unit, onError: ((String) -> Unit)? = null): Boolean {
        if (Build.VERSION.SDK_INT >= 31 && !has(Manifest.permission.BLUETOOTH_SCAN)) {
            onError?.invoke("missing BLUETOOTH_SCAN"); return false
        }
        val sc = adapter?.bluetoothLeScanner ?: run { onError?.invoke("scanner unavailable"); return false }
        stopScanning()

        val seen = HashSet<Long>()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val bytes = result.scanRecord?.getManufacturerSpecificData(BeaconSpec.MANUFACTURER_ID) ?: return
                val frame = decode(bytes) ?: return
                val dedupeKey = frame.peerId.hashCode().toLong() * 65536 + frame.seq
                if (!seen.add(dedupeKey)) return
                if (seen.size > 512) seen.clear()
                onFrame(frame, result.rssi)
            }
        }
        val filter = ScanFilter.Builder().setManufacturerData(
            BeaconSpec.MANUFACTURER_ID,
            byteArrayOf(BeaconSpec.MAGIC.toByte(), BeaconSpec.VERSION.toByte()),
            byteArrayOf(0xFF.toByte(), 0xFF.toByte()),
        ).build()
        sc.startScan(
            listOf(filter),
            ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER) // duty-cycled by the OS
                .build(),
            cb,
        )
        scanner = sc
        scanCallback = cb
        return true
    }

    fun stopScanning() {
        try { scanCallback?.let { scanner?.stopScan(it) } } catch (_: SecurityException) { }
        scanCallback = null
        scanner = null
    }

    // ---- decode (same layout as src/frame.ts tryDecodeBeaconFrame) -----------

    fun decode(bytes: ByteArray): BeaconPayload? {
        if (bytes.size < BeaconSpec.FRAME_LEN) return null
        if (bytes[0].toInt() and 0xFF != BeaconSpec.MAGIC || bytes[1].toInt() and 0xFF != BeaconSpec.VERSION) return null
        if (BeaconSpec.crc8(bytes, 20) != (bytes[20].toInt() and 0xFF)) return null
        val flags = bytes[2].toInt() and 0xFF
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var peerId = ""
        for (i in 5..8) peerId += (bytes[i].toInt() and 0xFF).toString(16).padStart(2, '0')
        val batteryRaw = bytes[10].toInt() and 0xFF
        return BeaconPayload(
            peerId = peerId,
            role = bytes[9].toInt() and 0xFF,
            seq = (bytes[3].toInt() and 0xFF) or ((bytes[4].toInt() and 0xFF) shl 8),
            needsHelp = flags and 2 != 0,
            batteryPct = if (batteryRaw == 0xFF) null else batteryRaw,
            lat = if (flags and 1 != 0) buf.getInt(11) / 1e7 else null,
            lon = if (flags and 1 != 0) buf.getInt(15) / 1e7 else null,
            accuracyM = if (flags and 1 != 0) bytes[19].toInt() and 0xFF else null,
        )
    }
}

        ByteBuffer.wrap(out, 3, 2).order(ByteOrder.LITTLE_ENDIAN).putShort(seq.toShort())
        for (i in 0 until 4) out[5 + i] = peerId.padEnd(8, '0').substring(i * 2, i * 2 + 2).toInt(16).toByte()
        out[9] = role.toByte()
        out[10] = ((batteryPct?.coerceIn(0, 100)) ?: 0xFF).toByte()
        ByteBuffer.wrap(out, 11, 8).order(ByteOrder.LITTLE_ENDIAN).let {
            it.putInt(((lat ?: 0.0) * 1e7).roundToInt())
            it.putInt(((lon ?: 0.0) * 1e7).roundToInt())
        }
        out[19] = (accuracyM?.coerceIn(0, 255) ?: 0).toByte()
        out[20] = BeaconSpec.crc8(out, 20).toByte()
        return out
    }
}
