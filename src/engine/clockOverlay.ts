// src/engine/clockOverlay.ts — overlay de relógio estilo lock screen do iOS, parte do LOOK do
// filtro "Slim Black iOS" (v1.1 r4, pedido do Weslley: a data/hora fazem parte do filtro AR
// original e entram na recriação). NÃO é shader: é camada 2D desenhada POR CIMA da foto, como as
// anotações — presente no preview (ClockOverlay.tsx) e no export (exportImage.ts) sempre que um
// filtro slim-black* está ativo, em QUALQUER variante.
//
// Geometria medida na referência (9.png, foto RETRATO 720×1280, análise de pixels brancos):
//   data  "Wednesday, August 05, 2026": banda y 20..50 (cap+descender ~30px), x 126..595, centrada
//   hora  "18:27": banda y 94..233 (altura de dígito 140px ≈ 10% da ALTURA), x 129..607, centrada
//   branco praticamente pleno (picos 255) → usamos 94% de opacidade
// Convertido em frações do MENOR LADO do frame (min(w,h)) — na referência retrato o menor lado é a
// largura (720), então as frações medidas lá continuam exatas; ancorar no menor lado (e não em w)
// mantém o relógio proporcional em foto DEITADA (em 16:9 paisagem, frações de w jogavam a baseline
// da hora a 57% da altura; num panorama 4:1 saía do frame). Posições ainda são clampadas contra h
// por segurança (matematicamente 0.3208·min(w,h) ≤ 0.3208·h < h, mas o clamp documenta o invariante):
//   data: font-size 0.044s, baseline 0.0597s · hora: font-size 0.256s (dígito ≈ 0.71em), baseline 0.3208s
//
// Conteúdo: data/hora ATUAIS no momento da aplicação do filtro (locale do device na data; hora
// forçada 24h "18:27" como na referência). A escolha de fonte é system-ui semibold/bold — aproxima
// a SF Pro do iOS sem embarcar fonte.
//
// ⚠️ Miniaturas do carrossel NÃO recebem o relógio (decisão de produto documentada): numa thumb de
// ~76px o texto viraria ruído ilegível — a thumb mostra só o grade. Como as thumbs são geradas
// direto pelo renderer WebGL (FilterPanel), a exclusão é automática: o overlay só existe nos dois
// pontos de composição 2D (preview do Editor e export).

import type { FilterOp } from '../state/editStack';

export const isClockFilter = (id: string | null | undefined): boolean => !!id && id.startsWith('slim-black');

// Instante da aplicação (release review, bloqueante 4): vive no PRÓPRIO FilterOp do snapshot
// (`appliedAt`, epoch ms) — undo/redo restauram a MESMA hora e nada é mutado durante o render.
// Regra: transição não-relógio → relógio grava agora; trocar entre variantes slim-black* (ou
// reaplicar o mesmo card) PRESERVA o instante já gravado — mesmo comportamento da ref antiga do
// Editor, que só resetava quando o filtro deixava de ser relógio. Filtro não-relógio passa intacto
// (sem appliedAt). savePreset faz o strip na persistência (modelo reaplicado ganha hora NOVA aqui).
export function withClockAppliedAt(next: FilterOp, current: FilterOp | null): FilterOp {
  if (!isClockFilter(next.id)) return next;
  const inherited = current && isClockFilter(current.id) ? current.appliedAt : undefined;
  return { ...next, appliedAt: inherited ?? Date.now() };
}

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
// do filtro (lido do snapshot — filter.appliedAt). `alpha` (0..1) = intensidade do filtro /100
// (release review, bloqueante 2): o relógio é parte do LOOK e desvanece junto com o slider de
// intensidade; em 0 não desenha nada.
export function drawClockOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, now: Date, alpha = 1): void {
  if (alpha <= 0) return;
  const s = Math.min(w, h); // âncora de escala: menor lado (ver geometria no topo)
  // letterSpacing negativo aproxima a largura dos dígitos SF (Roboto/Segoe são mais largos) —
  // calibrado por pixel contra a referência; propriedade suportada no Chromium/WebView moderno,
  // e ignorada sem quebrar onde não existir (por isso o cast opcional).
  const lsCtx = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = `rgba(255, 255, 255, ${(0.94 * Math.min(alpha, 1)).toFixed(4)})`;

  ctx.font = `600 ${(0.044 * s).toFixed(1)}px ${FONT_STACK}`;
  if (lsCtx.letterSpacing !== undefined) lsCtx.letterSpacing = `${(-0.002 * s).toFixed(2)}px`;
  ctx.fillText(formatClockDate(now), w / 2, Math.min(0.0597 * s, h));

  // 600 (semibold): no device real (Roboto) fica mais leve que 700, mais próximo do traço SF da
  // referência (nossa varredura de stroke: ref 156px acesos vs 189 no headless — o DejaVu do
  // Chromium headless não distingue 600/700 e renderiza mais pesado que o Roboto do device).
  ctx.font = `600 ${(0.256 * s).toFixed(1)}px ${FONT_STACK}`;
  if (lsCtx.letterSpacing !== undefined) lsCtx.letterSpacing = `${(-0.0252 * s).toFixed(2)}px`;
  ctx.fillText(formatClockTime(now), w / 2, Math.min(0.3208 * s, h));
  ctx.restore();
}
