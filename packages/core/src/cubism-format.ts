import type {
  BehaviorKeyframe,
  ModelBehavior,
  ModelParameter,
  MotionParameterSemantic,
  PuppetLoomProject
} from "./types.js";
import {
  CUBISM_BRIDGE_VERSION,
  CUBISM_EDITOR_API_VERSION,
  type CubismCompatibilityIssue,
  type CubismDisplayInfoJson,
  type CubismExportPlan,
  type CubismGeneratedSidecars,
  type CubismMotionCurve,
  type CubismMotionJson,
  type CubismParameterMapping,
  type CubismPhysicsJson
} from "./cubism-types.js";

interface SemanticTarget {
  ids: string[];
  range: { min: number; default: number; max: number };
  scale: number;
  offset: number;
}

const semanticTargets: Record<MotionParameterSemantic, SemanticTarget> = {
  "head-yaw": { ids: ["ParamAngleX"], range: { min: -30, default: 0, max: 30 }, scale: 30, offset: 0 },
  "head-pitch": { ids: ["ParamAngleY"], range: { min: -30, default: 0, max: 30 }, scale: 30, offset: 0 },
  "head-roll": { ids: ["ParamAngleZ"], range: { min: -30, default: 0, max: 30 }, scale: 30, offset: 0 },
  "body-sway": { ids: ["ParamBodyAngleX"], range: { min: -10, default: 0, max: 10 }, scale: 10, offset: 0 },
  "body-pitch": { ids: ["ParamBodyAngleY"], range: { min: -10, default: 0, max: 10 }, scale: 10, offset: 0 },
  "body-roll": { ids: ["ParamBodyAngleZ"], range: { min: -10, default: 0, max: 10 }, scale: 10, offset: 0 },
  "gaze-x": { ids: ["ParamEyeBallX"], range: { min: -1, default: 0, max: 1 }, scale: 1, offset: 0 },
  "gaze-y": { ids: ["ParamEyeBallY"], range: { min: -1, default: 0, max: 1 }, scale: 1, offset: 0 },
  breath: { ids: ["ParamBreath"], range: { min: 0, default: 0, max: 1 }, scale: 1, offset: 0 },
  blink: { ids: ["ParamEyeLOpen", "ParamEyeROpen"], range: { min: 0, default: 1, max: 1 }, scale: -1, offset: 1 },
  "mouth-open": { ids: ["ParamMouthOpenY"], range: { min: 0, default: 0, max: 1 }, scale: 1, offset: 0 }
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
}

function pascalIdentifier(value: string): string {
  const words = value.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const body = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join("");
  return body || "Parameter";
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createCubismParameterMappings(parameters: ModelParameter[]): CubismParameterMapping[] {
  const claimed = new Map<string, string>();
  return parameters.map((parameter) => {
    const semantic = parameter.semantic ? semanticTargets[parameter.semantic] : undefined;
    let ids = semantic?.ids ?? [`ParamPuppetLoom${pascalIdentifier(parameter.id)}`];
    ids = ids.map((id) => {
      const owner = claimed.get(id);
      if (!owner || owner === parameter.id) {
        claimed.set(id, parameter.id);
        return id;
      }
      const unique = `${id}${stableHash(parameter.id)}`;
      claimed.set(unique, parameter.id);
      return unique;
    });
    const range = semantic?.range ?? { min: parameter.min, default: parameter.default, max: parameter.max };
    return {
      sourceId: parameter.id,
      sourceName: parameter.name,
      sourceGroup: parameter.group,
      sourceRange: { min: parameter.min, default: parameter.default, max: parameter.max },
      ...(parameter.semantic ? { semantic: parameter.semantic } : {}),
      targetIds: ids,
      targetRange: range,
      scale: semantic?.scale ?? 1,
      offset: semantic?.offset ?? 0,
      standard: Boolean(semantic)
    };
  });
}

export function mapCubismParameterValue(mapping: CubismParameterMapping, value: number): number {
  return finite(clamp(value * mapping.scale + mapping.offset, mapping.targetRange.min, mapping.targetRange.max));
}

function bindingIssues(project: PuppetLoomProject): {
  issues: CubismCompatibilityIssue[];
  fullyWritable: number;
  partiallyWritable: number;
  blocked: number;
} {
  const issues: CubismCompatibilityIssue[] = [];
  let fullyWritable = 0;
  let partiallyWritable = 0;
  let blocked = 0;
  for (const binding of project.model.bindings) {
    const unsupported = new Set<string>();
    let supported = false;
    for (const keyform of binding.keyforms) {
      if (keyform.meshPointDeltas && Object.keys(keyform.meshPointDeltas).length > 0) unsupported.add("ArtMesh 顶点位移");
      if (keyform.warpPointDeltas && Object.keys(keyform.warpPointDeltas).length > 0) unsupported.add("Warp 控制点位移");
      if (keyform.transform?.translation) unsupported.add("平移关键形态");
      if (keyform.transform?.scale && Math.abs(keyform.transform.scale.x - keyform.transform.scale.y) > 1e-6) unsupported.add("非等比缩放关键形态");
      if (keyform.opacityMultiplier !== undefined || keyform.drawOrderOffset !== undefined || keyform.transform?.rotationDegrees !== undefined || keyform.transform?.scale !== undefined) supported = true;
    }
    if (unsupported.size === 0) {
      fullyWritable += 1;
      continue;
    }
    if (supported) partiallyWritable += 1;
    else blocked += 1;
    issues.push({
      code: "EDITOR_API_CANNOT_WRITE_KEYFORM_GEOMETRY",
      severity: "blocking",
      target: binding.id,
      message: `绑定 ${binding.id} 包含官方 External API 1.1.0 不能写入的内容：${[...unsupported].join("、")}。`
    });
  }
  return { issues, fullyWritable, partiallyWritable, blocked };
}

function runtimeIssues(project: PuppetLoomProject): CubismCompatibilityIssue[] {
  const features = Object.entries(project.runtime.features).filter(([, enabled]) => enabled).map(([name]) => name);
  if (features.length === 0) return [];
  return [{
    code: "PROCEDURAL_RUNTIME_REQUIRES_BAKED_GEOMETRY",
    severity: "blocking",
    message: `当前角色启用了 PuppetLoom 程序化动作（${features.join("、")}）；官方 External API 不能写入它生成的 ArtMesh 顶点，因此不能自动得到视觉等价的 Cubism 模型。`
  }];
}

export function buildCubismExportPlan(project: PuppetLoomProject, sourceRevision = 0): CubismExportPlan {
  const mappings = createCubismParameterMappings(project.model.parameters);
  const binding = bindingIssues(project);
  const issues: CubismCompatibilityIssue[] = [...binding.issues, ...runtimeIssues(project)];
  const semanticCounts = new Map<MotionParameterSemantic, number>();
  for (const parameter of project.model.parameters) {
    if (!parameter.semantic) continue;
    semanticCounts.set(parameter.semantic, (semanticCounts.get(parameter.semantic) ?? 0) + 1);
  }
  for (const [semantic, count] of semanticCounts) {
    if (count > 1) issues.push({ code: "DUPLICATE_SEMANTIC_PARAMETER", severity: "blocking", target: semantic, message: `语义 ${semantic} 被 ${count} 个参数重复声明，不能唯一映射到 Cubism 标准参数。` });
  }
  if (project.model.physics.length > 0) issues.push({
    code: "PHYSICS_APPROXIMATION",
    severity: "warning",
    message: "PuppetLoom 的参数弹簧会转换为 Cubism physics3.json 的两粒子近似；需要在 Cubism Viewer 中复核摆幅和响应。"
  });
  issues.push({
    code: "MOC3_REQUIRES_CUBISM_EDITOR",
    severity: "info",
    message: ".moc3 必须由 Live2D Cubism Editor 官方导出；PuppetLoom 不伪造或反向编译该专有二进制。"
  });
  const strictReady = !issues.some((issue) => issue.severity === "blocking");
  return {
    version: CUBISM_BRIDGE_VERSION,
    project: project.name,
    sourceRevision,
    editorApiVersion: CUBISM_EDITOR_API_VERSION,
    requiresCubismEditor: true,
    requiresEditorMocExport: true,
    strictReady,
    partialSyncAvailable: mappings.length > 0,
    mappings,
    coverage: {
      sourceParameters: mappings.length,
      targetParameters: mappings.reduce((total, mapping) => total + mapping.targetIds.length, 0),
      totalBindings: project.model.bindings.length,
      fullyWritableBindings: binding.fullyWritable,
      partiallyWritableBindings: binding.partiallyWritable,
      blockedBindings: binding.blocked,
      expressions: project.model.expressions.length,
      motions: project.model.behaviors.length,
      physicsSettings: project.model.physics.length
    },
    issues
  };
}

function safeFileId(value: string): string {
  const safe = value.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || `item-${stableHash(value)}`;
}

function mappingMap(mappings: CubismParameterMapping[]): Map<string, CubismParameterMapping> {
  return new Map(mappings.map((mapping) => [mapping.sourceId, mapping]));
}

function motionCurve(id: string, frames: BehaviorKeyframe[], mapping: CubismParameterMapping, valueTransform: (value: number) => number): CubismMotionCurve {
  const first = frames[0]!;
  const segments = [finite(first.time), mapCubismParameterValue(mapping, valueTransform(first.value))];
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]!;
    const current = frames[index]!;
    const easing = current.easing ?? "smoothstep";
    if (easing === "hold") {
      segments.push(2, finite(current.time), mapCubismParameterValue(mapping, valueTransform(previous.value)));
    } else if (easing === "linear") {
      segments.push(0, finite(current.time), mapCubismParameterValue(mapping, valueTransform(current.value)));
    } else {
      const duration = current.time - previous.time;
      const leftValue = mapCubismParameterValue(mapping, valueTransform(previous.value));
      const rightValue = mapCubismParameterValue(mapping, valueTransform(current.value));
      segments.push(
        1,
        finite(previous.time + duration / 3), leftValue,
        finite(previous.time + duration * 2 / 3), rightValue,
        finite(current.time), rightValue
      );
    }
  }
  return { Target: "Parameter", Id: id, Segments: segments, FadeInTime: 0.5, FadeOutTime: 0.5 };
}

function motionCounts(curves: CubismMotionCurve[]): { segments: number; points: number } {
  let segmentCount = 0;
  let pointCount = 0;
  for (const curve of curves) {
    pointCount += 1;
    let cursor = 2;
    while (cursor < curve.Segments.length) {
      const kind = curve.Segments[cursor]!;
      segmentCount += 1;
      if (kind === 1) { pointCount += 3; cursor += 7; }
      else { pointCount += 1; cursor += 3; }
    }
  }
  return { segments: segmentCount, points: pointCount };
}

function buildMotion(project: PuppetLoomProject, behavior: ModelBehavior, mappings: CubismParameterMapping[], issues: CubismCompatibilityIssue[]): CubismMotionJson {
  const bySource = mappingMap(mappings);
  const expressions = new Map(project.model.expressions.map((expression) => [expression.id, expression]));
  const curves: CubismMotionCurve[] = [];
  const claimed = new Set<string>();
  for (const track of behavior.tracks) {
    const targets: Array<{ parameterId: string; transform: (value: number) => number }> = [];
    if (track.target.kind === "parameter") targets.push({ parameterId: track.target.id, transform: (value) => value });
    else {
      const expression = expressions.get(track.target.id);
      if (!expression) continue;
      for (const [parameterId, expressionTarget] of Object.entries(expression.parameters)) {
        const parameter = project.model.parameters.find((candidate) => candidate.id === parameterId);
        if (parameter) targets.push({ parameterId, transform: (weight) => parameter.default + (expressionTarget - parameter.default) * clamp(weight, 0, 1) });
      }
    }
    for (const target of targets) {
      const mapping = bySource.get(target.parameterId);
      if (!mapping) continue;
      for (const id of mapping.targetIds) {
        if (claimed.has(id)) {
          issues.push({ code: "MOTION_CURVE_COLLISION", severity: "warning", target: behavior.id, message: `动作 ${behavior.id} 有多个轨道写入 ${id}；只保留第一个轨道。` });
          continue;
        }
        claimed.add(id);
        curves.push(motionCurve(id, track.keyframes, mapping, target.transform));
      }
    }
  }
  const counts = motionCounts(curves);
  return {
    Version: 3,
    Meta: {
      Duration: finite(behavior.duration), Fps: 30, Loop: behavior.loop, AreBeziersRestricted: true,
      CurveCount: curves.length, TotalSegmentCount: counts.segments, TotalPointCount: counts.points,
      UserDataCount: 0, TotalUserDataSize: 0
    },
    Curves: curves,
    UserData: []
  };
}

function buildPhysics(project: PuppetLoomProject, mappings: CubismParameterMapping[]): CubismPhysicsJson | undefined {
  if (project.model.physics.length === 0) return undefined;
  const bySource = mappingMap(mappings);
  const settings: Array<Record<string, unknown>> = [];
  for (const physics of project.model.physics) {
    const input = bySource.get(physics.inputParameterId);
    const output = bySource.get(physics.outputParameterId);
    if (!input || !output) continue;
    settings.push({
      Id: `PhysicsSettingPuppetLoom${safeFileId(physics.id)}`,
      Input: input.targetIds.map((id) => ({ Source: { Target: "Parameter", Id: id }, Weight: 100, Type: "X", Reflect: false })),
      Output: output.targetIds.map((id) => ({ Destination: { Target: "Parameter", Id: id }, VertexIndex: 1, Scale: finite(physics.outputScale), Weight: 100, Type: "X", Reflect: false })),
      Vertices: [
        { Position: { X: 0, Y: 0 }, Mobility: 0, Delay: 0, Acceleration: 0, Radius: 0 },
        { Position: { X: 0, Y: 1 }, Mobility: finite(clamp(physics.response / 30, 0.05, 1)), Delay: finite(clamp(physics.damping / 10, 0, 1)), Acceleration: finite(clamp(Math.abs(physics.inputScale), 0.1, 4)), Radius: 1 }
      ],
      Normalization: {
        Position: { Minimum: input.targetRange.min, Default: input.targetRange.default, Maximum: input.targetRange.max },
        Angle: { Minimum: -30, Default: 0, Maximum: 30 }
      }
    });
  }
  return {
    Version: 3,
    Meta: {
      PhysicsSettingCount: settings.length,
      TotalInputCount: settings.reduce((total, setting) => total + (setting.Input as unknown[]).length, 0),
      TotalOutputCount: settings.reduce((total, setting) => total + (setting.Output as unknown[]).length, 0),
      VertexCount: settings.length * 2,
      Fps: 30,
      EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
      PhysicsDictionary: project.model.physics.map((physics, index) => ({ Id: `PhysicsSettingPuppetLoom${safeFileId(physics.id)}`, Name: physics.name, Position: index }))
    },
    PhysicsSettings: settings
  };
}

function buildDisplayInfo(mappings: CubismParameterMapping[]): CubismDisplayInfoJson {
  const groups = [...new Set(mappings.map((mapping) => mapping.sourceGroup))];
  const groupIds = new Map(groups.map((group) => [group, `GroupPuppetLoom${pascalIdentifier(group)}`]));
  return {
    Version: 3,
    Parameters: mappings.flatMap((mapping) => mapping.targetIds.map((id) => ({ Id: id, GroupId: groupIds.get(mapping.sourceGroup)!, Name: mapping.sourceName }))),
    ParameterGroups: groups.map((group) => ({ Id: groupIds.get(group)!, GroupId: "", Name: group })),
    Parts: []
  };
}

export function generateCubismSidecars(project: PuppetLoomProject, mappings = createCubismParameterMappings(project.model.parameters)): CubismGeneratedSidecars {
  const issues: CubismCompatibilityIssue[] = [];
  const bySource = mappingMap(mappings);
  const expressions = project.model.expressions.map((expression) => {
    const parameters: Array<{ Id: string; Value: number; Blend: "Add" }> = [];
    for (const [sourceId, target] of Object.entries(expression.parameters)) {
      const mapping = bySource.get(sourceId);
      if (!mapping) continue;
      const targetValue = mapCubismParameterValue(mapping, target);
      const defaultValue = mapCubismParameterValue(mapping, mapping.sourceRange.default);
      for (const id of mapping.targetIds) parameters.push({ Id: id, Value: finite(targetValue - defaultValue), Blend: "Add" });
    }
    return {
      id: expression.id,
      name: expression.name,
      file: `puppetloom/expressions/${safeFileId(expression.id)}.exp3.json`,
      document: { Type: "Live2D Expression" as const, FadeInTime: 0.5, FadeOutTime: 0.5, Parameters: parameters }
    };
  });
  const motions = project.model.behaviors.map((behavior) => ({
    id: behavior.id,
    name: behavior.name,
    file: `puppetloom/motions/${safeFileId(behavior.id)}.motion3.json`,
    document: buildMotion(project, behavior, mappings, issues)
  }));
  const physics = buildPhysics(project, mappings);
  return {
    expressions,
    motions,
    ...(physics ? { physics: { file: "puppetloom/physics/puppetloom.physics3.json", document: physics } } : {}),
    displayInfo: { file: "puppetloom/model/puppetloom.cdi3.json", document: buildDisplayInfo(mappings) },
    issues
  };
}
