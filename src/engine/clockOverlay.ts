// src/engine/clockOverlay.ts — overlay de relógio estilo lock screen do iOS, parte do LOOK do
// filtro "Slim Black iOS" (v1.1 r4, pedido do Weslley: a data/hora fazem parte do filtro AR
// original e entram na recriação). NÃO é shader: é camada 2D desenhada POR CIMA da foto, como as
// anotações — presente no preview (ClockOverlay.tsx) e no export (exportImage.ts) sempre que um
// filtro slim-black* está ativo, em QUALQUER variante.
//
// Geometria medida na referência (9.png, foto 720px de largura, análise de pixels brancos):
//   data  "Wednesday, August 05, 2026": banda y 20..50 (cap+descender ~30px), x 126..595, centrada
//   hora  "18:27": banda y 94..233 (altura de dígito 140px), x 129..607, centrada
//   branco praticamente pleno (picos 255) → usamos 94% de opacidade
// Convertido em frações da LARGURA do frame (estável em qualquer aspecto):
//   data: font-size 0.044w, baseline 0.0597w · hora: font-size 0.274w (dígito ≈ 0.71em), baseline 0.3236w
//
// Conteúdo: data/hora ATUAIS no momento da aplicação do filtro (locale do device na data; hora
// forçada 24h "18:27" como na referência). A escolha de fonte é system-ui semibold/bold — aproxima
// a SF Pro do iOS sem embarcar fonte.
//
// ⚠️ Miniaturas do carrossel NÃO recebem o relógio (decisão de produto documentada): numa thumb de
// ~76px o texto viraria ruído ilegível — a thumb mostra só o grade. Como as thumbs são geradas
// direto pelo renderer WebGL (FilterPanel), a exclusão é automática: o overlay só existe nos dois
// pontos de composição 2D (preview do Editor e export).

export const isClockFilter = (id: string | null | undefined): boolean => !!id && id.startsWith('slim-black');

export function formatClockDate(now: Date): string {
  const s = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: '2-digit', year: 'numeric' }).format(now);
  return s.charAt(0).toUpperCase() + s.slice(1); // pt-BR/es começam minúsculo ("quarta-feira…")
}

export function formatClockTime(now: Date): string {
  // 24h fixo como na referência (iOS mostra conforme o ajuste do usuário; aqui padronizamos)
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}

const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Desenha o relógio no ctx (0,0 .. w,h já é o frame FINAL da foto). `now` = momento da APLICAÇÃO
// do filtro (o Editor captura ao ativar; o export recebe o mesmo instante).
export function drawClockOverlay(ctx: CanvasRenderingContext2D, w: number, _h: number, now: Date): void {
  // letterSpacing negativo aproxima a largura dos dígitos SF (Roboto/Segoe são mais largos) —
  // calibrado por pixel contra a referência; propriedade suportada no Chromium/WebView moderno,
  // e ignorada sem quebrar onde não existir (por isso o cast opcional).
  const lsCtx = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';

  ctx.font = `600 ${(0.044 * w).toFixed(1)}px ${FONT_STACK}`;
  if (lsCtx.letterSpacing !== undefined) lsCtx.letterSpacing = `${(-0.002 * w).toFixed(2)}px`;
  ctx.fillText(formatClockDate(now), w / 2, 0.0597 * w);

  // 600 (semibold): no device real (Roboto) fica mais leve que 700, mais próximo do traço SF da
  // referência (nossa varredura de stroke: ref 156px acesos vs 189 no headless — o DejaVu do
  // Chromium headless não distingue 600/700 e renderiza mais pesado que o Roboto do device).
  ctx.font = `600 ${(0.256 * w).toFixed(1)}px ${FONT_STACK}`;
  if (lsCtx.letterSpacing !== undefined) lsCtx.letterSpacing = `${(-0.0252 * w).toFixed(2)}px`;
  ctx.fillText(formatClockTime(now), w / 2, 0.3208 * w);
  ctx.restore();
}
