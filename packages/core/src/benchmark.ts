import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { PuppetLoomError } from "./errors.js";
import { loadCalibration, loadProject } from "./project.js";
import type { MotionParameterSemantic, PuppetLoomProject, RigLevel, SemanticRole, VerifyResult } from "./types.js";
import { verifyProject } from "./verify.js";

export type BenchmarkMaterialUse = "local-benchmark-only" | "redistributable";

export interface CharacterBenchmarkExpectations {
  allowedRigLevels?: RigLevel[];
  minLayerCount?: number;
  requiredRoles?: SemanticRole[];
  minArtMeshRatio?: number;
  requiredParameterSemantics?: MotionParameterSemantic[];
  requiredExpressionIds?: string[];
  requiredBehaviorIds?: string[];
  minPoseValidationCount?: number;
  minSafetyScale?: number;
  maxQualityIssueCount?: number;
  requirePoseField?: boolean;
  requirePoseOcclusion?: boolean;
}

export interface CharacterBenchmarkEntry {
  id: string;
  label: string;
  project: string;
  revision?: number;
  materialUse: BenchmarkMaterialUse;
  tags: string[];
  notes?: string;
  expected: CharacterBenchmarkExpectations;
}

export interface CharacterBenchmarkManifest {
  version: 1;
  name: string;
  description?: string;
  characters: CharacterBenchmarkEntry[];
}

export interface CharacterBenchmarkCheck {
  id: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface CharacterBenchmarkResult {
  id: string;
  label: string;
  project: string;
  revision: number;
  fingerprint: string;
  passed: boolean;
  materialUse: BenchmarkMaterialUse;
  tags: string[];
  metrics: {
    rigLevel: RigLevel;
    layerCount: number;
    artMeshRatio: number;
    roles: Partial<Record<SemanticRole, number>>;
    parameterSemantics: string[];
    expressionIds: string[];
    behaviorIds: string[];
    poseValidationCount: number;
    safetyScale: number;
    qualityIssueCount: number;
    poseField: boolean;
    poseOcclusion: boolean;
  };
  verify: VerifyResult;
  checks: CharacterBenchmarkCheck[];
}

export interface CharacterBenchmarkReport {
  version: 1;
  kind: "puppetloom-character-benchmark";
  manifest: string;
  name: string;
  generatedAt: string;
  readyForMaterials: boolean;
  passed: boolean;
  summary: { declared: number; executed: number; passed: number; failed: number };
  results: CharacterBenchmarkResult[];
}

const roles = new Set<SemanticRole>(["backHair", "frontHair", "sideHair", "face", "eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth", "ear", "neck", "topWear", "bottomWear", "arm", "hand", "leg", "foot", "headwear", "tail", "accessory", "unknown"]);
const semantics = new Set<MotionParameterSemantic>(["head-yaw", "head-pitch", "head-roll", "body-sway", "body-pitch", "body-roll", "gaze-x", "gaze-y", "breath", "blink", "mouth-open"]);
const rigLevels = new Set<RigLevel>(["semantic", "grouped", "minimal"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PuppetLoomError("INVALID_INPUT", `${label} 必须是对象。`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PuppetLoomError("INVALID_INPUT", `${label} 必须是非空字符串。`);
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new PuppetLoomError("INVALID_INPUT", `${label} 必须是字符串数组。`);
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function optionalNumber(source: Record<string, unknown>, key: string, minimum: number, maximum = Number.POSITIVE_INFINITY): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new PuppetLoomError("INVALID_INPUT", `${key} 必须是 ${minimum} 到 ${maximum} 之间的数字。`);
  return value;
}

function optionalInteger(source: Record<string, unknown>, key: string, minimum: number): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum) throw new PuppetLoomError("INVALID_INPUT", `${key} 必须是大于等于 ${minimum} 的整数。`);
  return value as number;
}

function optionalBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new PuppetLoomError("INVALID_INPUT", `${key} 必须是布尔值。`);
  return value;
}

function parseEnumArray<T extends string>(value: unknown, allowed: Set<T>, label: string): T[] | undefined {
  if (value === undefined) return undefined;
  const result = stringArray(value, label);
  if (result.some((item) => !allowed.has(item as T))) throw new PuppetLoomError("INVALID_INPUT", `${label} 含有不支持的值。`);
  return result as T[];
}

function parseExpectations(value: unknown, label: string): CharacterBenchmarkExpectations {
  const source = record(value, label);
  const allowedKeys = new Set(["allowedRigLevels", "minLayerCount", "requiredRoles", "minArtMeshRatio", "requiredParameterSemantics", "requiredExpressionIds", "requiredBehaviorIds", "minPoseValidationCount", "minSafetyScale", "maxQualityIssueCount", "requirePoseField", "requirePoseOcclusion"]);
  const unknown = Object.keys(source).filter((key) => !allowedKeys.has(key));
  if (unknown.length) throw new PuppetLoomError("INVALID_INPUT", `${label} 含有未知字段：${unknown.join(", ")}`);
  const allowedRigLevels = parseEnumArray(source.allowedRigLevels, rigLevels, `${label}.allowedRigLevels`);
  const minLayerCount = optionalInteger(source, "minLayerCount", 0);
  const requiredRoles = parseEnumArray(source.requiredRoles, roles, `${label}.requiredRoles`);
  const minArtMeshRatio = optionalNumber(source, "minArtMeshRatio", 0, 1);
  const requiredParameterSemantics = parseEnumArray(source.requiredParameterSemantics, semantics, `${label}.requiredParameterSemantics`);
  const minPoseValidationCount = optionalInteger(source, "minPoseValidationCount", 0);
  const minSafetyScale = optionalNumber(source, "minSafetyScale", 0, 1);
  const maxQualityIssueCount = optionalInteger(source, "maxQualityIssueCount", 0);
  const requirePoseField = optionalBoolean(source, "requirePoseField");
  const requirePoseOcclusion = optionalBoolean(source, "requirePoseOcclusion");
  return {
    ...(allowedRigLevels ? { allowedRigLevels } : {}),
    ...(minLayerCount === undefined ? {} : { minLayerCount }),
    ...(requiredRoles ? { requiredRoles } : {}),
    ...(minArtMeshRatio === undefined ? {} : { minArtMeshRatio }),
    ...(requiredParameterSemantics ? { requiredParameterSemantics } : {}),
    ...(source.requiredExpressionIds === undefined ? {} : { requiredExpressionIds: stringArray(source.requiredExpressionIds, `${label}.requiredExpressionIds`) }),
    ...(source.requiredBehaviorIds === undefined ? {} : { requiredBehaviorIds: stringArray(source.requiredBehaviorIds, `${label}.requiredBehaviorIds`) }),
    ...(minPoseValidationCount === undefined ? {} : { minPoseValidationCount }),
    ...(minSafetyScale === undefined ? {} : { minSafetyScale }),
    ...(maxQualityIssueCount === undefined ? {} : { maxQualityIssueCount }),
    ...(requirePoseField === undefined ? {} : { requirePoseField }),
    ...(requirePoseOcclusion === undefined ? {} : { requirePoseOcclusion })
  };
}

export function parseCharacterBenchmarkManifest(value: unknown): CharacterBenchmarkManifest {
  const source = record(value, "基准清单");
  if (source.version !== 1) throw new PuppetLoomError("INVALID_INPUT", "基准清单 version 必须为 1。" );
  if (!Array.isArray(source.characters)) throw new PuppetLoomError("INVALID_INPUT", "基准清单 characters 必须是数组。" );
  const seen = new Set<string>();
  const characters = source.characters.map((value, index): CharacterBenchmarkEntry => {
    const item = record(value, `characters[${index}]`);
    const id = text(item.id, `characters[${index}].id`);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new PuppetLoomError("INVALID_INPUT", `${id} 不是有效基准 ID。`);
    if (seen.has(id)) throw new PuppetLoomError("INVALID_INPUT", `基准 ID 重复：${id}`);
    seen.add(id);
    const materialUse = item.materialUse;
    if (materialUse !== "local-benchmark-only" && materialUse !== "redistributable") throw new PuppetLoomError("INVALID_INPUT", `${id}.materialUse 必须明确素材用途。`);
    const revision = item.revision;
    if (revision !== undefined && (!Number.isInteger(revision) || (revision as number) < 0)) throw new PuppetLoomError("INVALID_INPUT", `${id}.revision 必须是非负整数。`);
    return {
      id,
      label: text(item.label, `${id}.label`),
      project: text(item.project, `${id}.project`),
      ...(revision === undefined ? {} : { revision: revision as number }),
      materialUse,
      tags: stringArray(item.tags, `${id}.tags`),
      ...(typeof item.notes === "string" && item.notes.trim() ? { notes: item.notes.trim() } : {}),
      expected: parseExpectations(item.expected, `${id}.expected`)
    };
  });
  return { version: 1, name: text(source.name, "基准清单 name"), ...(typeof source.description === "string" && source.description.trim() ? { description: source.description.trim() } : {}), characters };
}

export async function readCharacterBenchmarkManifest(path: string): Promise<CharacterBenchmarkManifest> {
  try { return parseCharacterBenchmarkManifest(JSON.parse(await readFile(resolve(path), "utf8")) as unknown); }
  catch (cause) {
    if (cause instanceof PuppetLoomError) throw cause;
    throw new PuppetLoomError("INVALID_INPUT", `无法读取角色基准清单：${path}`, { cause });
  }
}

function addCheck(checks: CharacterBenchmarkCheck[], id: string, expected: unknown, actual: unknown, passed: boolean, message: string): void {
  checks.push({ id, expected, actual, passed, message });
}

function fingerprint(project: PuppetLoomProject, revision: number): string {
  return createHash("sha256").update(JSON.stringify({ revision, project })).digest("hex");
}

async function runEntry(manifestPath: string, entry: CharacterBenchmarkEntry): Promise<CharacterBenchmarkResult> {
  const projectDirectory = resolve(dirname(manifestPath), entry.project);
  const [project, calibration, verify] = await Promise.all([loadProject(projectDirectory), loadCalibration(projectDirectory), verifyProject(projectDirectory)]);
  const roleCounts: Partial<Record<SemanticRole, number>> = {};
  for (const layer of project.layers) roleCounts[layer.role] = (roleCounts[layer.role] ?? 0) + 1;
  const artMeshRatio = project.layers.length ? project.layers.filter((layer) => layer.mesh.topology === "art").length / project.layers.length : 0;
  const parameterSemantics = project.model.parameters.flatMap((parameter) => parameter.semantic ? [parameter.semantic] : []);
  const expressionIds = project.model.expressions.map((item) => item.id);
  const behaviorIds = project.model.behaviors.map((item) => item.id);
  const checks: CharacterBenchmarkCheck[] = [];
  addCheck(checks, "project-valid", true, verify.valid, verify.valid, verify.valid ? "项目验证通过。" : "项目文件、历史、证据或姿态验证失败。" );
  if (entry.revision !== undefined) addCheck(checks, "revision", entry.revision, calibration.revision, entry.revision === calibration.revision, "当前修订必须与基准清单锁定值一致。" );
  const expected = entry.expected;
  if (expected.allowedRigLevels) addCheck(checks, "rig-level", expected.allowedRigLevels, project.rigLevel, expected.allowedRigLevels.includes(project.rigLevel), "绑定等级必须在允许范围内。" );
  if (expected.minLayerCount !== undefined) addCheck(checks, "layer-count", `>=${expected.minLayerCount}`, project.layers.length, project.layers.length >= expected.minLayerCount, "图层数量必须达到角色样本门槛。" );
  if (expected.requiredRoles) {
    const missing = expected.requiredRoles.filter((role) => !roleCounts[role]);
    addCheck(checks, "required-roles", expected.requiredRoles, missing, missing.length === 0, "必须覆盖指定语义部件。" );
  }
  if (expected.minArtMeshRatio !== undefined) addCheck(checks, "art-mesh-ratio", `>=${expected.minArtMeshRatio}`, artMeshRatio, artMeshRatio >= expected.minArtMeshRatio, "ArtMesh 覆盖率必须达到门槛。" );
  if (expected.requiredParameterSemantics) {
    const missing = expected.requiredParameterSemantics.filter((value) => !parameterSemantics.includes(value));
    addCheck(checks, "parameter-semantics", expected.requiredParameterSemantics, missing, missing.length === 0, "必须提供指定运行时参数语义。" );
  }
  if (expected.requiredExpressionIds) {
    const missing = expected.requiredExpressionIds.filter((value) => !expressionIds.includes(value));
    addCheck(checks, "expressions", expected.requiredExpressionIds, missing, missing.length === 0, "必须提供指定表情。" );
  }
  if (expected.requiredBehaviorIds) {
    const missing = expected.requiredBehaviorIds.filter((value) => !behaviorIds.includes(value));
    addCheck(checks, "behaviors", expected.requiredBehaviorIds, missing, missing.length === 0, "必须提供指定动作。" );
  }
  if (expected.minPoseValidationCount !== undefined) addCheck(checks, "pose-validations", `>=${expected.minPoseValidationCount}`, project.quality.poseValidations.length, project.quality.poseValidations.length >= expected.minPoseValidationCount, "安全姿态数量必须达到门槛。" );
  if (expected.minSafetyScale !== undefined) addCheck(checks, "safety-scale", `>=${expected.minSafetyScale}`, project.quality.safetyScale, project.quality.safetyScale >= expected.minSafetyScale, "安全缩放不得低于门槛。" );
  if (expected.maxQualityIssueCount !== undefined) addCheck(checks, "quality-issues", `<=${expected.maxQualityIssueCount}`, project.quality.issues.length, project.quality.issues.length <= expected.maxQualityIssueCount, "质量问题数量不得超过门槛。" );
  if (expected.requirePoseField !== undefined) addCheck(checks, "pose-field", expected.requirePoseField, Boolean(project.runtime.poseField), Boolean(project.runtime.poseField) === expected.requirePoseField, "姿势壳层能力必须符合声明。" );
  if (expected.requirePoseOcclusion !== undefined) addCheck(checks, "pose-occlusion", expected.requirePoseOcclusion, Boolean(project.runtime.poseOcclusion), Boolean(project.runtime.poseOcclusion) === expected.requirePoseOcclusion, "姿势遮挡能力必须符合声明。" );
  const metrics = {
    rigLevel: project.rigLevel, layerCount: project.layers.length, artMeshRatio, roles: roleCounts,
    parameterSemantics, expressionIds, behaviorIds, poseValidationCount: project.quality.poseValidations.length,
    safetyScale: project.quality.safetyScale, qualityIssueCount: project.quality.issues.length,
    poseField: Boolean(project.runtime.poseField), poseOcclusion: Boolean(project.runtime.poseOcclusion)
  };
  return {
    id: entry.id, label: entry.label, project: projectDirectory, revision: calibration.revision,
    fingerprint: fingerprint(project, calibration.revision), passed: checks.every((check) => check.passed),
    materialUse: entry.materialUse, tags: entry.tags, metrics, verify, checks
  };
}

export async function runCharacterBenchmarks(manifestFile: string): Promise<CharacterBenchmarkReport> {
  const manifestPath = resolve(manifestFile);
  const manifest = await readCharacterBenchmarkManifest(manifestPath);
  const results: CharacterBenchmarkResult[] = [];
  for (const entry of manifest.characters) results.push(await runEntry(manifestPath, entry));
  const passed = results.filter((result) => result.passed).length;
  return {
    version: 1, kind: "puppetloom-character-benchmark", manifest: manifestPath, name: manifest.name,
    generatedAt: new Date().toISOString(), readyForMaterials: manifest.characters.length === 0,
    passed: results.every((result) => result.passed),
    summary: { declared: manifest.characters.length, executed: results.length, passed, failed: results.length - passed },
    results
  };
}
