import type { CharacterStateSelection, PuppetLoomProject, RuntimeMotionInput } from "@puppetloom/core/browser";
import { PuppetRenderer } from "@puppetloom/renderer";

export interface PuppetLoomWebPlayerOptions {
  projectUrl: string;
  canvas: HTMLCanvasElement;
  autoplay?: boolean;
  pointerLook?: boolean;
}

export class PuppetLoomWebPlayer {
  readonly project: PuppetLoomProject;
  readonly renderer: PuppetRenderer;
  private motion: RuntimeMotionInput = {};
  private characterState: CharacterStateSelection | undefined;
  private readonly sourceId = "web-sdk";
  private pointerHandler: ((event: PointerEvent) => void) | undefined;

  private constructor(project: PuppetLoomProject, renderer: PuppetRenderer, private readonly canvas: HTMLCanvasElement) { this.project = project; this.renderer = renderer; }

  static async create(options: PuppetLoomWebPlayerOptions): Promise<PuppetLoomWebPlayer> {
    const projectUrl = new URL(options.projectUrl, document.baseURI);
    const response = await fetch(projectUrl);
    if (!response.ok) throw new Error(`无法读取 PuppetLoom 项目：HTTP ${response.status}`);
    const project = await response.json() as PuppetLoomProject;
    if (project.version !== 4 || !Array.isArray(project.layers)) throw new Error("网页播放器需要 PuppetLoom v4 项目。");
    const renderer = await PuppetRenderer.create(options.canvas, project, async (layer) => {
      const texture = await fetch(new URL(layer.texture.replace(/\\/g, "/"), projectUrl));
      if (!texture.ok) throw new Error(`无法读取纹理 ${layer.texture}：HTTP ${texture.status}`);
      return texture.blob();
    });
    const player = new PuppetLoomWebPlayer(project, renderer, options.canvas);
    if (options.pointerLook !== false) player.enablePointerLook(options.canvas);
    if (options.autoplay !== false) renderer.start();
    else renderer.setPaused(true);
    return player;
  }

  setMotion(motion: RuntimeMotionInput): void { this.motion = { ...motion }; this.publish(); }
  setCharacterState(state: CharacterStateSelection | undefined): void { this.characterState = state ? structuredClone(state) : undefined; this.publish(); }
  pause(): void { this.renderer.setPaused(true); }
  play(): void { this.renderer.setPaused(false); this.renderer.start(); }
  dispose(): void { if (this.pointerHandler) this.canvas.removeEventListener("pointermove", this.pointerHandler); this.renderer.dispose(); }

  private publish(): void {
    this.renderer.setRuntimeControl({
      version: 1, viewerId: 1, capturedAtMs: Date.now(),
      sources: [{ id: this.sourceId, priority: 50, blend: 1, updatedAtMs: Date.now(), ...(Object.keys(this.motion).length ? { motion: this.motion } : {}), ...(this.characterState ? { characterState: this.characterState } : {}) }]
    });
  }
  private enablePointerLook(canvas: HTMLCanvasElement): void {
    this.pointerHandler = (event) => { const rect = canvas.getBoundingClientRect(); this.renderer.setLookTarget({ x: (event.clientX - rect.left) / Math.max(1, rect.width) * 2 - 1, y: (event.clientY - rect.top) / Math.max(1, rect.height) * 2 - 1, strength: 1 }); };
    canvas.addEventListener("pointermove", this.pointerHandler);
  }
}

export class PuppetLoomPlayerElement extends HTMLElement {
  player: PuppetLoomWebPlayer | undefined;
  private canvas = document.createElement("canvas");
  connectedCallback(): void {
    if (!this.canvas.isConnected) { this.canvas.style.cssText = "display:block;width:100%;height:100%;"; this.append(this.canvas); }
    const src = this.getAttribute("src"); if (!src) return;
    void PuppetLoomWebPlayer.create({ projectUrl: src, canvas: this.canvas, autoplay: !this.hasAttribute("paused"), pointerLook: !this.hasAttribute("no-pointer-look") }).then((player) => { this.player = player; this.dispatchEvent(new CustomEvent("puppetloom-ready")); }).catch((error) => this.dispatchEvent(new CustomEvent("puppetloom-error", { detail: error })));
  }
  disconnectedCallback(): void { this.player?.dispose(); this.player = undefined; }
}

if (!customElements.get("puppetloom-player")) customElements.define("puppetloom-player", PuppetLoomPlayerElement);
