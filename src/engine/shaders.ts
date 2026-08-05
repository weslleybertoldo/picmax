// src/engine/shaders.ts
export const VERT = `
attribute vec2 aPos; varying vec2 vUv; varying vec2 vFrameUv;
uniform mat3 uUvMat; // geometria: rot90/flip/straighten/crop no espaço UV
void main() {
  vFrameUv = (aPos + 1.0) * 0.5; // UV do FRAME final (pós-geometria) — vinheta segue o frame, não a textura
  vUv = (uUvMat * vec3(vFrameUv, 1.0)).xy;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv; varying vec2 vFrameUv;
uniform sampler2D uImage; uniform vec2 uTexel;
uniform float uBrightness, uContrast, uSaturation, uExposure, uTemperature, uShadows, uHighlights, uSharpness, uVignette;
uniform float uFGray, uFSat, uFCon, uFIntensity; uniform vec3 uFGammaInv, uFGain, uFLift;
// ---- filtros Instagram (v1.1, CSSgram — ver igFilters.ts) ----
// uIgActive: 1.0 = o filtro ativo é do caminho IG (camadas + ops CSS) em vez do grade().
// ops: até 4, em ordem — kind 0=nada 1=sepia 2=saturate 3=contrast 4=brightness 5=hue-rotate(rad) 6=grayscale.
// camadas: até 2 — meta=(kind 0/1=solid 2=linear 3=radial, blend 1..9, opacity, -);
//   geo: linear=(p0.xy, dir.xy em uv-css) | radial=(centro.xy, W/R, H/R) com R = raio farthest-corner em px;
//   stops=(pos0, pos1, pos2, nStops); cores PREMULTIPLICADAS (rgb*a, a) — CSS interpola premultiplicado.
uniform float uIgActive;
uniform vec4 uIgOpKind, uIgOpAmt;
uniform vec4 uIgL0Meta, uIgL0Geo, uIgL0Stops, uIgL0C0, uIgL0C1, uIgL0C2;
uniform vec4 uIgL1Meta, uIgL1Geo, uIgL1Stops, uIgL1C0, uIgL1C1, uIgL1C2;
// clarity (contraste local de raio largo, v1.1 — Dark Sharp): 0 = desligado (nenhum tap extra).
// uClarityRad = raio do anel de blur em UV (x, y pré-escalado no JS pra ficar circular em px).
uniform float uClarity;
uniform vec2 uClarityRad;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 adjust(vec3 c) {
  c *= pow(2.0, uExposure); c += uBrightness;
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;
  c.r += uTemperature * 0.08; c.b -= uTemperature * 0.08;
  float l = luma(c); c = mix(vec3(l), c, 1.0 + uSaturation);
  c += uShadows * 0.25 * (1.0 - smoothstep(0.0, 0.5, l));
  c += uHighlights * 0.25 * smoothstep(0.5, 1.0, l);
  return c;
}
vec3 grade(vec3 c) { // filtro genérico parametrizado
  float l = luma(c);
  c = mix(c, vec3(l), uFGray);
  c = mix(vec3(luma(c)), c, uFSat);
  c = (c - 0.5) * (1.0 + uFCon) + 0.5;
  c = pow(max(c, vec3(0.001)), uFGammaInv); // 1/gamma pré-computado no JS (clamp final já limita o topo)
  c = c * uFGain + uFLift * (1.0 - l);
  return c;
}
// ---- primitivas dos filtros Instagram (fórmulas W3C — ver igFilters.ts) ----
// blend modes separáveis do spec de compositing (b = backdrop/imagem, s = cor da camada):
vec3 igBlend(vec3 b, vec3 s, float mode) {
  if (mode < 1.5) return b * s;                                          // multiply
  if (mode < 2.5) return b + s - b * s;                                  // screen
  if (mode < 3.5) {                                                      // overlay = hard-light(s,b)
    vec3 lo = 2.0 * b * s;
    vec3 hi = 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
    return mix(lo, hi, step(0.5, b));
  }
  if (mode < 4.5) return min(b, s);                                      // darken
  if (mode < 5.5) return max(b, s);                                      // lighten
  if (mode < 6.5) return min(vec3(1.0), b / max(1.0 - s, vec3(1e-4)));   // color-dodge (b=0→0, s=1→1)
  if (mode < 7.5) return 1.0 - min(vec3(1.0), (1.0 - b) / max(s, vec3(1e-4))); // color-burn (b=1→1, s=0→0)
  if (mode < 8.5) {                                                      // soft-light (W3C, com D(x))
    vec3 d = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), step(0.25, b));
    vec3 lo = b - (1.0 - 2.0 * s) * b * (1.0 - b);
    vec3 hi = b + (2.0 * s - 1.0) * (d - b);
    return mix(lo, hi, step(0.5, s));
  }
  return b + s - 2.0 * b * s;                                            // exclusion
}
// cor da camada em (uv de css: y pra baixo): resolve o t do gradiente, interpola os stops em
// PREMULTIPLICADO (como o CSS) e devolve (cor não-premultiplicada, alpha efetivo com a opacity).
vec3 igLayer(vec3 b, vec4 meta, vec4 geo, vec4 stops, vec4 c0, vec4 c1, vec4 c2, vec2 uv) {
  if (meta.x < 0.5) return b; // sem camada
  float t = 0.0;
  if (meta.x > 2.5) {         // radial: distância ao centro em fração do raio farthest-corner
    t = length((uv - geo.xy) * geo.zw);
  } else if (meta.x > 1.5) {  // linear: projeção normalizada sobre a direção
    t = dot(uv - geo.xy, geo.zw) / max(dot(geo.zw, geo.zw), 1e-6);
  }
  vec4 pm;
  if (stops.w > 2.5) {
    pm = t <= stops.y
      ? mix(c0, c1, clamp((t - stops.x) / max(stops.y - stops.x, 1e-6), 0.0, 1.0))
      : mix(c1, c2, clamp((t - stops.y) / max(stops.z - stops.y, 1e-6), 0.0, 1.0));
  } else {
    pm = mix(c0, c1, clamp((t - stops.x) / max(stops.y - stops.x, 1e-6), 0.0, 1.0));
  }
  vec3 s = pm.rgb / max(pm.a, 1e-4); // desfaz o premultiply pro blend
  float alpha = pm.a * meta.z;
  // composição W3C com backdrop opaco: resultado = mix(b, B(b,s), alpha_da_camada)
  return mix(b, igBlend(b, s, meta.y), alpha);
}
// uma função de filtro CSS (clamp entre primitivas, como o spec de SVG filters)
vec3 igOp(vec3 c, float kind, float amt) {
  if (kind < 0.5) return c;
  if (kind < 1.5) {        // sepia(amt): mix identidade → matriz sépia W3C
    vec3 s = vec3(dot(c, vec3(0.393, 0.769, 0.189)),
                  dot(c, vec3(0.349, 0.686, 0.168)),
                  dot(c, vec3(0.272, 0.534, 0.131)));
    c = mix(c, s, amt);
  } else if (kind < 2.5) { // saturate(amt) — equivale à matriz W3C (luma Rec.709)
    float l = dot(c, vec3(0.213, 0.715, 0.072));
    c = vec3(l) + (c - vec3(l)) * amt;
  } else if (kind < 3.5) { // contrast(amt)
    c = (c - 0.5) * amt + 0.5;
  } else if (kind < 4.5) { // brightness(amt)
    c = c * amt;
  } else if (kind < 5.5) { // hue-rotate(amt em rad) — matriz W3C (colunas = canais de entrada)
    float cs = cos(amt), sn = sin(amt);
    mat3 m = mat3(
      0.213 + cs * 0.787 - sn * 0.213, 0.213 - cs * 0.213 + sn * 0.143, 0.213 - cs * 0.213 - sn * 0.787,
      0.715 - cs * 0.715 - sn * 0.715, 0.715 + cs * 0.285 + sn * 0.140, 0.715 - cs * 0.715 + sn * 0.715,
      0.072 - cs * 0.072 + sn * 0.928, 0.072 - cs * 0.072 - sn * 0.283, 0.072 + cs * 0.928 + sn * 0.072);
    c = m * c;
  } else {                 // grayscale(amt) = saturate(1-amt)
    float l = dot(c, vec3(0.213, 0.715, 0.072));
    c = vec3(l) + (c - vec3(l)) * (1.0 - amt);
  }
  return clamp(c, 0.0, 1.0);
}
// pipeline IG completo: camadas primeiro (é o que o navegador faz — o filter aplica no GRUPO já
// composto com os pseudo-elementos), depois as ops em ordem.
vec3 igApply(vec3 c) {
  vec2 uv = vec2(vFrameUv.x, 1.0 - vFrameUv.y); // espaço CSS: y cresce pra baixo
  c = clamp(c, 0.0, 1.0);
  c = igLayer(c, uIgL0Meta, uIgL0Geo, uIgL0Stops, uIgL0C0, uIgL0C1, uIgL0C2, uv);
  c = igLayer(c, uIgL1Meta, uIgL1Geo, uIgL1Stops, uIgL1C0, uIgL1C1, uIgL1C2, uv);
  c = igOp(c, uIgOpKind.x, uIgOpAmt.x);
  c = igOp(c, uIgOpKind.y, uIgOpAmt.y);
  c = igOp(c, uIgOpKind.z, uIgOpAmt.z);
  c = igOp(c, uIgOpKind.w, uIgOpAmt.w);
  return c;
}
void main() {
  vec3 c = texture2D(uImage, vUv).rgb;
  if (uSharpness > 0.0) {
    vec3 n = texture2D(uImage, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(uImage, vUv - vec2(0.0, uTexel.y)).rgb
           + texture2D(uImage, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(uImage, vUv - vec2(uTexel.x, 0.0)).rgb;
    c += (c * 4.0 - n) * uSharpness * 0.6;
  }
  // clarity (v1.1): unsharp mask de raio LARGO só em luminância — realça textura/linhas sem halo
  // colorido (a razão l/lb escala os 3 canais juntos, preservando matiz). Blur aproximado por anel
  // de 12 taps (8 no raio cheio + 4 a meio raio); CLAMP_TO_EDGE cobre os taps fora da borda. Os 12
  // fetches extras SÓ rodam quando o filtro ativo define clarity (uniform 0 nos demais — branch
  // uniforme, custo zero fora do Dark Sharp).
  if (uClarity > 0.0) {
    float lb = luma(texture2D(uImage, vUv + vec2( uClarityRad.x, 0.0)).rgb)
             + luma(texture2D(uImage, vUv + vec2(-uClarityRad.x, 0.0)).rgb)
             + luma(texture2D(uImage, vUv + vec2(0.0,  uClarityRad.y)).rgb)
             + luma(texture2D(uImage, vUv + vec2(0.0, -uClarityRad.y)).rgb)
             + luma(texture2D(uImage, vUv + uClarityRad * vec2( 0.7071,  0.7071)).rgb)
             + luma(texture2D(uImage, vUv + uClarityRad * vec2(-0.7071,  0.7071)).rgb)
             + luma(texture2D(uImage, vUv + uClarityRad * vec2( 0.7071, -0.7071)).rgb)
             + luma(texture2D(uImage, vUv + uClarityRad * vec2(-0.7071, -0.7071)).rgb)
             + luma(texture2D(uImage, vUv + vec2( uClarityRad.x * 0.5, 0.0)).rgb)
             + luma(texture2D(uImage, vUv + vec2(-uClarityRad.x * 0.5, 0.0)).rgb)
             + luma(texture2D(uImage, vUv + vec2(0.0,  uClarityRad.y * 0.5)).rgb)
             + luma(texture2D(uImage, vUv + vec2(0.0, -uClarityRad.y * 0.5)).rgb);
    lb /= 12.0;
    float l = luma(c);
    c *= 1.0 + uClarity * (l - lb) / max(l, 0.05);
  }
  c = adjust(c);
  if (uFIntensity > 0.0) c = mix(c, uIgActive > 0.5 ? igApply(c) : grade(c), uFIntensity);
  c *= 1.0 - uVignette * smoothstep(0.35, 0.75, distance(vFrameUv, vec2(0.5)));
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
