// src/tools/CropOverlay.tsx — modo Cortar: retângulo arrastável sobre o canvas + presets de razão +
// barra Cancelar/Aplicar.
//
// Semântica do frame (decisão v1, documentada no plano da T6): enquanto cropMode está ativo, o Editor
// troca o snapshot RENDERIZADO por um clone com geometry.crop=null — este overlay sempre opera sobre
// o frame ÍNTEGRO (pós rotate90/flip/straighten, sem o crop anterior), então o usuário pode reexpandir
// uma área já recortada. O retângulo aqui é uma FRAÇÃO 0..1 desse frame sem-crop; ao Aplicar, essa
// fração é gravada direto em geometry.crop (mesmo espaço — o frame sem-crop É o "frame pós-rotação" da
// spec, já que crop=null não altera rotate90/flip/straighten).
//
// Frações de TELA == frações de FRAME: o <canvas> é sempre dimensionado (atributos width/height) no
// aspecto exato do frame (ver renderer.ts), e o CSS (max-width/max-height:100% + width/height:auto)
// escala esse box mantendo a proporção — logo uma posição fracionária no box CSS do canvas corresponde
// à MESMA fração no frame em pixels, pra qualquer aspecto. Por isso o overlay nunca precisa consultar
// frameSize().
import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { CropRect } from '../state/editStack';

const MIN_SIZE = 0.1; // 10% mínimo em cada dimensão (spec)

type Handle = 'tl' | 'tr' | 'bl' | 'br';
interface Preset { id: string; label: string; ratio: number | null }
const PRESETS: Preset[] = [
  { id: 'livre', label: 'Livre', ratio: null },
  { id: '1-1', label: '1:1', ratio: 1 },
  { id: '4-5', label: '4:5', ratio: 4 / 5 },
  { id: '16-9', label: '16:9', ratio: 16 / 9 },
];
// sinal de direção em que o canto ARRASTADO se move a partir do canto FIXO (oposto)
const HANDLE_CFG: Record<Handle, { signX: 1 | -1; signY: 1 | -1 }> = {
  br: { signX: 1, signY: 1 },
  bl: { signX: -1, signY: 1 },
  tr: { signX: 1, signY: -1 },
  tl: { signX: -1, signY: -1 },
};

export interface CropOverlayProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  initialCrop: CropRect | null;
  onCancel: () => void;
  onApply: (crop: CropRect) => void;
}

interface Box { left: number; top: number; width: number; height: number }

// Box CSS do canvas em px, relativo a `containerRef` (ancestral position:relative) — recalculado a
// cada mudança de tamanho do canvas (ex.: girar 90° troca o aspecto) ou do container (resize/rotação
// de tela). NÃO exportado (Editor.tsx tem sua própria cópia idêntica pra grade do Endireitar — mesmo
// cálculo, mesmo motivo: o canvas é sempre proporcional ao frame): manter este arquivo exportando só
// o componente evita o warning de lint react/only-export-components (Fast Refresh).
function useCanvasBox(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  containerRef: RefObject<HTMLElement | null>,
): Box | null {
  const [box, setBox] = useState<Box | null>(null);
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

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

// Maior retângulo respeitando `ratio` (w/h), centrado no retângulo atual, sem sair de [0,1].
function applyRatio(r: CropRect, ratio: number): CropRect {
  let w = r.w, h = w / ratio;
  if (h > r.h) { h = r.h; w = h * ratio; }
  if (w > 1) { w = 1; h = w / ratio; }
  if (h > 1) { h = 1; w = h * ratio; }
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

type Drag =
  | { kind: 'move'; startX: number; startY: number; base: CropRect }
  | { kind: 'resize'; handle: Handle; fixedX: number; fixedY: number };

export default function CropOverlay({ canvasRef, containerRef, initialCrop, onCancel, onApply }: CropOverlayProps) {
  const [rect, setRect] = useState<CropRect>(initialCrop ?? { x: 0, y: 0, w: 1, h: 1 });
  const [ratio, setRatio] = useState<number | null>(null);
  const box = useCanvasBox(canvasRef, containerRef);
  const dragRef = useRef<Drag | null>(null);

  function selectPreset(p: Preset) {
    setRatio(p.ratio);
    setRect((r) => (p.ratio ? applyRatio(r, p.ratio) : r));
  }

  // Converte um ponto em coordenadas de VIEWPORT (e.clientX/Y) pra fração 0..1 do canvas. Usa
  // getBoundingClientRect do canvas DIRETO (não `box`, que é relativo ao container pra fins de CSS
  // do overlay portalado) — misturar as duas referências fazia a alça de resize "correr" na direção
  // errada (bug encontrado na verificação: box.top é relativo ao container, e.clientY é absoluto).
  function toFraction(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return { fx: 0, fy: 0 };
    const r = canvas.getBoundingClientRect();
    return { fx: clamp((clientX - r.left) / r.width, 0, 1), fy: clamp((clientY - r.top) / r.height, 0, 1) };
  }

  function onHandleDown(e: ReactPointerEvent, handle: Handle) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const cfg = HANDLE_CFG[handle];
    dragRef.current = {
      kind: 'resize',
      handle,
      fixedX: cfg.signX > 0 ? rect.x : rect.x + rect.w,
      fixedY: cfg.signY > 0 ? rect.y : rect.y + rect.h,
    };
  }

  function onBodyDown(e: ReactPointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { kind: 'move', startX: e.clientX, startY: e.clientY, base: rect };
  }

  function onMove(e: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag || !box) return;
    if (drag.kind === 'move') {
      const dx = (e.clientX - drag.startX) / box.width;
      const dy = (e.clientY - drag.startY) / box.height;
      const { base } = drag;
      setRect({
        x: clamp(base.x + dx, 0, 1 - base.w),
        y: clamp(base.y + dy, 0, 1 - base.h),
        w: base.w,
        h: base.h,
      });
      return;
    }
    const { fixedX, fixedY, handle } = drag;
    const { signX, signY } = HANDLE_CFG[handle];
    const { fx, fy } = toFraction(e.clientX, e.clientY);
    const maxW = signX > 0 ? 1 - fixedX : fixedX;
    const maxH = signY > 0 ? 1 - fixedY : fixedY;
    let w = clamp(signX * (fx - fixedX), MIN_SIZE, Math.max(MIN_SIZE, maxW));
    let h = clamp(signY * (fy - fixedY), MIN_SIZE, Math.max(MIN_SIZE, maxH));
    if (ratio) {
      // usa a dimensão que precisa de mais "alcance" pra chegar no ponteiro, mantendo a razão travada
      // (candidata largura-guia vs altura-guia; escolhe a maior das duas, depois recorta pelo max
      // disponível — nunca deixa o retângulo sair de [0,1], mesmo que isso quebre a razão num canto
      // extremo do frame, caso raríssimo e aceitável em v1).
      if (w / ratio >= h) { h = Math.min(w / ratio, maxH); w = h * ratio; }
      else { w = Math.min(h * ratio, maxW); h = w / ratio; }
      w = clamp(w, MIN_SIZE, maxW);
      h = clamp(h, MIN_SIZE, maxH);
    }
    setRect({
      x: signX > 0 ? fixedX : fixedX - w,
      y: signY > 0 ? fixedY : fixedY - h,
      w,
      h,
    });
  }

  function endDrag() {
    dragRef.current = null;
  }

  return (
    <>
      {box &&
        containerRef.current &&
        createPortal(
          <div
            className="crop-overlay"
            data-testid="crop-overlay"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            onPointerMove={onMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div
              className="crop-rect"
              data-testid="crop-rect"
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
              }}
              onPointerDown={onBodyDown}
            >
              {(['tl', 'tr', 'bl', 'br'] as Handle[]).map((h) => (
                <div
                  key={h}
                  className={`crop-handle crop-handle-${h}`}
                  data-testid={`crop-handle-${h}`}
                  onPointerDown={(e) => onHandleDown(e, h)}
                />
              ))}
            </div>
          </div>,
          containerRef.current,
        )}

      <div className="editor-panel crop-mode-panel" data-testid="crop-presets">
        <div className="slider-row-label">
          <span>Proporção</span>
        </div>
        <div className="crop-presets-row">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`btn btn-secondary crop-preset${ratio === p.ratio ? ' active' : ''}`}
              data-testid={`crop-preset-${p.id}`}
              onClick={() => selectPreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="editor-tabs crop-mode-bar" data-testid="crop-mode-bar">
        <button type="button" className="btn btn-secondary crop-mode-btn" data-testid="crop-cancel" onClick={onCancel}>
          Cancelar
        </button>
        <button type="button" className="btn btn-primary crop-mode-btn" data-testid="crop-apply" onClick={() => onApply(rect)}>
          Aplicar
        </button>
      </div>
    </>
  );
}
