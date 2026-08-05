// src/io/decodeImage.ts — decodifica um Blob de imagem num <canvas> já ORIENTADO (EXIF aplicado),
// SEM depender de `createImageBitmap(blob, { imageOrientation: 'from-image' })`.
//
// Achado real em smoke test num emulador Android 11 (WebView de sistema = Chrome 83, 2020): esse
// valor do enum ImageOrientation só existe a partir de Chromium ~89 — em WebView mais antiga (comum
// em devices reais com minSdk 29, que não força auto-update do WebView) a chamada lança
// `TypeError: The provided value 'from-image' is not a valid enum value` e a abertura de QUALQUER
// foto da galeria/câmera falha (bug bloqueante, pior que um crash: o app abre normal e quebra só na
// ação principal). `<img>`/`canvas.drawImage` já respeitam o EXIF por padrão desde Chrome 81 (a
// propriedade CSS `image-orientation` tem default `from-image` desde então, e o canvas herda essa
// orientação "as painted" ao desenhar um `<img>`) — decodificar por esse caminho cobre WebView antiga
// E moderna com o MESMO código, sem feature-detection e sem duas implementações pra manter.
export async function decodeOrientedCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Falha ao decodificar a imagem.'));
    });
    img.src = url;
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D não disponível para decodificar a imagem.');
    ctx.drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}
