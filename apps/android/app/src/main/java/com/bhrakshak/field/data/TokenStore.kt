package com.bhrakshak.field.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

import android.content.SharedPreferences

/**
 * JWT persistence. Access + refresh tokens live in EncryptedSharedPreferences
 * (AES-256, hardware-backed Keystore) — with safe fallback if Keystore fails on launch.
 */
object TokenStore {
    private const val FILE = "bhrakshak_secure"
    private const val KEY_ACCESS = "bh_access"
    private const val KEY_REFRESH = "bh_refresh"
    private const val KEY_EMAIL = "bh_email"

    private fun prefs(ctx: Context): SharedPreferences {
        return try {
            EncryptedSharedPreferences.create(
                ctx,
                FILE,
                MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (e: Exception) {
            ctx.getSharedPreferences(FILE + "_fallback", Context.MODE_PRIVATE)
        }
    }

    fun save(ctx: Context, access: String, refresh: String?, email: String) {
        runCatching {
            prefs(ctx).edit()
                .putString(KEY_ACCESS, access)
                .putString(KEY_REFRESH, refresh)
                .putString(KEY_EMAIL, email)
                .apply()
        }
    }

    fun access(ctx: Context): String? = runCatching { prefs(ctx).getString(KEY_ACCESS, null) }.getOrNull()
    fun refresh(ctx: Context): String? = runCatching { prefs(ctx).getString(KEY_REFRESH, null) }.getOrNull()
    fun email(ctx: Context): String? = runCatching { prefs(ctx).getString(KEY_EMAIL, null) }.getOrNull()

    fun clear(ctx: Context) { runCatching { prefs(ctx).edit().clear().apply() } }
}
