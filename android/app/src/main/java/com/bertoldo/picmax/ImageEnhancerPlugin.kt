package com.bertoldo.picmax

import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

// ImageEnhancerPlugin.kt — plugin nativo do PicMax.
// Task 8: saveToGallery grava o JPEG/PNG exportado (src/io/exportImage.ts) no MediaStore, pasta
// Pictures/PicMax (minSdk 29: RELATIVE_PATH funciona sem guarda de versão, sem precisar de
// WRITE_EXTERNAL_STORAGE — MediaStore.Images.Media.EXTERNAL_CONTENT_URI é escopado por app).
// Task 10: enhance/cancelEnhance — Real-ESRGAN 4x via NCNN (libpicmaxenhance.so, ver
// android/app/src/main/cpp/). Bridge TS: src/native/imageEnhancer.ts.
@CapacitorPlugin(name = "ImageEnhancer")
class ImageEnhancerPlugin : Plugin() {

    companion object {
        private const val TAG = "ImageEnhancerPlugin"

        // Lazy + tolerante a falha (não no <clinit> da classe): o plugin é registrado no onCreate da
        // MainActivity — se o System.loadLibrary rodasse ali e falhasse, derrubaria o app inteiro na
        // abertura e levaria junto o saveToGallery da Task 8, que não depende de nada nativo.
        @Volatile private var nativeLibState: Boolean? = null

        @Synchronized
        fun ensureNativeLib(): Boolean {
            nativeLibState?.let { return it }
            return try {
                System.loadLibrary("picmaxenhance")
                nativeLibState = true
                true
            } catch (t: Throwable) {
                Log.e(TAG, "falha ao carregar libpicmaxenhance", t)
                nativeLibState = false
                false
            }
        }
    }

    // Assinaturas espelhadas em cpp/jni.cpp (Java_com_bertoldo_picmax_ImageEnhancerPlugin_*).
    private external fun nativeInit(assetManager: android.content.res.AssetManager, useGpu: Boolean): Int
    private external fun nativeEnhance(inPath: String, outPath: String, maxOutputSide: Int): Int
    private external fun nativeCancel()
    private external fun nativeResetCancel()
    private external fun nativeHasVulkan(): Boolean

    // Serializa: só UMA melhoria por vez (o engine nativo é um singleton de processo).
    private val enhanceRunning = AtomicBoolean(false)

    // UMA thread de trabalho PERSISTENTE pra todos os enhances — não Thread nova por chamada.
    // Não é estilo: o OpenMP do ncnn (libomp) amarra o runtime ao thread master; deixar o master
    // morrer entre enhances deixava lock interno preso e o enhance SEGUINTE travava pra sempre em
    // __kmp_acquire_ticket_lock (100% CPU, visto no smoke real do AVD revapk30 com backtrace).
    // Mesma thread sempre = mesmo master OMP, como o upstream processa N imagens em loop.
    private val enhanceExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "picmax-enhance") }

    // Lido pelo onNativeProgress (thread de trabalho) — @Volatile porque é escrito na própria thread
    // de trabalho mas o valor precisa estar visível também num eventual retry CPU.
    @Volatile private var usingGpu = false

    // Chamado do JNI (env->CallVoidMethod) a cada tile processado, na MESMA thread do nativeEnhance.
    // notifyListeners é thread-safe (posta o eval na thread do WebView).
    @Suppress("unused")
    fun onNativeProgress(percent: Int) {
        notifyListeners("enhanceProgress", JSObject().put("percent", percent).put("usingGpu", usingGpu))
    }

    // enhance({path, maxOutputSide}) → {path, usedGpu}. O trabalho roda no enhanceExecutor e o
    // resolve/reject acontece DEPOIS do método retornar — isso funciona sem setKeepAlive: o
    // callback JS fica guardado até uma resposta chegar (native-bridge mantém o callbackId até o
    // resolve; keepAlive só é necessário pra MÚLTIPLOS callbacks na mesma call, ex. watchPosition),
    // e o objeto PluginCall é mantido vivo pela referência do runnable. Verificado no fonte do
    // Capacitor 8 (Bridge.callPluginMethod / native-bridge.js).
    @PluginMethod
    fun enhance(call: PluginCall) {
        val rawPath = call.getString("path") ?: return call.reject("path requerido")
        val maxOutputSide = call.getInt("maxOutputSide") ?: 8192
        val inPath = rawPath.removePrefix("file://")
        if (!File(inPath).canRead()) return call.reject("arquivo de entrada não encontrado")
        if (!ensureNativeLib()) return call.reject("IA indisponível neste dispositivo")
        if (!enhanceRunning.compareAndSet(false, true)) return call.reject("já existe uma melhoria em andamento")

        enhanceExecutor.execute {
            val outPath = File(context.cacheDir, "enhanced_${System.currentTimeMillis()}.jpg").absolutePath
            try {
                // Reset do cancel AQUI (antes do init), não dentro do nativeEnhance: o init pode
                // levar minutos (1º uso em GPU lenta) e um cancel emitido durante ele era apagado
                // pelo reset tardio — a UI ficava em "Cancelando…" e o enhance completava inteiro.
                // O nativeEnhance checa a flag logo na entrada e aborta com 2 sem processar tiles.
                // NÃO resetar de novo no retry GPU→CPU abaixo: cancel na 1ª tentativa vale pra 2ª.
                nativeResetCancel()
                var useGpu = nativeHasVulkan()
                usingGpu = useGpu
                var rc = if (nativeInit(context.assets, useGpu) == 0) {
                    onNativeProgress(0) // modo GPU/CPU aparece na UI antes do 1º tile (que pode demorar)
                    nativeEnhance(inPath, outPath, maxOutputSide)
                } else 1
                // Vulkan presente mas quebrado (driver de emulador, heap curto…): tenta 1x na CPU
                // antes de desistir — nunca degrada silenciosamente um cancelamento (rc==2).
                if (rc == 1 && useGpu) {
                    Log.w(TAG, "falha na GPU, tentando CPU")
                    useGpu = false
                    usingGpu = false
                    rc = if (nativeInit(context.assets, false) == 0) {
                        onNativeProgress(0)
                        nativeEnhance(inPath, outPath, maxOutputSide)
                    } else 1
                }
                when (rc) {
                    0 -> call.resolve(JSObject().put("path", outPath).put("usedGpu", useGpu))
                    2 -> { File(outPath).delete(); call.reject("cancelado") }
                    else -> { File(outPath).delete(); call.reject("falha na IA") }
                }
            } catch (t: Throwable) {
                Log.e(TAG, "erro no enhance", t)
                File(outPath).delete()
                call.reject(t.message ?: "erro nativo")
            } finally {
                enhanceRunning.set(false)
            }
        }
    }

    @PluginMethod
    fun cancelEnhance(call: PluginCall) {
        if (nativeLibState == true) nativeCancel()
        call.resolve()
    }

    // Abre a tela de detalhes do app nas Configurações do sistema (T12, review — gap 8): usada pelo
    // botão "Abrir Configurações" da Home quando a permissão de câmera/galeria é negada
    // (CameraPermissionDeniedError em src/io/openImage.ts) — o app não tem como pedir a permissão de
    // novo depois de "negar permanentemente" (Android some com o dialog nesse caso), só o usuário
    // habilitando manualmente ali resolve. Mesma tela que "Configurações do app > Permissões".
    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            intent.data = Uri.fromParts("package", context.packageName, null)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "erro ao abrir configurações")
        }
    }

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
