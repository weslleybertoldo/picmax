// src/annotate/AnnotationCanvas.tsx — camada 2D transparente sobreposta ao canvas WebGL: redesenha as
// anotações confirmadas (+ a que está em progresso) via drawAnnotations, e captura o gesto de criar uma
// anotação nova quando a aba Anotar está ativa e uma ferramenta está selecionada (`enabled`, decidido
// pelo Editor — ver Editor.tsx).
//
// Por que uma camada SEPARADA da foto: a borracha usa destination-out — se desenhasse no MESMO canvas
// da foto, apagaria pixels da foto. Aqui é um <canvas> 2D próprio, sempre transparente, empilhado por
// CSS sobre o canvas WebGL — destination-out só apaga o que ESTA camada já pintou (outras anotações),
// nunca o que está por baixo (2 elementos DOM distintos).
//
// Box/fração: mesma técnica do CropOverlay/StraightenGrid — useCanvasBox posiciona este overlay
// exatamente sobre o box CSS do <canvas> WebGL; toFraction converte clientX/clientY pra fração 0..1
// dele. Diferente do CropOverlay, este componente já nasce como filho direto de `.editor-canvas-wrap`
// (ver Editor.tsx) — não precisa de createPortal, só position:absolute + o próprio box.
//
// Buffer vs CSS: o <canvas> interno tem seus atributos width/height (buffer real) ajustados pra
// box.width/height × devicePixelRatio, não o tamanho CSS puro — sem isso, o traço fica borrado em
// telas de alta densidade (o navegador escalaria um buffer de baixa-res pra cima via CSS).
import { useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { Annotation, EditAction, EditSnapshot } from '../state/editStack';
import { toFraction, useCanvasBox } from '../tools/canvasGeometry';
import { drawAnnotations } from './drawAnnotations';

export type AnnotateTool = 'pen' | 'eraser' | 'text' | 'arrow' | 'rect' | 'ellipse' | 'line';
export const DEFAULT_ANNOTATE_COLOR = '#ffffff';
export const DEFAULT_ANNOTATE_SIZE = 12;

const SHAPE_TOOL: Partial<Record<AnnotateTool, 'arrow' | 'rect' | 'ellipse' | 'line'>> = {
  arrow: 'arrow',
  rect: 'rect',
  ellipse: 'ellipse',
  line: 'line',
};
const MOVE_THROTTLE = 0.003; // spec: só adiciona ponto ao stroke se moveu >0.3% do frame desde o último
const MIN_SHAPE_DIST = 0.01; // spec: forma com <1% de distância entre from/to é descartada ao soltar

type Point = { x: number; y: number };
// Snapshot de tool/color/size no MOMENTO do pointerdown (spec review): `tool`/`color`/`size` são props
// VIVAS do Editor (mudam a qualquer momento via AnnotatePanel) — sem congelar no início do gesto, um
// 2º dedo trocando cor/ferramenta no painel ENQUANTO este traço está em andamento faria o commit final
// usar a cor/ferramenta ERRADA (a de quando soltou, não a de quando começou). Pior ainda pra forma:
// trocar pra 'pen'/'text'/null no meio deixava `SHAPE_TOOL[tool]` undefined, salvando `shape:
// undefined` (drawAnnotations cai no último `else` = ellipse, silenciosamente errado). Por isso o Drag
// carrega sua PRÓPRIA cópia de color/size/erase (ou shape) — resolvida 1x no pointerdown — e
// move/up/commit leem só do `drag`, nunca mais das props ao vivo.
type Drag =
  | { kind: 'stroke'; pointerId: number; points: Point[]; color: string; size: number; erase: boolean }
  | { kind: 'shape'; pointerId: number; from: Point; to: Point; color: string; size: number; shape: 'arrow' | 'rect' | 'ellipse' | 'line' };

export interface AnnotationCanvasProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  present: EditSnapshot;
  dispatch: Dispatch<EditAction>;
  enabled: boolean; // aba Anotar ativa E ferramenta selecionada (e fora do modo Cortar) — só então captura pointer
  tool: AnnotateTool | null;
  color: string;
  size: number;
}

export default function AnnotationCanvas({
  canvasRef,
  containerRef,
  present,
  dispatch,
  enabled,
  tool,
  color,
  size,
}: AnnotationCanvasProps) {
  const layerRef = useRef<HTMLCanvasElement>(null);
  const box = useCanvasBox(canvasRef, containerRef);
  const dragRef = useRef<Drag | null>(null);
  // Anotação em progresso (stroke sendo arrastado / forma sendo definida): só o que o usuário VÊ
  // enquanto desenha — nunca vai pro histórico por si só (só o commit final, em onPointerUp, dispatcha).
  const [liveDraft, setLiveDraft] = useState<Annotation | null>(null);
  // Toque com a ferramenta Texto: âncora (fração) esperando o mini-modal confirmar/cancelar.
  const [textAnchor, setTextAnchor] = useState<Point | null>(null);
  const [textValue, setTextValue] = useState('');

  // Redesenha a camada inteira sempre que as anotações confirmadas OU o rascunho ao vivo mudam (ou o
  // box muda de tamanho, ex.: girar 90° troca o aspecto do frame). Sem estado incremental — a lista é
  // pequena o bastante pra redesenhar do zero a cada mudança, mesma escolha de simplicidade do
  // CropOverlay/StraightenGrid (recalcular tudo via efeito, não manter um canvas "sujo" à mão).
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
    const list = liveDraft ? [...present.annotations, liveDraft] : present.annotations;
    drawAnnotations(ctx, list, bw, bh);
  }, [present.annotations, liveDraft, box]);

  function fractionOf(e: ReactPointerEvent): Point {
    const { fx, fy } = toFraction(canvasRef.current, e.clientX, e.clientY);
    return { x: fx, y: fy };
  }

  function onPointerDown(e: ReactPointerEvent) {
    if (!enabled || !tool || textAnchor) return;
    if (dragRef.current) return; // gesto já em andamento: 2º ponteiro é ignorado (disciplina do CropOverlay)
    const p = fractionOf(e);
    if (tool === 'text') {
      setTextAnchor(p);
      setTextValue('');
      return; // sem drag pra ferramenta Texto — o mini-modal decide commit/cancelamento
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'pen' || tool === 'eraser') {
      const erase = tool === 'eraser';
      dragRef.current = { kind: 'stroke', pointerId: e.pointerId, points: [p], color, size, erase };
      setLiveDraft({ kind: 'stroke', points: [p], color, size, erase });
    } else {
      const shape = SHAPE_TOOL[tool]!;
      dragRef.current = { kind: 'shape', pointerId: e.pointerId, from: p, to: p, color, size, shape };
      setLiveDraft({ kind: 'shape', shape, from: p, to: p, color, size });
    }
  }

  function onPointerMove(e: ReactPointerEvent) {
    const drag = dragRef.current;
    // 2º dedo (pointerId diferente do que iniciou o gesto) não interfere no drag ativo — mesma regra
    // do CropOverlay. Usa SÓ os campos do próprio `drag` (snapshot do pointerdown), nunca as props
    // `tool`/`color`/`size` ao vivo — ver comentário no tipo Drag acima.
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = fractionOf(e);
    if (drag.kind === 'stroke') {
      const last = drag.points[drag.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < MOVE_THROTTLE) return; // throttle: exige >0.3% de deslocamento
      drag.points.push(p);
      setLiveDraft({ kind: 'stroke', points: [...drag.points], color: drag.color, size: drag.size, erase: drag.erase });
    } else {
      drag.to = p;
      setLiveDraft({ kind: 'shape', shape: drag.shape, from: drag.from, to: p, color: drag.color, size: drag.size });
    }
  }

  // Soltura normal: comita a anotação em progresso como 1 entrada de histórico. Cor/espessura/tipo de
  // forma vêm do SNAPSHOT capturado no pointerdown (drag.color/size/erase/shape) — não das props ao
  // vivo, que podem já ter mudado se um 2º dedo tocou o AnnotatePanel durante o gesto.
  function onPointerUp(e: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setLiveDraft(null);
    if (drag.kind === 'stroke') {
      const annotation: Annotation = { kind: 'stroke', points: drag.points, color: drag.color, size: drag.size, erase: drag.erase };
      dispatch({ type: 'set', patch: { annotations: [...present.annotations, annotation] } });
    } else {
      // distância mínima (spec): gesto ínfimo (quase um toque só) descarta a forma, sem dispatch.
      if (Math.hypot(drag.to.x - drag.from.x, drag.to.y - drag.from.y) < MIN_SHAPE_DIST) return;
      const annotation: Annotation = { kind: 'shape', shape: drag.shape, from: drag.from, to: drag.to, color: drag.color, size: drag.size };
      dispatch({ type: 'set', patch: { annotations: [...present.annotations, annotation] } });
    }
  }

  // Interrompido sem soltura normal (ex.: gesto do sistema assumiu o ponteiro no meio do desenho):
  // descarta o rascunho inteiro, SEM registrar no histórico — a anotação em progresso nunca chega a
  // existir pro histórico (não há "baseline" pra reverter, diferente do CropOverlay/sliders).
  function onPointerCancel(e: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setLiveDraft(null);
  }

  function confirmText() {
    const text = textValue.trim();
    if (text && textAnchor) {
      const annotation: Annotation = { kind: 'text', x: textAnchor.x, y: textAnchor.y, text, color, size };
      dispatch({ type: 'set', patch: { annotations: [...present.annotations, annotation] } });
    }
    setTextAnchor(null);
  }

  return (
    <>
      {box && (
        <div
          className="annotation-layer"
          data-testid="annotation-layer"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            pointerEvents: enabled ? 'auto' : 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <canvas ref={layerRef} className="annotation-layer-canvas" data-testid="annotation-canvas" />
        </div>
      )}

      {textAnchor && (
        <div className="text-modal-backdrop" data-testid="text-modal">
          <div className="text-modal">
            <input
              type="text"
              className="text-modal-input"
              data-testid="text-modal-input"
              autoFocus
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              placeholder="Digite o texto"
            />
            <div className="text-modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="text-modal-cancel"
                onClick={() => setTextAnchor(null)}
              >
                Cancelar
              </button>
              <button type="button" className="btn btn-primary" data-testid="text-modal-ok" onClick={confirmText}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
