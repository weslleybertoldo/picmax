// src/engine/renderer.ts — renderer WebGL1: quad fullscreen + geometria via uUvMat + ajustes/filtro no fragment
import type { EditSnapshot, Geometry } from '../state/editStack';
import { resolveFilter, type FilterDef } from './filters';
import type { IgLayer, IgOp } from './igFilters';
import { FRAG, VERT } from './shaders';

export interface RendererOpts { maxSide?: number }

/**
 * Contrato:
 * - crop: frações do frame pós-rot90, origem no canto superior ESQUERDO (y cresce pra baixo, como DOM/anotações)
 * - flipH/flipV: eixos de TELA (flipH sempre espelha horizontalmente o que se vê, mesmo com rot90 ímpar)
 * - straighten: graus, positivo = anti-horário na tela; zoom-in interno — NÃO muda frameSize
 * - snapshot.geometry.resizeMaxSide NÃO é aplicado aqui; o export (Task 8) mapeia ele pra opts.maxSide
 * - frameSize antes de setImage retorna {w:1,h:1} — cheque hasImage
 */
export interface Renderer {
  setImage(bitmap: ImageBitmap): void;
  render(snapshot: EditSnapshot): void;
  frameSize(snapshot: EditSnapshot): { w: number; h: number };
  hasImage: boolean;
  limits: { maxTextureSize: number };
  // loseContext default false: um canvas com contexto perdido não pode ser reaproveitado
  // (React StrictMode roda setup→cleanup→setup no MESMO elemento em dev). Passe true só em
  // renderer offscreen descartável (ex.: thumbnails da T5), onde o canvas nunca é reusado.
  destroy(opts?: { loseContext?: boolean }): void;
}

// --- mat3 column-major (layout do uniformMatrix3fv), zero alocação por frame ---
// seguro só porque render() é síncrono: nenhuma outra chamada pode reentrar e ler M_OUT/M_TMP
// no meio de uma composição (sem await, sem callback assíncrono entre loadIdentity() e o uso final).
type Mat3 = Float32Array;
const M_OUT: Mat3 = new Float32Array(9); // resultado final reutilizado (vai direto pro uniformMatrix3fv)
const M_TMP: Mat3 = new Float32Array(9);
function loadIdentity() { M_OUT.fill(0); M_OUT[0] = M_OUT[4] = M_OUT[8] = 1; }
// M_OUT = M_OUT · [a c tx; b d ty; 0 0 1] — anexa um fator à direita (aplicado ANTES dos acumulados)
function fac(a: number, b: number, c: number, d: number, tx: number, ty: number) {
  for (let r = 0; r < 3; r++) {
    M_TMP[r] = M_OUT[r] * a + M_OUT[3 + r] * b;
    M_TMP[3 + r] = M_OUT[r] * c + M_OUT[3 + r] * d;
    M_TMP[6 + r] = M_OUT[r] * tx + M_OUT[3 + r] * ty + M_OUT[6 + r];
  }
  M_OUT.set(M_TMP);
}
const translate = (tx: number, ty: number) => fac(1, 0, 0, 1, tx, ty);
const scale = (sx: number, sy: number) => fac(sx, 0, 0, sy, 0, 0);
const rotate = (rad: number) => { const c = Math.cos(rad), s = Math.sin(rad); fac(c, s, -s, c, 0, 0); };

// uv_tex = Ytex( flips( rot90( straighten( crop(uv_screen) ) ) ) ) — resultado escrito em M_OUT.
// Ytex: a textura guarda a linha 0 no topo (UNPACK_FLIP_Y_WEBGL é IGNORADO p/ ImageBitmap, por spec);
// o flip final converte o espaço y-up da composição pro layout real da textura.
// Retorna a escala de cobertura do straighten (>= 1), usada na paridade de nitidez preview/export.
function computeUvMatrix(g: Geometry, texW: number, texH: number): number {
  loadIdentity();
  translate(0.5, 0.5); scale(1, -1); translate(-0.5, -0.5); // Ytex
  const k = g.rotate90 & 3;
  // flips em eixos de TELA: com rot90 ímpar, flip horizontal de tela = flip vertical de textura
  const fx = k % 2 ? g.flipV : g.flipH, fy = k % 2 ? g.flipH : g.flipV;
  if (fx || fy) { translate(0.5, 0.5); scale(fx ? -1 : 1, fy ? -1 : 1); translate(-0.5, -0.5); }
  if (k) { // k·90° exatos (sem ruído de FP de cos/sin)
    const c = [1, 0, -1, 0][k], s = [0, 1, 0, -1][k];
    translate(0.5, 0.5); fac(c, s, -s, c, 0, 0); translate(-0.5, -0.5);
  }
  let cover = 1;
  if (g.straighten) {
    // rotação de -θ em espaço de PIXEL do frame pós-rot90 (senão distorce em imagem não-quadrada),
    // com cobertura: UV encolhe 1/cover → zoom-in na imagem, sem mostrar borda
    const rad = (g.straighten * Math.PI) / 180;
    const fw = k % 2 ? texH : texW, fh = k % 2 ? texW : texH;
    const ratio = Math.max(fw, fh) / Math.min(fw, fh);
    cover = Math.cos(Math.abs(rad)) + ratio * Math.sin(Math.abs(rad));
    translate(0.5, 0.5);
    scale(1 / cover, 1 / cover); scale(1 / fw, 1 / fh); rotate(-rad); scale(fw, fh);
    translate(-0.5, -0.5);
  }
  if (g.crop) { // crop y-down (origem no topo, como DOM) → converte pro espaço UV y-up da composição
    translate(g.crop.x, 1 - g.crop.y - g.crop.h);
    scale(g.crop.w, g.crop.h);
  }
  return cover;
}

// arredonda o lado maior e deriva o outro do aspecto (evita 1512x1511 em crop 1:1)
// exportada (v1.1): o modal de resolução do export (Editor.tsx) usa o MESMO arredondamento pra
// exibir as dimensões reais de saída de cada opção.
export function roundKeepingAspect(w: number, h: number): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 1, h: 1 };
  if (w >= h) { const rw = Math.max(1, Math.round(w)); return { w: rw, h: Math.max(1, Math.round((rw * h) / w)) }; }
  const rh = Math.max(1, Math.round(h)); return { w: Math.max(1, Math.round((rh * w) / h)), h: rh };
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader falhou');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? 'sem log';
    gl.deleteShader(sh);
    throw new Error(`Shader não compilou: ${log}`);
  }
  return sh;
}

const NEUTRAL: FilterDef = { id: '', name: 'Neutro', gray: 0, sat: 1, con: 0, gamma: [1, 1, 1], gain: [1, 1, 1], lift: [0, 0, 0] };

// ---- filtros Instagram (v1.1): mapeamentos JS → uniforms do shader (ver igFilters.ts/shaders.ts) ----
const IG_BLEND_NUM: Record<string, number> = {
  multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5,
  'color-dodge': 6, 'color-burn': 7, 'soft-light': 8, exclusion: 9,
};
const IG_OP_NUM: Record<IgOp['kind'], number> = {
  sepia: 1, saturate: 2, contrast: 3, brightness: 4, 'hue-rotate': 5, grayscale: 6,
};

export function createRenderer(canvas: HTMLCanvasElement, opts: RendererOpts = {}): Renderer {
  const maxSide = opts.maxSide ?? 2048;
  let gl: WebGLRenderingContext | null = canvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL não disponível neste dispositivo');
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
  let fs: WebGLShader;
  try {
    fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
  } catch (e) {
    gl.deleteShader(vs);
    throw e;
  }
  let prog: WebGLProgram | null = gl.createProgram();
  if (!prog) { gl.deleteShader(vs); gl.deleteShader(fs); throw new Error('createProgram falhou'); }
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? 'sem log';
    gl.deleteProgram(prog);
    throw new Error(`Programa não linkou: ${log}`);
  }
  gl.useProgram(prog);

  // quad fullscreen: 2 triângulos em clip space
  let quad: WebGLBuffer | null = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string) => gl!.getUniformLocation(prog!, name);
  const loc = {
    uvMat: u('uUvMat'), image: u('uImage'), texel: u('uTexel'),
    brightness: u('uBrightness'), contrast: u('uContrast'), saturation: u('uSaturation'),
    exposure: u('uExposure'), temperature: u('uTemperature'), shadows: u('uShadows'),
    highlights: u('uHighlights'), sharpness: u('uSharpness'), vignette: u('uVignette'),
    fGray: u('uFGray'), fSat: u('uFSat'), fCon: u('uFCon'), fIntensity: u('uFIntensity'),
    fGammaInv: u('uFGammaInv'), fGain: u('uFGain'), fLift: u('uFLift'),
    igActive: u('uIgActive'), igOpKind: u('uIgOpKind'), igOpAmt: u('uIgOpAmt'),
    clarity: u('uClarity'), clarityRad: u('uClarityRad'),
    motionOn: u('uMotionOn'), motionStep: u('uMotionStep'),
    echoAmt: u('uEchoAmt'), echoOff: u('uEchoOff'), echoStep: u('uEchoStep'),
    softAmount: u('uSoftAmount'), softRad: u('uSoftRad'),
  };
  // locations das 2 camadas IG (mesma ordem de uniforms pra cada uma)
  const igLayerLoc = [0, 1].map((i) => ({
    meta: u(`uIgL${i}Meta`), geo: u(`uIgL${i}Geo`), stops: u(`uIgL${i}Stops`),
    c0: u(`uIgL${i}C0`), c1: u(`uIgL${i}C1`), c2: u(`uIgL${i}C2`),
  }));

  // Cores dos stops PREMULTIPLICADAS (rgb*a, a) — o shader interpola premultiplicado como o CSS.
  function premult(c: [number, number, number, number]): [number, number, number, number] {
    return [(c[0] / 255) * c[3], (c[1] / 255) * c[3], (c[2] / 255) * c[3], c[3]];
  }

  // Uniforms de UMA camada IG. cw/ch = px do canvas (proporcional ao frame): usados pra converter o
  // raio farthest-corner do radial (px) pra fração no espaço uv-css do shader.
  function setIgLayer(i: number, layer: IgLayer | null, cw: number, ch: number) {
    const L = igLayerLoc[i];
    if (!gl) return;
    if (!layer) {
      gl.uniform4f(L.meta, 0, 0, 0, 0);
      return;
    }
    const blend = IG_BLEND_NUM[layer.blend];
    const opacity = layer.opacity ?? 1;
    if (layer.kind === 'solid') {
      gl.uniform4f(L.meta, 1, blend, opacity, 0);
      gl.uniform4f(L.geo, 0, 0, 0, 0);
      gl.uniform4f(L.stops, 0, 1, 0, 2);
      const c = premult(layer.color);
      gl.uniform4fv(L.c0, c);
      gl.uniform4fv(L.c1, c);
      gl.uniform4f(L.c2, 0, 0, 0, 0);
      return;
    }
    const stops = layer.stops;
    const s0 = stops[0], s1 = stops[1], s2 = stops[2] ?? stops[1];
    gl.uniform4f(L.stops, s0.pos, s1.pos, s2.pos, stops.length);
    gl.uniform4fv(L.c0, premult(s0.color));
    gl.uniform4fv(L.c1, premult(s1.color));
    gl.uniform4fv(L.c2, premult(s2.color));
    if (layer.kind === 'linear') {
      gl.uniform4f(L.meta, 2, blend, opacity, 0);
      gl.uniform4f(L.geo, layer.from[0], layer.from[1], layer.to[0] - layer.from[0], layer.to[1] - layer.from[1]);
    } else {
      // radial `circle` (CSS): raio = distância do centro ao canto MAIS DISTANTE, em px do frame
      const [cx, cy] = layer.center;
      const dx = Math.max(cx, 1 - cx) * cw;
      const dy = Math.max(cy, 1 - cy) * ch;
      const r = Math.max(1e-6, Math.hypot(dx, dy));
      gl.uniform4f(L.meta, 3, blend, opacity, 0);
      gl.uniform4f(L.geo, cx, cy, cw / r, ch / r);
    }
  }

  let tex: WebGLTexture | null = null;
  let texW = 0, texH = 0;

  function frameSize(s: EditSnapshot): { w: number; h: number } {
    if (!texW || !texH) return { w: 1, h: 1 };
    const k = s.geometry.rotate90 & 3;
    let w = k % 2 ? texH : texW, h = k % 2 ? texW : texH;
    if (s.geometry.crop) { w *= s.geometry.crop.w; h *= s.geometry.crop.h; }
    return roundKeepingAspect(w, h);
  }

  return {
    get hasImage() { return tex !== null; },
    limits: { maxTextureSize },

    setImage(bitmap: ImageBitmap) {
      if (!gl) return;
      if (bitmap.width > maxTextureSize || bitmap.height > maxTextureSize)
        throw new Error(`Imagem ${bitmap.width}x${bitmap.height} excede o limite da GPU (MAX_TEXTURE_SIZE=${maxTextureSize}) — reduza antes de enviar`);
      if (tex) gl.deleteTexture(tex);
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // UNPACK_FLIP_Y_WEBGL é ignorado p/ ImageBitmap (spec); o flip y-up é assado no uUvMat
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      texW = bitmap.width; texH = bitmap.height;
    },

    render(snapshot: EditSnapshot) {
      if (!gl || !prog || !tex) return;
      const { w: fw, h: fh } = frameSize(snapshot);
      const fit = Math.min(1, maxSide / Math.max(fw, fh));
      const { w: cw, h: ch } = roundKeepingAspect(fw * fit, fh * fit);
      if (canvas.width !== cw) canvas.width = cw;   // só redimensiona se mudou (evita flicker)
      if (canvas.height !== ch) canvas.height = ch;
      gl.viewport(0, 0, cw, ch);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc.image, 0);

      const cover = computeUvMatrix(snapshot.geometry, texW, texH);
      gl.uniformMatrix3fv(loc.uvMat, false, M_OUT);
      // px da fonte por px de saída: mantém o raio do sharpen igual no preview e no export
      const texelScale = Math.max(1, 1 / (cover * fit));
      gl.uniform2f(loc.texel, texelScale / texW, texelScale / texH);

      const resolved = snapshot.filter ? resolveFilter(snapshot.filter.id) : null;
      const intensity = resolved && snapshot.filter ? snapshot.filter.intensity / 100 : 0;

      const a = snapshot.adjustments;
      gl.uniform1f(loc.brightness, (a.brightness / 100) * 0.35);
      gl.uniform1f(loc.contrast, (a.contrast / 100) * 0.6);
      gl.uniform1f(loc.saturation, a.saturation / 100);
      gl.uniform1f(loc.exposure, a.exposure / 100);
      gl.uniform1f(loc.temperature, a.temperature / 100);
      gl.uniform1f(loc.shadows, a.shadows / 100);
      gl.uniform1f(loc.highlights, a.highlights / 100);
      // sharpen do FILTRO (v1.1, ex.: Dark Sharp): somado ao do usuário no mesmo pass, escalado pela
      // intensidade do filtro (o mix de uFIntensity não cobre o sharpen — ele roda ANTES do adjust()).
      const filterSharpen = (resolved?.def.sharpen ?? 0) * intensity;
      gl.uniform1f(loc.sharpness, a.sharpness / 100 + filterSharpen);
      // clarity do filtro (v1.1, só IG/Dark Sharp): raio = fração da LARGURA da textura, com o eixo
      // v compensado pelo aspecto pra ficar circular em px. Escalado pela intensidade como o sharpen;
      // uniform 0 = os 12 taps extras nem rodam (branch uniforme no shader).
      const igDef = resolved?.kind === 'ig' ? resolved.def : null;
      const clarity = (igDef?.clarity ?? 0) * intensity;
      gl.uniform1f(loc.clarity, clarity);
      const clarityRad = igDef?.clarityRadius ?? 0.025;
      gl.uniform2f(loc.clarityRad, clarityRad, (clarityRad * texW) / texH);
      // blurs de base (v1.1 r3): comprimentos/raios como fração da LARGURA da textura, eixo v
      // compensado pelo aspecto (circular/isotrópico em px); escalados pela intensidade do filtro.
      const motion = igDef?.motionBlur;
      const motionLen = (motion?.length ?? 0) * intensity;
      gl.uniform1f(loc.motionOn, motionLen > 0 ? 1 : 0);
      if (motion && motionLen > 0) {
        const rad = (motion.angle * Math.PI) / 180;
        const dirX = Math.cos(rad), dirY = Math.sin(rad);
        const stepPx = (motionLen * texW) / 15; // 16 taps → 15 intervalos cobrindo o comprimento total
        gl.uniform2f(loc.motionStep, (dirX * stepPx) / texW, (dirY * stepPx) / texH);
        // eco (r4): cluster de 8 taps deslocado ao longo do MESMO eixo; espacial × intensidade,
        // amount × intensidade (intensidade → 0 apaga o fantasma junto com o resto do look)
        const echo = motion.echo;
        const echoAmt = (echo?.amount ?? 0) * intensity;
        gl.uniform1f(loc.echoAmt, echoAmt);
        if (echo && echoAmt > 0) {
          const offPx = echo.offset * intensity * texW;
          const eStepPx = (echo.length * intensity * texW) / 7; // 8 taps → 7 intervalos
          gl.uniform2f(loc.echoOff, (dirX * offPx) / texW, (dirY * offPx) / texH);
          gl.uniform2f(loc.echoStep, (dirX * eStepPx) / texW, (dirY * eStepPx) / texH);
        } else {
          gl.uniform2f(loc.echoOff, 0, 0);
          gl.uniform2f(loc.echoStep, 0, 0);
        }
      } else {
        gl.uniform2f(loc.motionStep, 0, 0);
        gl.uniform1f(loc.echoAmt, 0);
        gl.uniform2f(loc.echoOff, 0, 0);
        gl.uniform2f(loc.echoStep, 0, 0);
      }
      const soft = igDef?.softBlur;
      gl.uniform1f(loc.softAmount, (soft?.amount ?? 0) * intensity);
      const softRad = soft?.radius ?? 0.01;
      gl.uniform2f(loc.softRad, softRad, (softRad * texW) / texH);
      gl.uniform1f(loc.vignette, (a.vignette / 100) * 0.8);

      gl.uniform1f(loc.fIntensity, intensity);
      const f = resolved?.kind === 'classic' ? resolved.def : NEUTRAL;
      gl.uniform1f(loc.fGray, f.gray);
      gl.uniform1f(loc.fSat, f.sat);
      gl.uniform1f(loc.fCon, f.con);
      gl.uniform3f(loc.fGammaInv, // 1/gamma pré-computado com guarda (shader recebe já invertido)
        1 / Math.max(1e-3, f.gamma[0]), 1 / Math.max(1e-3, f.gamma[1]), 1 / Math.max(1e-3, f.gamma[2]));
      gl.uniform3fv(loc.fGain, f.gain);
      gl.uniform3fv(loc.fLift, f.lift);

      // caminho Instagram (v1.1): ops + camadas só quando um filtro IG está ativo
      if (resolved?.kind === 'ig') {
        const ig = resolved.def;
        gl.uniform1f(loc.igActive, 1);
        const kinds = [0, 0, 0, 0], amts = [0, 0, 0, 0];
        ig.ops.slice(0, 4).forEach((o, i) => {
          kinds[i] = IG_OP_NUM[o.kind];
          amts[i] = o.kind === 'hue-rotate' ? (o.amount * Math.PI) / 180 : o.amount;
        });
        gl.uniform4fv(loc.igOpKind, kinds);
        gl.uniform4fv(loc.igOpAmt, amts);
        setIgLayer(0, ig.layers[0] ?? null, cw, ch);
        setIgLayer(1, ig.layers[1] ?? null, cw, ch);
      } else {
        gl.uniform1f(loc.igActive, 0);
      }

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    frameSize,

    destroy(opts?: { loseContext?: boolean }) {
      if (!gl) return;
      if (tex) gl.deleteTexture(tex);
      if (quad) gl.deleteBuffer(quad);
      if (prog) gl.deleteProgram(prog);
      if (opts?.loseContext) gl.getExtension('WEBGL_lose_context')?.loseContext();
      tex = null; quad = null; prog = null; gl = null;
    },
  };
}
