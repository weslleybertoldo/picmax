// src/native/imageEnhancer.ts — bridge TS do plugin Capacitor nativo `ImageEnhancer`
// (android/app/src/main/java/com/bertoldo/picmax/ImageEnhancerPlugin.kt).
// Task 8: saveToGallery (grava o export no MediaStore). Task 10: enhance/cancelEnhance +
// evento `enhanceProgress` — IA Real-ESRGAN 4x via NCNN (GPU Vulkan quando disponível, senão CPU).
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface SaveToGalleryOptions {
  base64: string;
  mime: string;
}

export interface SaveToGalleryResult {
  uri: string;
}

export interface EnhanceOptions {
  /** Caminho nativo (aceita prefixo file://) de um JPEG/PNG a melhorar. */
  path: string;
  /** Lado maior máximo da saída (default 8192): entradas grandes são pré-reduzidas pra saída 4x caber. */
  maxOutputSide?: number;
}

export interface EnhanceResult {
  /** Caminho absoluto do JPEG (q90) gerado no cacheDir do app. */
  path: string;
  usedGpu: boolean;
}

export interface EnhanceProgressEvent {
  percent: number; // 0..100, avança por tile processado
  usingGpu: boolean;
}

export interface ImageEnhancerPlugin {
  saveToGallery(options: SaveToGalleryOptions): Promise<SaveToGalleryResult>;
  /** Rejeita com "cancelado" (cancelEnhance) ou "falha na IA". Só 1 melhoria por vez. */
  enhance(options: EnhanceOptions): Promise<EnhanceResult>;
  cancelEnhance(): Promise<void>;
  addListener(
    eventName: 'enhanceProgress',
    listener: (event: EnhanceProgressEvent) => void,
  ): Promise<PluginListenerHandle>;
}

export const ImageEnhancer = registerPlugin<ImageEnhancerPlugin>('ImageEnhancer');
