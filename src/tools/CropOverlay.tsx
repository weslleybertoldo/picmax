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
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { CropRect } from '../state/editStack';
import { clamp, toFraction, useCanvasBox, type CanvasBox } from './canvasGeometry';

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

// Converte uma razão de PIXEL (ex.: 1 pra "1:1", 16/9 pra "16:9") pra razão equivalente no espaço de
// FRAÇÃO 0..1 usado pelo CropRect. Bug corrigido (spec review): fração e pixel só têm a MESMA razão
// quando o frame é quadrado — ww/hh (fração) precisa ser dividido pelo aspecto do frame pra que
// ww*fw == hh*fh (pixels reais) quando fw≠fh. Como o box CSS do canvas é sempre proporcional ao frame
// (ver comentário no topo do arquivo), `box.width/box.height` já É o aspecto do frame (fw/fh) — não é
// preciso consultar frameSize().
function pixelRatioToFracRatio(pixelRatio: number, box: CanvasBox): number {
  return pixelRatio / (box.width / box.height);
}

// Maior retângulo respeitando `fracRatio` (w/h EM FRAÇÃO, já convertido — ver pixelRatioToFracRatio),
// centrado no retângulo atual, sem sair de [0,1] e sem cair abaixo de MIN_SIZE (spec review: um
// aspecto de preset extremo — ex. 16:9 — num frame também extremo pode empurrar a dimensão menor
// abaixo de 10% se isso não for corrigido).
function applyRatio(r: CropRect, fracRatio: number): CropRect {
  let w = r.w, h = w / fracRatio;
  if (h > r.h) { h = r.h; w = h * fracRatio; }
  if (w > 1) { w = 1; h = w / fracRatio; }
  if (h > 1) { h = 1; w = h * fracRatio; }
  // a dimensão "pequena" é sempre a mesma dada a razão (h quando fracRatio>=1, w quando <1) — corrige
  // só ela e deriva a outra, mantendo fracRatio; clamp final defensivo cobre o caso raríssimo de um
  // aspecto tão extremo que nem MIN_SIZE cabe em [0,1] mantendo a razão exata.
  if (fracRatio >= 1) {
    if (h < MIN_SIZE) { h = MIN_SIZE; w = h * fracRatio; }
  } else if (w < MIN_SIZE) {
    w = MIN_SIZE; h = w / fracRatio;
  }
  w = clamp(w, MIN_SIZE, 1);
  h = clamp(h, MIN_SIZE, 1);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

type Drag =
  | { kind: 'move'; pointerId: number; startX: number; startY: number; baseline: CropRect }
  | { kind: 'resize'; pointerId: number; handle: Handle; fixedX: number; fixedY: number; baseline: CropRect };

export default function CropOverlay({ canvasRef, containerRef, initialCrop, onCancel, onApply }: CropOverlayProps) {
  const [rect, setRect] = useState<CropRect>(initialCrop ?? { x: 0, y: 0, w: 1, h: 1 });
  const [ratio, setRatio] = useState<number | null>(null);
  const box = useCanvasBox(canvasRef, containerRef);
  const dragRef = useRef<Drag | null>(null);

  function selectPreset(p: Preset) {
    setRatio(p.ratio);
    // `ratio` guarda a razão de PIXEL (identidade do preset, comparada abaixo pra marcar o botão
    // ativo); a conversão pra fração só entra no momento de aplicar (aqui) ou de redimensionar (onMove).
    setRect((r) => (p.ratio && box ? applyRatio(r, pixelRatioToFracRatio(p.ratio, box)) : r));
  }

  function onHandleDown(e: ReactPointerEvent, handle: Handle) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const cfg = HANDLE_CFG[handle];
    dragRef.current = {
      kind: 'resize',
      pointerId: e.pointerId,
      handle,
      fixedX: cfg.signX > 0 ? rect.x : rect.x + rect.w,
      fixedY: cfg.signY > 0 ? rect.y : rect.y + rect.h,
      baseline: rect,
    };
  }

  function onBodyDown(e: ReactPointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { kind: 'move', pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseline: rect };
  }

  function onMove(e: ReactPointerEvent) {
    const drag = dragRef.current;
    // 2º dedo (pointerId diferente do que iniciou o arraste) não sequestra nem interfere no drag ativo
    // (spec review, item 2) — só o ponteiro que fez o pointerdown original controla o gesto.
    if (!drag || !box || e.pointerId !== drag.pointerId) return;
    if (drag.kind === 'move') {
      const dx = (e.clientX - drag.startX) / box.width;
      const dy = (e.clientY - drag.startY) / box.height;
      const { baseline } = drag;
      setRect({
        x: clamp(baseline.x + dx, 0, 1 - baseline.w),
        y: clamp(baseline.y + dy, 0, 1 - baseline.h),
        w: baseline.w,
        h: baseline.h,
      });
      return;
    }
    const { fixedX, fixedY, handle } = drag;
    const { signX, signY } = HANDLE_CFG[handle];
    const { fx, fy } = toFraction(canvasRef.current, e.clientX, e.clientY);
    const maxW = signX > 0 ? 1 - fixedX : fixedX;
    const maxH = signY > 0 ? 1 - fixedY : fixedY;
    let w = clamp(signX * (fx - fixedX), MIN_SIZE, Math.max(MIN_SIZE, maxW));
    let h = clamp(signY * (fy - fixedY), MIN_SIZE, Math.max(MIN_SIZE, maxH));
    if (ratio) {
      // `ratio` é a razão de PIXEL do preset (ex.: 1 pra "1:1") — converte pra fração ANTES de travar
      // (bug do spec review: sem essa conversão, "1:1" ficava quadrado em FRAÇÃO, não em pixel real,
      // num frame não-quadrado; ver pixelRatioToFracRatio).
      const fracRatio = pixelRatioToFracRatio(ratio, box);
      // usa a dimensão que precisa de mais "alcance" pra chegar no ponteiro, mantendo a razão travada
      // (candidata largura-guia vs altura-guia; escolhe a maior das duas, depois recorta pelo max
      // disponível — nunca deixa o retângulo sair de [0,1], mesmo que isso quebre a razão num canto
      // extremo do frame, caso raríssimo e aceitável em v1).
      if (w / fracRatio >= h) { h = Math.min(w / fracRatio, maxH); w = h * fracRatio; }
      else { w = Math.min(h * fracRatio, maxW); h = w / fracRatio; }
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

  // Soltura normal (pointerup): mantém o resultado do arraste, só encerra o gesto.
  function onUp(e: ReactPointerEvent) {
    const drag = dragRef.current;
    if (drag && e.pointerId === drag.pointerId) dragRef.current = null;
  }

  // Interrompido sem soltura normal (pointercancel — ex.: gesto do sistema assumiu o ponteiro no meio
  // do arraste): reverte pro retângulo de ANTES do gesto (spec review, item 6 — mesma ideia do
  // cancelGesture dos sliders em useSliderGesture.ts, que também reverte ao baseline).
  function onCancelDrag(e: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setRect(drag.baseline);
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
            onPointerUp={onUp}
            onPointerCancel={onCancelDrag}
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
