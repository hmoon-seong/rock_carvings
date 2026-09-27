// Wall shader: the lighting contract of WALL_ASSETS.md plus the user carve layer.
// 3 texture fetches (normal, albedo+AO, detail) + the carve layer.

export const VS = `#version 300 es
in vec2 aPos;
out vec2 vPos;
void main() {
  vPos = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);   // y down, like the wall mm
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const FS = `#version 300 es
precision highp float;
in vec2 vPos;
out vec4 frag;

uniform sampler2D uNormal, uAlbedo, uDetail, uCarve;
uniform vec2 uCenterMM, uExtentMM, uWallMM;
uniform float uTileMM, uDetailStrength;
uniform vec3 uL, uSunCol, uSkyCol, uGroundCol;
uniform float uSun, uAmbient, uExposure;
uniform vec4 uCarveRect;          // x, y, w, h in mm
// uCarve: rg = carve normal xy, b = cast shadow, a = soft mask
uniform float uCarveAmount;       // 0 = uncarved, 1 = full depth
uniform float uLightening;
uniform float uRubbing;           // 0 = lit rock, 1 = 탁본 (rubbing on paper)
uniform vec3 uPaper, uInkCol;     // sRGB

vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec2 mm = uCenterMM + (vPos - 0.5) * uExtentMM;
  vec2 uv = mm / uWallMM;
  vec3 bg = vec3(0.075, 0.072, 0.08);
  vec4 a = texture(uAlbedo, uv);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))) || a.a < 0.004) { frag = vec4(bg, 1.0); return; }

  vec3 nBase = texture(uNormal, uv).xyz * 2.0 - 1.0;
  vec3 nDetail = texture(uDetail, mm / uTileMM).xyz * 2.0 - 1.0;
  vec3 n = normalize(vec3(nBase.xy + uDetailStrength * nDetail.xy, nBase.z));

  float carved = 0.0, carveShadow = 0.0;
  vec2 cuv = (mm - uCarveRect.xy) / uCarveRect.zw;
  if (uCarveAmount > 0.0 && all(greaterThanEqual(cuv, vec2(0.0))) && all(lessThanEqual(cuv, vec2(1.0)))) {
    vec4 c = texture(uCarve, cuv);
    vec2 nCarve = c.xy * 2.0 - 1.0;
    n = normalize(vec3(n.xy + uCarveAmount * nCarve, n.z));
    carved = c.a * uCarveAmount;
    carveShadow = c.b * uCarveAmount;         // cast shadow of the cut, per light (see carve/shadow.ts)
  }

  vec3 albedo = toLin(a.rgb) * (1.0 + uLightening * carved);
  float diffuse = max(dot(n, uL), 0.0) * (1.0 - carveShadow);
  vec3 ambient = mix(uGroundCol, uSkyCol, n.y * 0.5 + 0.5) * a.a * uAmbient;
  vec3 color = albedo * (uSunCol * uSun * diffuse + ambient) * uExposure;
  vec3 rock = toSrgb(color);

  // 탁본: paper pressed onto the stone and inked with a pad. Ink catches the exposed
  // surface; crevices (low AO) and the carving stay paper-white. The fine grain mottles it.
  // AO here is two-humped: deep crevices sit near 0.15, open stone mostly above 0.6.
  float exposed = smoothstep(0.2, 0.5, a.a);
  float mottle = clamp(0.6 + 1.1 * dot(nDetail.xy, vec2(0.7071)) + 0.3 * dot(nBase.xy, vec2(0.7071)), 0.0, 1.0);
  float ink = exposed * mix(0.55, 1.0, mottle) * (1.0 - smoothstep(0.08, 0.5, carved));
  vec3 rubbing = mix(uPaper, uInkCol, 0.88 * ink);

  frag = vec4(mix(rock, rubbing, uRubbing), 1.0);
}`;
