// WebGL renderer: recolours and restyles the hair layer live on the GPU.
//
// Textures (all the same aspect ratio as the photo):
//   uImage  – the photo
//   uMask   – R: hair alpha, G: face skin
//   uStrand – R: fine streak noise, G: chunky streak noise, B: strand direction (x)
//   uPlate  – the photo with hair painted out (LaMa), shown wherever hair is removed

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);  // v = 0 at the top of the photo
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uImage, uMask, uStrand, uPlate;
uniform float uAspect;              // width / height
uniform vec4 uHairBox, uFaceBox;    // x0, y0, x1, y1 in uv
uniform float uHairL, uHairLStd;    // CIE L* stats of the original hair

uniform int uTechnique;             // 0 all-over, 1 balayage, 2 ombre, 3 babylights, 4 highlights, 5 split dye
uniform vec3 uBaseLab, uLightLab;
uniform float uStrength, uCoverage, uBlend, uRoot, uFrame, uShine, uLift;

uniform float uLength, uVolume, uWave, uWaveSize, uCurl, uSleek, uBangs, uStyleMix;
uniform float uSplit;               // before/after divider (uv x); left side shows the original
uniform int uView;                  // 0 result, 1 hair mask

const float TAU = 6.2831853;

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 rgb2lab(vec3 c) {
  vec3 l = toLinear(c);
  vec3 v = vec3(dot(l, vec3(0.4124564, 0.3575761, 0.1804375)) / 0.95047,
                dot(l, vec3(0.2126729, 0.7151522, 0.0721750)),
                dot(l, vec3(0.0193339, 0.1191920, 0.9503041)) / 1.08883);
  vec3 f = mix(v * 7.787 + 16.0 / 116.0, pow(max(v, vec3(0.0)), vec3(1.0 / 3.0)), step(0.008856, v));
  return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}
vec3 lab2rgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  vec3 f = vec3(fy + lab.y / 500.0, fy, fy - lab.z / 200.0);
  vec3 f3 = f * f * f;
  vec3 v = mix((f - 16.0 / 116.0) / 7.787, f3, step(0.008856, f3)) * vec3(0.95047, 1.0, 1.08883);
  return toSrgb(vec3(dot(v, vec3( 3.2404542, -1.5371385, -0.4985314)),
                     dot(v, vec3(-0.9692660,  1.8760108,  0.0415560)),
                     dot(v, vec3( 0.0556434, -0.2040259,  1.0572252))));
}

float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
float vnoise(float x) {
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + 1.0), f);
}
float softplus(float x, float k) { return k * log(1.0 + exp(clamp(x / k, -30.0, 30.0))); }
float band(float x, float centre, float width) { float d = (x - centre) / width; return exp(-d * d); }

// Map a hair pixel's lightness onto a target shade. Light and shade are kept as a ratio
// (in L*+16 space), so shadows stay shadows and shine stays shine on any shade.
vec3 tint(vec3 lab, vec3 target) {
  float mean = target.x - max(target.x - 55.0, 0.0) * 0.3 + uLift * 22.0;  // light shades keep headroom for highlights
  // Soften the ratio for very dark hair (JPEG noise) and for harshly lit hair (big light/shadow spread)
  float gamma = min(clamp((uHairL + 16.0) / 45.0, 0.6, 1.0), clamp(0.3 * (uHairL + 16.0) / max(uHairLStd, 1.0), 0.5, 1.0));
  float lim = 2.5 * uHairLStd + 4.0;                         // soft-edge background pixels don't blow out
  float ratio = pow(max(uHairL + clamp(lab.x - uHairL, -lim, lim) + 16.0, 1.0) / (uHairL + 16.0), gamma);
  float L = (mean + 16.0) * ratio - 16.0;
  if (L > 78.0) L = 78.0 + 20.0 * (1.0 - exp(-(L - 78.0) / 20.0));
  if (L < 4.0) L = 4.0 * exp((L - 4.0) / 4.0);
  // Deep shadows and near-white shine carry less colour than the mid-tones
  float chroma = clamp(1.0 - max(mean - L, 0.0) / 45.0 - max(L - 75.0, 0.0) / 40.0, 0.35, 1.0) * 1.08;
  return vec3(L, target.yz * chroma);
}

void main() {
  vec2 p = vUv;
  vec3 img = texture2D(uImage, p).rgb;
  if (p.x < uSplit) { gl_FragColor = vec4(img, 1.0); return; }

  float cx = 0.5 * (uFaceBox.x + uFaceBox.z);
  float fw = max(0.5 * (uFaceBox.z - uFaceBox.x), 0.02);
  float fy0 = uFaceBox.y;
  float fy1 = uFaceBox.w;
  float fh = max(fy1 - fy0, 0.03);
  float fhx = fh / uAspect;           // face height measured in x-uv units
  float hb = uHairBox.w;

  // ---------------------------------------------------------------- restyle warp
  // q = where in the original photo this pixel's hair comes from.
  vec2 q = p;
  float shade = 0.0;

  if (uWave + uCurl > 0.001) {
    float lam = fh * mix(mix(0.95, 0.42, uWaveSize), 0.2, uCurl);
    float amp = fhx * (0.1 * uWave + 0.05 * uCurl);
    float ramp = smoothstep(fy0 + fh * 0.1, fy0 + fh * 1.1, p.y);   // roots stay flat
    float clump = fhx * mix(0.7, 0.13, uCurl);                      // curls form separate ringlets
    float ph = TAU * (p.y - fy0) / lam + uCurl * TAU * vnoise(p.x / clump) + 2.0 * vnoise(p.x / (clump * 2.5) + 7.0);
    q.x -= amp * ramp * sin(ph);
    shade = ramp * (11.0 * uWave + 14.0 * uCurl) * cos(ph + 0.9);   // light catching each bend
  }

  float vol = uVolume + 0.3 * uWave + 0.4 * uCurl - 0.3 * uSleek;
  if (abs(vol) > 0.001) {
    float s = 1.0 + 0.5 * vol;
    float dx = q.x - cx;
    float vy = smoothstep(fy0 - fh * 0.7, fy0 + fh * 0.3, q.y);
    float zone = softplus(abs(dx) - fw * 0.85, fw * 0.2);           // only hair beyond the face moves
    q.x = cx + sign(dx) * (abs(dx) - (1.0 - 1.0 / s) * zone * vy);
    float up = fy0 - q.y;
    float sv = 1.0 + 0.22 * vol;                                    // lift at the crown
    q.y = fy0 - (up - (1.0 - 1.0 / sv) * softplus(up - fh * 0.05, fh * 0.1));
  }

  if (uLength > 0.001) {
    float pivot = min(fy1, hb - fh * 0.2);
    float span = max(hb - pivot, 0.02);
    if (q.y > pivot) q.y = pivot + (q.y - pivot) * span / (span + uLength * max(span, fh));
  }

  float alpha = texture2D(uMask, q).r;
  vec2 qc = q;

  // Curtain bangs: stretch hair from just above the hairline down over the forehead
  float bangEnd = 0.0, bangSide = 0.0;
  if (uBangs > 0.001) {
    float rx = (p.x - cx) / (fw * 1.05);
    bangSide = 1.0 - smoothstep(0.8, 1.0, abs(rx));
    float top = fy0 - fh * 0.22;
    bangEnd = fy0 + fh * uBangs * (0.24 + 0.14 * rx * rx);
    if (bangSide > 0.0 && p.y > top && p.y < bangEnd + fh * 0.05) {
      float srcBottom = fy0 + fh * 0.015;
      vec2 qb = vec2(p.x - (p.x - cx) * 0.18 * smoothstep(fy0, bangEnd, p.y),
                     top + (p.y - top) * (srcBottom - top) / (bangEnd - top));
      float jag = (texture2D(uStrand, qb).r - 0.5) * fh * 0.07;
      float a = texture2D(uMask, qb).r * bangSide * (1.0 - smoothstep(bangEnd - fh * 0.035, bangEnd, p.y + jag));
      if (a > alpha) { alpha = a; qc = qb; }
    }
  }

  vec4 st = texture2D(uStrand, qc);
  float fine = st.r, coarse = st.g;

  // Haircut: remove hair below the new length, with piece-y ends
  float tb = hb;
  if (uLength < -0.001) tb = mix(hb, fy0 + fh * 0.55, -uLength);
  if (uCurl > 0.001) tb -= 0.22 * uCurl * max(tb - (fy0 + fh * 0.7), 0.0);   // curls spring up
  if (tb < hb - 0.002) {
    float jag = (fine - 0.5) * fh * 0.12 + (coarse - 0.5) * fh * 0.05;
    alpha *= 1.0 - smoothstep(tb - fh * 0.05, tb + fh * 0.01, p.y + jag);
  }
  alpha = mix(alpha, smoothstep(0.3, 0.8, alpha), uSleek);   // sleek = no frizzy halo

  // ---------------------------------------------------------------- hair colour
  vec3 src = texture2D(uImage, qc).rgb;
  if (uSleek > 0.001) {
    // Smooth along the strand direction to calm flyaways
    float tx = st.b * 2.0 - 1.0;
    vec2 dir = vec2(tx / uAspect, sqrt(max(1.0 - tx * tx, 0.0))) * fh * 0.006 * uSleek;
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = -4; i <= 4; i++) {
      float fi = float(i);
      float wt = exp(-fi * fi / 8.0);
      acc += texture2D(uImage, qc + dir * fi).rgb * wt;
      wsum += wt;
    }
    src = mix(src, acc / wsum, 0.85);
  }

  vec3 lab = rgb2lab(src);
  lab.x = clamp(lab.x + shade, 0.0, 100.0);
  if (uSleek > 0.001) {
    float sheen = band(qc.y, fy0 - fh * 0.02, fh * 0.13) + 0.6 * band(qc.y, fy1 + fh * 0.3, fh * 0.18);
    lab.x = min(lab.x + uSleek * 9.0 * sheen * (0.5 + fine), 100.0);
  }

  float t = clamp((qc.y - uHairBox.y) / max(hb - uHairBox.y, 0.05), 0.0, 1.0);  // 0 roots … 1 ends
  float w = 0.0;  // 0 = main colour, 1 = highlight colour
  if (uTechnique == 1) {        // balayage: hand-painted, lighter towards the ends
    float grad = smoothstep(uBlend - 0.3, uBlend + 0.4, t + (coarse - 0.5) * 0.5);
    float thr = 0.56 - uCoverage * 0.3;
    float pieces = smoothstep(thr - 0.12, thr + 0.12, coarse * 0.75 + fine * 0.25);
    w = clamp(grad * mix(0.45, 1.0, pieces) + pieces * 0.35 * smoothstep(uBlend - 0.5, uBlend, t), 0.0, 1.0);
  } else if (uTechnique == 2) { // ombre: smooth root-to-tip fade
    w = smoothstep(uBlend - 0.2, uBlend + 0.3, t + (coarse - 0.5) * 0.1);
  } else if (uTechnique == 3) { // babylights: many very fine, soft strands
    float thr = 0.6 - uCoverage * 0.22;
    w = smoothstep(thr - 0.14, thr + 0.14, fine) * smoothstep(-0.05, 0.25, t) * 0.7;
  } else if (uTechnique == 4) { // foil highlights: bolder sections
    float thr = 0.6 - uCoverage * 0.26;
    w = smoothstep(thr - 0.1, thr + 0.1, coarse * 0.7 + fine * 0.3) * smoothstep(-0.05, 0.12, t);
  } else if (uTechnique == 5) { // split dye down the parting
    w = smoothstep(-0.004, 0.004, qc.x - cx);
  }

  // Money piece: brighter face-framing sections right beside the face
  float fd = (abs(qc.x - cx) - fw * 1.08) / (fw * 0.24);
  w = max(w, uFrame * exp(-fd * fd) * smoothstep(fy0 - fh * 0.3, fy0 + fh * 0.1, qc.y) * mix(0.8, 1.0, coarse));

  // Root shadow: melt back to the natural colour at the roots
  float root = uRoot * (1.0 - smoothstep(0.02, 0.1 + 0.3 * uRoot, t));
  w *= 1.0 - root;

  vec3 colored = mix(tint(lab, uBaseLab), tint(lab, uLightLab), w);
  colored = mix(colored, vec3(lab.x * 0.9, lab.yz), root * 0.85);
  vec3 outLab = mix(lab, colored, uStrength);
  float gloss = smoothstep(uHairL + 0.3 * uHairLStd, uHairL + 2.0 * uHairLStd, lab.x);
  outLab.x = min(outLab.x + uShine * gloss * 10.0, 100.0);
  vec3 hair = lab2rgb(outLab);

  // ---------------------------------------------------------------- composite
  // Show the hair-free background only where the restyle actually took hair away
  float removed = smoothstep(0.02, 0.35, texture2D(uMask, p).r - alpha) * uStyleMix;
  vec3 under = mix(img, texture2D(uPlate, p).rgb, removed);
  if (uBangs > 0.001) {  // soft shadow the fringe casts on the forehead
    under *= 1.0 - 0.3 * uBangs * bangSide * texture2D(uMask, p).g * band(p.y, bangEnd + fh * 0.015, fh * 0.035);
  }
  // Soft-edge pixels far lighter/darker than the hair are mostly background: tint them less
  float outlier = smoothstep(1.0, 1.8, abs(lab.x - shade - uHairL) / (2.5 * uHairLStd + 4.0));
  alpha *= 1.0 - 0.6 * outlier * (1.0 - smoothstep(0.3, 0.95, alpha));
  vec3 col = mix(under, hair, alpha);
  if (uView == 1) col = mix(img * 0.5 + 0.08, vec3(1.0, 0.28, 0.5), texture2D(uMask, p).r * 0.8);
  gl_FragColor = vec4(col, 1.0);
}`;

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}

export function rgbToLab([r, g, b]) {
  const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = v => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const TECHNIQUES = { solid: 0, balayage: 1, ombre: 2, babylights: 3, highlights: 4, split: 5 };

export class HairRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('This browser does not support WebGL.');
    this.gl = gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.units = { uImage: 0, uMask: 1, uStrand: 2, uPlate: 3 };
    this.textures = {};
    for (const [name, unit] of Object.entries(this.units)) {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(3));
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
      this.textures[name] = tex;
    }
    this.loc = {};
  }

  u(name) {
    if (!(name in this.loc)) this.loc[name] = this.gl.getUniformLocation(this.prog, name);
    return this.loc[name];
  }

  setTexture(name, source) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + this.units[name]);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[name]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
  }

  setSize(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  setMeta(meta) {
    const gl = this.gl;
    gl.uniform1f(this.u('uAspect'), meta.width / meta.height);
    gl.uniform4fv(this.u('uHairBox'), meta.hairBox);
    gl.uniform4fv(this.u('uFaceBox'), meta.faceBox);
    gl.uniform1f(this.u('uHairL'), meta.hairL);
    gl.uniform1f(this.u('uHairLStd'), meta.hairLStd);
  }

  render(s) {
    const gl = this.gl;
    const f = (n, v) => gl.uniform1f(this.u(n), v);
    gl.uniform1i(this.u('uTechnique'), TECHNIQUES[s.technique] ?? 0);
    gl.uniform3fv(this.u('uBaseLab'), rgbToLab(hexToRgb(s.base)));
    gl.uniform3fv(this.u('uLightLab'), rgbToLab(hexToRgb(s.light)));
    f('uStrength', s.strength);
    f('uCoverage', s.coverage);
    f('uBlend', s.blend);
    f('uRoot', s.root);
    f('uFrame', s.frame);
    f('uShine', s.shine);
    f('uLift', s.lift);
    f('uLength', s.length);
    f('uVolume', s.volume);
    f('uWave', s.wave);
    f('uWaveSize', s.waveSize);
    f('uCurl', s.curl);
    f('uSleek', s.sleek);
    f('uBangs', s.bangs);
    const styleAmount = Math.max(Math.abs(s.length), Math.abs(s.volume), s.wave, s.curl, s.sleek, s.bangs);
    f('uStyleMix', Math.min(1, styleAmount * 8));
    f('uSplit', s.split ?? 0);
    gl.uniform1i(this.u('uView'), s.showMask ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
