// src/engine/shaders.ts
export const VERT = `
attribute vec2 aPos; varying vec2 vUv;
uniform mat3 uUvMat; // geometria: rot90/flip/straighten/crop no espaço UV
void main() { vUv = (uUvMat * vec3((aPos + 1.0) * 0.5, 1.0)).xy; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const FRAG = `
precision highp float; varying vec2 vUv;
uniform sampler2D uImage; uniform vec2 uTexel;
uniform float uBrightness, uContrast, uSaturation, uExposure, uTemperature, uShadows, uHighlights, uSharpness, uVignette;
uniform float uFGray, uFSat, uFCon, uFIntensity; uniform vec3 uFGamma, uFGain, uFLift;
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
  c = pow(clamp(c, 0.001, 1.0), 1.0 / uFGamma);
  c = c * uFGain + uFLift * (1.0 - l);
  return c;
}
void main() {
  vec3 c = texture2D(uImage, vUv).rgb;
  if (uSharpness > 0.0) {
    vec3 n = texture2D(uImage, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(uImage, vUv - vec2(0.0, uTexel.y)).rgb
           + texture2D(uImage, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(uImage, vUv - vec2(uTexel.x, 0.0)).rgb;
    c += (c * 4.0 - n) * uSharpness * 0.6;
  }
  c = adjust(c);
  if (uFIntensity > 0.0) c = mix(c, grade(c), uFIntensity);
  c *= 1.0 - uVignette * smoothstep(0.35, 0.75, distance(vUv, vec2(0.5)));
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
