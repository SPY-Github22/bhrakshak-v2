package com.bhrakshak.field.data

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.MediaStore
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max

/**
 * Android image capture, client-side downsampling, compression, and multipart request building.
 */
object ImageUploadHelper {

    fun createCameraIntent(): Intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)

    fun createGalleryIntent(): Intent = Intent(Intent.ACTION_GET_CONTENT).apply {
        type = "image/*"
        addCategory(Intent.CATEGORY_OPENABLE)
    }

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

    fun compressImage(
        sourceFile: File,
        targetFile: File,
        maxDimension: Int = 1280,
        quality: Int = 85,
    ): File {
        if (!sourceFile.exists() || sourceFile.length() == 0L) return sourceFile

        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        BitmapFactory.decodeFile(sourceFile.absolutePath, options)

        val origW = options.outWidth
        val origH = options.outHeight
        if (origW <= 0 || origH <= 0) return sourceFile

        var inSampleSize = 1
        val maxSide = max(origW, origH)
        if (maxSide > maxDimension) {
            val halfMax = maxSide / 2
            while ((halfMax / inSampleSize) >= maxDimension) {
                inSampleSize *= 2
            }
        }

        val decodeOptions = BitmapFactory.Options().apply {
            inSampleSize = inSampleSize
            inPreferredConfig = Bitmap.Config.RGB_565
        }
        val decodedBmp = BitmapFactory.decodeFile(sourceFile.absolutePath, decodeOptions)
            ?: return sourceFile

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

        FileOutputStream(targetFile).use { out ->
            finalBmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
        }

        if (finalBmp != decodedBmp) decodedBmp.recycle()
        finalBmp.recycle()

        return targetFile
    }
}
