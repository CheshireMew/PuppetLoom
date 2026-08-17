import { randomUUID } from "node:crypto";
import { buildCubismExportPlan, mapCubismParameterValue } from "./cubism-format.js";
import { PuppetLoomError } from "./errors.js";
import { loadCalibration, loadProject } from "./project.js";
import type { LayerBinding, ModelBinding, ModelDeformer, PuppetLoomProject } from "./types.js";
import type {
  CubismBridgeOperation,
  CubismEditorInspection,
  CubismEditorObject,
  CubismEditorParameter,
  CubismEditorPreviewResult,
  CubismEditorSyncResult,
  CubismExportPlan,
  CubismParameterMapping,
  CubismPreviewPose
} from "./cubism-types.js";

export interface CubismRpc {
  request(method: string, data?: Record<string, unknown>, version?: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface CubismWebSocketLike {
  readonly readyState: number;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export type CubismWebSocketFactory = (url: string) => CubismWebSocketLike;

interface PendingRequest {
  method: string;
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CubismRpcError extends Error {
  readonly method: string;
  readonly data: Record<string, unknown>;

  constructor(method: string, data: Record<string, unknown>) {
    const detail = typeof data.Message === "string" ? data.Message : typeof data.ErrorType === "string" ? data.ErrorType : JSON.stringify(data);
    super(`Cubism Editor ${method} 失败：${detail}`);
    this.name = "CubismRpcError";
    this.method = method;
    this.data = data;
  }
}

function defaultSocketFactory(url: string): CubismWebSocketLike {
  const constructor = (globalThis as unknown as { WebSocket?: new (value: string) => CubismWebSocketLike }).WebSocket;
  if (!constructor) throw new PuppetLoomError("CUBISM_CONNECTION", "当前 Node.js 没有 WebSocket 支持；PuppetLoom 需要 Node.js 24 或更新版本。" );
  return new constructor(url);
}

function eventText(event: unknown): string {
  const data = (event as { data?: unknown }).data;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data ?? "");
}

export class CubismEditorClient implements CubismRpc {
  readonly url: string;
  readonly timeoutMs: number;
  private readonly socketFactory: CubismWebSocketFactory;
  private socket: CubismWebSocketLike | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private version = "1.1.0";
  private token = "";

  constructor(url = "ws://127.0.0.1:22033", timeoutMs = 15_000, socketFactory: CubismWebSocketFactory = defaultSocketFactory) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.socketFactory = socketFactory;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === 1) return;
    await new Promise<void>((resolveConnection, rejectConnection) => {
      let settled = false;
      const socket = this.socketFactory(this.url);
      this.socket = socket;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        rejectConnection(new PuppetLoomError("CUBISM_CONNECTION", `连接 Cubism Editor 超时：${this.url}`));
      }, this.timeoutMs);
      socket.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveConnection();
      });
      socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectConnection(new PuppetLoomError("CUBISM_CONNECTION", `无法连接 Cubism Editor：${this.url}。请在 Editor 中开启“外部应用程序集成”。`));
      });
      socket.addEventListener("message", (event) => this.receive(eventText(event)));
      socket.addEventListener("close", () => this.rejectAll(new PuppetLoomError("CUBISM_CONNECTION", "Cubism Editor 连接已关闭。")));
    });
  }

  private receive(text: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(text) as Record<string, unknown>; }
    catch { return; }
    if (message.Type !== "Response" && message.Type !== "Error") return;
    const requestId = typeof message.RequestId === "string" ? message.RequestId : "";
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const data = message.Data && typeof message.Data === "object" ? message.Data as Record<string, unknown> : {};
    if (message.Type === "Error") pending.reject(new CubismRpcError(pending.method, data));
    else pending.resolve(data);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(method: string, data: Record<string, unknown> = {}, version = this.version): Promise<Record<string, unknown>> {
    if (!this.socket || this.socket.readyState !== 1) throw new PuppetLoomError("CUBISM_CONNECTION", "尚未连接 Cubism Editor。" );
    const requestId = randomUUID().replaceAll("-", "");
    return await new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        rejectRequest(new PuppetLoomError("CUBISM_CONNECTION", `Cubism Editor 请求超时：${method}`));
      }, this.timeoutMs);
      this.pending.set(requestId, { method, resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        this.socket!.send(JSON.stringify({ Version: version, RequestId: requestId, Type: "Request", Method: method, Data: data }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        rejectRequest(new PuppetLoomError("CUBISM_CONNECTION", `无法发送 Cubism Editor 请求：${method}`, { cause: error }));
      }
    });
  }

  async register(token = "", name = "PuppetLoom"): Promise<string> {
    await this.connect();
    let response: Record<string, unknown>;
    try {
      response = await this.request("RegisterPlugin", { Token: token, Name: name }, "1.1.0");
      this.version = "1.1.0";
    } catch (error) {
      if (!(error instanceof CubismRpcError)) throw error;
      response = await this.request("RegisterPlugin", { Token: token, Name: name }, "0.9.5");
      this.version = "0.9.5";
    }
    this.token = typeof response.Token === "string" ? response.Token : token;
    return this.token;
  }

  getToken(): string { return this.token; }
  getVersion(): string { return this.version; }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
  }
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseParameters(value: unknown): CubismEditorParameter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.Id !== "string") return [];
    return [{
      Id: item.Id,
      Name: typeof item.Name === "string" ? item.Name : item.Id,
      Min: number(item.Min), Default: number(item.Default), Max: number(item.Max),
      ...(typeof item.GroupUID === "string" ? { GroupUID: item.GroupUID } : {}),
      ...(typeof item.Type === "number" ? { Type: item.Type } : {}),
      ...(Array.isArray(item.Keyform) ? { Keyform: item.Keyform.flatMap((key) => {
        const value = key && typeof key === "object" ? (key as Record<string, unknown>).Value : undefined;
        return typeof value === "number" ? [{ Value: value }] : [];
      }) } : {})
    }];
  });
}

function flattenObjects(value: unknown, parentId?: string): CubismEditorObject[] {
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  const own = typeof item.Id === "string" && typeof item.Type === "string"
    ? [{ Id: item.Id, Name: typeof item.Name === "string" ? item.Name : item.Id, Type: item.Type, ...(parentId ? { ParentId: parentId } : {}) }]
    : [];
  const nextParent = typeof item.Id === "string" ? item.Id : parentId;
  const entries = Array.isArray(item.Entries) ? item.Entries : [];
  return [...own, ...entries.flatMap((entry) => flattenObjects(entry, nextParent))];
}

function rpcErrorType(error: unknown): string {
  return error instanceof CubismRpcError && typeof error.data.ErrorType === "string" ? error.data.ErrorType : "";
}

export async function inspectCubismEditor(rpc: CubismRpc, url = "ws://127.0.0.1:22033", apiVersion = "1.1.0"): Promise<CubismEditorInspection> {
  const warnings: string[] = [];
  const approval = await rpc.request("GetIsApproval");
  const approved = approval.Result === true;
  if (!approved) return { url, connected: true, approved: false, editApproved: false, editApiAvailable: false, apiVersion, parameters: [], objects: [], warnings: ["已连接，但尚未在 Cubism Editor 中授予 Allow 权限。"] };
  const [uidResponse, modeResponse] = await Promise.all([
    rpc.request("GetCurrentModelUID", {}),
    rpc.request("GetCurrentEditMode", {}).catch(() => ({}))
  ]);
  const modelUid = typeof uidResponse.ModelUID === "string" ? uidResponse.ModelUID : undefined;
  const editModeValue = (modeResponse as Record<string, unknown>).EditMode;
  const editMode = typeof editModeValue === "string" ? editModeValue : undefined;
  const parametersResponse = modelUid ? await rpc.request("GetParameters", { ModelUID: modelUid }) : { Parameters: [] };
  const parameters = parseParameters(parametersResponse.Parameters);
  let editApiAvailable = true;
  let editApproved = false;
  let objects: CubismEditorObject[] = [];
  try {
    editApproved = (await rpc.request("GetIsEditApproval", {}, "1.1.0")).Result === true;
    if (modelUid && editApproved) {
      const part = await rpc.request("GetPartStructure", { ModelUID: modelUid }, "1.1.0");
      objects = flattenObjects(part.PartStructure);
    }
  } catch (error) {
    editApiAvailable = false;
    const type = rpcErrorType(error);
    warnings.push(`当前 Editor 不支持 External API 1.1.0 编辑操作${type ? `（${type}）` : ""}；5.3 可检查/预览，但结构同步需要 5.4 alpha 或更新版本。`);
  }
  if (!modelUid) warnings.push("Cubism Editor 当前没有可用的建模模型。" );
  if (editApiAvailable && !editApproved) warnings.push("尚未在 Cubism Editor 中授予 Edit 权限。" );
  if (editMode && editMode !== "Modeling") warnings.push(`当前 Editor 模式是 ${editMode}；结构同步需要 Modeling 模式。`);
  return {
    url, connected: true, approved, editApproved, editApiAvailable, apiVersion,
    ...(modelUid ? { modelUid } : {}),
    ...(editMode ? { editMode } : {}),
    parameters, objects, warnings
  };
}

function cleanId(value: string, prefix: string): string {
  const body = value.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("") || "Object";
  return `${prefix}PuppetLoom${body}`;
}

function closeEnough(left: number, right: number): boolean { return Math.abs(left - right) <= 1e-6; }

function layerObject(project: PuppetLoomProject, objects: CubismEditorObject[], layer: LayerBinding): CubismEditorObject | undefined {
  const artMeshes = objects.filter((object) => object.Type.toLowerCase() === "artmesh");
  const exact = artMeshes.filter((object) => object.Name === layer.sourceName);
  if (exact.length === 1) return exact[0];
  const normalize = (value: string): string => value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const relaxed = artMeshes.filter((object) => normalize(object.Name) === normalize(layer.sourceName));
  return relaxed.length === 1 ? relaxed[0] : undefined;
}

function targetParameterId(mapping: CubismParameterMapping, layer?: LayerBinding): string {
  if (mapping.targetIds.length === 1) return mapping.targetIds[0]!;
  if (layer?.side === "right") return mapping.targetIds.find((id) => id.includes("R")) ?? mapping.targetIds[0]!;
  return mapping.targetIds.find((id) => id.includes("L")) ?? mapping.targetIds[0]!;
}

function drawOrders(project: PuppetLoomProject): Map<string, number> {
  const sorted = [...project.layers].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return new Map(sorted.map((layer, index) => [layer.id, sorted.length === 1 ? 500 : Math.round(index * 1000 / (sorted.length - 1))]));
}

interface CompiledOperations {
  operations: CubismBridgeOperation[];
  warnings: string[];
  blocking: string[];
  objectIds: Set<string>;
}

function bindingTarget(
  project: PuppetLoomProject,
  binding: ModelBinding,
  objects: CubismEditorObject[],
  generatedDeformers: Set<string>
): { id: string; method: "EditArtMesh" | "EditRotationDeformer" | "EditWarpDeformer"; layer?: LayerBinding } | undefined {
  if (binding.target.kind === "layer") {
    const layer = project.layers.find((candidate) => candidate.id === binding.target.id);
    if (!layer) return undefined;
    const object = layerObject(project, objects, layer);
    return object ? { id: object.Id, method: "EditArtMesh", layer } : undefined;
  }
  const deformer = project.model.deformers.find((candidate) => candidate.id === binding.target.id);
  if (!deformer) return undefined;
  const id = cleanId(deformer.id, deformer.kind === "warp" ? "Warp" : "Rotation");
  const object = objects.find((candidate) => candidate.Id === id);
  if (!object && !generatedDeformers.has(id)) return undefined;
  return { id, method: deformer.kind === "warp" ? "EditWarpDeformer" : "EditRotationDeformer" };
}

async function knownKeys(rpc: CubismRpc, modelUid: string, objectIds: Set<string>): Promise<Map<string, Set<string>>> {
  const output = new Map<string, Set<string>>();
  await Promise.all([...objectIds].map(async (objectId) => {
    try {
      const response = await rpc.request("GetParameterKeys", { ModelUID: modelUid, ObjectId: objectId }, "1.1.0");
      const values = new Set<string>();
      if (Array.isArray(response.Parameters)) for (const entry of response.Parameters) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.Id !== "string" || !Array.isArray(item.KeyValues)) continue;
        for (const key of item.KeyValues) if (typeof key === "number") values.add(`${item.Id}\0${key}`);
      }
      output.set(objectId, values);
    } catch { output.set(objectId, new Set()); }
  }));
  return output;
}

function compileOperations(project: PuppetLoomProject, plan: CubismExportPlan, inspection: CubismEditorInspection): CompiledOperations {
  const operations: CubismBridgeOperation[] = [];
  const warnings: string[] = [];
  const blocking: string[] = [];
  const existingParameters = new Map(inspection.parameters.map((parameter) => [parameter.Id, parameter]));
  for (const mapping of plan.mappings) for (const id of mapping.targetIds) {
    const existing = existingParameters.get(id);
    if (!existing) {
      operations.push({ method: "AddParameter", description: `添加参数 ${id}`, data: { Id: id, Name: mapping.sourceName, Min: mapping.targetRange.min, Default: mapping.targetRange.default, Max: mapping.targetRange.max, IsBlendShape: false } });
      continue;
    }
    if (!closeEnough(existing.Min, mapping.targetRange.min) || !closeEnough(existing.Default, mapping.targetRange.default) || !closeEnough(existing.Max, mapping.targetRange.max)) {
      blocking.push(`Cubism 参数 ${id} 已存在，但范围 ${existing.Min}/${existing.Default}/${existing.Max} 与目标 ${mapping.targetRange.min}/${mapping.targetRange.default}/${mapping.targetRange.max} 不一致。`);
    }
  }
  const generatedDeformers = new Set<string>();
  for (const deformer of project.model.deformers) {
    const id = cleanId(deformer.id, deformer.kind === "warp" ? "Warp" : "Rotation");
    if (inspection.objects.some((object) => object.Id === id)) continue;
    const childLayers = project.layers.filter((layer) => layer.deformerId === deformer.id);
    const targetIds = childLayers.map((layer) => layerObject(project, inspection.objects, layer)?.Id).filter((value): value is string => Boolean(value));
    if (targetIds.length === 0) {
      warnings.push(`变形器 ${deformer.name} 没有找到可挂接的 Cubism ArtMesh，已跳过。`);
      continue;
    }
    const parent = deformer.parentId ? project.model.deformers.find((candidate) => candidate.id === deformer.parentId) : undefined;
    const parentId = parent ? cleanId(parent.id, parent.kind === "warp" ? "Warp" : "Rotation") : undefined;
    const data: Record<string, unknown> = { Id: id, Name: deformer.name, TargetObjectIds: targetIds, Mode: "AsParent", ...(parentId ? { ParentId: parentId } : {}) };
    if (deformer.kind === "warp") Object.assign(data, { WarpDivH: Math.max(2, deformer.cols - 1), WarpDivV: Math.max(2, deformer.rows - 1), ConsiderChildKeyforms: true, SnapCenter: true });
    operations.push({ method: deformer.kind === "warp" ? "AddWarpDeformer" : "AddRotationDeformer", data, description: `添加变形器 ${deformer.name}` });
    generatedDeformers.add(id);
  }
  const mappings = new Map(plan.mappings.map((mapping) => [mapping.sourceId, mapping]));
  const orders = drawOrders(project);
  const objectIds = new Set<string>();
  for (const binding of project.model.bindings) {
    const target = bindingTarget(project, binding, inspection.objects, generatedDeformers);
    if (!target) {
      blocking.push(`绑定 ${binding.id} 在 Cubism 模型中找不到唯一目标对象。ArtMesh 名称应与 PSD 图层名一致。`);
      continue;
    }
    objectIds.add(target.id);
    for (const keyform of binding.keyforms) {
      const parameters = binding.parameterIds.flatMap((sourceId, index) => {
        const mapping = mappings.get(sourceId);
        if (!mapping) return [];
        return [{ Id: targetParameterId(mapping, target.layer), Value: mapCubismParameterValue(mapping, keyform.values[index]!) }];
      });
      for (const parameter of parameters) operations.push({
        method: "AddParameterKey",
        description: `为 ${target.id} 添加 ${parameter.Id}=${parameter.Value} 关键点`,
        data: { ObjectId: target.id, ParameterId: parameter.Id, KeyValue: parameter.Value }
      });
      const data: Record<string, unknown> = { Id: target.id, Parameters: parameters, IsExactMatch: true };
      let writable = false;
      if (target.method === "EditArtMesh" && target.layer) {
        if (keyform.opacityMultiplier !== undefined) { data.Opacity = Math.max(0, Math.min(100, target.layer.opacity * keyform.opacityMultiplier * 100)); writable = true; }
        if (keyform.drawOrderOffset !== undefined) { data.DrawOrder = Math.max(0, Math.min(1000, (orders.get(target.layer.id) ?? 500) + keyform.drawOrderOffset)); writable = true; }
      }
      if (target.method === "EditRotationDeformer") {
        if (keyform.transform?.rotationDegrees !== undefined) { data.Angle = keyform.transform.rotationDegrees; writable = true; }
        if (keyform.transform?.scale !== undefined) { data.Scale = keyform.transform.scale.x; writable = true; }
      }
      if (writable) operations.push({ method: target.method, data, description: `写入 ${binding.id} 的可支持关键形态属性` });
    }
  }
  return { operations, warnings, blocking, objectIds };
}

function responseFailed(response: Record<string, unknown>): boolean {
  return response.Result === false || Object.hasOwn(response, "Error");
}

export async function executeCubismEditorOperations(rpc: CubismRpc, modelUid: string, operations: CubismBridgeOperation[]): Promise<number> {
  let applied = 0;
  let begun = false;
  let failure: unknown;
  try {
    const begin = await rpc.request("EditBegin", { Silent: false }, "1.1.0");
    if (responseFailed(begin)) throw new CubismRpcError("EditBegin", begin);
    begun = true;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      await rpc.request("EditSendProgress", { Value: operations.length === 0 ? 1 : (index + 1) / operations.length }, "1.1.0").catch(() => ({}));
      await rpc.request("EditSendLog", { Message: `[${index + 1}/${operations.length}] ${operation.description}` }, "1.1.0").catch(() => ({}));
      const response = await rpc.request(operation.method, { ...operation.data, ModelUID: modelUid }, "1.1.0");
      if (responseFailed(response)) throw new CubismRpcError(operation.method, response);
      applied += 1;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (begun) {
      try { await rpc.request("EditEnd", { Cancel: Boolean(failure) }, "1.1.0"); }
      catch (endError) { if (!failure) failure = endError; }
    }
  }
  if (failure) throw new PuppetLoomError("CUBISM_CONNECTION", `Cubism 同步失败，Editor 事务已回滚：${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
  return applied;
}

export async function syncCubismProject(projectDirectory: string, rpc: CubismRpc, options: { allowPartial?: boolean; url?: string; apiVersion?: string } = {}): Promise<CubismEditorSyncResult> {
  const [project, calibration] = await Promise.all([loadProject(projectDirectory), loadCalibration(projectDirectory)]);
  const plan = buildCubismExportPlan(project, calibration.revision);
  const inspection = await inspectCubismEditor(rpc, options.url, options.apiVersion);
  if (!inspection.approved) throw new PuppetLoomError("CUBISM_BLOCKED", "Cubism Editor 尚未授予 Allow 权限。" );
  if (!inspection.editApiAvailable) throw new PuppetLoomError("CUBISM_BLOCKED", "当前 Cubism Editor 不支持 External API 1.1.0 编辑操作；请使用 5.4 alpha 或更新版本。" );
  if (!inspection.editApproved) throw new PuppetLoomError("CUBISM_BLOCKED", "Cubism Editor 尚未授予 Edit 权限。" );
  if (!inspection.modelUid) throw new PuppetLoomError("CUBISM_BLOCKED", "Cubism Editor 当前没有打开可编辑模型。" );
  if (inspection.editMode !== "Modeling") throw new PuppetLoomError("CUBISM_BLOCKED", `Cubism Editor 当前模式是 ${inspection.editMode ?? "unknown"}，请切换到 Modeling。`);
  if (!options.allowPartial && !plan.strictReady) {
    throw new PuppetLoomError("CUBISM_BLOCKED", `严格同步已停止：${plan.issues.filter((issue) => issue.severity === "blocking").map((issue) => issue.message).join("；")}`);
  }
  const compiled = compileOperations(project, plan, inspection);
  if (!options.allowPartial && compiled.blocking.length > 0) throw new PuppetLoomError("CUBISM_BLOCKED", `严格同步已停止：${compiled.blocking.join("；")}`);
  const keyMap = await knownKeys(rpc, inspection.modelUid, compiled.objectIds);
  const operations = compiled.operations.filter((operation) => {
    if (operation.method !== "AddParameterKey") return true;
    const objectId = String(operation.data.ObjectId);
    const key = `${String(operation.data.ParameterId)}\0${String(operation.data.KeyValue)}`;
    return !(keyMap.get(objectId)?.has(key));
  });
  const applied = await executeCubismEditorOperations(rpc, inspection.modelUid, operations);
  return {
    plan,
    inspection,
    partial: !plan.strictReady || compiled.blocking.length > 0,
    appliedOperations: applied,
    skippedOperations: compiled.operations.length - operations.length,
    warnings: [...inspection.warnings, ...compiled.warnings, ...compiled.blocking]
  };
}

const previewPoseValues: Record<CubismPreviewPose, Partial<Record<NonNullable<CubismParameterMapping["semantic"]>, number>>> = {
  neutral: {},
  left: { "head-yaw": -0.6, "body-sway": -0.25, "gaze-x": -0.8 },
  right: { "head-yaw": 0.6, "body-sway": 0.25, "gaze-x": 0.8 },
  up: { "head-pitch": -0.5, "gaze-y": -0.6 },
  down: { "head-pitch": 0.5, "gaze-y": 0.6 },
  blink: { blink: 1 },
  mouth: { "mouth-open": 1 }
};

export async function previewCubismProject(
  projectDirectory: string,
  rpc: CubismRpc,
  pose: CubismPreviewPose,
  options: { url?: string; apiVersion?: string } = {}
): Promise<CubismEditorPreviewResult> {
  const [project, calibration] = await Promise.all([loadProject(projectDirectory), loadCalibration(projectDirectory)]);
  const plan = buildCubismExportPlan(project, calibration.revision);
  const inspection = await inspectCubismEditor(rpc, options.url, options.apiVersion);
  if (!inspection.approved) throw new PuppetLoomError("CUBISM_BLOCKED", "Cubism Editor 尚未授予 Allow 权限。" );
  if (!inspection.modelUid) throw new PuppetLoomError("CUBISM_BLOCKED", "Cubism Editor 当前没有打开模型。" );
  const existing = new Set(inspection.parameters.map((parameter) => parameter.Id));
  const semanticValues = previewPoseValues[pose];
  const parameters = plan.mappings.flatMap((mapping) => {
    const value = mapping.semantic && semanticValues[mapping.semantic] !== undefined
      ? semanticValues[mapping.semantic]!
      : mapping.sourceRange.default;
    return mapping.targetIds.filter((id) => existing.has(id)).map((id) => ({ Id: id, Value: mapCubismParameterValue(mapping, value) }));
  });
  if (parameters.length === 0) throw new PuppetLoomError("CUBISM_BLOCKED", "当前 Cubism 模型没有与 PuppetLoom 映射匹配的参数。" );
  const response = await rpc.request("SetParameterValues", { ModelUID: inspection.modelUid, Parameters: parameters });
  if (responseFailed(response)) throw new CubismRpcError("SetParameterValues", response);
  return { project: project.name, pose, inspection, parameters };
}

export async function clearCubismPreview(rpc: CubismRpc, options: { url?: string; apiVersion?: string } = {}): Promise<CubismEditorInspection> {
  const inspection = await inspectCubismEditor(rpc, options.url, options.apiVersion);
  if (!inspection.approved) throw new PuppetLoomError("CUBISM_BLOCKED", "Cubism Editor 尚未授予 Allow 权限。" );
  if (!inspection.modelUid) throw new PuppetLoomError("CUBISM_BLOCKED", "Cubism Editor 当前没有打开模型。" );
  await rpc.request("ClearParameterValues", { ModelUID: inspection.modelUid });
  return inspection;
}

export function cubismBridgeOperationsForTest(project: PuppetLoomProject, plan: CubismExportPlan, inspection: CubismEditorInspection): CubismBridgeOperation[] {
  return compileOperations(project, plan, inspection).operations;
}
