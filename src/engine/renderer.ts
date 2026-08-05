// src/engine/renderer.ts — renderer WebGL1: quad fullscreen + geometria via uUvMat + ajustes/filtro no fragment
import type { EditSnapshot, Geometry } from '../state/editStack';
import { filterById } from './filters';
import { FRAG, VERT } from './shaders';

export interface RendererOpts { maxSide?: number }
export interface Renderer {
  setImage(bitmap: ImageBitmap): void;
  render(snapshot: EditSnapshot): void;
  frameSize(snapshot: EditSnapshot): { w: number; h: number };
  destroy(): void;
}

// --- helpers mat3 (column-major: m[col*3+row], pronto pro uniformMatrix3fv) ---
type Mat3 = number[];
function mul(a: Mat3, b: Mat3): Mat3 { // a·b (aplica b primeiro em vetores-coluna)
  const o = new Array<number>(9);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++)
    o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
  return o;
}
const translate = (tx: number, ty: number): Mat3 => [1, 0, 0, 0, 1, 0, tx, ty, 1];
const scale = (sx: number, sy: number): Mat3 => [sx, 0, 0, 0, sy, 0, 0, 0, 1];
const rotate = (rad: number): Mat3 => {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
};
const aroundCenter = (m: Mat3): Mat3 => mul(mul(translate(0.5, 0.5), m), translate(-0.5, -0.5));

// uv_tex = flips( rot90( straighten( crop(uv_screen) ) ) )  →  M = Ytex · F · R90 · S · C
// Ytex: a textura é armazenada com a linha 0 no topo (UNPACK_FLIP_Y_WEBGL é IGNORADO para
// ImageBitmap, por spec) — o flip final converte o espaço UV y-up pro layout real da textura.
function uvMatrix(g: Geometry, texW: number, texH: number): Mat3 {
  let m = aroundCenter(scale(1, -1));
  if (g.flipH || g.flipV) m = mul(m, aroundCenter(scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1)));
  const k = g.rotate90 & 3;
  if (k) { // rotação exata de k·90° em UV ao redor do centro (sem ruído de FP)
    const c = [1, 0, -1, 0][k], s = [0, 1, 0, -1][k];
    m = mul(m, aroundCenter([c, s, 0, -s, c, 0, 0, 0, 1]));
  }
  if (g.straighten) {
    // rotação de -θ em espaço de PIXEL do frame pós-rot90 (senão distorce em imagem não-quadrada),
    // com escala de cobertura: UV encolhe 1/s → zoom-in na imagem, sem mostrar borda
    const rad = (g.straighten * Math.PI) / 180;
    const fw = k % 2 ? texH : texW, fh = k % 2 ? texW : texH;
    const ratio = Math.max(fw, fh) / Math.min(fw, fh);
    const cover = Math.cos(Math.abs(rad)) + ratio * Math.sin(Math.abs(rad));
    let lin = mul(scale(1 / fw, 1 / fh), mul(rotate(-rad), scale(fw, fh)));
    lin = mul(scale(1 / cover, 1 / cover), lin);
    m = mul(m, aroundCenter(lin));
  }
  if (g.crop) m = mul(m, mul(translate(g.crop.x, g.crop.y), scale(g.crop.w, g.crop.h)));
  return m;
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader falhou');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error(`Shader não compilou: ${gl.getShaderInfoLog(sh) ?? 'sem log'}`);
  return sh;
}

const NEUTRAL = { gray: 0, sat: 1, con: 0, gamma: [1, 1, 1], gain: [1, 1, 1], lift: [0, 0, 0] };

export function createRenderer(canvas: HTMLCanvasElement, opts: RendererOpts = {}): Renderer {
  const maxSide = opts.maxSide ?? 2048;
  let gl: WebGLRenderingContext | null = canvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL não disponível neste dispositivo');

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
  let prog: WebGLProgram | null = gl.createProgram();
  if (!prog) throw new Error('createProgram falhou');
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`Programa não linkou: ${gl.getProgramInfoLog(prog) ?? 'sem log'}`);
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
    fGamma: u('uFGamma'), fGain: u('uFGain'), fLift: u('uFLift'),
  };

  let tex: WebGLTexture | null = null;
  let texW = 0, texH = 0;

  function frameSize(s: EditSnapshot): { w: number; h: number } {
    const k = s.geometry.rotate90 & 3;
    let w = k % 2 ? texH : texW, h = k % 2 ? texW : texH;
    if (s.geometry.crop) { w *= s.geometry.crop.w; h *= s.geometry.crop.h; }
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  return {
    setImage(bitmap: ImageBitmap) {
      if (!gl) return;
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
      const cw = Math.max(1, Math.round(fw * fit)), ch = Math.max(1, Math.round(fh * fit));
      if (canvas.width !== cw) canvas.width = cw;   // só redimensiona se mudou (evita flicker)
      if (canvas.height !== ch) canvas.height = ch;
      gl.viewport(0, 0, cw, ch);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc.image, 0);
      gl.uniform2f(loc.texel, 1 / texW, 1 / texH);
      gl.uniformMatrix3fv(loc.uvMat, false, uvMatrix(snapshot.geometry, texW, texH));

      const a = snapshot.adjustments;
      gl.uniform1f(loc.brightness, (a.brightness / 100) * 0.35);
      gl.uniform1f(loc.contrast, (a.contrast / 100) * 0.6);
      gl.uniform1f(loc.saturation, a.saturation / 100);
      gl.uniform1f(loc.exposure, a.exposure / 100);
      gl.uniform1f(loc.temperature, a.temperature / 100);
      gl.uniform1f(loc.shadows, a.shadows / 100);
      gl.uniform1f(loc.highlights, a.highlights / 100);
      gl.uniform1f(loc.sharpness, a.sharpness / 100);
      gl.uniform1f(loc.vignette, (a.vignette / 100) * 0.8);

      const def = snapshot.filter ? filterById(snapshot.filter.id) : null;
      const f = def ?? NEUTRAL;
      gl.uniform1f(loc.fIntensity, def && snapshot.filter ? snapshot.filter.intensity / 100 : 0);
      gl.uniform1f(loc.fGray, f.gray);
      gl.uniform1f(loc.fSat, f.sat);
      gl.uniform1f(loc.fCon, f.con);
      gl.uniform3fv(loc.fGamma, f.gamma);
      gl.uniform3fv(loc.fGain, f.gain);
      gl.uniform3fv(loc.fLift, f.lift);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    frameSize,

    destroy() {
      if (!gl) return;
      if (tex) gl.deleteTexture(tex);
      if (quad) gl.deleteBuffer(quad);
      if (prog) gl.deleteProgram(prog);
      tex = null; quad = null; prog = null; gl = null;
    },
  };
}
