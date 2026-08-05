// src/io/openImage.ts
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { decodeOrientedCanvas } from './decodeImage';
export interface LoadedImage { bitmap: ImageBitmap; blob: Blob; width: number; height: number }

// Limite de abertura (T12, robustez): uma foto absurdamente grande (ex.: 108MP de um sensor high-end)
// pode estourar memória mais adiante no pipeline (texImage2D, createImageBitmap do preview, export
// full-res) de forma imprevisível — melhor recusar aqui, com uma mensagem clara, do que deixar o app
// travar/crashar silenciosamente 2 telas depois. NÃO aplicado ao resultado da IA (T10): a saída do
// Real-ESRGAN pode passar de 48MP de propósito (maxOutputSide default 8192 ≈ 67MP) — por isso o limite
// é um parâmetro OPCIONAL de loadedImageFromBlob, não uma checagem incondicional dentro dela.
export const MAX_OPEN_MEGAPIXELS = 48;

export class PhotoTooLargeError extends Error {
  readonly megapixels: number;
  constructor(megapixels: number) {
    super(`Foto muito grande (${megapixels.toFixed(0)}MP). O limite é ${MAX_OPEN_MEGAPIXELS}MP.`);
    this.name = 'PhotoTooLargeError';
    this.megapixels = megapixels;
  }
}

// Erro distinto pra permissão de câmera/galeria negada (T12): o chamador (Home.tsx) mostra uma
// instrução pra habilitar o acesso nas Configurações do sistema, em vez do toast genérico de "não foi
// possível abrir". Detecção por heurística de mensagem (ver classifyCameraError abaixo) — o plugin
// Capacitor não expõe um código de erro estruturado, só uma string em inglês vinda do lado nativo.
export class CameraPermissionDeniedError extends Error {
  constructor() {
    super('Permissão negada');
    this.name = 'CameraPermissionDeniedError';
  }
}

// Camera.getPhoto rejeita com mensagens fixas do lado nativo Android (ver
// LegacyCameraFlow.java: "User cancelled photos app" / "User denied access to camera"), mas isso não é
// contratual entre plataformas/versões — por isso a classificação é por heurística (substring, case
// insensitive) em vez de comparar a string exata. Cancelamento é o caminho feliz (usuário desistiu de
// propósito): vira `null`, sem toast. Qualquer outra coisa que mencione "denied"/"permission" é tratada
// como permissão negada; o resto cai no erro genérico (rede, hardware, etc.) que o chamador already loga.
function classifyCameraError(e: unknown): 'cancelled' | 'permission' | 'other' {
  const msg = e instanceof Error ? e.message : String(e);
  if (/cancel/i.test(msg)) return 'cancelled';
  if (/denied|permission/i.test(msg)) return 'permission';
  return 'other';
}

// Blob de imagem → LoadedImage (preview ≤2048 + dimensões full-res). Usado tanto na abertura
// (galeria/câmera) quanto no resultado da IA (T10: o JPEG 4x vira uma nova BASE com o mesmo shape).
// `maxMegapixels` (T12): guarda opcional aplicada SÓ pela abertura (ver openImage) — o resultado da
// IA chama esta função sem o opts e nunca é recusado por tamanho.
export async function loadedImageFromBlob(blob: Blob, opts: { maxMegapixels?: number } = {}): Promise<LoadedImage> {
  // orientação EXIF já aplicada por decodeOrientedCanvas (ver comentário lá — NÃO usar
  // createImageBitmap(blob, {imageOrientation:'from-image'}) direto: quebra em WebView antiga).
  const oriented = await decodeOrientedCanvas(blob);
  const fullW = oriented.width, fullH = oriented.height; // dimensões REAIS (full-res, já orientadas)
  if (opts.maxMegapixels) {
    const megapixels = (fullW * fullH) / 1_000_000;
    if (megapixels > opts.maxMegapixels) throw new PhotoTooLargeError(megapixels);
  }
  // preview reduzido (≤2048 no lado maior) — full-res só no export/IA, a partir do blob
  const scale = Math.min(1, 2048 / Math.max(fullW, fullH));
  const bitmap = scale < 1
    ? await createImageBitmap(oriented, { resizeQuality: 'high', resizeWidth: Math.round(fullW * scale), resizeHeight: Math.round(fullH * scale) })
    : await createImageBitmap(oriented);
  return { bitmap, blob, width: fullW, height: fullH };
}

export async function openImage(source: 'gallery' | 'camera'): Promise<LoadedImage | null> {
  let photo: Awaited<ReturnType<typeof Camera.getPhoto>>;
  try {
    photo = await Camera.getPhoto({
      resultType: CameraResultType.Uri, quality: 100,
      source: source === 'gallery' ? CameraSource.Photos : CameraSource.Camera,
    });
  } catch (e) {
    const kind = classifyCameraError(e);
    if (kind === 'cancelled') return null; // usuário desistiu: sem erro, sem toast (comportamento já existente)
    if (kind === 'permission') throw new CameraPermissionDeniedError();
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (!photo?.webPath) return null;
  const blob = await (await fetch(photo.webPath)).blob();
  return loadedImageFromBlob(blob, { maxMegapixels: MAX_OPEN_MEGAPIXELS });
}
