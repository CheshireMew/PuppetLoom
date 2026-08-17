import { authoredLayersInRenderOrder, authoredOpacityFor, deformedPoints, normalizedBlendMode, type LayerBinding, type MotionState, type PuppetLoomProject } from "@puppetloom/core/browser";
import { CalmMotionController } from "./motion.js";
import type { PointerLookTarget } from "./pointer.js";

export type TextureResolver = (layer: LayerBinding) => Promise<Blob | ImageBitmapSource>;

interface LayerGpuResources {
  texture: WebGLTexture;
  indexBuffer: WebGLBuffer;
  indexCount: number;
}

const vertexShaderSource = `#version 300 es
precision highp float;
in vec2 a_position;
in vec2 a_uv;
uniform vec2 u_aspectScale;
out vec2 v_uv;
out vec2 v_position;
void main() {
  v_uv = a_uv;
  v_position = a_position;
  vec2 clipPosition = vec2(a_position.x * 2.0 - 1.0, 1.0 - a_position.y * 2.0);
  gl_Position = vec4(clipPosition * u_aspectScale, 0.0, 1.0);
}`;

const fragmentShaderSource = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform float u_opacity;
uniform float u_alphaThreshold;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 color = texture(u_texture, v_uv);
  if (color.a <= u_alphaThreshold) discard;
  color.a *= u_opacity;
  color.rgb *= color.a;
  outColor = color;
}`;

export { layersInRenderOrder, opacityFor } from "@puppetloom/core/browser";

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("无法创建 WebGL 着色器。" );
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "未知着色器错误";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("无法创建 WebGL 程序。" );
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "WebGL 程序链接失败。" );
  return program;
}

async function toImageBitmap(source: Blob | ImageBitmapSource): Promise<ImageBitmap> {
  if (source instanceof Blob) return createImageBitmap(source, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  return createImageBitmap(source, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}

export interface AspectFitScale {
  x: number;
  y: number;
}

export function activeElapsedSeconds(startedAt: number, now: number, pausedDuration: number, pausedAt?: number): number {
  const inactive = pausedDuration + (pausedAt === undefined ? 0 : Math.max(0, now - pausedAt));
  return Math.max(0, now - startedAt - inactive) / 1000;
}

/**
 * Fits project coordinates inside the current drawing buffer without changing
 * their proportions. Any unused area stays transparent in the viewer.
 */
export function aspectFitScale(
  projectWidth: number,
  projectHeight: number,
  viewportWidth: number,
  viewportHeight: number
): AspectFitScale {
  if (![projectWidth, projectHeight, viewportWidth, viewportHeight].every((value) => Number.isFinite(value) && value > 0)) {
    return { x: 1, y: 1 };
  }
  const projectAspect = projectWidth / projectHeight;
  const viewportAspect = viewportWidth / viewportHeight;
  if (viewportAspect > projectAspect) return { x: projectAspect / viewportAspect, y: 1 };
  if (viewportAspect < projectAspect) return { x: 1, y: viewportAspect / projectAspect };
  return { x: 1, y: 1 };
}

function applyBlendMode(gl: WebGL2RenderingContext, mode: string): void {
  const normalized = normalizedBlendMode(mode);
  gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
  if (normalized === "multiply") {
    gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return;
  }
  if (normalized === "screen") {
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return;
  }
  if (normalized === "add") {
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return;
  }
  if (normalized === "darken") {
    gl.blendEquationSeparate(gl.MIN, gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return;
  }
  if (normalized === "lighten") {
    gl.blendEquationSeparate(gl.MAX, gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return;
  }
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}

export class PuppetRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private currentProject: PuppetLoomProject;
  controller: CalmMotionController;
  private readonly program: WebGLProgram;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly resources = new Map<string, LayerGpuResources>();
  private animationFrame = 0;
  private startedAt = 0;
  private paused = false;
  private pausedAt: number | undefined;
  private pausedDuration = 0;
  private lastState: MotionState | undefined;
  private lookTarget: PointerLookTarget = { x: 0, y: 0, strength: 0 };

  private constructor(canvas: HTMLCanvasElement, project: PuppetLoomProject) {
    this.canvas = canvas;
    this.currentProject = project;
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, stencil: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error("当前环境不支持 WebGL2。" );
    this.gl = gl;
    this.program = createProgram(gl);
    const vertexBuffer = gl.createBuffer();
    if (!vertexBuffer) throw new Error("无法创建 WebGL 顶点缓冲区。" );
    this.vertexBuffer = vertexBuffer;
    this.controller = new CalmMotionController(project);
  }

  get project(): PuppetLoomProject {
    return this.currentProject;
  }

  /** The exact state used by the most recently rendered frame. */
  get motionState(): MotionState | undefined {
    return this.lastState;
  }

  static async create(canvas: HTMLCanvasElement, project: PuppetLoomProject, resolveTexture: TextureResolver): Promise<PuppetRenderer> {
    const renderer = new PuppetRenderer(canvas, project);
    await renderer.loadTextures(resolveTexture);
    renderer.resize();
    return renderer;
  }

  private async loadTextures(resolveTexture: TextureResolver): Promise<void> {
    const gl = this.gl;
    for (const layer of this.project.layers) {
      const texture = gl.createTexture();
      const indexBuffer = gl.createBuffer();
      if (!texture || !indexBuffer) throw new Error(`无法为 ${layer.sourceName} 创建 GPU 资源。`);
      const bitmap = await toImageBitmap(await resolveTexture(layer));
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bitmap.close();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(layer.mesh.triangles), gl.STATIC_DRAW);
      this.resources.set(layer.id, { texture, indexBuffer, indexCount: layer.mesh.triangles.length });
    }
  }

  resize(): void {
    const width = Math.max(1, Math.round(this.canvas.clientWidth * window.devicePixelRatio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * window.devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  render(state: MotionState): void {
    this.lastState = state;
    const gl = this.gl;
    this.resize();
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    const positionLocation = gl.getAttribLocation(this.program, "a_position");
    const uvLocation = gl.getAttribLocation(this.program, "a_uv");
    const opacityLocation = gl.getUniformLocation(this.program, "u_opacity");
    const alphaThresholdLocation = gl.getUniformLocation(this.program, "u_alphaThreshold");
    const aspectScaleLocation = gl.getUniformLocation(this.program, "u_aspectScale");
    const aspectScale = aspectFitScale(
      this.project.canvas.width,
      this.project.canvas.height,
      this.canvas.width,
      this.canvas.height
    );
    gl.uniform2f(aspectScaleLocation, aspectScale.x, aspectScale.y);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 16, 8);

    const drawLayer = (layer: LayerBinding, points: ReturnType<typeof deformedPoints>, opacity: number, alphaThreshold = 0): void => {
      const resource = this.resources.get(layer.id);
      if (!resource) return;
      const vertices = new Float32Array(points.length * 4);
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index]!;
        const uv = layer.mesh.uvs[index]!;
        vertices[index * 4] = point.x;
        vertices[index * 4 + 1] = point.y;
        vertices[index * 4 + 2] = uv.x;
        vertices[index * 4 + 3] = uv.y;
      }
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, resource.texture);
      gl.uniform1f(opacityLocation, opacity);
      gl.uniform1f(alphaThresholdLocation, alphaThreshold);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resource.indexBuffer);
      gl.drawElements(gl.TRIANGLES, resource.indexCount, gl.UNSIGNED_SHORT, 0);
    };

    for (const layer of authoredLayersInRenderOrder(this.project, state)) {
      const points = deformedPoints(this.project, layer, state);
      const clipLayer = layer.clipLayerId ? this.project.layers.find((candidate) => candidate.id === layer.clipLayerId) : undefined;
      if (clipLayer) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0xff);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.stencilFunc(gl.ALWAYS, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.colorMask(false, false, false, false);
        gl.disable(gl.BLEND);
        drawLayer(clipLayer, deformedPoints(this.project, clipLayer, state), 1, 0.01);

        gl.colorMask(true, true, true, true);
        gl.stencilMask(0x00);
        gl.stencilFunc(gl.EQUAL, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      }

      gl.enable(gl.BLEND);
      applyBlendMode(gl, layer.blendMode);
      drawLayer(layer, points, authoredOpacityFor(this.project, layer, state));

      if (clipLayer) {
        gl.disable(gl.STENCIL_TEST);
        gl.stencilMask(0xff);
      }
    }
  }

  start(): void {
    if (this.animationFrame) return;
    this.startedAt = performance.now();
    this.pausedDuration = 0;
    this.pausedAt = undefined;
    const loop = (now: number) => {
      if (!this.paused) {
        this.render(this.controller.sample(activeElapsedSeconds(this.startedAt, now, this.pausedDuration, this.pausedAt), { lookTarget: this.lookTarget }));
      } else {
        const width = Math.max(1, Math.round(this.canvas.clientWidth * window.devicePixelRatio));
        const height = Math.max(1, Math.round(this.canvas.clientHeight * window.devicePixelRatio));
        if (this.canvas.width !== width || this.canvas.height !== height) {
          this.render(this.lastState ?? this.controller.sample(0, { lookTarget: this.lookTarget }));
        }
      }
      this.animationFrame = requestAnimationFrame(loop);
    };
    this.animationFrame = requestAnimationFrame(loop);
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    const now = performance.now();
    if (paused) this.pausedAt = now;
    else if (this.pausedAt !== undefined) {
      this.pausedDuration += Math.max(0, now - this.pausedAt);
      this.pausedAt = undefined;
    }
    this.paused = paused;
  }

  setLookTarget(target: PointerLookTarget): void {
    this.lookTarget = {
      x: Math.max(-1, Math.min(1, target.x)),
      y: Math.max(-1, Math.min(1, target.y)),
      strength: Math.max(0, Math.min(1, target.strength))
    };
  }

  updateProject(project: PuppetLoomProject): void {
    const currentIds = new Set(this.currentProject.layers.map((layer) => layer.id));
    if (project.layers.length !== currentIds.size || project.layers.some((layer) => !currentIds.has(layer.id))) {
      throw new Error("编辑期间不能增加或移除纹理图层，请重新打开项目。" );
    }
    for (const layer of project.layers) {
      const resource = this.resources.get(layer.id);
      if (!resource) continue;
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, resource.indexBuffer);
      this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(layer.mesh.triangles), this.gl.STATIC_DRAW);
      resource.indexCount = layer.mesh.triangles.length;
    }
    this.currentProject = project;
    this.controller = new CalmMotionController(project);
  }

  dispose(): void {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    for (const resource of this.resources.values()) {
      this.gl.deleteTexture(resource.texture);
      this.gl.deleteBuffer(resource.indexBuffer);
    }
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteProgram(this.program);
    this.resources.clear();
  }
}
