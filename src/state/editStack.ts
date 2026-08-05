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
