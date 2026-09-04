package com.bhrakshak.field.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.bhrakshak.field.data.Api
import com.bhrakshak.field.data.BhuDb
import com.bhrakshak.field.data.ReportItem
import com.bhrakshak.field.data.SyncBatchIn
import com.bhrakshak.field.data.TokenStore
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Flushes the offline report queue to the backend.
 *
 * Scheduled every 15 minutes AND triggered immediately on connectivity
 * (ConnectivityManager callback registered in MainActivity — see
 * [triggerNow]). Retries forever with backoff — WorkManager guarantees the
 * enqueue survives process death and reboots, which is the whole point for
 * NER valleys with patchy links.
 */
class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val db = BhuDb.get(applicationContext)
        val dao = db.queueDao()
        val pending = dao.pendingOnce()
        if (pending.isEmpty()) return Result.success()

        val token = TokenStore.access(applicationContext)
            ?: return Result.retry() // not logged in yet; try after login

        return try {
            val syncedIds = mutableListOf<String>()
            val remaining = mutableListOf<com.bhrakshak.field.data.QueuedReport>()

            // 1. Upload reports that have local photos via /api/v1/images/upload
            for (r in pending) {
                var uploaded = false
                if (!r.photoPath.isNullOrBlank()) {
                    val photoFile = File(r.photoPath)
                    if (photoFile.exists() && photoFile.length() > 0L) {
                        try {
                            val part = MultipartBody.Part.createFormData(
                                "photo", photoFile.name,
                                photoFile.readBytes().toRequestBody("image/jpeg".toMediaTypeOrNull())
                            )
                            val textType = "text/plain".toMediaTypeOrNull()
                            Api.service.uploadImageReport(
                                photo = part,
                                description = r.description?.toRequestBody(textType),
                                category = r.category.toRequestBody(textType),
                                lat = r.lat.toString().toRequestBody(textType),
                                lon = r.lon.toString().toRequestBody(textType),
                                clientId = r.clientId.toRequestBody(textType),
                                takenAt = r.takenAt.toRequestBody(textType),
                                token = "Bearer $token",
                            )
                            syncedIds.add(r.clientId)
                            uploaded = true
                        } catch (e: Exception) {
                            // Upload failed; fallback to regular batch sync
                        }
                    }
                }
                if (!uploaded) {
                    remaining.add(r)
                }
            }

            // 2. Batch sync any remaining reports without images or that failed image upload
            if (remaining.isNotEmpty()) {
                val out = Api.service.syncReports(
                    SyncBatchIn(
                        batchId = UUID.randomUUID().toString(),
                        reports = remaining.map { r ->
                            ReportItem(
                                clientId = r.clientId,
                                category = r.category,
                                lat = r.lat,
                                lon = r.lon,
                                description = r.description,
                                takenAt = r.takenAt,
                                mediaRefs = listOfNotNull(r.mediaKey),
                                exifGeoOk = true,
                            )
                        },
                    ),
                    token = "Bearer $token",
                )
                syncedIds.addAll(out.syncedIds)
            }

            if (syncedIds.isNotEmpty()) {
                dao.markSynced(syncedIds)
                dao.prune(System.currentTimeMillis() - 7L * 24 * 3600 * 1000)
            }
            Result.success()
        } catch (e: Exception) {
            Result.retry() // offline or 5xx; WorkManager backs off exponentially
        }
    }

    companion object {
        fun schedule(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                "bhrakshak-sync",
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).build(),
            )
        }

        /** Immediate flush — called when the network comes back. */
        fun triggerNow(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                "bhrakshak-sync-now",
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<SyncWorker>().build(),
            )
        }
    }
}
