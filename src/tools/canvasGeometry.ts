// src/tools/canvasGeometry.ts — helpers geométricos do canvas compartilhados entre overlays que
// desenham por cima do <canvas> WebGL (CropOverlay hoje, grade do Endireitar em Editor.tsx; a T7
// AnnotationCanvas seria a 3ª cópia se isso não fosse extraído — revisão pediu centralizar aqui).
import { useLayoutEffect, useState, type RefObject } from 'react';

export interface CanvasBox { left: number; top: number; width: number; height: number }

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// Box CSS do canvas em px, relativo a `containerRef` (ancestral position:relative) — recalculado a
// cada mudança de tamanho do canvas (ex.: girar 90° troca o aspecto) ou do container (resize/rotação
// de tela). O canvas é sempre dimensionado (atributos width/height) no aspecto exato do frame, e o
// CSS (max-width/max-height:100% + width/height:auto) escala esse box mantendo a proporção — logo uma
// posição fracionária nesse box corresponde à MESMA fração no frame em pixels, pra qualquer aspecto.
export function useCanvasBox(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  containerRef: RefObject<HTMLElement | null>,
): CanvasBox | null {
  const [box, setBox] = useState<CanvasBox | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    function update() {
      if (!canvas || !container) return;
      const c = canvas.getBoundingClientRect();
      const p = container.getBoundingClientRect();
      setBox({ left: c.left - p.left, top: c.top - p.top, width: c.width, height: c.height });
    }
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    ro.observe(container);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [canvasRef, containerRef]);
  return box;
}

// Converte um ponto em coordenadas de VIEWPORT (e.clientX/clientY) pra fração 0..1 do canvas. Usa
// getBoundingClientRect do canvas DIRETO (não o `box` de useCanvasBox, que é relativo ao container
// pra fins de posicionamento CSS de overlay portalado) — misturar as duas referências (uma absoluta,
// outra relativa) foi um bug real encontrado na verificação da T6 (alça de crop "corria" errado).
export function toFraction(
  canvas: HTMLCanvasElement | null,
  clientX: number,
  clientY: number,
): { fx: number; fy: number } {
  if (!canvas) return { fx: 0, fy: 0 };
  const r = canvas.getBoundingClientRect();
  return { fx: clamp((clientX - r.left) / r.width, 0, 1), fy: clamp((clientY - r.top) / r.height, 0, 1) };
}
