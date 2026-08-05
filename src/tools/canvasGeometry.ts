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
    let ro: ResizeObserver | undefined;
    let raf = 0;
    let cancelled = false;

    function update() {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const c = canvas.getBoundingClientRect();
      const p = container.getBoundingClientRect();
      setBox({ left: c.left - p.left, top: c.top - p.top, width: c.width, height: c.height });
    }

    // Tenta configurar; se `canvasRef`/`containerRef` ainda não foram atribuídos, tenta de novo no
    // próximo frame (achado real na T7/AnnotationCanvas: React atribui refs bottom-up durante o
    // commit — quando um consumidor deste hook é montado no MESMO commit do elemento apontado por
    // `containerRef` (ex.: AnnotationCanvas, filho direto de `.editor-canvas-wrap`, que é o próprio
    // container), o layout effect do FILHO roda ANTES do ref do PAI ser atribuído, então
    // `containerRef.current` ainda é null nesse instante. CropOverlay/StraightenGrid nunca bateram
    // nisso por montarem DEPOIS do commit inicial — quando já leem um container-ref havia sido
    // atribuído. Sem esse retry, o efeito nunca mais roda (deps são refs estáveis) e `box` fica null
    // pra sempre. Retry limitado a 1 frame por chamada — assim que os dois refs existem (o commit
    // inteiro já terminou), configura os observers normalmente e não tenta de novo.
    function trySetup() {
      if (cancelled) return;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) {
        raf = requestAnimationFrame(trySetup);
        return;
      }
      update();
      ro = new ResizeObserver(update);
      ro.observe(canvas);
      ro.observe(container);
      window.addEventListener('resize', update);
    }
    trySetup();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
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
