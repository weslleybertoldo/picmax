// src/presets/presets.ts — CRUD de modelos de edição (T11) sobre @capacitor/preferences (web: cai em
// localStorage; nativo: SharedPreferences/UserDefaults) — mesmo mecanismo de persistência já usado
// pelo resto do app (Preferences está no package.json desde a Task 1). Um modelo guarda só
// `adjustments`+`filter`: crop/anotações/base da IA ficam FORA por design (spec) — são propriedades da
// FOTO, não da "receita" de cor que se quer reaplicar em qualquer imagem.
import { Preferences } from '@capacitor/preferences';
import type { Adjustments, FilterOp } from '../state/editStack';

export interface EditPreset {
  id: string;
  name: string;
  adjustments: Adjustments;
  filter: FilterOp | null;
  createdAt: string;
}

const KEY = 'picmax.presets';

// crypto.randomUUID só existe a partir do Chrome 92 — WebView alvo mínima é 83 (mesmo limite do
// target es2019 do build, ver comentário em vite.config.ts e editStack.ts). Fallback simples e
// suficiente pra um id local (não precisa ser um UUID de verdade, só único o bastante pra essa lista).
function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export async function listPresets(): Promise<EditPreset[]> {
  const { value } = await Preferences.get({ key: KEY });
  return value ? JSON.parse(value) : [];
}

export async function savePreset(p: Omit<EditPreset, 'id' | 'createdAt'>): Promise<EditPreset> {
  const all = await listPresets();
  const preset: EditPreset = { ...p, id: genId(), createdAt: new Date().toISOString() };
  await Preferences.set({ key: KEY, value: JSON.stringify([preset, ...all]) });
  return preset;
}

export async function renamePreset(id: string, name: string) {
  const all = await listPresets();
  await Preferences.set({ key: KEY, value: JSON.stringify(all.map((p) => (p.id === id ? { ...p, name } : p))) });
}

export async function deletePreset(id: string) {
  const all = await listPresets();
  await Preferences.set({ key: KEY, value: JSON.stringify(all.filter((p) => p.id !== id)) });
}
