// realesrgan.cpp — implementação do wrapper (ver decisão de adaptação em realesrgan.h).
#include "realesrgan.h"

#include <algorithm>

#include "cpu.h"

int RealEsrgan::load(AAssetManager* mgr, const char* parampath, const char* modelpath, bool useGpu) {
    // opt precisa estar configurado ANTES de load_param — é no load que o ncnn decide o layout dos
    // pesos (fp16, packing) e se cria pipelines Vulkan.
    net.clear();
    net.opt = ncnn::Option();
    net.opt.use_vulkan_compute = useGpu;
    net.opt.num_threads = ncnn::get_big_cpu_count();
    if (net.load_param(mgr, parampath) != 0) return 1;
    if (net.load_model(mgr, modelpath) != 0) return 1;
    tilesize = useGpu ? 128 : 256;
    gpu = useGpu;
    return 0;
}

int RealEsrgan::process(const unsigned char* rgb, int w, int h, unsigned char* out,
                        const std::function<bool(float)>& on_tile) const {
    if (!rgb || !out || w <= 0 || h <= 0) return 1;
    const int ow = w * scale;

    const int xtiles = (w + tilesize - 1) / tilesize;
    const int ytiles = (h + tilesize - 1) / tilesize;
    const int total = xtiles * ytiles;
    int done = 0;

    // Real-ESRGAN espera RGB float 0..1 (sem mean); a saída volta 0..1.
    const float norm[3] = { 1 / 255.f, 1 / 255.f, 1 / 255.f };

    for (int ty = 0; ty < ytiles; ty++) {
        for (int tx = 0; tx < xtiles; tx++) {
            // Miolo do tile [x0,x1)x[y0,y1) + padding de contexto CLAMPADO na borda da imagem
            // (tile encostado na borda não tem de onde tirar contexto — o clamp zera o pad ali,
            // e a própria borda da imagem vira a borda do tile, como no processamento sem tiles).
            const int x0 = tx * tilesize, y0 = ty * tilesize;
            const int x1 = std::min(x0 + tilesize, w), y1 = std::min(y0 + tilesize, h);
            const int padL = std::min(prepadding, x0), padT = std::min(prepadding, y0);
            const int padR = std::min(prepadding, w - x1), padB = std::min(prepadding, h - y1);
            const int ix0 = x0 - padL, iy0 = y0 - padT;
            const int iw = (x1 + padR) - ix0, ih = (y1 + padB) - iy0;

            // from_pixels com stride = extrai o subretângulo direto do buffer da imagem inteira.
            ncnn::Mat in = ncnn::Mat::from_pixels(rgb + (static_cast<size_t>(iy0) * w + ix0) * 3,
                                                  ncnn::Mat::PIXEL_RGB, iw, ih, w * 3);
            if (in.empty()) return 1;
            in.substract_mean_normalize(nullptr, norm);

            ncnn::Mat outm;
            {
                ncnn::Extractor ex = net.create_extractor();
                if (ex.input("data", in) != 0) return 1;
                if (ex.extract("output", outm) != 0) return 1;
            }
            if (outm.w != iw * scale || outm.h != ih * scale || outm.c != 3) return 1;

            // Copia só o miolo (descarta o padding ampliado) pro buffer final, desnormalizando.
            const int cx0 = padL * scale, cy0 = padT * scale;   // origem do miolo dentro do tile inferido
            const int cw = (x1 - x0) * scale, ch = (y1 - y0) * scale;
            const int dx0 = x0 * scale, dy0 = y0 * scale;       // destino no buffer da imagem final
            for (int c = 0; c < 3; c++) {
                const float* src = outm.channel(c);
                for (int yy = 0; yy < ch; yy++) {
                    const float* srow = src + static_cast<size_t>(cy0 + yy) * outm.w + cx0;
                    unsigned char* drow = out + (static_cast<size_t>(dy0 + yy) * ow + dx0) * 3 + c;
                    for (int xx = 0; xx < cw; xx++) {
                        const float v = srow[xx] * 255.f + 0.5f;
                        drow[static_cast<size_t>(xx) * 3] =
                            static_cast<unsigned char>(std::min(std::max(v, 0.f), 255.f));
                    }
                }
            }

            done++;
            if (on_tile && !on_tile(static_cast<float>(done) / static_cast<float>(total))) return 2;
        }
    }
    return 0;
}
