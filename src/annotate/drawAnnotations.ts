// src/annotate/drawAnnotations.ts — rasteriza a lista de anotações num contexto 2D. Função PURA e
// REUSADA em dois lugares: AnnotationCanvas.tsx (preview ao vivo, camada transparente sobre o canvas
// WebGL) e o export full-res da T8 (mesmo desenho, canvas maior) — por isso não depende de nada além
// do próprio ctx/annotations/w/h recebidos (sem DOM global, sem estado do editor).
//
// Convenção de coordenadas (contrato com state/editStack.ts): x,y de cada anotação são FRAÇÕES 0..1
// do frame final (pós-geometria), y cresce pra baixo — mesma convenção do DOM e do CropRect. Aqui
// multiplicamos por (w,h) — as dimensões do canvas de DESTINO em px — pra converter pra pixels reais;
// como w/h já carregam o aspecto e a resolução do destino (preview em CSS×dpr, ou full-res no export),
// a MESMA lista de anotações rasteriza correta em qualquer tamanho de canvas.
import type { Annotation } from '../state/editStack';

const ARROW_HEAD_ANGLE = Math.PI / 6; // 30°, spec: "cabeça de 2 segmentos a 30°"
const ARROW_HEAD_FACTOR = 6; // comprimento da cabeça = N× a largura do traço (proporcional, não fixo)

// Largura do traço relativa ao frame (spec): size/1000*w — devolve o valor aplicado pra reusar no
// cálculo do comprimento da cabeça de seta (proporcional à largura, não a um px fixo).
function applyStrokeStyle(ctx: CanvasRenderingContext2D, color: string, size: number, w: number): number {
  const lineWidth = Math.max(0.5, (size / 1000) * w);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  return lineWidth;
}

// Cabeça de seta: 2 segmentos partindo de (toX,toY) de volta em direção a (fromX,fromY), abertos a
// ±30° em torno da direção da linha — comprimento proporcional a `lineWidth` (a largura do traço),
// como pedido na spec ("comprimento proporcional à largura").
function drawArrowHead(ctx: CanvasRenderingContext2D, fromX: number, fromY: number, toX: number, toY: number, lineWidth: number) {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const headLen = lineWidth * ARROW_HEAD_FACTOR;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLen * Math.cos(angle - ARROW_HEAD_ANGLE), toY - headLen * Math.sin(angle - ARROW_HEAD_ANGLE));
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLen * Math.cos(angle + ARROW_HEAD_ANGLE), toY - headLen * Math.sin(angle + ARROW_HEAD_ANGLE));
  ctx.stroke();
}

export function drawAnnotations(ctx: CanvasRenderingContext2D, annotations: Annotation[], w: number, h: number) {
  // Ordem do array = ordem de desenho: uma borracha (destination-out) só apaga o que já foi desenhado
  // ANTES dela nesta MESMA lista — nunca o que vem depois (spec).
  for (const a of annotations) {
    ctx.save();
    if (a.kind === 'stroke') {
      // camada é um canvas 2D próprio e transparente (ver AnnotationCanvas.tsx) — destination-out
      // aqui só apaga pixels JÁ PINTADOS por outras anotações nesta camada, nunca a foto por baixo.
      ctx.globalCompositeOperation = a.erase ? 'destination-out' : 'source-over';
      const lineWidth = applyStrokeStyle(ctx, a.color, a.size, w);
      if (a.points.length === 1) {
        // toque sem arraste: um moveTo isolado sem lineTo não desenha nada no Canvas 2D — vira um
        // "dot" (bolinha do raio da espessura) pra dar feedback visual do toque.
        ctx.beginPath();
        ctx.arc(a.points[0].x * w, a.points[0].y * h, lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (a.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(a.points[0].x * w, a.points[0].y * h);
        for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x * w, a.points[i].y * h);
        ctx.stroke();
      }
    } else if (a.kind === 'text') {
      const px = Math.max(1, (a.size / 1000) * w);
      ctx.font = `bold ${px}px sans-serif`;
      ctx.fillStyle = a.color;
      ctx.textBaseline = 'top';
      ctx.fillText(a.text, a.x * w, a.y * h);
    } else {
      // a.kind === 'shape'
      const lineWidth = applyStrokeStyle(ctx, a.color, a.size, w);
      const fromX = a.from.x * w, fromY = a.from.y * h, toX = a.to.x * w, toY = a.to.y * h;
      if (a.shape === 'line' || a.shape === 'arrow') {
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
        if (a.shape === 'arrow') drawArrowHead(ctx, fromX, fromY, toX, toY, lineWidth);
      } else if (a.shape === 'rect') {
        ctx.strokeRect(Math.min(fromX, toX), Math.min(fromY, toY), Math.abs(toX - fromX), Math.abs(toY - fromY));
      } else {
        // a.shape === 'ellipse'
        const cx = (fromX + toX) / 2, cy = (fromY + toY) / 2;
        const rx = Math.abs(toX - fromX) / 2, ry = Math.abs(toY - fromY) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(rx, 0.01), Math.max(ry, 0.01), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
