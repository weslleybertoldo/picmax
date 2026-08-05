// src/io/openImage.ts
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
export interface LoadedImage { bitmap: ImageBitmap; blob: Blob; width: number; height: number }
export async function openImage(source: 'gallery' | 'camera'): Promise<LoadedImage | null> {
  const photo = await Camera.getPhoto({
    resultType: CameraResultType.Uri, quality: 100,
    source: source === 'gallery' ? CameraSource.Photos : CameraSource.Camera,
  }).catch(() => null);
  if (!photo?.webPath) return null;
  const blob = await (await fetch(photo.webPath)).blob();
  // preview reduzido (≤2048 no lado maior, orientação EXIF aplicada) — full-res só no export/IA, a partir do blob
  const probe = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const fullW = probe.width, fullH = probe.height; // capturar ANTES do close (bitmap fechado devolve 0)
  const scale = Math.min(1, 2048 / Math.max(fullW, fullH));
  const bitmap = scale < 1
    ? await createImageBitmap(blob, { imageOrientation: 'from-image', resizeQuality: 'high', resizeWidth: Math.round(fullW * scale), resizeHeight: Math.round(fullH * scale) })
    : probe;
  if (bitmap !== probe) probe.close();
  return { bitmap, blob, width: fullW, height: fullH }; // width/height = dimensões REAIS (full-res)
}
