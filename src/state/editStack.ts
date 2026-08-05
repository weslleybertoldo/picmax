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
export interface CropRect { x: number; y: number; w: number; h: number } // x,y = canto superior esquerdo em frações do frame pós-rotação (y cresce pra baixo)

// Transforma um CropRect definido nas frações do frame ANTES de +1 rotate90 pras frações do frame
// DEPOIS (mesmo giro de 90° que o renderer aplica ao conteúdo — ver contrato em engine/renderer.ts).
// Sem essa transformação, girar 90° com um crop ativo mantém as MESMAS frações, que passam a
// selecionar uma região visual DIFERENTE (o conteúdo girou, o retângulo fixo não acompanhou).
// Derivação (validada por pixel-check + álgebra a partir de computeUvMatrix em renderer.ts): com 0 ou
// 2 flips ativos (paridade PAR) o giro é HORÁRIO nessa convenção (y-down, como DOM) — cada canto
// (x,y)→(1-y,x); pra um retângulo isso dá {x:1-y-h, y:x, w:h, h:w}.
//
// flip e rotação NÃO comutam (2ª rodada de review, achado por verificação numérica): com exatamente
// 1 flip ativo (flipH XOR flipV — paridade ÍMPAR), o giro do RETÂNGULO precisa ser o INVERSO da
// fórmula acima — flipar espelha o sentido em que os cantos percorrem o quadrado ao rotacionar. A
// inversa algébrica de {x:1-y-h, y:x, w:h, h:w} é {x:y, y:1-x-w, w:h, h:w} (resolvendo o sistema:
// y'=x, h'=w, w'=h, x'=1-y-h ⟺ x=y', w=h', h=w', y=1-x'-h=1-x'-w').
// 4 aplicações sucessivas (com a MESMA paridade de flip mantida) voltam ao retângulo original.
export function rotateCropRect90(c: CropRect, flipParityOdd: boolean): CropRect {
  return flipParityOdd
    ? { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }
    : { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w };
}

// Achado durante a validação da rotação+flip (3ª rodada de review): Espelhar H/V SOZINHO, mesmo sem
// girar, já corrompe um crop ativo — o flip espelha em torno do centro do FRAME inteiro (não do
// centro do próprio retângulo de crop), então uma janela de crop não-centrada passa a revelar uma
// região FISICAMENTE DIFERENTE da foto (confirmado por pixel-check: cortar no quadrante do marcador
// e só espelhar H, sem girar, já faz o marcador desaparecer da vista). Espelhar H mirra crop.x (1-x-w);
// Espelhar V mirra crop.y (1-y-h) — essa regra é a MESMA pra qualquer rotate90 atual (0..3), porque
// crop.x/y já estão nas frações do OUTPUT (alinhadas à tela, não à textura) — verificado
// algebricamente pra k=0..3 a partir de computeUvMatrix.
export function mirrorCropRect(c: CropRect, axis: 'x' | 'y'): CropRect {
  return axis === 'x' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h };
}

export interface Geometry {
  rotate90: 0 | 1 | 2 | 3; flipH: boolean; flipV: boolean;
  straighten: number;            // graus -45..45
  crop: CropRect | null;
  resizeMaxSide: number | null;  // px do lado maior no export
}
export const DEFAULT_GEOMETRY: Geometry = { rotate90: 0, flipH: false, flipV: false, straighten: 0, crop: null, resizeMaxSide: null };

// `font` (T12, review — gap 7): família CSS ('sans-serif' | 'serif' | 'monospace' | 'cursive' — ver
// ANNOTATE_FONTS em annotate/AnnotationCanvas.tsx). Sempre preenchido em anotações NOVAS (o modal de
// texto sempre passa um valor); leituras (drawAnnotations) usam `?? 'sans-serif'` mesmo assim —
// forward-compat defensivo caso algum objeto tenha sido construído sem o campo (ex.: hook de dev que
// injeta `annotations` fake, ver Editor.tsx).
export type Annotation =
  | { kind: 'stroke'; points: { x: number; y: number }[]; color: string; size: number; erase: boolean }
  | { kind: 'text'; x: number; y: number; text: string; color: string; size: number; font: string }
  | { kind: 'shape'; shape: 'arrow' | 'rect' | 'ellipse' | 'line'; from: { x: number; y: number }; to: { x: number; y: number }; color: string; size: number };
// coordenadas de anotação são frações 0..1 do frame final (pós-geometria)

export interface EditSnapshot {
  geometry: Geometry; adjustments: Adjustments;
  filter: FilterOp | null; annotations: Annotation[];
  baseVersion: number; // 0 = original; incrementa quando a IA troca a base
  // Estado "Aplicado ✓" do auto-ajuste (v1.1): `before` = adjustments de ANTES do auto-ajuste, pra o
  // toggle de desfazer no card da aba Melhorar. null = não aplicado. Faz parte do snapshot (undo/redo
  // andam junto), mas NÃO entra em modelos/presets (presets.ts salva só adjustments+filter). Mexer
  // manualmente nos sliders DEPOIS de aplicar mantém o estado "aplicado" de propósito — desfazer
  // restaura o `before` salvo, descartando também os ajustes manuais feitos por cima (documentado
  // no card em EnhancePanel.tsx).
  autoEnhance: { before: Adjustments } | null;
}
export const initialSnapshot = (): EditSnapshot => ({
  geometry: DEFAULT_GEOMETRY, adjustments: { ...DEFAULT_ADJUSTMENTS },
  filter: null, annotations: [], baseVersion: 0, autoEnhance: null,
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
    // h.past[length-1], NÃO h.past.at(-1): Array.prototype.at é ES2022 e não existe em WebView
    // antiga (Chrome 83) — o target es2019 do build transpila SINTAXE, não métodos de runtime
    // (achado real na T10: undo estourava "e.past.at is not a function" e derrubava o editor).
    case 'undo': return h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h;
    case 'redo': return h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h;
    case 'reset': return { past: [...h.past, h.present], present: initialSnapshot(), future: [] };
  }
}
