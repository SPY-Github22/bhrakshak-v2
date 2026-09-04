package com.bhrakshak.imageupload

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.MediaStore
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max

/**
 * Reusable helper for Android image capture, client-side downsampling,
 * compression, and multipart request building.
 */
object ImageUploadHelper {

    /**
     * Intent to capture a new photo via device camera.
     */
    fun createCameraIntent(): Intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)

    /**
     * Intent to select an image from the device gallery or photo picker.
     */
    fun createGalleryIntent(): Intent = Intent(Intent.ACTION_GET_CONTENT).apply {
        type = "image/*"
        addCategory(Intent.CATEGORY_OPENABLE)
    }

    /**
     * Copy an image from a content Uri (e.g. Gallery pick) into a target local cache file.
     */
    fun copyUriToFile(ctx: Context, uri: Uri, destFile: File): Boolean {
        return try {
            ctx.contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(destFile).use { output ->
                    input.copyTo(output)
                }
            }
            destFile.exists() && destFile.length() > 0L
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Decode and downsample an image file so its maximum dimension is at most [maxDimension],
     * compressed as JPEG with [quality]% quality. Prevents OutOfMemory errors and ensures
     * reliable uploads over spotty mobile networks.
     */
    fun compressImage(
        sourceFile: File,
        targetFile: File,
        maxDimension: Int = 1280,
        quality: Int = 85,
    ): File {
        if (!sourceFile.exists() || sourceFile.length() == 0L) return sourceFile

        // 1. Read image dimensions without loading full pixels into memory
        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        BitmapFactory.decodeFile(sourceFile.absolutePath, options)

        val origW = options.outWidth
        val origH = options.outHeight
        if (origW <= 0 || origH <= 0) return sourceFile

        // 2. Compute inSampleSize power of 2
        var inSampleSize = 1
        val maxSide = max(origW, origH)
        if (maxSide > maxDimension) {
            val halfMax = maxSide / 2
            while ((halfMax / inSampleSize) >= maxDimension) {
                inSampleSize *= 2
            }
        }

        // 3. Decode scaled bitmap
        val decodeOptions = BitmapFactory.Options().apply {
            inSampleSize = inSampleSize
            inPreferredConfig = Bitmap.Config.RGB_565 // half memory footprint
        }
        val decodedBmp = BitmapFactory.decodeFile(sourceFile.absolutePath, decodeOptions)
            ?: return sourceFile

        // 4. Exact scale if still slightly larger than maxDimension
        val curW = decodedBmp.width
        val curH = decodedBmp.height
        val finalBmp = if (max(curW, curH) > maxDimension) {
            val scale = maxDimension.toFloat() / max(curW, curH).toFloat()
            val dstW = (curW * scale).toInt()
            val dstH = (curH * scale).toInt()
            Bitmap.createScaledBitmap(decodedBmp, dstW, dstH, true)
        } else {
            decodedBmp
        }

        // 5. Compress to destination file
        FileOutputStream(targetFile).use { out ->
            finalBmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
        }

        if (finalBmp != decodedBmp) decodedBmp.recycle()
        finalBmp.recycle()

        return targetFile
    }

    /**
     * Build multipart form data for uploading an image report.
     */
    fun buildMultipart(
        photoFile: File,
        description: String?,
        category: String = "slope_movement",
        lat: Double? = null,
        lon: Double? = null,
        clientId: String? = null,
        takenAt: String? = null,
    ): MultipartBody {
        val builder = MultipartBody.Builder().setType(MultipartBody.FORM)

        val fileBody = photoFile.asRequestBody("image/jpeg".toMediaTypeOrNull())
        builder.addFormDataPart("photo", photoFile.name, fileBody)

        description?.let { builder.addFormDataPart("description", it) }
        builder.addFormDataPart("category", category)
        lat?.let { builder.addFormDataPart("lat", it.toString()) }
        lon?.let { builder.addFormDataPart("lon", it.toString()) }
        clientId?.let { builder.addFormDataPart("client_id", it) }
        takenAt?.let { builder.addFormDataPart("taken_at", it) }

        return builder.build()
    }
}
