// WebGL2 wall renderer: one full-screen quad showing a mm rectangle of the wall.

import { DEFAULT_LIGHT, hexToRgb, PAPER_HEX, sunColor, type LabSettings, type WallMeta } from "../config";
import { FS, VS } from "./shaders";
import type { WallImages } from "./textures";

const UNIT = { normal: 0, albedo: 1, detail: 2, carve: 3 } as const;

export interface Light {
  azimuth: number; // deg, 0 = from the top of the image, 90 = from the right
  elevation: number; // deg above the wall plane
}

export class WallRenderer {
  light: Light;
  carveAmount = 0;
  /** 0 = lit rock, 1 = 탁본 rubbing. */
  rubbing = 0;
  /** View rectangle in wall mm: [x, y, w, h]. */
  view: [number, number, number, number] = [0, 0, 1, 1];

  private gl: WebGL2RenderingContext;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private tex: Partial<Record<keyof typeof UNIT, WebGLTexture>> = {};
  private wallMM: [number, number] = [1, 1];
  private carveRect: [number, number, number, number] = [0, 0, 1, 1];
  private carveSize: [number, number] = [1, 1];
  private dirty = true;
  private ready = false;

  constructor(private canvas: HTMLCanvasElement, private meta: WallMeta) {
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2");
    this.gl = gl;
    this.light = { ...DEFAULT_LIGHT };
    this.initProgram();
    const loop = () => {
      if (this.dirty && this.ready) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  invalidate() {
    this.dirty = true;
  }

  setWall(images: WallImages, rectKey: "overview" | "full") {
    this.upload("normal", images.normal);
    this.upload("albedo", images.albedo);
    const r = this.meta.images[`${rectKey}_albedo`].rect_mm!;
    this.wallMM = [r[2], r[3]];
    this.invalidate();
  }

  setDetail(img: ImageBitmap) {
    this.upload("detail", img, true);
    this.ready = true;
    this.invalidate();
  }

  /** Shading from the lab sliders (sun, light color, shade, exposure, grain, lightening). */
  setLook(look: LabSettings) {
    const { gl, u } = this;
    gl.uniform3fv(u.uSunCol, sunColor(this.meta.lighting.sun_color, look.sun_warmth));
    gl.uniform1f(u.uSun, look.sun_intensity);
    gl.uniform1f(u.uAmbient, look.ambient_intensity);
    gl.uniform1f(u.uExposure, look.exposure);
    gl.uniform1f(u.uDetailStrength, look.detail_strength);
    gl.uniform1f(u.uLightening, look.fresh_stone_lightening);
    this.invalidate();
  }

  setCarve(rgba: Uint8Array, w: number, h: number, rectMM: [number, number, number, number]) {
    this.upload("carve", rgba, false, w, h);
    this.carveRect = rectMM;
    this.carveSize = [w, h];
    this.invalidate();
  }

  /** Re-uploads the carve layer in place (same size), e.g. after its shadow changed. */
  updateCarve(rgba: Uint8Array) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + UNIT.carve);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.carve!);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.carveSize[0], this.carveSize[1], gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.invalidate();
  }

  private initProgram() {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    gl.useProgram(prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(prog, i)!.name;
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    gl.uniform1i(this.u.uNormal, UNIT.normal);
    gl.uniform1i(this.u.uAlbedo, UNIT.albedo);
    gl.uniform1i(this.u.uDetail, UNIT.detail);
    gl.uniform1i(this.u.uCarve, UNIT.carve);

    const L = this.meta.lighting;
    gl.uniform3fv(this.u.uSkyCol, L.sky_color);
    gl.uniform3fv(this.u.uGroundCol, L.ground_color);
    gl.uniform1f(this.u.uTileMM, this.meta.detail_tile_mm);
    gl.uniform3fv(this.u.uPaper, hexToRgb(PAPER_HEX).map((v) => v / 255));
    gl.uniform3f(this.u.uInkCol, 0.11, 0.105, 0.11);

    // 1×1 flat carve layer until the first carving exists.
    this.upload("carve", new Uint8Array([128, 128, 0, 0]), false, 1, 1);
  }

  private upload(key: keyof typeof UNIT, src: ImageBitmap | Uint8Array, repeat = false, w = 0, h = 0) {
    const gl = this.gl;
    if (this.tex[key]) gl.deleteTexture(this.tex[key]!);
    const t = gl.createTexture()!;
    this.tex[key] = t;
    gl.activeTexture(gl.TEXTURE0 + UNIT[key]);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (src instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  }

  private draw() {
    this.dirty = false;
    const { gl, canvas, u } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    const [vx, vy, vw, vh] = this.view;
    gl.uniform2f(u.uCenterMM, vx + vw / 2, vy + vh / 2);
    gl.uniform2f(u.uExtentMM, vw, vh);
    gl.uniform2f(u.uWallMM, this.wallMM[0], this.wallMM[1]);
    const az = (this.light.azimuth * Math.PI) / 180, el = (this.light.elevation * Math.PI) / 180;
    gl.uniform3f(u.uL, Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
    gl.uniform4fv(u.uCarveRect, this.carveRect);
    gl.uniform1f(u.uCarveAmount, this.carveAmount);
    gl.uniform1f(u.uRubbing, this.rubbing);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
