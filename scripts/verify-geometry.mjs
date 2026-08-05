#!/usr/bin/env node
// scripts/verify-geometry.mjs — fuzz de regressão pra geometria (crop + rotate90 + flip + straighten).
//
// Como rodar: node scripts/verify-geometry.mjs
//
// Por quê: o invariante "o crop acompanha rotate90/flip/straighten sem corromper a região visual"
// queimou 3 rodadas de review consecutivas (T6):
//   1) Girar 90° com crop ativo não transformava o retângulo (região errada após girar).
//   2) Flip e rotação não comutam — com paridade ÍMPAR de flip (H xor V), o giro do retângulo
//      precisa da fórmula INVERSA (e o flip sozinho, sem girar, já precisa mirar o retângulo).
//   3) Flip e straighten não comutam (F·S(θ) = S(−θ)·F) — Espelhar com straighten≠0 corrompia o
//      crop; fix: negar `straighten` no mesmo dispatch do toggleFlip.
// Este script fecha o assunto pra sempre: replica a matemática EXATA de computeUvMatrix
// (src/engine/renderer.ts) e a semântica das ações Girar90/Espelhar H/V (com os transforms de crop
// de src/state/editStack.ts: rotateCropRect90, mirrorCropRect, e a negação de straighten aplicada em
// src/tools/BasicPanel.tsx) — e testa TODAS as sequências de ações de comprimento 1..7, pra cada
// straighten inicial de um conjunto fixo, verificando que o conjunto de pontos de textura amostrados
// do crop NUNCA muda (só reorienta na tela) ao longo da sequência.
//
// Node puro, sem dependências, roda em menos de 1s. SEMPRE rodar antes de comitar qualquer mudança em
// rotate90/flip/straighten/crop (Editor/BasicPanel/CropOverlay/editStack/renderer).

const TEX_W = 1024, TEX_H = 768; // mesmo tamanho da imagem de teste do app (aspecto não-quadrado, de propósito)

// ---------------------------------------------------------------------------
// mat3 utilitário — MESMA convenção de renderer.ts (column-major, M_novo = M_velho · F_fator; cada
// fac() novo é aplicado ANTES dos acumulados quando usado num vetor via M*v).
// ---------------------------------------------------------------------------
function newMat() {
  const m = new Float64Array(9);
  m[0] = m[4] = m[8] = 1;
  return m;
}
function fac(m, a, b, c, d, tx, ty) {
  const t = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    t[r] = m[r] * a + m[3 + r] * b;
    t[3 + r] = m[r] * c + m[3 + r] * d;
    t[6 + r] = m[r] * tx + m[3 + r] * ty + m[6 + r];
  }
  m.set(t);
}
const translate = (m, tx, ty) => fac(m, 1, 0, 0, 1, tx, ty);
const scale = (m, sx, sy) => fac(m, sx, 0, 0, sy, 0, 0);
const rotate = (m, rad) => {
  const c = Math.cos(rad), s = Math.sin(rad);
  fac(m, c, s, -s, c, 0, 0);
};
// aplica m (mat3 column-major) a um vec3 (x,y,1), retorna [x',y'] (equivalente a `(m * vec3(x,y,1)).xy` no GLSL)
function applyMat(m, x, y) {
  return [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]];
}

// ---------------------------------------------------------------------------
// computeUvMatrix — cópia fiel de src/engine/renderer.ts (mesma ordem de fac(): Ytex, flips, rot90,
// straighten, crop). Retorna a matriz M_OUT tal que vUv = M_OUT * vec3(v, 1), v = UV de saída (y-up,
// como no vertex shader: v = (aPos+1)*0.5).
// ---------------------------------------------------------------------------
function computeUvMatrix(g, texW, texH) {
  const m = newMat();
  translate(m, 0.5, 0.5); scale(m, 1, -1); translate(m, -0.5, -0.5); // Ytex
  const k = g.rotate90 & 3;
  const fx = k % 2 ? g.flipV : g.flipH, fy = k % 2 ? g.flipH : g.flipV;
  if (fx || fy) { translate(m, 0.5, 0.5); scale(m, fx ? -1 : 1, fy ? -1 : 1); translate(m, -0.5, -0.5); }
  if (k) {
    const c = [1, 0, -1, 0][k], s = [0, 1, 0, -1][k];
    translate(m, 0.5, 0.5); fac(m, c, s, -s, c, 0, 0); translate(m, -0.5, -0.5);
  }
  if (g.straighten) {
    const rad = (g.straighten * Math.PI) / 180;
    const fw = k % 2 ? texH : texW, fh = k % 2 ? texW : texH;
    const ratio = Math.max(fw, fh) / Math.min(fw, fh);
    const cover = Math.cos(Math.abs(rad)) + ratio * Math.sin(Math.abs(rad));
    translate(m, 0.5, 0.5);
    scale(m, 1 / cover, 1 / cover); scale(m, 1 / fw, 1 / fh); rotate(m, -rad); scale(m, fw, fh);
    translate(m, -0.5, -0.5);
  }
  if (g.crop) {
    translate(m, g.crop.x, 1 - g.crop.y - g.crop.h);
    scale(m, g.crop.w, g.crop.h);
  }
  return m;
}

// Posição de OUTPUT (Sx,Sy — y-down/DOM, 0..1, mesma convenção do CropRect) -> posição de TEXTURA
// (Tx,Ty — y-down, fração 0..1 de texW/texH). v (y-up, shader) = (Sx, 1-Sy); vUv = M*v já sai em
// y-down de textura (renderer.ts: "a textura guarda a linha 0 no topo").
function outputToTexture(g, texW, texH, Sx, Sy) {
  const m = computeUvMatrix(g, texW, texH);
  return applyMat(m, Sx, 1 - Sy);
}

// ---------------------------------------------------------------------------
// Transforms de crop/geometria — cópia fiel de src/state/editStack.ts + a lógica de
// src/tools/BasicPanel.tsx (handleRotate90 / toggleFlip).
// ---------------------------------------------------------------------------
function rotateCropRect90(c, flipParityOdd) {
  return flipParityOdd
    ? { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }
    : { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w };
}
function mirrorCropRect(c, axis) {
  return axis === 'x' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h };
}

function applyAction(g, action) {
  if (action === 'ROTATE') {
    const flipParityOdd = g.flipH !== g.flipV;
    return {
      ...g,
      rotate90: (g.rotate90 + 1) % 4,
      crop: g.crop ? rotateCropRect90(g.crop, flipParityOdd) : null,
    };
  }
  const flipKey = action === 'FLIPH' ? 'flipH' : 'flipV';
  const axis = action === 'FLIPH' ? 'x' : 'y';
  return {
    ...g,
    [flipKey]: !g[flipKey],
    crop: g.crop ? mirrorCropRect(g.crop, axis) : null,
    // fix desta rodada (3ª review): flip e straighten não comutam (F·S(θ) = S(−θ)·F) — negar
    // straighten no MESMO dispatch do toggleFlip fecha a comutação (mirrorCropRect trata o C, a
    // negação trata o S, a paridade do rotateCropRect90 já trata o R).
    straighten: -g.straighten,
  };
}

// ---------------------------------------------------------------------------
// Fuzzer
// ---------------------------------------------------------------------------
const ACTIONS = ['ROTATE', 'FLIPH', 'FLIPV'];
const STRAIGHTEN_VALUES = [0, 7.3, -7.3, 15, -15, 33, -33, 44.9, -44.9];
// pontos amostrados do crop (fração do OUTPUT atual, y-down): 4 cantos + centro
const SAMPLE_POINTS = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]];
const MAX_LEN = 7;
const TOLERANCE_PX = 1.5; // tolerância de comparação, em px da textura (lado maior ~1024)

function* sequences(maxLen) {
  function* rec(prefix, remaining) {
    if (remaining === 0) { yield prefix; return; }
    for (const a of ACTIONS) yield* rec([...prefix, a], remaining - 1);
  }
  for (let len = 1; len <= maxLen; len++) yield* rec([], len);
}

function textureSet(g) {
  return SAMPLE_POINTS.map(([sx, sy]) => {
    const [tx, ty] = outputToTexture(g, TEX_W, TEX_H, sx, sy);
    return [tx * TEX_W, ty * TEX_H]; // em px reais da textura, pra comparar com tolerância em px
  });
}

// Compara dois conjuntos de pontos SEM ORDEM (as pontas do crop podem "trocar de canto" sob
// rotação/flip) via matching guloso do vizinho mais próximo.
function setsMatch(a, b, tol) {
  const usedB = new Array(b.length).fill(false);
  let maxDist = 0;
  for (const pa of a) {
    let bestI = -1, bestD = Infinity;
    for (let i = 0; i < b.length; i++) {
      if (usedB[i]) continue;
      const d = Math.hypot(pa[0] - b[i][0], pa[1] - b[i][1]);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI === -1) return { ok: false, maxDist: Infinity };
    usedB[bestI] = true;
    maxDist = Math.max(maxDist, bestD);
  }
  return { ok: maxDist <= tol, maxDist };
}

// crop inicial propositalmente "feio": não-quadrado, não-centrado (expõe assimetrias que um crop
// central/quadrado mascararia).
const INITIAL_CROP = { x: 0.12, y: 0.2, w: 0.5, h: 0.33 };

function main() {
  let total = 0;
  const failures = [];
  for (const straighten0 of STRAIGHTEN_VALUES) {
    for (const seq of sequences(MAX_LEN)) {
      total++;
      let g = { rotate90: 0, flipH: false, flipV: false, straighten: straighten0, crop: { ...INITIAL_CROP } };
      const reference = textureSet(g);
      let failedAt = -1, failedDist = 0;
      for (let i = 0; i < seq.length; i++) {
        g = applyAction(g, seq[i]);
        const current = textureSet(g);
        const { ok, maxDist } = setsMatch(reference, current, TOLERANCE_PX);
        if (!ok) { failedAt = i; failedDist = maxDist; break; }
      }
      if (failedAt >= 0) failures.push({ straighten0, seq: seq.slice(0, failedAt + 1), maxDist: failedDist });
    }
  }

  console.log(`Fuzz de geometria: ${total} sequências testadas (comprimento 1..${MAX_LEN} × ${STRAIGHTEN_VALUES.length} straighten iniciais).`);
  if (failures.length > 0) {
    console.error(`FALHOU: ${failures.length}/${total} sequências com desvio > ${TOLERANCE_PX}px.`);
    for (const f of failures.slice(0, 20)) {
      console.error(`  straighten0=${f.straighten0}  seq=[${f.seq.join(',')}]  desvio=${f.maxDist.toFixed(1)}px`);
    }
    if (failures.length > 20) console.error(`  ... e mais ${failures.length - 20} falha(s)`);
    process.exit(1);
  }
  console.log('OK: 0 falhas — crop+rotate90+flip+straighten preservam o conjunto de pixels amostrados em TODAS as sequências testadas.');
  process.exit(0);
}

main();
