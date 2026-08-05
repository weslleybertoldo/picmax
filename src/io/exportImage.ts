// src/io/exportImage.ts — render full-res do frame final (geometria + ajustes + filtro) com as
// anotações compostas por cima, pronto pra galeria/compartilhamento (Task 8).
//
// Pipeline: 1) decodifica o blob ORIGINAL (full-res, orientação EXIF aplicada) — nunca reusa
// base.bitmap (que é o preview reduzido a ≤2048, ver src/io/openImage.ts); 2) cria um renderer
// OFFSCREEN descartável só pra ler `limits.maxTextureSize` (só existe depois de criar um renderer —
// ver contrato em src/engine/renderer.ts); 3) se o bitmap full-res exceder esse limite, reduz o
// bitmap (createImageBitmap com resize) ANTES do setImage — setImage() lança se a textura excede
// MAX_TEXTURE_SIZE, então a redução tem que acontecer aqui, não dentro do renderer; 4) cria o
// renderer FINAL já com opts.maxSide = min(resizeMaxSide do snapshot, maxTextureSize) e renderiza o
// snapshot nele; 5) compõe: desenha o canvas WebGL num canvas 2D e SÓ DEPOIS a camada de anotações
// via renderAnnotationsLayer + drawImage — NUNCA drawAnnotations direto no ctx que já tem a foto
// (destination-out da borracha furaria a foto; ver aviso em src/annotate/drawAnnotations.ts).
import type { EditSnapshot } from '../state/editStack';
import type { LoadedImage } from './openImage';
import { createRenderer } from '../engine/renderer';
import { renderAnnotationsLayer } from '../annotate/drawAnnotations';
import { drawClockOverlay, isClockFilter } from '../engine/clockOverlay';
import { decodeOrientedCanvas } from './decodeImage';

export interface ExportOpts {
  // Relógio do Slim Black iOS (r4): instante capturado quando o filtro foi APLICADO no Editor —
  // o export desenha o mesmo horário do preview. Sem valor, usa agora.
  clockDate?: Date;
}

export async function exportImage(base: LoadedImage, snap: EditSnapshot, opts: ExportOpts = {}): Promise<Blob> {
  let fullBitmap: ImageBitmap | null = null;
  let scaledBitmap: ImageBitmap | null = null;
  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = 1;
  probeCanvas.height = 1;
  let probeRenderer: ReturnType<typeof createRenderer> | null = null;
  let renderer: ReturnType<typeof createRenderer> | null = null;

  try {
    // full-res a partir do arquivo original — o preview (base.bitmap) já foi reduzido no openImage.
    // decodeOrientedCanvas aplica o EXIF (ver comentário lá — NÃO usar
    // createImageBitmap(blob, {imageOrientation:'from-image'}) direto: quebra em WebView antiga).
    const orientedCanvas = await decodeOrientedCanvas(base.blob);
    fullBitmap = await createImageBitmap(orientedCanvas);

    // limits só existe depois de criar um renderer: usa um descartável num canvas 1x1 só pra ler o
    // MAX_TEXTURE_SIZE real da GPU deste device, sem pagar o custo de subir uma textura grande nele.
    probeRenderer = createRenderer(probeCanvas);
    const maxTextureSize = probeRenderer.limits.maxTextureSize;
    probeRenderer.destroy({ loseContext: true });
    probeRenderer = null;

    const maxSide = Math.min(snap.geometry.resizeMaxSide ?? Infinity, maxTextureSize);

    // se o bitmap full-res excede o limite de textura da GPU, reduz ANTES do setImage (que lançaria).
    let uploadBitmap = fullBitmap;
    if (fullBitmap.width > maxTextureSize || fullBitmap.height > maxTextureSize) {
      const scale = maxTextureSize / Math.max(fullBitmap.width, fullBitmap.height);
      scaledBitmap = await createImageBitmap(orientedCanvas, {
        resizeQuality: 'high',
        resizeWidth: Math.round(fullBitmap.width * scale),
        resizeHeight: Math.round(fullBitmap.height * scale),
      });
      uploadBitmap = scaledBitmap;
    }

    const glCanvas = document.createElement('canvas');
    renderer = createRenderer(glCanvas, { maxSide });
    renderer.setImage(uploadBitmap);
    renderer.render(snap);

    // compõe: foto (WebGL) primeiro, anotações (camada isolada) depois — nesta ordem, source-over.
    const w = glCanvas.width, h = glCanvas.height;
    const composed = document.createElement('canvas');
    composed.width = w;
    composed.height = h;
    const ctx = composed.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D não disponível para compor a exportação.');
    ctx.drawImage(glCanvas, 0, 0);
    if (snap.annotations.length > 0) {
      const layer = renderAnnotationsLayer(snap.annotations, w, h);
      ctx.drawImage(layer, 0, 0);
    }
    // Relógio do Slim Black iOS (r4): camada 2D, parte do look do filtro (qualquer variante) —
    // mesma composição do preview. As MINIATURAS não passam por aqui (renderer puro) e ficam sem
    // relógio de propósito (ilegível em thumb; ver clockOverlay.ts).
    if (isClockFilter(snap.filter?.id)) {
      drawClockOverlay(ctx, w, h, opts.clockDate ?? new Date());
    }

    const mime = base.blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const quality = mime === 'image/jpeg' ? 0.9 : undefined;
    const blob = await new Promise<Blob>((resolve, reject) => {
      composed.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao gerar a imagem exportada.'))), mime, quality);
    });
    return blob;
  } finally {
    probeRenderer?.destroy({ loseContext: true });
    renderer?.destroy({ loseContext: true });
    fullBitmap?.close();
    scaledBitmap?.close();
  }
}
