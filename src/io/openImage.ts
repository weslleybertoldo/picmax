// src/io/openImage.ts
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { decodeOrientedCanvas } from './decodeImage';
export interface LoadedImage { bitmap: ImageBitmap; blob: Blob; width: number; height: number }
export async function openImage(source: 'gallery' | 'camera'): Promise<LoadedImage | null> {
  const photo = await Camera.getPhoto({
    resultType: CameraResultType.Uri, quality: 100,
    source: source === 'gallery' ? CameraSource.Photos : CameraSource.Camera,
  }).catch(() => null);
  if (!photo?.webPath) return null;
  const blob = await (await fetch(photo.webPath)).blob();
  // orientação EXIF já aplicada por decodeOrientedCanvas (ver comentário lá — NÃO usar
  // createImageBitmap(blob, {imageOrientation:'from-image'}) direto: quebra em WebView antiga).
  const oriented = await decodeOrientedCanvas(blob);
  const fullW = oriented.width, fullH = oriented.height; // dimensões REAIS (full-res, já orientadas)
  // preview reduzido (≤2048 no lado maior) — full-res só no export/IA, a partir do blob
  const scale = Math.min(1, 2048 / Math.max(fullW, fullH));
  const bitmap = scale < 1
    ? await createImageBitmap(oriented, { resizeQuality: 'high', resizeWidth: Math.round(fullW * scale), resizeHeight: Math.round(fullH * scale) })
    : await createImageBitmap(oriented);
  return { bitmap, blob, width: fullW, height: fullH };
}
