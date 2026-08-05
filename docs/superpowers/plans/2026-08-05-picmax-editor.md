# PicMax — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** APK Android offline de edição de imagens (PicMax) com editor não-destrutivo WebGL, 20 filtros com slider de intensidade, 2 modos de melhorar (auto-ajuste e IA Real-ESRGAN nativa) e modelos de edição salvos.

**Architecture:** Capacitor + Vite + React + TS. Pilha de operações não-destrutiva renderizada em WebGL (preview em resolução de tela, export em resolução total). Plugin Capacitor Kotlin (`ImageEnhancer`) com NCNN/Vulkan para a IA e MediaStore para salvar na galeria.

**Tech Stack:** Capacitor 8, Vite, React 19, TypeScript, WebGL1, Kotlin + JNI/C++ (NCNN, Real-ESRGAN `realesr-general-x4v3`). *(Versões reais do scaffold da T1; plano citava Cap 7/React 18.)* `minSdkVersion 29` (MediaStore RELATIVE_PATH na T8).

**Nota de processo (CLAUDE.md global):** projeto pessoal → TDD test-first NÃO obrigatório. Cada task termina com verificação objetiva (`npm run build`, `gradlew assembleDebug` e/ou smoke em device) + commit convencional com trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>` (HEREDOC).

---

## Estrutura de arquivos

```
picmax/
├── capacitor.config.ts
├── index.html / vite.config.ts / tsconfig.json / package.json
├── assets/logo.png                  # já commitado
├── resources/icon.png               # gerado da logo (ícone do app)
├── src/
│   ├── main.tsx / App.tsx / styles.css
│   ├── state/editStack.ts           # tipos + reducer + undo/redo (1 responsabilidade: estado)
│   ├── engine/shaders.ts            # GLSL (ajustes + grade genérico de filtro)
│   ├── engine/filters.ts            # tabela dos 20 filtros (parâmetros do grade)
│   ├── engine/renderer.ts           # WebGL: textura, geometria, uniforms, render(preview|full)
│   ├── engine/autoEnhance.ts        # "Melhorar qualidade" (histograma → ajustes)
│   ├── annotate/AnnotationCanvas.tsx# camada 2D (desenho/texto/formas/borracha)
│   ├── annotate/drawAnnotations.ts  # rasteriza anotações num ctx 2D (preview e export)
│   ├── tools/BasicPanel.tsx         # crop/girar/espelhar/endireitar/redimensionar
│   ├── tools/AdjustPanel.tsx        # sliders de ajuste
│   ├── tools/FilterPanel.tsx        # grade de filtros + slider intensidade
│   ├── tools/AnnotatePanel.tsx      # controles da anotação
│   ├── tools/EnhancePanel.tsx       # 2 botões de melhorar + progresso IA
│   ├── presets/presets.ts           # CRUD de modelos (Preferences)
│   ├── presets/PresetsPanel.tsx     # UI salvar/aplicar/gerenciar
│   ├── io/openImage.ts              # galeria/câmera → ImageBitmap + arquivo base
│   ├── io/exportImage.ts            # render full-res + anotações → galeria/share
│   └── screens/{Home,Editor}.tsx
└── android/
    └── app/src/main/
        ├── java/com/bertoldo/picmax/ImageEnhancerPlugin.kt
        ├── cpp/{jni.cpp, realesrgan.cpp, realesrgan.h, CMakeLists.txt}
        └── assets/models/realesr-general-x4v3.{param,bin}
```

Ordem geral: cada task entrega algo rodável; UI evolui por abas.

---

### Task 1: Scaffold Capacitor + ícone + APK debug de fumaça

**Files:** Create: projeto Vite na raiz, `capacitor.config.ts`, `resources/icon.png`

- [ ] **Step 1: Scaffold Vite (raiz já tem .git/docs/assets → criar em tmp e mover)**

```bash
cd ~/projetos/picmax
npm create vite@latest picmax-tmp -- --template react-ts
rsync -a picmax-tmp/ ./ && rm -rf picmax-tmp
npm install
```

- [ ] **Step 2: Capacitor + plugins**

```bash
npm i @capacitor/core @capacitor/android @capacitor/camera @capacitor/preferences @capacitor/share @capacitor/filesystem
npm i -D @capacitor/cli @capacitor/assets sharp
npx cap init PicMax com.bertoldo.picmax --web-dir dist
npm run build && npx cap add android
```

- [ ] **Step 3: Ícone e splash a partir da logo**

```bash
mkdir -p resources
node -e "require('sharp')('assets/logo.png').resize(1024,1024).png().toFile('resources/icon.png')"
node -e "const s=require('sharp');s({create:{width:2732,height:2732,channels:4,background:'#0d0d0f'}}).composite([{input:'resources/icon.png'}]).png().toFile('resources/splash.png')"
npx @capacitor/assets generate --android
```

- [ ] **Step 4: Permissões no `android/app/src/main/AndroidManifest.xml`** (dentro de `<manifest>`)

```xml
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES"/>
<uses-permission android:name="android.permission.CAMERA"/>
```

- [ ] **Step 5: Verificar build**

Run: `npm run build && npx cap sync android && cd android && ./gradlew assembleDebug && cd ..`
Expected: `BUILD SUCCESSFUL`; APK em `android/app/build/outputs/apk/debug/app-debug.apk`

- [ ] **Step 6: Commit** — `chore: scaffold Capacitor PicMax com ícone e permissões`

---

### Task 2: Estado da edição (pilha não-destrutiva + undo/redo)

**Files:** Create: `src/state/editStack.ts`

- [ ] **Step 1: Escrever tipos e reducer**

```ts
// src/state/editStack.ts
export interface Adjustments {
  brightness: number; contrast: number; saturation: number; exposure: number;
  temperature: number; shadows: number; highlights: number; // -100..100
  sharpness: number; vignette: number;                       // 0..100
}
export const DEFAULT_ADJUSTMENTS: Adjustments = {
  brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0,
  shadows: 0, highlights: 0, sharpness: 0, vignette: 0,
};
export interface FilterOp { id: string; intensity: number } // 0..100
export interface CropRect { x: number; y: number; w: number; h: number } // fração 0..1 do frame pós-rotação
export interface Geometry {
  rotate90: 0 | 1 | 2 | 3; flipH: boolean; flipV: boolean;
  straighten: number;            // graus -45..45
  crop: CropRect | null;
  resizeMaxSide: number | null;  // px do lado maior no export
}
export const DEFAULT_GEOMETRY: Geometry = { rotate90: 0, flipH: false, flipV: false, straighten: 0, crop: null, resizeMaxSide: null };

export type Annotation =
  | { kind: 'stroke'; points: { x: number; y: number }[]; color: string; size: number; erase: boolean }
  | { kind: 'text'; x: number; y: number; text: string; color: string; size: number }
  | { kind: 'shape'; shape: 'arrow' | 'rect' | 'ellipse' | 'line'; from: { x: number; y: number }; to: { x: number; y: number }; color: string; size: number };
// coordenadas de anotação são frações 0..1 do frame final (pós-geometria)

export interface EditSnapshot {
  geometry: Geometry; adjustments: Adjustments;
  filter: FilterOp | null; annotations: Annotation[];
  baseVersion: number; // 0 = original; incrementa quando a IA troca a base
}
export const initialSnapshot = (): EditSnapshot => ({
  geometry: DEFAULT_GEOMETRY, adjustments: { ...DEFAULT_ADJUSTMENTS },
  filter: null, annotations: [], baseVersion: 0,
});

export interface EditHistory { past: EditSnapshot[]; present: EditSnapshot; future: EditSnapshot[] }
export type EditAction =
  | { type: 'set'; patch: Partial<EditSnapshot> }   // registra no histórico
  | { type: 'preview'; patch: Partial<EditSnapshot> } // slider arrastando: NÃO registra
  | { type: 'undo' } | { type: 'redo' } | { type: 'reset' };

export function editReducer(h: EditHistory, a: EditAction): EditHistory {
  switch (a.type) {
    case 'preview': return { ...h, present: { ...h.present, ...a.patch } };
    case 'set': return { past: [...h.past, h.present].slice(-50), present: { ...h.present, ...a.patch }, future: [] };
    case 'undo': return h.past.length ? { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] } : h;
    case 'redo': return h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h;
    case 'reset': return { past: [...h.past, h.present], present: initialSnapshot(), future: [] };
  }
}
```

- [ ] **Step 2: Verificar** — Run: `npx tsc --noEmit` · Expected: sem erros
- [ ] **Step 3: Commit** — `feat(state): pilha de edição não-destrutiva com undo/redo`

---

### Task 3: Engine WebGL (ajustes + grade de filtro + geometria)

**Files:** Create: `src/engine/shaders.ts`, `src/engine/filters.ts`, `src/engine/renderer.ts`

- [ ] **Step 1: Shaders**

```ts
// src/engine/shaders.ts
export const VERT = `
attribute vec2 aPos; varying vec2 vUv;
uniform mat3 uUvMat; // geometria: rot90/flip/straighten/crop no espaço UV
void main() { vUv = (uUvMat * vec3((aPos + 1.0) * 0.5, 1.0)).xy; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const FRAG = `
precision highp float; varying vec2 vUv;
uniform sampler2D uImage; uniform vec2 uTexel;
uniform float uBrightness, uContrast, uSaturation, uExposure, uTemperature, uShadows, uHighlights, uSharpness, uVignette;
uniform float uFGray, uFSat, uFCon, uFIntensity; uniform vec3 uFGamma, uFGain, uFLift;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 adjust(vec3 c) {
  c *= pow(2.0, uExposure); c += uBrightness;
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;
  c.r += uTemperature * 0.08; c.b -= uTemperature * 0.08;
  float l = luma(c); c = mix(vec3(l), c, 1.0 + uSaturation);
  c += uShadows * 0.25 * (1.0 - smoothstep(0.0, 0.5, l));
  c += uHighlights * 0.25 * smoothstep(0.5, 1.0, l);
  return c;
}
vec3 grade(vec3 c) { // filtro genérico parametrizado
  float l = luma(c);
  c = mix(c, vec3(l), uFGray);
  c = mix(vec3(luma(c)), c, uFSat);
  c = (c - 0.5) * (1.0 + uFCon) + 0.5;
  c = pow(clamp(c, 0.001, 1.0), 1.0 / uFGamma);
  c = c * uFGain + uFLift * (1.0 - l);
  return c;
}
void main() {
  vec3 c = texture2D(uImage, vUv).rgb;
  if (uSharpness > 0.0) {
    vec3 n = texture2D(uImage, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(uImage, vUv - vec2(0.0, uTexel.y)).rgb
           + texture2D(uImage, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(uImage, vUv - vec2(uTexel.x, 0.0)).rgb;
    c += (c * 4.0 - n) * uSharpness * 0.6;
  }
  c = adjust(c);
  if (uFIntensity > 0.0) c = mix(c, grade(c), uFIntensity);
  c *= 1.0 - uVignette * smoothstep(0.35, 0.75, distance(vUv, vec2(0.5)));
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
```

- [ ] **Step 2: Tabela dos 20 filtros**

```ts
// src/engine/filters.ts — parâmetros do grade(); neutro = sat1 con0 gamma1 gain1 lift0
export interface FilterDef { id: string; name: string; gray: number; sat: number; con: number; gamma: [number, number, number]; gain: [number, number, number]; lift: [number, number, number] }
const F = (id: string, name: string, p: Partial<FilterDef> = {}): FilterDef => ({ id, name, gray: 0, sat: 1, con: 0, gamma: [1, 1, 1], gain: [1, 1, 1], lift: [0, 0, 0], ...p });
export const FILTERS: FilterDef[] = [
  F('pb', 'P&B', { gray: 1 }),
  F('pb-intenso', 'P&B Intenso', { gray: 1, con: 0.35 }),
  F('noir', 'Noir', { gray: 1, con: 0.5, gamma: [0.85, 0.85, 0.85] }),
  F('sepia', 'Sépia', { gray: 1, gain: [1.07, 0.95, 0.78] }),
  F('vintage', 'Vintage', { sat: 0.75, con: -0.08, gain: [1.05, 0.97, 0.85], lift: [0.06, 0.04, 0.02] }),
  F('retro', 'Retrô', { sat: 0.8, gamma: [1.1, 1.0, 0.9], lift: [0.08, 0.05, 0.0] }),
  F('fade', 'Fade', { sat: 0.85, con: -0.15, lift: [0.09, 0.09, 0.09] }),
  F('quente', 'Quente', { gain: [1.1, 1.0, 0.88] }),
  F('frio', 'Frio', { gain: [0.9, 0.98, 1.12] }),
  F('cinema', 'Cinema', { sat: 0.9, con: 0.18, gain: [1.02, 1.0, 0.95], lift: [0.0, 0.02, 0.05] }),
  F('vivido', 'Vívido', { sat: 1.35, con: 0.15 }),
  F('dramatico', 'Dramático', { sat: 1.1, con: 0.35, gamma: [0.9, 0.9, 0.9] }),
  F('verao', 'Verão', { sat: 1.15, gain: [1.08, 1.02, 0.9], gamma: [1.05, 1.0, 0.95] }),
  F('inverno', 'Inverno', { sat: 0.9, gain: [0.92, 1.0, 1.1], lift: [0.02, 0.03, 0.06] }),
  F('dourado', 'Dourado', { sat: 1.05, gain: [1.15, 1.02, 0.8], gamma: [1.1, 1.0, 0.9] }),
  F('rosado', 'Rosado', { sat: 1.05, gain: [1.1, 0.95, 1.02], lift: [0.05, 0.0, 0.03] }),
  F('esmeralda', 'Esmeralda', { sat: 0.95, gain: [0.92, 1.08, 0.98] }),
  F('azul-noite', 'Azul Noite', { sat: 0.85, con: 0.2, gain: [0.85, 0.92, 1.15], gamma: [0.95, 0.95, 1.05] }),
  F('pastel', 'Pastel', { sat: 0.7, con: -0.12, lift: [0.08, 0.07, 0.08], gamma: [1.08, 1.08, 1.08] }),
  F('tropical', 'Tropical', { sat: 1.3, gain: [1.05, 1.05, 0.9], con: 0.1 }),
];
export const filterById = (id: string) => FILTERS.find(f => f.id === id) ?? null;
```

- [ ] **Step 3: Renderer**

```ts
// src/engine/renderer.ts — API:
//   const r = createRenderer(canvas)
//   r.setImage(bitmap)                          // upload textura
//   r.render(snapshot)                          // desenha com geometria+ajustes+filtro
//   r.destroy()
// Detalhes de implementação obrigatórios:
// - WebGL1, quad fullscreen (2 triângulos), TEXTURE_2D com CLAMP_TO_EDGE + LINEAR.
// - uUvMat (mat3) compõe, nesta ordem: crop (escala+offset do subretângulo UV) ∘
//   rotação straighten (em torno de 0.5,0.5 com escala de cobertura
//   s = cos|θ| + (max(w,h)/min(w,h))·sin|θ|) ∘ rot90 (troca de eixos) ∘ flips (espelha UV).
// - Canvas dimensionado pro aspect do frame final (pós-crop/rot90); preview usa
//   devicePixelRatio limitado a 2048 no lado maior; export usa resolução plena.
// - Uniforms normalizados a partir do snapshot:
//   brightness/100*0.35, contrast/100*0.6, saturation/100, exposure/100 (stops),
//   temperature/100, shadows/100, highlights/100, sharpness/100, vignette/100*0.8.
// - Filtro: se snapshot.filter, aplica FilterDef nos uniforms uF* e
//   uFIntensity = intensity/100; senão uFIntensity = 0.
```

Implementar o arquivo completo seguindo o contrato acima (≈150 linhas).

- [ ] **Step 4: Verificar** — página dev com uma imagem estática renderizada no canvas e um slider de brilho ligado no `render()`. Run: `npm run dev` e conferir no browser que o slider altera a imagem em tempo real.
- [ ] **Step 5: Commit** — `feat(engine): renderer WebGL com ajustes, geometria e grade de filtros`

---

### Task 4: Abrir imagem + telas Home/Editor + aba Ajustes

**Files:** Create: `src/io/openImage.ts`, `src/screens/Home.tsx`, `src/screens/Editor.tsx`, `src/tools/AdjustPanel.tsx`, `src/styles.css`; Modify: `src/App.tsx`

- [ ] **Step 1: openImage**

```ts
// src/io/openImage.ts
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
export interface LoadedImage { bitmap: ImageBitmap; blob: Blob; width: number; height: number }
export async function openImage(source: 'gallery' | 'camera'): Promise<LoadedImage | null> {
  const photo = await Camera.getPhoto({
    resultType: CameraResultType.Uri, quality: 100,
    source: source === 'gallery' ? CameraSource.Photos : CameraSource.Camera,
  }).catch(() => null);
  if (!photo?.webPath) return null;
  const blob = await (await fetch(photo.webPath)).blob();
  const bitmap = await createImageBitmap(blob);
  return { bitmap, blob, width: bitmap.width, height: bitmap.height };
}
```

- [ ] **Step 2: Home** — tema escuro (fundo `#0d0d0f`, acentos em gradiente laranja→rosa→azul, combinando com a logo). Dois botões grandes ("Abrir da galeria", "Tirar foto") chamando `openImage` e navegando pro Editor (estado no App: `image: LoadedImage | null`).

- [ ] **Step 3: Editor (shell)** — layout: topo (voltar, undo, redo, salvar-modelo, exportar), canvas central (`renderer.render(present)` num `useEffect` sobre o snapshot), toolbar inferior com abas `Básico · Ajustes · Filtros · Anotar · Melhorar`. `useReducer(editReducer)`.

- [ ] **Step 4: AdjustPanel** — 9 sliders (`<input type=range>`): Brilho, Contraste, Saturação, Exposição, Temperatura, Sombras, Realces, Nitidez, Vinheta. `onInput` → dispatch `preview`; `onChange` (soltou o dedo) → dispatch `set`. Botão "Restaurar ajustes" (patch com `DEFAULT_ADJUSTMENTS`).

- [ ] **Step 5: Verificar em device** — `npm run build && npx cap sync android && cd android && ./gradlew assembleDebug`; instalar APK, abrir foto da galeria, mexer sliders (fluido), undo/redo funcionando.
- [ ] **Step 6: Commit** — `feat(ui): telas Home/Editor com ajustes ao vivo`

---

### Task 5: Aba Filtros (toque = 100% + slider de intensidade)

**Files:** Create: `src/tools/FilterPanel.tsx`

- [ ] **Step 1: FilterPanel**

```tsx
// Comportamento (requisito central):
// - Carrossel horizontal de miniaturas: a própria foto (thumb ~128px, gerada 1x com
//   createImageBitmap(blob,{resizeWidth:128}) e renderizada com cada filtro a 100%
//   num renderer offscreen compartilhado) + card "Original".
// - Tocar num filtro → dispatch set { filter: { id, intensity: 100 } } e o slider
//   de intensidade APARECE logo abaixo do carrossel, em 100.
// - Slider 0..100: onInput → preview { filter: { id, intensity: v } }; onChange → set.
//   Em 0 o filtro some visualmente (mix no shader); trocar de filtro volta pra 100.
// - Tocar em "Original" → set { filter: null } e o slider some.
// - Filtro ativo tem borda gradiente + nome destacado.
```

- [ ] **Step 2: Verificar em device** — grade mostra 20 miniaturas com cara distinta; tocar aplica 100%; arrastar slider pra esquerda suaviza até sumir; export ainda não (Task 8).
- [ ] **Step 3: Commit** — `feat(filters): 20 filtros com slider de intensidade`

---

### Task 6: Aba Básico (crop, girar, espelhar, endireitar, redimensionar)

**Files:** Create: `src/tools/BasicPanel.tsx`; Modify: `src/screens/Editor.tsx` (overlay de crop)

- [ ] **Step 1: BasicPanel** — botões: Girar 90° (`rotate90: (r+1)%4`), Espelhar H/V (toggle), slider Endireitar −45..45° com grade de linhas sobreposta enquanto arrasta, Redimensionar (chips 100% / 2048px / 1080px → `resizeMaxSide`), e modo Cortar.
- [ ] **Step 2: Modo Cortar** — overlay no canvas com retângulo arrastável (4 alças de canto + mover; presets Livre/1:1/4:5/16:9). Confirmar → `set { geometry.crop }` em frações 0..1 do frame pós-rotação; Cancelar mantém. ⚠️ Como anotações usam frações do frame final, mudar crop DEPOIS de anotar move as anotações: ao alterar crop/rot90 com `annotations.length > 0`, avisar ("Anotações serão removidas") e limpar `annotations` na confirmação.
- [ ] **Step 3: Verificar em device** — girar/espelhar/endireitar/crop refletem no preview; undo desfaz cada um.
- [ ] **Step 4: Commit** — `feat(basic): crop, rotação, espelho, endireitar e resize`

---

### Task 7: Aba Anotar (desenho, texto, formas, borracha)

**Files:** Create: `src/annotate/drawAnnotations.ts`, `src/annotate/AnnotationCanvas.tsx`, `src/tools/AnnotatePanel.tsx`

- [ ] **Step 1: drawAnnotations** — `drawAnnotations(ctx, annotations, w, h)`: strokes com `lineJoin/lineCap round`, largura `size/1000*w`; `erase: true` usa `globalCompositeOperation='destination-out'` (a camada de anotação é um canvas próprio, então a borracha apaga só anotações); texto `bold ${size/1000*w}px sans-serif`; setas = linha + cabeça (2 segmentos a 30°); rect/ellipse/line com stroke. Coordenadas multiplicadas por (w,h).
- [ ] **Step 2: AnnotationCanvas** — canvas 2D transparente posicionado exatamente sobre o canvas WebGL (mesmo box). Pointer events capturam desenho quando a aba Anotar está ativa: stroke acumula pontos em frações; soltar → dispatch `set { annotations: [...anotações, nova] }`. Texto: tocar posiciona → prompt de texto + cor/tamanho. Re-render da camada a cada mudança via `drawAnnotations`.
- [ ] **Step 3: AnnotatePanel** — ferramentas: Caneta / Borracha / Texto / Seta / Retângulo / Elipse / Linha; paleta de 8 cores; slider de espessura; botão "Limpar anotações".
- [ ] **Step 4: Verificar em device** — desenhar, apagar com borracha, texto e seta; undo remove a última anotação.
- [ ] **Step 5: Commit** — `feat(annotate): camada de anotações com desenho, texto e formas`

---

### Task 8: Export (galeria + compartilhar)

**Files:** Create: `src/io/exportImage.ts`; Create: `android/app/src/main/java/com/bertoldo/picmax/ImageEnhancerPlugin.kt` (método `saveToGallery`); Modify: `android/app/src/main/java/com/bertoldo/picmax/MainActivity.kt`

- [ ] **Step 1: Render full-res** — `exportImage(base: LoadedImage, snap: EditSnapshot): Promise<Blob>`: canvas offscreen no tamanho final (aplica crop/rot90/resizeMaxSide; cap no `MAX_TEXTURE_SIZE` do GL, mínimo garantido 4096), `createRenderer` + `setImage(bitmap full)` + `render(snap)`, depois compõe anotações com `drawAnnotations` num ctx 2D por cima, `canvas.toBlob('image/jpeg', 0.9)` (PNG se `blob.type==='image/png'`).
- [ ] **Step 2: Plugin Kotlin — registro + saveToGallery**

```kotlin
// ImageEnhancerPlugin.kt
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
    resolver.openOutputStream(uri).use { it!!.write(bytes) }
    call.resolve(JSObject().put("uri", uri.toString()))
  }
}
// MainActivity.kt → registerPlugin(ImageEnhancerPlugin::class.java) antes do super.onCreate
```

- [ ] **Step 3: Front do export** — botão Exportar no topo: gera blob → base64 → `ImageEnhancer.saveToGallery`; toast "Salvo em Pictures/PicMax". Botão Compartilhar: grava blob em cache via Filesystem e chama `Share.share({ files: [uri] })`. Bridge TS do plugin: `registerPlugin<ImageEnhancerPlugin>('ImageEnhancer')` com tipos dos métodos.
- [ ] **Step 4: Verificar em device** — exportar foto editada (filtro 50% + anotação + crop): aparece na galeria idêntica ao preview, original intocado; compartilhar abre share sheet.
- [ ] **Step 5: Commit** — `feat(export): salvar na galeria via MediaStore e compartilhar`

---

### Task 9: Melhorar qualidade (auto-ajuste instantâneo)

**Files:** Create: `src/engine/autoEnhance.ts`, `src/tools/EnhancePanel.tsx`

- [ ] **Step 1: autoEnhance**

```ts
// src/engine/autoEnhance.ts — analisa a imagem e devolve ajustes automáticos
export function computeAutoEnhance(bitmap: ImageBitmap): Partial<Adjustments> {
  const c = document.createElement('canvas'); c.width = 256; c.height = Math.round(256 * bitmap.height / bitmap.width);
  const ctx = c.getContext('2d')!; ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let min = 255, max = 0, sum = 0, sumSat = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    min = Math.min(min, l); max = Math.max(max, l); sum += l;
    sumSat += (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]));
  }
  const mean = sum / n, range = (max - min) / 255, sat = sumSat / n / 255;
  return {
    exposure: Math.max(-40, Math.min(40, (128 - mean) / 128 * 60)), // corrige exposição média
    contrast: range < 0.85 ? Math.min(35, (0.85 - range) * 120) : 0, // estica histograma achatado
    saturation: sat < 0.25 ? Math.min(25, (0.25 - sat) * 160) : 0,
    sharpness: 20,
  };
}
```

- [ ] **Step 2: EnhancePanel (parte 1)** — botão **"Melhorar qualidade"**: `computeAutoEnhance(base.bitmap)` → dispatch `set { adjustments: { ...present.adjustments, ...auto } }` (instantâneo, desfazível). Botão **"Melhorar qualidade com IA"** aparece desabilitado com badge "Task 10".
- [ ] **Step 3: Verificar em device** — foto escura/lavada melhora visivelmente em 1 toque; undo restaura.
- [ ] **Step 4: Commit** — `feat(enhance): melhorar qualidade com auto-ajuste por histograma`

---

### Task 10: Melhorar qualidade com IA (plugin NCNN/Vulkan + Real-ESRGAN)

**Files:** Create: `android/app/src/main/cpp/{CMakeLists.txt, jni.cpp, realesrgan.cpp, realesrgan.h}`, `android/app/src/main/assets/models/realesr-general-x4v3.{param,bin}`; Modify: `ImageEnhancerPlugin.kt`, `android/app/build.gradle`

- [ ] **Step 1: Vendorar NCNN e Real-ESRGAN**

```bash
cd ~/projetos/picmax/android/app/src/main/cpp
# NCNN prebuilt android vulkan (usar a release estável mais recente)
curl -LO https://github.com/Tencent/ncnn/releases/download/20240820/ncnn-20240820-android-vulkan.zip
unzip -q ncnn-20240820-android-vulkan.zip && rm ncnn-20240820-android-vulkan.zip
# Fonte do Real-ESRGAN ncnn (realesrgan.cpp/h com tiling + progresso)
curl -LO https://raw.githubusercontent.com/xinntao/Real-ESRGAN-ncnn-vulkan/master/src/realesrgan.cpp
curl -LO https://raw.githubusercontent.com/xinntao/Real-ESRGAN-ncnn-vulkan/master/src/realesrgan.h
# Modelo (do zip de release do Real-ESRGAN)
cd ../assets && mkdir -p models && cd models
curl -LO https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip
unzip -jq realesrgan-*.zip 'models/realesr-general-x4v3.param' 'models/realesr-general-x4v3.bin' && rm realesrgan-*.zip
```

- [ ] **Step 2: CMake + gradle (externalNativeBuild, abiFilters arm64-v8a)**

```cmake
cmake_minimum_required(VERSION 3.22)
project(picmaxenhance)
set(ncnn_DIR ${CMAKE_SOURCE_DIR}/ncnn-20240820-android-vulkan/${ANDROID_ABI}/lib/cmake/ncnn)
find_package(ncnn REQUIRED)
add_library(picmaxenhance SHARED jni.cpp realesrgan.cpp)
target_link_libraries(picmaxenhance ncnn android jnigraphics log)
```

- [ ] **Step 3: jni.cpp** — expõe:
  - `nativeInit(assetMgr, useGpu)` → carrega `.param/.bin` dos assets (`AAssetManager`), `realesrgan->scale=4`, `tilesize` = 128 (GPU por heap Vulkan) / 400 (CPU);
  - `nativeEnhance(inPath, outPath)` → decode JPEG/PNG com `stb_image` (vendorar `stb_image.h`/`stb_image_write.h`), processa por tiles chamando `realesrgan->process()`, grava JPEG q90; reporta progresso por tile via callback JNI (`env->CallVoidMethod`) e checa flag de cancelamento;
  - `nativeCancel()`, `nativeHasVulkan()` (`ncnn::get_gpu_count() > 0`).

- [ ] **Step 4: Kotlin — método enhance**

```kotlin
@PluginMethod
fun enhance(call: PluginCall) {
  val inPath = call.getString("path") ?: return call.reject("path requerido")
  val maxSide = call.getInt("maxOutputSide") ?: 8192
  Thread {
    try {
      val useGpu = nativeHasVulkan()
      nativeInit(context.assets, useGpu)
      val outPath = File(context.cacheDir, "enhanced_${System.currentTimeMillis()}.jpg").absolutePath
      val ok = nativeEnhance(inPath, outPath, maxSide) // progresso → notifyListeners("enhanceProgress", {percent, usingGpu})
      if (ok == 0) call.resolve(JSObject().put("path", outPath).put("usedGpu", useGpu))
      else call.reject(if (ok == 2) "cancelado" else "falha na IA")
    } catch (e: Throwable) { call.reject(e.message ?: "erro nativo") }
  }.start()
}
@PluginMethod fun cancelEnhance(call: PluginCall) { nativeCancel(); call.resolve() }
```

- [ ] **Step 5: Front** — botão "Melhorar qualidade com IA": grava `base.blob` em cache (Filesystem) → `ImageEnhancer.enhance({path})` → modal com barra de progresso (listener `enhanceProgress`; aviso "sem GPU, vai demorar mais" quando `usedGpu=false`) + botão Cancelar → resultado: carrega arquivo como novo `LoadedImage`, troca a base e dispatch `set { baseVersion: present.baseVersion + 1 }` (desfazível: undo volta `baseVersion`, App mantém array de bases).
- [ ] **Step 6: Verificar em device** — foto ~2MP borrada → nítida e 4x maior em <30s (com Vulkan); progresso anda; cancelar funciona; ajustes/filtros seguem funcionando sobre o resultado; export usa a base nova.
- [ ] **Step 7: Commit** — `feat(ai): melhorar qualidade com IA via Real-ESRGAN NCNN/Vulkan`

---

### Task 11: Modelos de edição (presets do usuário)

**Files:** Create: `src/presets/presets.ts`, `src/presets/PresetsPanel.tsx`; Modify: `src/screens/{Home,Editor}.tsx`

- [ ] **Step 1: presets.ts**

```ts
import { Preferences } from '@capacitor/preferences';
import type { Adjustments, FilterOp } from '../state/editStack';
export interface EditPreset { id: string; name: string; adjustments: Adjustments; filter: FilterOp | null; createdAt: string }
const KEY = 'picmax.presets';
export async function listPresets(): Promise<EditPreset[]> {
  const { value } = await Preferences.get({ key: KEY });
  return value ? JSON.parse(value) : [];
}
export async function savePreset(p: Omit<EditPreset, 'id' | 'createdAt'>): Promise<EditPreset> {
  const all = await listPresets();
  const preset: EditPreset = { ...p, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await Preferences.set({ key: KEY, value: JSON.stringify([preset, ...all]) });
  return preset;
}
export async function renamePreset(id: string, name: string) { const all = await listPresets(); await Preferences.set({ key: KEY, value: JSON.stringify(all.map(p => p.id === id ? { ...p, name } : p)) }); }
export async function deletePreset(id: string) { const all = await listPresets(); await Preferences.set({ key: KEY, value: JSON.stringify(all.filter(p => p.id !== id)) }); }
```

- [ ] **Step 2: UI** — Editor topo: botão "Salvar modelo" (modal pede nome; salva `adjustments+filter` atuais — crop/anotações/IA ficam de fora, por design). PresetsPanel (acessível no Editor e na Home): lista com nome+data, tocar aplica (`set { adjustments, filter }`, desfazível), long-press → renomear/excluir.
- [ ] **Step 3: Verificar em device** — editar foto A (ajustes+filtro 60%), salvar "Meu look"; abrir foto B, aplicar → mesmo visual; renomear/excluir ok; persiste após fechar o app.
- [ ] **Step 4: Commit** — `feat(presets): modelos de edição reutilizáveis`

---

### Task 12: Robustez + release

**Files:** Modify: pontos de erro em `io/`, `EnhancePanel`, `Editor`; `android/app/build.gradle` (signing)

- [ ] **Step 1: Erros e guardas** — permissão de mídia negada → tela com botão pra Configurações (`App.openSettings` não existe: usar `NativeSettings` não; simples: instrução + retry). Foto >48MP → recusar com toast explicando limite. IA sem memória (`ok!=0` com erro de alloc) → reduzir `tilesize` pela metade e tentar 1x de novo. Voltar/fechar com edição não exportada → confirmação. Try/catch em todo caminho de arquivo com toast de erro (sem stack trace).
- [ ] **Step 2: Ajustes finais de UX** — comparar antes/depois (segurar o dedo no canvas mostra original), haptic leve ao aplicar filtro (`@capacitor/haptics` opcional — só se não inflar; senão pular), splash escura já configurada na Task 1.
- [ ] **Step 3: Keystore + APK release**

```bash
keytool -genkeypair -v -keystore ~/projetos/picmax/android/picmax-release.keystore \
  -alias picmax -keyalg RSA -keysize 2048 -validity 10000
# configurar signingConfigs.release no android/app/build.gradle (senha via env PICMAX_KS_PASS)
cd ~/projetos/picmax/android && ./gradlew assembleRelease
ls -lh app/build/outputs/apk/release/app-release.apk   # esperado ≤ ~60MB
```

Registrar keystore+senha na memória global (`Acesso Keystore PicMax.md`), como nos outros apps.

- [ ] **Step 4: Smoke final (critérios da spec)** — 12MP fluida nos sliders; IA 2MP <30s; filtro toque=100% + slider até sumir; modelo reproduz visual em outra foto; APK ≤60MB. Anotar resultados reais.
- [ ] **Step 5: Commit** — `chore(release): APK release assinado do PicMax v1.0.0` + tag `v1.0.0`

---

### Task 13: Atualização silenciosa in-app + verificação no rodapé

**Files:** Create: `src/update/updater.ts`, componente de rodapé na Home; Modify: plugin Kotlin (instalador) conforme a skill

- [ ] **Step 1: Invocar a skill `skill-wbs-instalacao-silenciosa-app` (Caminho A — Capacitor Android)** e seguir o passo a passo dela: hospedagem do APK + `version.json` (mesmo padrão dos outros apps do Weslley), download in-app com barra de progresso e chamada do instalador do sistema (FileProvider + `ACTION_VIEW`/PackageInstaller).
- [ ] **Step 2: Rodapé na Home** — mostra `v{versão atual}` (de `package.json`/BuildConfig) + botão "Verificar atualização": consulta o `version.json` remoto; se houver mais nova → modal com changelog e botão Atualizar (download + instala); se não → toast "Você está na versão mais recente". Checagem automática silenciosa ao abrir o app (sem bloquear; só badge no rodapé se houver update).
- [ ] **Step 3: Verificar em device** — instalar APK v1.0.0, publicar v1.0.1, rodapé acusa update, atualizar in-app sem ir a navegador/loja.
- [ ] **Step 4: Commit** — `feat(update): atualização in-app com verificação no rodapé`

---

## Self-review (feito)

- **Cobertura da spec:** básico (T6), ajustes (T4), anotações (T7), filtros+intensidade (T5), melhorar 2 modos (T9/T10), modelos (T11), export/share (T8), erros (T12), critérios de sucesso (T12.4). ✓
- **Placeholders:** nenhum "TBD"; os dois arquivos descritos por contrato (renderer.ts, FilterPanel) têm contrato completo de comportamento/uniforms no próprio step. ✓
- **Consistência de tipos:** `EditSnapshot/Adjustments/FilterOp/Geometry/Annotation` usados por T3–T11 conforme definidos em T2; plugin `ImageEnhancer` com métodos `saveToGallery/enhance/cancelEnhance` consistentes entre T8 e T10. ✓
