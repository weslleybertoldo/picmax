// src/native/imageEnhancer.ts — bridge TS do plugin Capacitor nativo `ImageEnhancer`
// (android/app/src/main/java/com/bertoldo/picmax/ImageEnhancerPlugin.kt). Task 8: só `saveToGallery`
// (grava o export no MediaStore). `enhance`/`cancelEnhance` (IA Real-ESRGAN via NCNN/Vulkan) chegam
// na Task 10 — não declarados aqui ainda, pra não anunciar uma API que a plataforma não tem.
import { registerPlugin } from '@capacitor/core';

export interface SaveToGalleryOptions {
  base64: string;
  mime: string;
}

export interface SaveToGalleryResult {
  uri: string;
}

export interface ImageEnhancerPlugin {
  saveToGallery(options: SaveToGalleryOptions): Promise<SaveToGalleryResult>;
}

export const ImageEnhancer = registerPlugin<ImageEnhancerPlugin>('ImageEnhancer');
