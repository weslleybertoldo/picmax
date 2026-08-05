// src/engine/autoEnhance.ts — analisa a imagem (histograma 256px) e devolve ajustes automáticos.
// Recebe o bitmap de PREVIEW (≤2048 no lado maior, ver io/openImage.ts): suficiente pro histograma e
// mais rápido que decodificar o full-res só pra medir luma/saturação média.
import type { Adjustments } from '../state/editStack';
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
  // Math.round em TODOS os campos (v1.1): sem isso, valores como 20.59818339100346 vazavam pra UI
  // (chips/sliders exibem o valor do snapshot). Slider tem step 1 — ajustes são sempre inteiros.
  return {
    exposure: Math.round(Math.max(-40, Math.min(40, (128 - mean) / 128 * 60))), // corrige exposição média
    contrast: range < 0.85 ? Math.round(Math.min(35, (0.85 - range) * 120)) : 0, // estica histograma achatado
    saturation: sat < 0.25 ? Math.round(Math.min(25, (0.25 - sat) * 160)) : 0,
    sharpness: 20,
  };
}
