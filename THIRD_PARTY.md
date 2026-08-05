# Avisos de terceiros (THIRD_PARTY)

O código deste repositório é licenciado sob [MIT](LICENSE) (Weslley Bertoldo). O PicMax também
embarca/depende de software de terceiros, listado abaixo com a licença de origem. Nenhum destes
projetos endossa ou é afiliado ao PicMax — os créditos são só atribuição, como as licenças exigem.

## ncnn

- **O quê:** motor de inferência usado pela IA (Real-ESRGAN 4x), vendorado como prebuilt em
  `android/app/src/main/cpp/ncnn-20240820-android-vulkan/` (só os binários dos ABIs `arm64-v8a`/
  `x86_64` usados pelo app — não o código-fonte completo do projeto).
- **Autor/projeto:** Tencent — <https://github.com/Tencent/ncnn>
- **Licença:** BSD 3-Clause.

## glslang

- **O quê:** compilador de shaders GLSL→SPIR-V, incluído dentro do prebuilt do ncnn acima (usado
  internamente pelo backend Vulkan do ncnn — o PicMax não o invoca diretamente).
- **Autor/projeto:** Khronos Group / Google — <https://github.com/KhronosGroup/glslang>
- **Licença:** licença própria do projeto (termos estilo BSD/Apache-2.0 conforme o arquivo `LICENSE`
  upstream) — ver o repositório oficial para o texto completo.

## stb_image / stb_image_write

- **O quê:** decodificação/codificação de imagem (JPEG/PNG) em C, vendorado diretamente em
  `android/app/src/main/cpp/stb_image.h` e `stb_image_write.h`.
- **Autor:** Sean Barrett — <https://github.com/nothings/stb>
- **Licença:** domínio público (Unlicense) OU MIT, à escolha de quem usa (dual-license, conforme o
  cabeçalho do próprio arquivo).

## Real-ESRGAN

- **O quê:** arquitetura/pesos do modelo de super-resolução. `android/app/src/main/cpp/realesrgan.{h,cpp}`
  neste repo são um **wrapper próprio, adaptado** sobre `ncnn::Net` (não uma cópia do
  `realesrgan.cpp` upstream — ver comentário no topo de `realesrgan.h` sobre a adaptação). Os pesos
  embarcados (`android/app/src/main/assets/models/realesr-general-x4v3.param/.bin`) vêm da conversão
  NCNN fp16 publicada em [upscayl/custom-models](https://github.com/upscayl/custom-models)
  (`RealESRGAN_General_x4_v3`), derivada dos pesos do projeto abaixo.
- **Autor/projeto:** Xintao Wang et al. — <https://github.com/xinntao/Real-ESRGAN>
- **Licença:** BSD 3-Clause.

## CSSgram

- **O quê:** fórmulas dos filtros estilo Instagram da seção "Instagram" do app
  (`src/engine/igFilters.ts`). O CSSgram é uma recriação de referência dos filtros do Instagram em
  CSS puro; o PicMax porta os VALORES (funções de filtro CSS + camadas com blend mode) pro fragment
  shader WebGL próprio — nenhum código CSS/JS do projeto upstream é embarcado, só os parâmetros.
- **Autor/projeto:** Una Kravets — <https://github.com/una/CSSgram>
- **Licença:** MIT.

## Capacitor

- **O quê:** runtime nativo (bridge WebView↔Kotlin/Java) e plugins oficiais (`@capacitor/core`,
  `@capacitor/android`, `@capacitor/camera`, `@capacitor/filesystem`, `@capacitor/preferences`,
  `@capacitor/share`, `@capacitor/app`).
- **Autor/projeto:** Ionic — <https://github.com/ionic-team/capacitor>
- **Licença:** MIT.

## React / React DOM

- **O quê:** biblioteca de UI usada por toda a interface web do app.
- **Autor/projeto:** Meta — <https://github.com/facebook/react>
- **Licença:** MIT.
