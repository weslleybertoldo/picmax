# PicMax

Editor de imagens Android offline (Capacitor + Vite + React + WebGL) com IA de super-resolução
(Real-ESRGAN 4x via NCNN — GPU Vulkan quando disponível, senão CPU).

## Build

```bash
npm install
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug
```

Requisitos do build nativo (Task 10 — lib `picmaxenhance`):

- **NDK 27.1.12297006** e **CMake 3.22.1** instalados no SDK (`sdkmanager "ndk;27.1.12297006" "cmake;3.22.1"`).
- Prebuilt do NCNN vendorado em `android/app/src/main/cpp/ncnn-20240820-android-vulkan/`
  (só arm64-v8a e x86_64 — os ABIs do `abiFilters`). Se faltar, o CMake falha com instrução de download.
- Modelo `realesr-general-x4v3.param/.bin` em `android/app/src/main/assets/models/`
  (fonte: NCNN fp16 de [upscayl/custom-models](https://github.com/upscayl/custom-models), `RealESRGAN_General_x4_v3`).

---

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
