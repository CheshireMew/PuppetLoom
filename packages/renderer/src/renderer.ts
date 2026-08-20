import { authoredRenderFrame, createDeformationFrameContext, deformedAuthoredPoints, normalizedBlendMode, type LayerBinding, type MotionState, type PuppetLoomProject, type RuntimeControlSnapshot } from "@puppetloom/core/browser";
import { CalmMotionController } from "./motion.js";
import type { PointerLookTarget } from "./pointer.js";

export type TextureResolver = (layer: LayerBinding) => Promise<Blob | ImageBitmapSource>;

interface LayerGpuResources {
  texture: WebGLTexture;
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
  indices: Uint16Array;
  vertices: Float32Array;
}

interface ProgramLocations {
  position: number;
  uv: number;
  opacity: WebGLUniformLocation;
  alphaThreshold: WebGLUniformLocation;
  aspectScale: WebGLUniformLocation;
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

export interface DrawingBufferSize {
  width: number;
  height: number;
}

export const MAX_DRAWING_BUFFER_PIXELS = 2048 * 2048;
export const MAX_DRAWING_BUFFER_DIMENSION = 4096;

/**
 * Preserves device-pixel sharpness until the drawing buffer reaches a bounded
 * GPU budget, then scales both axes equally so aspect ratio never changes.
 */
export function drawingBufferSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels = MAX_DRAWING_BUFFER_PIXELS,
  maxDimension = MAX_DRAWING_BUFFER_DIMENSION
): DrawingBufferSize {
  const safeWidth = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 1;
  const safeHeight = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : 1;
  const safeRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const desiredWidth = Math.max(1, Math.round(safeWidth * safeRatio));
  const desiredHeight = Math.max(1, Math.round(safeHeight * safeRatio));
  const safeMaxPixels = Number.isFinite(maxPixels) && maxPixels > 0 ? maxPixels : MAX_DRAWING_BUFFER_PIXELS;
  const safeMaxDimension = Number.isFinite(maxDimension) && maxDimension > 0 ? maxDimension : MAX_DRAWING_BUFFER_DIMENSION;
  const scale = Math.min(
    1,
    Math.sqrt(safeMaxPixels / (desiredWidth * desiredHeight)),
    safeMaxDimension / desiredWidth,
    safeMaxDimension / desiredHeight
  );
  const fit = (value: number) => scale < 1 ? Math.floor(value * scale) : value;
  return {
    width: Math.max(1, fit(desiredWidth)),
    height: Math.max(1, fit(desiredHeight))
  };
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
  private readonly locations: ProgramLocations;
  private readonly resources = new Map<string, LayerGpuResources>();
  private animationFrame = 0;
  private startedAt = 0;
  private paused = false;
  private pausedAt: number | undefined;
  private pausedDuration = 0;
  private lastState: MotionState | undefined;
  private lookTarget: PointerLookTarget = { x: 0, y: 0, strength: 0 };
  private runtimeControl: RuntimeControlSnapshot | undefined;

  private constructor(canvas: HTMLCanvasElement, project: PuppetLoomProject) {
    this.canvas = canvas;
    this.currentProject = project;
    // Artwork edges are already antialiased in each alpha texture and mesh
    // triangles share their edge vertices. Avoiding an additional full-canvas
    // multisample resolve keeps transparent desktop playback on the v-sync budget.
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      stencil: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance"
    });
    if (!gl) throw new Error("当前环境不支持 WebGL2。" );
    this.gl = gl;
    this.program = createProgram(gl);
    const opacity = gl.getUniformLocation(this.program, "u_opacity");
    const alphaThreshold = gl.getUniformLocation(this.program, "u_alphaThreshold");
    const aspectScale = gl.getUniformLocation(this.program, "u_aspectScale");
    if (!opacity || !alphaThreshold || !aspectScale) throw new Error("WebGL 程序缺少必要的 uniform。" );
    this.locations = {
      position: gl.getAttribLocation(this.program, "a_position"),
      uv: gl.getAttribLocation(this.program, "a_uv"),
      opacity,
      alphaThreshold,
      aspectScale
    };
    gl.clearStencil(0);
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
      const vertexBuffer = gl.createBuffer();
      const indexBuffer = gl.createBuffer();
      if (!texture || !vertexBuffer || !indexBuffer) throw new Error(`无法为 ${layer.sourceName} 创建 GPU 资源。`);
      const bitmap = await toImageBitmap(await resolveTexture(layer));
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bitmap.close();
      const vertices = new Float32Array(layer.mesh.points.length * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      const indices = new Uint16Array(layer.mesh.triangles);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      this.resources.set(layer.id, { texture, vertexBuffer, indexBuffer, indexCount: indices.length, indices, vertices });
    }
  }

  resize(): void {
    const { width, height } = drawingBufferSize(this.canvas.clientWidth, this.canvas.clientHeight, window.devicePixelRatio);
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
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    const { position: positionLocation, uv: uvLocation, opacity: opacityLocation, alphaThreshold: alphaThresholdLocation, aspectScale: aspectScaleLocation } = this.locations;
    const aspectScale = aspectFitScale(
      this.project.canvas.width,
      this.project.canvas.height,
      this.canvas.width,
      this.canvas.height
    );
    gl.uniform2f(aspectScaleLocation, aspectScale.x, aspectScale.y);
    gl.enableVertexAttribArray(positionLocation);
    gl.enableVertexAttribArray(uvLocation);

    const drawLayer = (layer: LayerBinding, points: ReturnType<typeof deformedAuthoredPoints>, opacity: number, alphaThreshold = 0): void => {
      const resource = this.resources.get(layer.id);
      if (!resource) return;
      if (resource.vertices.length !== points.length * 4) {
        resource.vertices = new Float32Array(points.length * 4);
        gl.bindBuffer(gl.ARRAY_BUFFER, resource.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, resource.vertices.byteLength, gl.DYNAMIC_DRAW);
      }
      const vertices = resource.vertices;
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index]!;
        const uv = layer.mesh.uvs[index]!;
        vertices[index * 4] = point.x;
        vertices[index * 4 + 1] = point.y;
        vertices[index * 4 + 2] = uv.x;
        vertices[index * 4 + 3] = uv.y;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, resource.vertexBuffer);
      // Re-specifying the store lets the driver orphan a buffer still consumed by the GPU,
      // avoiding a periodic CPU/GPU synchronization stall while reusing the JS array.
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 16, 8);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, resource.texture);
      gl.uniform1f(opacityLocation, opacity);
      gl.uniform1f(alphaThresholdLocation, alphaThreshold);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resource.indexBuffer);
      gl.drawElements(gl.TRIANGLES, resource.indexCount, gl.UNSIGNED_SHORT, 0);
    };

    const frame = authoredRenderFrame(this.project, state);
    const deformationFrame = createDeformationFrameContext(this.project, frame.state);
    for (const entry of frame.layers) {
      const { layer } = entry;
      const points = deformedAuthoredPoints(this.project, layer, entry.authoring.points, frame.state, deformationFrame);
      const clipLayer = layer.clipLayerId ? this.project.layers.find((candidate) => candidate.id === layer.clipLayerId) : undefined;
      if (clipLayer) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0xff);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.stencilFunc(gl.ALWAYS, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.colorMask(false, false, false, false);
        gl.disable(gl.BLEND);
        const clipAuthoring = frame.authoringByLayerId.get(clipLayer.id);
        drawLayer(clipLayer, clipAuthoring ? deformedAuthoredPoints(this.project, clipLayer, clipAuthoring.points, frame.state, deformationFrame) : clipLayer.mesh.points, 1, 0.01);

        gl.colorMask(true, true, true, true);
        gl.stencilMask(0x00);
        gl.stencilFunc(gl.EQUAL, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      }

      gl.enable(gl.BLEND);
      applyBlendMode(gl, layer.blendMode);
      drawLayer(layer, points, entry.opacity);

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
        this.render(this.controller.sample(activeElapsedSeconds(this.startedAt, now, this.pausedDuration, this.pausedAt), { lookTarget: this.lookTarget, ...(this.runtimeControl ? { runtimeControl: this.runtimeControl } : {}), nowMs: Date.now() }));
      } else {
        const { width, height } = drawingBufferSize(this.canvas.clientWidth, this.canvas.clientHeight, window.devicePixelRatio);
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

  setRuntimeControl(snapshot: RuntimeControlSnapshot | undefined): void {
    this.runtimeControl = snapshot;
  }

  updateProject(project: PuppetLoomProject): void {
    const currentIds = new Set(this.currentProject.layers.map((layer) => layer.id));
    if (project.layers.length !== currentIds.size || project.layers.some((layer) => !currentIds.has(layer.id))) {
      throw new Error("编辑期间不能增加或移除纹理图层，请重新打开项目。" );
    }
    for (const layer of project.layers) {
      const resource = this.resources.get(layer.id);
      if (!resource) continue;
      if (resource.vertices.length !== layer.mesh.points.length * 4) {
        resource.vertices = new Float32Array(layer.mesh.points.length * 4);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, resource.vertexBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, resource.vertices.byteLength, this.gl.DYNAMIC_DRAW);
      }
      const triangles = layer.mesh.triangles;
      const indicesChanged = resource.indices.length !== triangles.length
        || resource.indices.some((value, index) => value !== triangles[index]);
      if (indicesChanged) {
        resource.indices = new Uint16Array(triangles);
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, resource.indexBuffer);
        this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, resource.indices, this.gl.STATIC_DRAW);
        resource.indexCount = resource.indices.length;
      }
    }
    this.currentProject = project;
    this.controller = new CalmMotionController(project);
  }

  dispose(): void {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    for (const resource of this.resources.values()) {
      this.gl.deleteTexture(resource.texture);
      this.gl.deleteBuffer(resource.vertexBuffer);
      this.gl.deleteBuffer(resource.indexBuffer);
    }
    this.gl.deleteProgram(this.program);
    this.resources.clear();
  }
}
