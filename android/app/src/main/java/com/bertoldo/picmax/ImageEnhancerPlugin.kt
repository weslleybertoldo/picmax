package com.bertoldo.picmax

import android.content.ContentValues
import android.provider.MediaStore
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// ImageEnhancerPlugin.kt — plugin nativo do PicMax.
// Task 8: saveToGallery grava o JPEG/PNG exportado (src/io/exportImage.ts) no MediaStore, pasta
// Pictures/PicMax (minSdk 29: RELATIVE_PATH funciona sem guarda de versão, sem precisar de
// WRITE_EXTERNAL_STORAGE — MediaStore.Images.Media.EXTERNAL_CONTENT_URI é escopado por app).
// enhance/cancelEnhance (IA Real-ESRGAN via NCNN/Vulkan) chegam na Task 10. Bridge TS:
// src/native/imageEnhancer.ts.
@CapacitorPlugin(name = "ImageEnhancer")
class ImageEnhancerPlugin : Plugin() {

    @PluginMethod
    fun saveToGallery(call: PluginCall) {
        val b64 = call.getString("base64") ?: return call.reject("base64 requerida")
        val mime = call.getString("mime") ?: "image/jpeg"
        val bytes = Base64.decode(b64, Base64.DEFAULT)
        val name = "PicMax_${System.currentTimeMillis()}.${if (mime.endsWith("png")) "png" else "jpg"}"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/PicMax")
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: return call.reject("Falha ao criar entrada na galeria")
        try {
            resolver.openOutputStream(uri).use { it!!.write(bytes) }
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            return call.reject("Falha ao gravar: ${e.message}")
        }
        call.resolve(JSObject().put("uri", uri.toString()))
    }
}
