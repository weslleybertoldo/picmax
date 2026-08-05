# PicMax

Editor de imagens Android **100% offline** (Capacitor + Vite + React + WebGL), com corte/ajustes/
filtros/anotações, dois modos de "Melhorar" (auto-ajuste e IA Real-ESRGAN 4x on-device via NCNN —
GPU Vulkan quando disponível, senão CPU) e modelos de edição reutilizáveis. Sem backend, sem coleta
de dados, distribuído como APK direto (releases do GitHub), sem Play Store.

## Arquitetura (mínima)

Pilha de edição **não-destrutiva**: a imagem aberta nunca é alterada — o estado é um `EditSnapshot`
(geometria + ajustes + filtro + anotações, ver `src/state/editStack.ts`) reaplicado a cada render.
Preview roda em WebGL na resolução da tela; export reaplica o MESMO snapshot na resolução total.

| Diretório | Responsabilidade |
|---|---|
| `src/engine/` | Renderer WebGL1 (shaders de ajuste, geometria via matriz UV, grade de filtro), tabela dos 20 filtros, auto-ajuste por histograma |
| `src/tools/` | Painéis da UI por aba: Básico (crop/girar/espelhar/endireitar), Ajustes, Filtros, Anotar, Melhorar |
| `src/annotate/` | Camada 2D isolada (desenho/texto/formas/borracha) sobreposta ao canvas WebGL |
| `src/io/` | Abrir da galeria/câmera (com guardas de permissão e tamanho), exportar full-res pra galeria/share |
| `src/presets/` | CRUD de modelos de edição (adjustments+filter) via `@capacitor/preferences` |
| `src/update/` | Atualização in-app: checa a release mais nova no GitHub, baixa e instala sem loja |
| `src/screens/` | `Home` (abrir foto) e `Editor` (shell: canvas + abas + undo/redo + export) |

**Múltiplas bases (IA):** a IA (Real-ESRGAN) não edita a foto atual — ela entra como uma NOVA base no
array `bases` do `App.tsx`; o snapshot aponta pra base ativa via `baseVersion` (índice), então undo
depois de rodar a IA volta pra base antiga (que continua viva no array).

**2 plugins nativos Android (Kotlin/Java):**
- `ImageEnhancerPlugin` — `enhance`/`cancelEnhance` (JNI → NCNN/Real-ESRGAN, `android/app/src/main/cpp/`),
  `saveToGallery` (MediaStore) e `openAppSettings` (abre Configurações do app quando uma permissão foi negada).
- `ApkInstallerPlugin` — download do APK de update + instalador do sistema (FileProvider + PackageInstaller).

## Build local

```bash
npm install
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug
```

Requisitos do build nativo (lib `picmaxenhance`, IA):

- **NDK 27.1.12297006** e **CMake 3.22.1** instalados no SDK (`sdkmanager "ndk;27.1.12297006" "cmake;3.22.1"`).
- Prebuilt do NCNN vendorado em `android/app/src/main/cpp/ncnn-20240820-android-vulkan/`
  (só arm64-v8a e x86_64 — os ABIs do `abiFilters`). Se faltar, o CMake falha com instrução de download.
- Modelo `realesr-general-x4v3.param/.bin` em `android/app/src/main/assets/models/`
  (fonte: NCNN fp16 de [upscayl/custom-models](https://github.com/upscayl/custom-models), `RealESRGAN_General_x4_v3`).

## Verificação

```bash
npm run lint                        # oxlint
npm run build                       # tsc -b && vite build
node scripts/verify-geometry.mjs    # fuzz de regressão: crop+rotate90+flip+straighten
cd android && ./gradlew assembleDebug
```

`verify-geometry.mjs` roda em Node puro, sem dependências, e precisa continuar em **0 falhas** antes
de qualquer commit que toque geometria (crop/rotação/flip/straighten) — o invariante já queimou
3 rodadas de review no passado (ver comentário no topo do script).

## Release (build assinado + publicação)

### Versão — fonte única

`package.json.version` é a **única** fonte da versão do app: `vite.config.ts` injeta `__APP_VERSION__`
a partir dele (rodapé da Home + comparação de update in-app) e `android/app/build.gradle` deriva
`versionName`/`versionCode` do MESMO arquivo (`versionCode = major*10000 + minor*100 + patch`). Pra
publicar uma versão nova: **só** dar bump em `package.json` — nunca editar `versionCode`/`versionName`
direto no `build.gradle` (eles são calculados, editar ali não sobrevive ao próximo build).

### Keystore

O APK de release é assinado com um keystore local, **fora do git** (`android/.gitignore` cobre
`*.keystore`/`*.jks`; o `.gitignore` da raiz também, em profundidade). Sem ele, `assembleRelease`
ainda builda — só produz um APK **não assinado**.

```bash
# gerar 1x (senha forte, guardada em local seguro)
keytool -genkeypair -v -keystore android/picmax-release.keystore \
  -alias picmax -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" -dname "CN=PicMax,O=Bertoldo,C=BR"

# build assinado
cd android
export PICMAX_KS_PASS="$PASS"
./gradlew assembleRelease
# APK em app/build/outputs/apk/release/app-release.apk
```

Fallback sem env var: propriedade `PICMAX_KS_PASS` no `~/.gradle/gradle.properties` **do usuário**
(fora do repo) — **nunca** em `android/gradle.properties` (esse arquivo é versionado/committed).

Backup do keystore fora do repo também: `~/projetos/picmax-keys/`.

### Procedimento de publicar uma release

1. Bump `package.json.version` (fonte única — ver acima).
2. `npm run build && npx cap sync android`.
3. `cd android && export PICMAX_KS_PASS=... && ./gradlew assembleRelease`.
4. Renomeie o APK pra `PicMax-vX.Y.Z.apk` (**o nome precisa terminar em `.apk`** — é assim que
   `src/update/apkUpdater.ts` acha o asset certo na release do GitHub; sem isso, o app reporta
   "Nenhum APK disponível ainda").
5. `gh release create vX.Y.Z PicMax-vX.Y.Z.apk --repo weslleybertoldo/picmax --title "PicMax vX.Y.Z" --notes "..."`.
6. Smoke: instalar o APK de release num device/emulador (desinstale qualquer APK debug antes —
   assinaturas diferentes) e confirmar no rodapé da Home que "Verificar atualizações" mostra
   "✓ Versão mais recente".

## Decisões de build (por quê)

- **`minSdkVersion 29`**: `MediaStore.RELATIVE_PATH` (export pra galeria) funciona sem guarda de
  versão a partir daí, sem precisar de `WRITE_EXTERNAL_STORAGE`.
- **2 ABIs (`arm64-v8a`, `x86_64`)**: cobre devices reais (arm64) e o emulador de smoke test
  (x86_64); o prebuilt do NCNN só é vendorado pra esses 2, então `armeabi-v7a`/`x86` nem compilam.
- **`target: 'es2019'` no build web** (`vite.config.ts`): WebView de sistema em devices reais com
  minSdk 29 pode ser bem mais antiga que o Chromium do browser de dev — `es2019` cobre até
  WebView ~Chrome 80, sem precisar de polyfills.
- **`minifyEnabled`/`shrinkResources` DESLIGADOS no release** (v1, deliberado): Capacitor resolve
  plugins por reflection (nome de classe) e o JNI casa métodos por nome de símbolo
  (`Java_com_bertoldo_picmax_ImageEnhancerPlugin_*`) — ligar R8 sem regras `-keep` testadas arrisca
  quebrar os dois sem ganho real num app pessoal sem Play Store.

## Licença

Código deste repositório sob [MIT](LICENSE). Dependências e assets de terceiros (NCNN, Real-ESRGAN,
stb, glslang, Capacitor, React) com suas próprias licenças — ver [THIRD_PARTY.md](THIRD_PARTY.md).
