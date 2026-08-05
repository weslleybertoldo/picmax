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
export const filterById = (id: string): FilterDef | null => {
  const f = FILTERS.find(x => x.id === id) ?? null;
  if (!f) console.warn(`[filters] filtro desconhecido: "${id}"`);
  return f;
};
