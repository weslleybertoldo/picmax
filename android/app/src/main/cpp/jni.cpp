// jni.cpp — ponte JNI do plugin ImageEnhancer (Task 10): decode (stb) → Real-ESRGAN 4x por tiles
// (realesrgan.cpp) → JPEG q90 (stb_write), com progresso por tile e cancelamento cooperativo.
//
// Threading: nativeEnhance roda numa Thread Kotlin e é SÍNCRONO — o callback de progresso dispara
// dentro dessa mesma chamada nativa, então o JNIEnv* recebido pelo método é válido pro
// CallVoidMethod (o env de um método nativo vale pela duração da chamada naquela thread). Não
// precisa cachear JavaVM/AttachCurrentThread: nenhum callback sobrevive ao retorno de nativeEnhance.
#include <jni.h>

#include <algorithm>
#include <atomic>
#include <memory>
#include <new>

#include <android/asset_manager_jni.h>
#include <android/log.h>

#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

#include "gpu.h" // ncnn::get_gpu_count
#include "mat.h" // ncnn::resize_bilinear_c3
#include "realesrgan.h"

#define LOG_TAG "picmaxenhance"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

namespace {
// Engine global: o plugin é singleton no processo e o Kotlin serializa enhance() (enhanceRunning),
// então não há corrida entre init/enhance. g_cancel é atômico porque nativeCancel chega de OUTRA
// thread (a main do Capacitor) enquanto process() lê a flag na thread de trabalho.
std::unique_ptr<RealEsrgan> g_engine;
std::atomic<bool> g_cancel{false};

constexpr int kOk = 0, kError = 1, kCancelled = 2;

std::string jstringToUtf8(JNIEnv* env, jstring s) {
    const char* chars = env->GetStringUTFChars(s, nullptr);
    if (!chars) return {};
    std::string out(chars);
    env->ReleaseStringUTFChars(s, chars);
    return out;
}
} // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_com_bertoldo_picmax_ImageEnhancerPlugin_nativeHasVulkan(JNIEnv*, jobject) {
    // get_gpu_count cria a instância Vulkan sob demanda; devolve 0 sem driver/sem device — é o
    // seletor GPU/CPU do Kotlin. Device tipo 3 (cpu, ex.: SwiftShader do emulador API 30) NÃO conta
    // como GPU: é Vulkan emulado em CPU, MUITO mais lento que o caminho CPU nativo do ncnn (visto no
    // smoke real: init de minutos no AVD revapk30 — o Vulkan "existir" não significa ser utilizável).
    if (ncnn::get_gpu_count() <= 0) return JNI_FALSE;
    return ncnn::get_gpu_info().type() != 3 ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_bertoldo_picmax_ImageEnhancerPlugin_nativeInit(JNIEnv* env, jobject, jobject assetManager,
                                                        jboolean useGpu) {
    // Engine CACHEADO entre enhances: re-init só quando o modo GPU/CPU muda. Não é só otimização —
    // recarregar o Net a cada chamada travava o 2º nativeInit num spin de lock do OpenMP (libomp do
    // ncnn; deadlock com atfork handler, visto no smoke real do AVD revapk30: thread a 100% CPU em
    // __kmp_acquire_ticket_lock para sempre). Init 1x por processo evita reentrar nesse caminho.
    if (g_engine && g_engine->gpu == static_cast<bool>(useGpu)) return kOk;

    AAssetManager* mgr = AAssetManager_fromJava(env, assetManager);
    if (!mgr) {
        LOGE("AAssetManager_fromJava falhou");
        return kError;
    }
    g_engine.reset(); // libera o engine antigo ANTES de criar o novo (pico de memória e VkDevice duplicado)
    auto engine = std::make_unique<RealEsrgan>();
    if (engine->load(mgr, "models/realesr-general-x4v3.param",
                     "models/realesr-general-x4v3.bin", useGpu) != 0) {
        LOGE("falha ao carregar o modelo dos assets (useGpu=%d)", (int)useGpu);
        return kError;
    }
    g_engine = std::move(engine);
    LOGI("modelo carregado (useGpu=%d, tilesize=%d)", (int)useGpu, g_engine->tilesize);
    return kOk;
}

extern "C" JNIEXPORT void JNICALL
Java_com_bertoldo_picmax_ImageEnhancerPlugin_nativeCancel(JNIEnv*, jobject) {
    g_cancel = true;
}

// Reset da flag no INÍCIO do fluxo Kotlin (antes do nativeInit) — não dentro de nativeEnhance:
// o init pode levar MINUTOS (1º uso em GPU lenta) e um cancel emitido durante ele era apagado
// pelo reset tardio, fazendo a UI ficar em "Cancelando…" enquanto o enhance completava inteiro.
// O retry GPU→CPU do Kotlin NÃO chama isto de novo: cancel na 1ª tentativa vale pra 2ª.
extern "C" JNIEXPORT void JNICALL
Java_com_bertoldo_picmax_ImageEnhancerPlugin_nativeResetCancel(JNIEnv*, jobject) {
    g_cancel = false;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_bertoldo_picmax_ImageEnhancerPlugin_nativeEnhance(JNIEnv* env, jobject thiz, jstring jin,
                                                           jstring jout, jint maxOutputSide) {
    if (!g_engine) return kError;
    // Cancel chegado durante o nativeInit (a flag é resetada ANTES do init, via nativeResetCancel):
    // aborta aqui, antes de decodificar/processar qualquer tile.
    if (g_cancel.load(std::memory_order_relaxed)) {
        LOGI("cancelado antes do processamento");
        return kCancelled;
    }

    const std::string inPath = jstringToUtf8(env, jin);
    const std::string outPath = jstringToUtf8(env, jout);
    if (inPath.empty() || outPath.empty()) return kError;

    int w = 0, h = 0, comp = 0;
    unsigned char* decoded = stbi_load(inPath.c_str(), &w, &h, &comp, 3);
    if (!decoded) {
        LOGE("stbi_load falhou (%s): %s", inPath.c_str(), stbi_failure_reason());
        return kError;
    }
    // guarda RAII do buffer do stb (evita free manual em cada early-return)
    std::unique_ptr<unsigned char, decltype(&stbi_image_free)> decodedGuard(decoded, &stbi_image_free);

    // Se a saída 4x estourar maxOutputSide, reduz a ENTRADA antes da inferência (bilinear) em vez
    // de reduzir a saída depois: mesmo resultado prático (a saída respeita o limite), mas limita a
    // MEMÓRIA e o TRABALHO — uma foto 12MP viraria 16000x12000 (576MB só de buffer RGB) pra depois
    // jogar píxel fora; pré-reduzindo, o buffer de saída nunca passa de maxOutputSide² e a
    // inferência processa só o necessário.
    const int maxSide = maxOutputSide > 0 ? maxOutputSide : 8192;
    const unsigned char* rgb = decoded;
    std::unique_ptr<unsigned char[]> shrunk;
    if (static_cast<long>(std::max(w, h)) * g_engine->scale > maxSide) {
        const int targetInSide = std::max(1, maxSide / g_engine->scale);
        const float s = static_cast<float>(targetInSide) / static_cast<float>(std::max(w, h));
        const int nw = std::max(1, static_cast<int>(w * s + 0.5f));
        const int nh = std::max(1, static_cast<int>(h * s + 0.5f));
        // new(nothrow), não vector: o INTERFACE do target ncnn propaga -fno-exceptions pra este TU
        // (visto no build real) — bad_alloc/try não compilam; falta de memória vira código de erro.
        shrunk.reset(new (std::nothrow) unsigned char[static_cast<size_t>(nw) * nh * 3]);
        if (!shrunk) {
            LOGE("sem memória para a entrada reduzida %dx%d", nw, nh);
            return kError;
        }
        ncnn::resize_bilinear_c3(decoded, w, h, w * 3, shrunk.get(), nw, nh, nw * 3);
        decodedGuard.reset(); // libera o full-res já — só o reduzido segue em uso
        rgb = shrunk.get();
        LOGI("entrada pré-reduzida %dx%d -> %dx%d (maxOutputSide=%d)", w, h, nw, nh, maxSide);
        w = nw;
        h = nh;
    }

    const int ow = w * g_engine->scale, oh = h * g_engine->scale;
    std::unique_ptr<unsigned char[]> out(new (std::nothrow) unsigned char[static_cast<size_t>(ow) * oh * 3]);
    if (!out) {
        LOGE("sem memória para a saída %dx%d", ow, oh);
        return kError;
    }

    // Progresso: CallVoidMethod em onNativeProgress(int) do próprio plugin (mesma thread, env
    // válido — ver cabeçalho). Exceção Java pendente derruba CallVoidMethod seguintes: limpa e loga.
    jclass cls = env->GetObjectClass(thiz);
    jmethodID onProgress = cls ? env->GetMethodID(cls, "onNativeProgress", "(I)V") : nullptr;
    if (!onProgress && env->ExceptionCheck()) env->ExceptionClear();
    int lastPercent = -1;
    auto onTile = [&](float frac) -> bool {
        const int percent = std::min(100, static_cast<int>(frac * 100.f + 0.5f));
        if (onProgress && percent != lastPercent) {
            lastPercent = percent;
            env->CallVoidMethod(thiz, onProgress, static_cast<jint>(percent));
            if (env->ExceptionCheck()) env->ExceptionClear();
        }
        return !g_cancel.load(std::memory_order_relaxed);
    };

    int rc = g_engine->process(rgb, w, h, out.get(), onTile);
    // Retry único com tilesize pela metade (T12, robustez) em falha de processamento (rc==1). O ncnn
    // roda com -fno-exceptions neste build (ver comentário sobre "new(nothrow)" acima) — bad_alloc
    // nunca chega aqui como exceção, só como o MESMO código de erro genérico que qualquer outra falha
    // do Extractor (blob incompatível, etc.), então não há como distinguir "falta de memória" de outro
    // erro pelo valor de retorno (limitação documentada, não deu pra fazer melhor sem instrumentar o
    // ncnn). Best-effort: tile menor = pico de memória por inferência menor, cobre o caso comum (OOM
    // num device/tile grande) sem custo no caminho feliz; se a causa raiz não for memória, a 2ª
    // tentativa falha igual e o erro sobe do mesmo jeito — só custou um pouco de tempo. Guardado por
    // tilesize>32 pra nunca tentar 2x com um tile já degenerado. tilesize é restaurado depois: o
    // engine é CACHEADO entre chamadas (ver nativeInit) e o próximo enhance não deve herdar o tile
    // reduzido desta falha.
    //
    // ⚠️ AMPLIFICAÇÃO (T12, review — fix 13): este retry NÃO é o único no caminho da IA — o Kotlin
    // (ImageEnhancerPlugin.enhance) já tenta a mesma imagem 2x no nível GPU→CPU quando rc==1 na GPU.
    // As duas camadas se compõem: (1ª tentativa GPU, tilesize normal) falha → (2ª tentativa GPU,
    // tilesize/2, ESTE retry) falha → Kotlin troca pra CPU → (3ª tentativa CPU, tilesize normal) falha
    // → (4ª tentativa CPU, tilesize/2, ESTE retry de novo) falha → só então rejeita "falha na IA". Pior
    // caso: ATÉ 4 inferências completas da imagem antes de desistir — em hardware modesto/imagem
    // grande, isso pode multiplicar o tempo de espera do usuário por até 4x antes do erro final
    // aparecer (o modal mostra "Melhorando com IA…" o tempo todo, sem diferenciar qual tentativa está
    // rodando). Aceito como trade-off v1 (mais chances de sucesso > tempo de espera num caminho que já
    // é de erro), mas registrado aqui pra quem for debugar "por que demorou tanto pra falhar".
    if (rc == kError && g_engine->tilesize > 32) {
        const int originalTilesize = g_engine->tilesize;
        g_engine->tilesize = std::max(32, originalTilesize / 2);
        LOGI("falha no processamento (rc=1) — retry único com tilesize %d -> %d", originalTilesize,
             g_engine->tilesize);
        lastPercent = -1; // progresso reinicia do zero na tentativa nova
        rc = g_engine->process(rgb, w, h, out.get(), onTile);
        g_engine->tilesize = originalTilesize;
    }
    if (rc != kOk) {
        if (rc == kCancelled) LOGI("processamento cancelado");
        return rc;
    }

    if (!stbi_write_jpg(outPath.c_str(), ow, oh, 3, out.get(), 90)) {
        LOGE("stbi_write_jpg falhou (%s)", outPath.c_str());
        return kError;
    }
    LOGI("saída %dx%d gravada em %s", ow, oh, outPath.c_str());
    return kOk;
}
