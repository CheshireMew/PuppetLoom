import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCubismExportPlan, createCubismParameterMappings, generateCubismSidecars, mapCubismParameterValue } from "../src/cubism-format.js";
import { CubismEditorClient, CubismRpcError, executeCubismEditorOperations, inspectCubismEditor, validateCubismEditorProject, type CubismRpc, type CubismWebSocketLike } from "../src/cubism-bridge.js";
import { verifyCubismModel } from "../src/cubism-export.js";
import { createDefaultAuthoringModel } from "../src/model.js";
import { createProject, loadProject } from "../src/project.js";
import type { AuthoringModel, LayerBinding, PuppetLoomProject } from "../src/types.js";
import { artifactPath } from "../../../test/support/artifacts.js";

function layer(): LayerBinding {
  return {
    id: "face", sourceName: "Face", sourcePath: ["Face"], role: "face", side: "center", order: 0,
    opacity: 1, blendMode: "normal", bounds: { x: 0, y: 0, width: 1, height: 1 }, texture: "textures/face.png",
    pivot: { x: 0.5, y: 0.5 },
    mesh: {
      rows: 2, cols: 2,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      triangles: [0, 1, 2, 1, 3, 2]
    },
    weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "root"
  };
}

function project(model: AuthoringModel = createDefaultAuthoringModel()): PuppetLoomProject {
  return {
    version: 3, name: "cubism-fixture", canvas: { width: 100, height: 100 },
    source: { originalFileName: "fixture.psd", psdSha256: "0".repeat(64), psdPath: "source/fixture.psd" },
    rigLevel: "minimal", layers: [layer()], model, anchors: {},
    runtime: {
      seed: 1, profile: "calm-v1",
      envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, gazeX: 0, gazeY: 0, breath: 0, globalScale: 1 },
      features: { headTurn: false, bodyFollow: false, gaze: false, hairPhysics: false, blink: false, mouthMotion: false }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] }, disabledReasons: []
  };
}

class FakeRpc implements CubismRpc {
  readonly calls: Array<{ method: string; data: Record<string, unknown>; version?: string }> = [];
  constructor(private readonly handler: (method: string, data: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>) {}
  async request(method: string, data: Record<string, unknown> = {}, version?: string): Promise<Record<string, unknown>> {
    this.calls.push({ method, data, ...(version ? { version } : {}) });
    return await this.handler(method, data);
  }
  async close(): Promise<void> {}
}

class FakeSocket implements CubismWebSocketLike {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor() { queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); }); }
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: unknown) => void): void {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  send(data: string): void {
    const request = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(request);
    const method = request.Method;
    const responseData = method === "RegisterPlugin" ? { Token: "persisted-token" } : { Result: true };
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ Type: "Response", Method: method, RequestId: request.RequestId, Data: responseData }) }));
  }
  close(): void { this.readyState = 3; this.emit("close", {}); }
  private emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

describe("Cubism official bridge", () => {
  it("uses the official WebSocket envelope and returns the registered token", async () => {
    let socket: FakeSocket | undefined;
    const client = new CubismEditorClient("ws://fixture", 1000, () => {
      socket = new FakeSocket();
      return socket;
    });
    await expect(client.register("old-token", "PuppetLoom Test")).resolves.toBe("persisted-token");
    expect(socket!.sent[0]).toMatchObject({
      Version: "1.1.0", Type: "Request", Method: "RegisterPlugin",
      Data: { Token: "old-token", Name: "PuppetLoom Test" }
    });
    expect(typeof socket!.sent[0]!.RequestId).toBe("string");
    await client.close();
  });

  it("maps PuppetLoom semantics to standard Cubism IDs and reverses blink", () => {
    const mappings = createCubismParameterMappings(createDefaultAuthoringModel().parameters);
    const yaw = mappings.find((mapping) => mapping.semantic === "head-yaw")!;
    const blink = mappings.find((mapping) => mapping.semantic === "blink")!;
    expect(yaw.targetIds).toEqual(["ParamAngleX"]);
    expect(mapCubismParameterValue(yaw, 0.5)).toBe(15);
    expect(blink.targetIds).toEqual(["ParamEyeLOpen", "ParamEyeROpen"]);
    expect(mapCubismParameterValue(blink, 0)).toBe(1);
    expect(mapCubismParameterValue(blink, 1)).toBe(0);
  });

  it("reports geometry and procedural runtime gaps as blockers instead of fake success", () => {
    const model = createDefaultAuthoringModel();
    model.bindings.push({
      id: "face-turn", parameterIds: ["param-head-yaw"], target: { kind: "layer", id: "face" },
      keyforms: [{ values: [-1], meshPointDeltas: { "0": { x: -0.1, y: 0 } } }, { values: [1], meshPointDeltas: { "0": { x: 0.1, y: 0 } } }]
    });
    const value = project(model);
    value.runtime.features.headTurn = true;
    const plan = buildCubismExportPlan(value, 7);
    expect(plan.sourceRevision).toBe(7);
    expect(plan.strictReady).toBe(false);
    expect(plan.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "EDITOR_API_CANNOT_WRITE_KEYFORM_GEOMETRY", "PROCEDURAL_RUNTIME_REQUIRES_BAKED_GEOMETRY"
    ]));
  });

  it("generates official expression and motion JSON with exact curve counts", () => {
    const model = createDefaultAuthoringModel();
    model.expressions.push({ id: "closed", name: "Closed", parameters: { "param-blink": 1 } });
    model.behaviors.push({
      id: "turn", name: "Turn", duration: 1, loop: true,
      tracks: [{ target: { kind: "parameter", id: "param-head-yaw" }, keyframes: [{ time: 0, value: -1 }, { time: 1, value: 1, easing: "smoothstep" }] }]
    });
    const sidecars = generateCubismSidecars(project(model));
    expect(sidecars.expressions[0]!.document.Parameters).toEqual([
      { Id: "ParamEyeLOpen", Value: -1, Blend: "Add" },
      { Id: "ParamEyeROpen", Value: -1, Blend: "Add" }
    ]);
    expect(sidecars.motions[0]!.document.Meta).toMatchObject({ CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 4 });
    expect(sidecars.motions[0]!.document.Curves[0]!.Segments).toEqual([0, -30, 1, 0.333333, -30, 0.666667, 30, 1, 30]);
  });

  it("distinguishes a stable Editor from the 1.1 editing API", async () => {
    const rpc = new FakeRpc((method) => {
      if (method === "GetIsApproval") return { Result: true };
      if (method === "GetCurrentModelUID") return { ModelUID: "model-1" };
      if (method === "GetCurrentEditMode") return { EditMode: "Modeling" };
      if (method === "GetParameters") return { Parameters: [{ Id: "ParamAngleX", Name: "Angle X", Min: -30, Default: 0, Max: 30 }] };
      if (method === "GetIsEditApproval") throw new CubismRpcError(method, { ErrorType: "UnsupportedVersion" });
      return {};
    });
    const inspection = await inspectCubismEditor(rpc, "ws://fixture", "0.9.5");
    expect(inspection).toMatchObject({ approved: true, editApiAvailable: false, editApproved: false, modelUid: "model-1", editMode: "Modeling" });
    expect(inspection.parameters[0]).toMatchObject({ Id: "ParamAngleX", Min: -30, Default: 0, Max: 30 });
  });

  it("commits successful Editor operations and rolls back on the first failure", async () => {
    const success = new FakeRpc(() => ({ Result: true }));
    await expect(executeCubismEditorOperations(success, "model", [{ method: "AddParameter", data: { Id: "ParamTest" }, description: "add" }])).resolves.toBe(1);
    expect(success.calls.at(-1)).toMatchObject({ method: "EditEnd", data: { Cancel: false } });

    const failed = new FakeRpc((method) => {
      if (method === "AddParameter") throw new CubismRpcError(method, { ErrorType: "InvalidInput", Message: "bad parameter" });
      return { Result: true };
    });
    await expect(executeCubismEditorOperations(failed, "model", [{ method: "AddParameter", data: { Id: "ParamBad" }, description: "bad" }])).rejects.toThrow("事务已回滚");
    expect(failed.calls.at(-1)).toMatchObject({ method: "EditEnd", data: { Cancel: true } });
  });

  it("validates an Editor model against the exact project revision and keeps manual geometry blockers visible", async () => {
    const projectDirectory = artifactPath(`cubism-editor-validation-${process.pid}-${Date.now()}`);
    await createProject({ input: "test/fixtures/semantic.psd", output: projectDirectory, seed: 42 });
    const source = await loadProject(projectDirectory);
    const plan = buildCubismExportPlan(source, 0);
    const parameters = plan.mappings.flatMap((mapping) => mapping.targetIds.map((Id) => ({
      Id, Name: Id, Min: mapping.targetRange.min, Default: mapping.targetRange.default, Max: mapping.targetRange.max
    })));
    const rpc = new FakeRpc((method) => {
      if (method === "GetIsApproval" || method === "GetIsEditApproval") return { Result: true };
      if (method === "GetCurrentModelUID") return { ModelUID: "formal-model" };
      if (method === "GetCurrentEditMode") return { EditMode: "Modeling" };
      if (method === "GetParameters") return { Parameters: parameters };
      if (method === "GetPartStructure") return { PartStructure: { Id: "root", Name: "Root", Type: "Part", Entries: source.layers.map((layer) => ({ Id: `art-${layer.id}`, Name: layer.sourceName, Type: "ArtMesh" })) } };
      return {};
    });
    const pre = await validateCubismEditorProject(projectDirectory, rpc, "pre-sync", { url: "ws://fixture" });
    expect(pre.layerCoverage.matched).toBe(source.layers.length);
    expect(pre.parameterCoverage.missing).toHaveLength(0);
    expect(pre.readyForPartialSync).toBe(true);
    expect(pre.readyForStrictSync).toBe(false);
    expect(pre.manualGeometryReviewRequired.length).toBeGreaterThan(0);

    const post = await validateCubismEditorProject(projectDirectory, rpc, "post-sync", { url: "ws://fixture" });
    expect(post.readyForOfficialExportReview).toBe(false);
    expect(post.issues.some((issue) => issue.severity === "blocking" && pre.manualGeometryReviewRequired.includes(issue.target ?? issue.code))).toBe(true);
  });

  it("validates model references, MOC3 header and decodable textures", async () => {
    const root = artifactPath(`cubism-verify-${process.pid}-${Date.now()}`);
    await mkdir(join(root, "textures"), { recursive: true });
    await writeFile(join(root, "fixture.moc3"), Buffer.from("MOC3fixture"));
    await copyFile("test/fixtures/semantic-reference.png", join(root, "textures", "texture_00.png"));
    const modelPath = join(root, "fixture.model3.json");
    await writeFile(modelPath, JSON.stringify({ Version: 3, FileReferences: { Moc: "fixture.moc3", Textures: ["textures/texture_00.png"] } }));
    await expect(verifyCubismModel(modelPath)).resolves.toMatchObject({ valid: true, moc: "fixture.moc3" });

    await writeFile(join(root, "fixture.moc3"), Buffer.from("FAKEfixture"));
    const invalid = await verifyCubismModel(modelPath);
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map((issue) => issue.code)).toContain("INVALID_MOC3_HEADER");
    expect(await readFile(modelPath, "utf8")).toContain("fixture.moc3");
  });
});
