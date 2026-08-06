// src/engine/igFilters.ts — filtros Instagram fiéis (v1.1): fórmulas EXATAS do CSSgram
// (https://github.com/una/CSSgram, MIT, Una Kravets — recriação de referência dos filtros reais do
// Instagram em CSS puro), portadas pro fragment shader (ver shaders.ts / renderer.ts).
//
// Modelo de execução (idêntico ao que o navegador faz com o CSS do CSSgram):
//   1. as CAMADAS (::before em z-index menor, ::after por cima) são mescladas sobre a imagem com o
//      mix-blend-mode delas (fórmulas W3C compositing, ver igBlend no shader). O elemento com
//      `filter:` isola o blending dos filhos, então cada camada mescla só com o que está abaixo
//      DENTRO do grupo;
//   2. a LISTA de funções de filtro CSS (sepia/saturate/contrast/brightness/hue-rotate/grayscale)
//      aplica sobre o resultado do grupo, NA ORDEM declarada, com clamp [0,1] entre cada primitiva
//      (como o spec de SVG filters manda). Por isso `ops` é um ARRAY ordenado, não um objeto — a
//      ordem muda o resultado (ex.: reyes aplica sepia antes do contraste; inkwell o contrário).
//   3. o slider de intensidade do app mescla o resultado final com a imagem sem filtro (mesmo
//      comportamento dos filtros Clássicos — uFIntensity no shader).
//
// Limites do shader (ver shaders.ts): até 4 ops e até 2 camadas por filtro — cobre todos os filtros
// do CSSgram portados aqui. Gradientes com até 3 stops (interpolação PREMULTIPLICADA, como CSS).
// Blend modes implementados: multiply, screen, overlay, darken, lighten, color-dodge, color-burn,
// soft-light, exclusion — os que os filtros portados usam ('hue'/'color' do CSSgram completo ficam
// de fora: nenhum filtro escolhido precisa, e blends não-separáveis custariam bem mais shader).

export type IgBlendMode =
  | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'soft-light' | 'exclusion';

export interface IgOp {
  kind: 'sepia' | 'saturate' | 'contrast' | 'brightness' | 'hue-rotate' | 'grayscale';
  amount: number; // hue-rotate em GRAUS; demais na escala CSS (1 = neutro p/ saturate/contrast/brightness)
}

export type Rgba = [number, number, number, number]; // 0..255 nos canais, alpha 0..1

export interface IgStop { color: Rgba; pos: number } // pos em fração do raio/eixo (0..1; CSS aceita >1, ex.: 110%)

// Camadas em coordenadas do FRAME final (como o CSS: 0,0 = canto superior esquerdo do elemento).
// radial: `circle` do CSS — raio = distância do centro ao canto MAIS DISTANTE (farthest-corner, o
// default), em px do frame; stops em fração desse raio. linear: t = projeção de (uv - from) sobre
// (to - from) — só direções alinhadas a eixo em uso (aden usa "to right"); pra direções diagonais a
// conversão px→fração exigiria o aspecto do frame (documentado, sem uso hoje).
export type IgLayer =
  | { kind: 'solid'; color: Rgba; blend: IgBlendMode; opacity?: number }
  | { kind: 'linear'; from: [number, number]; to: [number, number]; stops: IgStop[]; blend: IgBlendMode; opacity?: number }
  | { kind: 'radial'; center: [number, number]; stops: IgStop[]; blend: IgBlendMode; opacity?: number };

export interface IgFilterDef {
  id: string;
  name: string;
  ops: IgOp[];      // máx. 4 (limite do shader)
  layers: IgLayer[]; // máx. 2, na ordem de empilhamento (::before primeiro, ::after por cima)
  // Nitidez embutida do filtro (0..1): somada ao sharpen do usuário no pass existente do shader,
  // escalada pela intensidade do filtro (ver renderer.ts). Usada pelo Dark Sharp.
  sharpen?: number;
  // Clarity (contraste local de raio LARGO, só em luminância — realça textura/linhas sem halo
  // colorido): unsharp mask com blur aproximado por anel de 12 taps no shader. `clarityRadius` =
  // raio do anel como fração da largura da textura (default 0.025). Escalado pela intensidade do
  // filtro; custo (12 fetches extra/pixel) só quando definido. Usada pelo Dark Sharp.
  clarity?: number;
  clarityRadius?: number;
  // Motion blur direcional (v1.1 r3/r4 — "The Motto"): smear de 16 taps ao longo de `angle` (graus,
  // 0 = horizontal→direita, 90 = vertical→baixo em coords de TEXTURA/UV — o passo é somado em vUv
  // no shader, ANTES da geometria, então com rotate90 o smear GIRA JUNTO com o conteúdo; num frame
  // girado 90°, angle 0 aparece vertical na tela. Aceitável pro The Motto: o smear acompanha a
  // cena, não o enquadramento). Comprimento TOTAL `length` como
  // fração da largura da textura (mesma convenção do clarityRadius). `echo` (r4) = cluster
  // fantasma de 8 taps: deslocado `offset` (fração da largura, ao longo do MESMO angle; pode ser
  // negativo), comprimento próprio `length`, misturado por `amount` (0..1) — recria o eco/ghosting
  // do filtro real, que um smear linear puro não tem. Tudo escalado pela intensidade.
  motionBlur?: { angle: number; length: number; echo?: { offset: number; length: number; amount: number } };
  // Soft blur / soft focus (v1.1 r3 — "Aesthetic Blur"): média de 13 amostras (centro + anel) com
  // raio `radius` (fração da largura), misturada de volta por `amount` (0..1). Escalado pela
  // intensidade do filtro (amount).
  softBlur?: { radius: number; amount: number };
}

const TRANSPARENT: Rgba = [0, 0, 0, 0];

const op = (kind: IgOp['kind'], amount: number): IgOp => ({ kind, amount });

// Fábrica das 3 variantes do Dark Sharp (ver comentário na lista): só clarity, contraste e sharpen
// variam entre elas — brilho/saturação/vinheta/raio são os do fit e ficam iguais nas 3.
function darkSharp(id: string, name: string, clarity: number, contrast: number, sharpen: number): IgFilterDef {
  return {
    id,
    name,
    ops: [op('contrast', contrast), op('brightness', 0.863), op('saturate', 0.792)],
    layers: [
      {
        kind: 'radial', // vinheta multiply: branco até 55% do raio, esfria/escurece até ~90%
        center: [0.5, 0.5],
        stops: [
          { color: [255, 255, 255, 1], pos: 0.553 },
          { color: [123, 138, 135, 1], pos: 0.896 },
        ],
        blend: 'multiply',
      },
    ],
    sharpen,
    clarity,
    clarityRadius: 0.0159,
  };
}

// ============================================================================
// AR_FILTERS — filtros AR de story RECRIADOS POR FITTING (não-CSSgram), TODOS aprovados pelo
// Weslley em prévias, cada um em 3 intensidades (Fiel = fit exato / Forte ≈ +35% / Max ≈ +70% no
// eixo de intensidade próprio de cada look). São a PRIMEIRA seção da aba Filtros (decisão de
// produto), antes de Instagram/Clássicos. Nenhum código/asset dos filtros originais foi usado:
// parâmetros ajustados por otimização sobre pares antes/depois de screenshots (custo = cor por
// patch 8x8 + contraste local std 16x16 + estatísticas de gradiente pros blurs + julgamento visual
// lado a lado). Scripts de fit e métricas nos reports da v1.1 (rodadas 2-4).
// ============================================================================

// "Slim Black iOS" (rodada 3/4): escurecimento global pesado em 2 estágios (solid multiply +
// brightness), contraste levemente negativo, saturação ~neutra; vinheta desprezível no fit
// (dropada). MAE 4.0/3.9/3.9 — o mais fiel dos AR. ⚠️ O RELÓGIO estilo lock screen faz parte do
// look (pedido do Weslley): overlay 2D desenhado por cima no preview/export pra QUALQUER id
// slim-black* (ver clockOverlay.ts) — não é shader e NÃO aparece nas miniaturas (ilegível).
// Variantes escalam o desvio do tom (brightness/contraste — o eixo real deste look).
function slimBlack(id: string, name: string, contrast: number, brightness: number): IgFilterDef {
  return {
    id,
    name,
    ops: [op('contrast', contrast), op('brightness', brightness), op('saturate', 1.028)],
    layers: [{ kind: 'solid', color: [170, 170, 170, 1], blend: 'multiply' }], // ≈0.666 por canal
  };
}

// "The Motto" (rodada 4): smear HORIZONTAL (direção PROVADA por anisotropia — ref gy/gx=3.5 vs base
// 0.59) com ECO/fantasma: smear principal curto + cluster de eco LARGO deslocado (o ghosting do
// filtro real, que smear linear puro não tem — 1º fit dava aniso 8.2 e foi reprovado) + softBlur
// leve (suavidade geral/perpendicular). Fiel = fit + ajuste visual: anisotropia EXATA (3.418 vs
// 3.414), MAE 11.8/10.6/11.4. Variantes escalam o conjunto espacial (smear/eco/softBlur) + contraste.
// É o filtro mais caro do app (24 taps de motion + 12 de softBlur por pixel) — ainda fração de
// frame em GPU real a ≤2MP.
function theMotto(id: string, name: string, contrast: number, mLen: number, eOff: number, eLen: number, sAmt: number): IgFilterDef {
  return {
    id,
    name,
    ops: [op('contrast', contrast), op('brightness', 0.756), op('saturate', 1.226)],
    layers: [],
    motionBlur: { angle: 0, length: mLen, echo: { offset: eOff, length: eLen, amount: 0.494 } },
    softBlur: { radius: 0.006, amount: sAmt },
  };
}

// "ВУИ" (rodada 3/4): P&B + leve contraste + escurecimento forte; o fit zerou a vinheta (edge=1 —
// bound superior evita "anel de brilho" overfitado). MAE 6.1 (R=G=B). Variantes escalam o desvio
// do tom (brightness/contraste).
function byu(id: string, name: string, contrast: number, brightness: number): IgFilterDef {
  return {
    id,
    name,
    ops: [op('grayscale', 1), op('contrast', contrast), op('brightness', brightness)],
    layers: [],
  };
}

export const AR_FILTERS: IgFilterDef[] = [
  // ---- Dark Sharp (rodada 2) ----
  // O look: mais escuro, contraste alto, levemente dessaturado, bordas frias (vinheta radial) e
  // realce forte de textura/linhas via `clarity` (unsharp de raio largo em luminância, ~1.6% da
  // largura). O sharpen 1px extra é decisão de produto (Weslley): micro-nitidez além da textura de
  // raio largo em fotos full-res. Fiel: MAE 5.9/4.4/4.5; contraste local 15.2 = referência.
  // Variantes: clarity/contraste/sharpen +35%/+70% (contraste local +14%/+28% vs referência).
  darkSharp('dark-sharp-fiel', 'Dark Sharp Fiel', 0.702, 1.246, 0.15),
  darkSharp('dark-sharp-forte', 'Dark Sharp Forte', 0.947, 1.333, 0.203),
  darkSharp('dark-sharp-max', 'Dark Sharp Max', 1.193, 1.419, 0.255),
  // ---- Slim Black iOS (com relógio — ver comentário da factory) ----
  slimBlack('slim-black-fiel', 'Slim Black iOS Fiel', 0.963, 0.657),
  slimBlack('slim-black-forte', 'Slim Black iOS Forte', 0.95, 0.537),
  slimBlack('slim-black-max', 'Slim Black iOS Max', 0.937, 0.416),
  // ---- The Motto ----
  theMotto('the-motto-fiel', 'The Motto Fiel', 0.954, 0.014, 0.024, 0.0382, 0.2),
  theMotto('the-motto-forte', 'The Motto Forte', 0.938, 0.0189, 0.0324, 0.0516, 0.27),
  theMotto('the-motto-max', 'The Motto Max', 0.921, 0.0238, 0.0408, 0.065, 0.34),
  // ---- ВУИ ----
  byu('byu-fiel', 'ВУИ Fiel', 1.052, 0.649),
  byu('byu-forte', 'ВУИ Forte', 1.071, 0.526),
  byu('byu-max', 'ВУИ Max', 1.089, 0.403),
];

export const IG_FILTERS: IgFilterDef[] = [
  // ---- CSSgram (valores exatos do css publicado) ----
  {
    id: 'ig-clarendon',
    name: 'Clarendon',
    ops: [op('contrast', 1.2), op('saturate', 1.35)],
    layers: [{ kind: 'solid', color: [127, 187, 227, 0.2], blend: 'overlay' }],
  },
  {
    id: 'ig-gingham',
    name: 'Gingham',
    ops: [op('brightness', 1.05), op('hue-rotate', -10)],
    layers: [{ kind: 'solid', color: [230, 230, 250, 1], blend: 'soft-light' }], // lavender
  },
  {
    id: 'ig-moon',
    name: 'Moon',
    ops: [op('grayscale', 1), op('contrast', 1.1), op('brightness', 1.1)],
    layers: [
      { kind: 'solid', color: [160, 160, 160, 1], blend: 'soft-light' }, // ::before #a0a0a0
      { kind: 'solid', color: [56, 56, 56, 1], blend: 'lighten' },       // ::after  #383838
    ],
  },
  {
    id: 'ig-lark',
    name: 'Lark',
    ops: [op('contrast', 0.9)],
    layers: [
      { kind: 'solid', color: [34, 37, 63, 1], blend: 'color-dodge' },    // ::before #22253f
      { kind: 'solid', color: [242, 242, 242, 0.8], blend: 'darken' },    // ::after
    ],
  },
  {
    id: 'ig-reyes',
    name: 'Reyes',
    ops: [op('sepia', 0.22), op('brightness', 1.1), op('contrast', 0.85), op('saturate', 0.75)],
    layers: [{ kind: 'solid', color: [239, 205, 173, 1], blend: 'soft-light', opacity: 0.5 }], // #efcdad
  },
  {
    id: 'ig-slumber',
    name: 'Slumber',
    ops: [op('saturate', 0.66), op('brightness', 1.05)],
    layers: [
      { kind: 'solid', color: [69, 41, 12, 0.4], blend: 'lighten' },      // ::before
      { kind: 'solid', color: [125, 105, 24, 0.5], blend: 'soft-light' }, // ::after
    ],
  },
  {
    id: 'ig-aden',
    name: 'Aden',
    ops: [op('hue-rotate', -20), op('contrast', 0.9), op('saturate', 0.85), op('brightness', 1.2)],
    layers: [
      {
        kind: 'linear', // linear-gradient(to right, rgba(66,10,14,.2), transparent)
        from: [0, 0],
        to: [1, 0],
        stops: [
          { color: [66, 10, 14, 0.2], pos: 0 },
          { color: TRANSPARENT, pos: 1 },
        ],
        blend: 'darken',
      },
    ],
  },
  {
    id: 'ig-valencia',
    name: 'Valencia',
    ops: [op('contrast', 1.08), op('brightness', 1.08), op('sepia', 0.08)],
    layers: [{ kind: 'solid', color: [58, 3, 57, 1], blend: 'exclusion', opacity: 0.5 }], // #3a0339
  },
  {
    id: 'ig-xpro2',
    name: 'X-Pro II',
    ops: [op('sepia', 0.3)],
    layers: [
      {
        kind: 'radial', // radial-gradient(circle, #e6e7e0 40%, rgba(43,42,161,.6) 110%)
        center: [0.5, 0.5],
        stops: [
          { color: [230, 231, 224, 1], pos: 0.4 },
          { color: [43, 42, 161, 0.6], pos: 1.1 },
        ],
        blend: 'color-burn',
      },
    ],
  },
  {
    id: 'ig-lofi',
    name: 'Lo-Fi',
    ops: [op('saturate', 1.1), op('contrast', 1.5)],
    layers: [
      {
        kind: 'radial', // radial-gradient(circle, transparent 70%, #222 150%)
        center: [0.5, 0.5],
        stops: [
          { color: TRANSPARENT, pos: 0.7 },
          { color: [34, 34, 34, 1], pos: 1.5 },
        ],
        blend: 'multiply',
      },
    ],
  },
  {
    id: 'ig-nashville',
    name: 'Nashville',
    ops: [op('sepia', 0.2), op('contrast', 1.2), op('brightness', 1.05), op('saturate', 1.2)],
    layers: [
      { kind: 'solid', color: [247, 176, 153, 0.56], blend: 'darken' }, // ::before
      { kind: 'solid', color: [0, 70, 150, 0.4], blend: 'lighten' },    // ::after
    ],
  },
  {
    id: 'ig-1977',
    name: '1977',
    ops: [op('contrast', 1.1), op('brightness', 1.1), op('saturate', 1.3)],
    layers: [{ kind: 'solid', color: [243, 106, 188, 0.3], blend: 'screen' }],
  },
  {
    id: 'ig-earlybird',
    name: 'Earlybird',
    ops: [op('contrast', 0.9), op('sepia', 0.2)],
    layers: [
      {
        kind: 'radial', // radial-gradient(circle, #d0ba8e 20%, #360309 85%, #1d0210 100%)
        center: [0.5, 0.5],
        stops: [
          { color: [208, 186, 142, 1], pos: 0.2 },
          { color: [54, 3, 9, 1], pos: 0.85 },
          { color: [29, 2, 16, 1], pos: 1 },
        ],
        blend: 'overlay',
      },
    ],
  },
  {
    id: 'ig-toaster',
    name: 'Toaster',
    ops: [op('contrast', 1.5), op('brightness', 0.9)],
    layers: [
      {
        kind: 'radial', // radial-gradient(circle, #804e0f, #3b003b)
        center: [0.5, 0.5],
        stops: [
          { color: [128, 78, 15, 1], pos: 0 },
          { color: [59, 0, 59, 1], pos: 1 },
        ],
        blend: 'screen',
      },
    ],
  },
  {
    id: 'ig-hudson',
    name: 'Hudson',
    ops: [op('brightness', 1.2), op('contrast', 0.9), op('saturate', 1.1)],
    layers: [
      {
        kind: 'radial', // radial-gradient(circle, #a6b1ff 50%, #342134)
        center: [0.5, 0.5],
        stops: [
          { color: [166, 177, 255, 1], pos: 0.5 },
          { color: [52, 33, 52, 1], pos: 1 },
        ],
        blend: 'multiply',
        opacity: 0.5,
      },
    ],
  },
  {
    id: 'ig-mayfair',
    name: 'Mayfair',
    ops: [op('contrast', 1.1), op('saturate', 1.1)],
    layers: [
      {
        kind: 'radial', // radial-gradient(circle at 40% 40%, rgba(255,255,255,.8), rgba(255,200,200,.6), #111 60%)
        center: [0.4, 0.4],
        stops: [
          { color: [255, 255, 255, 0.8], pos: 0 },
          { color: [255, 200, 200, 0.6], pos: 0.3 }, // stop do meio sem posição no CSS → ponto médio
          { color: [17, 17, 17, 1], pos: 0.6 },
        ],
        blend: 'overlay',
        opacity: 0.4,
      },
    ],
  },
];

// (v1.1: o "Aesthetic Blur" foi DESCARTADO pelo Weslley após 7 rodadas — o look real exige LUT 3D
// (dessaturação seletiva de matiz) + blur direcional, fora do alcance das primitivas do shader. A
// def experimental que vivia aqui num R3_FILTERS fora do carrossel foi removida na limpeza da
// release; histórico completo nos reports da v1.1.)

export const igFilterById = (id: string): IgFilterDef | null =>
  AR_FILTERS.find((f) => f.id === id) ??
  IG_FILTERS.find((f) => f.id === id) ??
  null;
