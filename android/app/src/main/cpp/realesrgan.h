// realesrgan.h — wrapper próprio do Real-ESRGAN sobre ncnn::Net (Task 10).
//
// ADAPTADO, não vendorado: o realesrgan.cpp upstream (xinntao/Real-ESRGAN-ncnn-vulkan) depende de
// shaders Vulkan custom pré-compilados (realesrgan_preproc/postproc *.spv.hex.h, gerados pelo build
// dele via glslangValidator) só para converter RGB u8 <-> float na GPU. Aqui o pre/pós-processamento
// (normalizar 0..1, desnormalizar, recorte do padding) é feito em CPU com ncnn::Mat::from_pixels +
// substract_mean_normalize — a INFERÊNCIA continua indo pra GPU quando use_vulkan_compute=true (o
// ncnn cuida do upload/download por dentro do Extractor). Mais simples, sem build de shader, e o
// custo extra de CPU é desprezível perto da inferência.
//
// Modelo esperado: realesr-general-x4v3 (SRVGGNetCompact), blob de entrada "data" (RGB float 0..1),
// blob de saída "output" (RGB float 0..1, 4x maior) — ver assets/models/realesr-general-x4v3.param.
#ifndef PICMAX_REALESRGAN_H
#define PICMAX_REALESRGAN_H

#include <functional>

#include <android/asset_manager.h>

#include "net.h"

class RealEsrgan {
public:
    // Fator fixo do realesr-general-x4v3. tilesize é decidido no load() (GPU 128 / CPU 256 — tiles
    // menores na GPU respeitam o heap Vulkan de devices modestos; na CPU tiles maiores amortizam o
    // overhead por tile). prepadding 8px: cada tile é inferido com uma borda de contexto que depois
    // é DESCARTADA na montagem — sem isso a convolução "enxerga" a borda do tile e aparecem emendas
    // (seams) visíveis na grade de tiles.
    int scale = 4;
    int tilesize = 256;
    int prepadding = 8;
    // Config com que load() rodou — o jni.cpp usa pra CACHEAR o engine entre enhances (re-init só
    // quando o modo GPU/CPU muda). Não é só otimização: re-carregar o Net a cada enhance deixava a
    // thread PRESA num spin de lock do OpenMP (libomp do ncnn) no 2º nativeInit — deadlock real
    // visto no smoke do AVD revapk30 (fork() de outro lado do processo + atfork handler do libomp).
    bool gpu = false;

    // Carrega .param/.bin direto dos assets do APK. Retorna 0 ok / 1 erro.
    int load(AAssetManager* mgr, const char* parampath, const char* modelpath, bool useGpu);

    // rgb: entrada compacta w*h*3 (RGB, row-major). out: buffer já alocado de (w*scale)*(h*scale)*3.
    // on_tile: chamado após CADA tile com a fração concluída (0..1]; retornar false cancela.
    // Retorna 0 ok / 1 erro / 2 cancelado (mesmos códigos que o JNI propaga pro Kotlin).
    int process(const unsigned char* rgb, int w, int h, unsigned char* out,
                const std::function<bool(float)>& on_tile) const;

private:
    ncnn::Net net;
};

#endif // PICMAX_REALESRGAN_H
