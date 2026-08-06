// src/tools/ClockOverlay.tsx — camada 2D do relógio do "Slim Black iOS" no PREVIEW do Editor
// (v1.1 r4). Mesmo posicionamento do AnnotationCanvas (useCanvasBox + absolute sobre o canvas
// WebGL), sempre pointer-events:none — é decorativo, nunca captura gesto (o tap antes/depois
// continua chegando no wrap). Montada pelo Editor só quando um filtro slim-black* está ativo e
// fora de cropMode/showOriginal (mesma regra das anotações: o frame nesses modos é OUTRO).
// O instante exibido vem do SNAPSHOT (filter.appliedAt, epoch ms — ver clockOverlay.ts) e a
// opacidade segue a intensidade do filtro (0..100): o relógio é parte do look e desvanece com o
// slider (em 0, drawClockOverlay não desenha nada).
import { useEffect, useRef, type RefObject } from 'react';
import { drawClockOverlay } from '../engine/clockOverlay';
import { useCanvasBox } from './canvasGeometry';

export interface ClockOverlayProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  appliedAt: number; // epoch ms (primitivo de propósito: identidade estável pro deps do efeito)
  intensity: number; // 0..100 — intensidade atual do filtro
}

export default function ClockOverlay({ canvasRef, containerRef, appliedAt, intensity }: ClockOverlayProps) {
  const layerRef = useRef<HTMLCanvasElement>(null);
  const box = useCanvasBox(canvasRef, containerRef);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !box) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(box.width * dpr));
    const bh = Math.max(1, Math.round(box.height * dpr));
    if (layer.width !== bw) layer.width = bw;
    if (layer.height !== bh) layer.height = bh;
    const ctx = layer.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, bw, bh);
    drawClockOverlay(ctx, bw, bh, new Date(appliedAt), intensity / 100);
  }, [box, appliedAt, intensity]);

  if (!box) return null;
  return (
    <div
      className="clock-overlay"
      data-testid="clock-overlay"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <canvas ref={layerRef} className="clock-overlay-canvas" />
    </div>
  );
}
