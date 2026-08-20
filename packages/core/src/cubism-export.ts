import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import sharp from "sharp";
import { PuppetLoomError } from "./errors.js";
import { buildCubismExportPlan, generateCubismSidecars } from "./cubism-format.js";
import type {
  CubismDisplayInfoJson,
  CubismFinalizeOptions,
  CubismFinalizeResult,
  CubismGeneratedSidecars,
  CubismHandoffManifest,
  CubismModel3Json,
  CubismPhysicsJson,
  CubismPrepareResult,
  CubismVerificationIssue,
  CubismVerificationResult
} from "./cubism-types.js";
import { loadCalibration, loadProject } from "./project.js";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function jsonPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function safeReference(root: string, reference: string): string {
  if (!reference || isAbsolute(reference)) throw new Error(`Cubism 引用必须是相对路径：${reference || "<empty>"}`);
  const target = resolve(root, reference);
  const relation = relative(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Cubism 引用越过模型目录：${reference}`);
  return target;
}

function referencedFiles(model: CubismModel3Json): string[] {
  const files = new Set<string>();
  const references = model.FileReferences;
  for (const value of [references.Moc, references.Physics, references.Pose, references.DisplayInfo, references.UserData]) {
    if (typeof value === "string" && value) files.add(jsonPath(value));
  }
  for (const texture of references.Textures ?? []) if (typeof texture === "string" && texture) files.add(jsonPath(texture));
  for (const expression of references.Expressions ?? []) if (typeof expression.File === "string" && expression.File) files.add(jsonPath(expression.File));
  for (const motions of Object.values(references.Motions ?? {})) {
    for (const motion of motions) {
      for (const key of ["File", "Sound"] as const) {
        const value = motion[key];
        if (typeof value === "string" && value) files.add(jsonPath(value));
      }
    }
  }
  return [...files].sort();
}

function parseModel3(raw: unknown, path: string): CubismModel3Json {
  if (!raw || typeof raw !== "object") throw new Error(`${path} 不是 JSON 对象。`);
  const model = raw as Partial<CubismModel3Json>;
  if (model.Version !== 3) throw new Error(`${path} 的 Version 必须为 3。`);
  if (!model.FileReferences || typeof model.FileReferences !== "object") throw new Error(`${path} 缺少 FileReferences。`);
  if (typeof model.FileReferences.Moc !== "string" || model.FileReferences.Moc.length === 0) throw new Error(`${path} 缺少 FileReferences.Moc。`);
  if (!Array.isArray(model.FileReferences.Textures)) throw new Error(`${path} 的 FileReferences.Textures 必须是数组。`);
  return raw as CubismModel3Json;
}

async function readModel3(path: string): Promise<CubismModel3Json> {
  try { return parseModel3(JSON.parse(await readFile(path, "utf8")), path); }
  catch (error) { throw new PuppetLoomError("INVALID_INPUT", `无法读取 Cubism model3.json：${path}`, { cause: error }); }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(root, path));
    else if (entry.isFile()) output.push(jsonPath(relative(root, path)));
  }
  return output.sort();
}

async function writeSidecars(root: string, sidecars: CubismGeneratedSidecars): Promise<void> {
  for (const expression of sidecars.expressions) await writeJson(safeReference(root, expression.file), expression.document);
  for (const motion of sidecars.motions) await writeJson(safeReference(root, motion.file), motion.document);
  if (sidecars.physics) await writeJson(safeReference(root, sidecars.physics.file), sidecars.physics.document);
  await writeJson(safeReference(root, sidecars.displayInfo.file), sidecars.displayInfo.document);
}

function mergeById<T extends { Id: string }>(left: T[], right: T[]): T[] {
  const values = new Map(left.map((value) => [value.Id, value]));
  for (const value of right) values.set(value.Id, value);
  return [...values.values()];
}

function mergeDisplayInfo(existing: CubismDisplayInfoJson | undefined, generated: CubismDisplayInfoJson): CubismDisplayInfoJson {
  if (!existing) return generated;
  return {
    Version: 3,
    Parameters: mergeById(existing.Parameters ?? [], generated.Parameters),
    ParameterGroups: mergeById(existing.ParameterGroups ?? [], generated.ParameterGroups),
    Parts: mergeById(existing.Parts ?? [], generated.Parts)
  };
}

function mergePhysics(existing: CubismPhysicsJson | undefined, generated: CubismPhysicsJson): CubismPhysicsJson {
  if (!existing) return generated;
  const settings = [...(Array.isArray(existing.PhysicsSettings) ? existing.PhysicsSettings : []), ...generated.PhysicsSettings];
  const dictionary = [
    ...(Array.isArray(existing.Meta.PhysicsDictionary) ? existing.Meta.PhysicsDictionary as unknown[] : []),
    ...(Array.isArray(generated.Meta.PhysicsDictionary) ? generated.Meta.PhysicsDictionary as unknown[] : [])
  ];
  const count = (key: string): number => settings.reduce((total, setting) => total + (Array.isArray(setting[key]) ? setting[key].length : 0), 0);
  return {
    Version: 3,
    Meta: {
      ...existing.Meta,
      PhysicsSettingCount: settings.length,
      TotalInputCount: count("Input"),
      TotalOutputCount: count("Output"),
      VertexCount: count("Vertices"),
      PhysicsDictionary: dictionary
    },
    PhysicsSettings: settings
  };
}

async function readOptionalJson<T>(path: string | undefined): Promise<T | undefined> {
  if (!path) return undefined;
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { return undefined; }
}

export async function prepareCubismExport(projectDirectory: string, output: string): Promise<CubismPrepareResult> {
  const outputDirectory = resolve(output);
  if (await exists(outputDirectory)) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `准备目录必须尚未存在：${outputDirectory}`);
  const [project, calibration] = await Promise.all([loadProject(resolve(projectDirectory)), loadCalibration(resolve(projectDirectory))]);
  const plan = buildCubismExportPlan(project, calibration.revision);
  const sidecars = generateCubismSidecars(project, plan.mappings);
  plan.issues.push(...sidecars.issues);
  plan.strictReady = !plan.issues.some((issue) => issue.severity === "blocking");
  const parent = dirname(outputDirectory);
  const staging = join(parent, `.${basename(outputDirectory)}.cubism-prepare-${randomUUID()}`);
  const projectRoot = resolve(projectDirectory);
  const generatedSidecars = [
    ...sidecars.expressions.map((item) => item.file),
    ...sidecars.motions.map((item) => item.file),
    ...(sidecars.physics ? [sidecars.physics.file] : []),
    sidecars.displayInfo.file
  ];
  const handoff: CubismHandoffManifest = {
    version: 1,
    kind: "puppetloom-cubism-handoff",
    createdAt: new Date().toISOString(),
    source: {
      projectDirectory: projectRoot,
      projectName: project.name,
      revision: calibration.revision,
      fingerprint: createHash("sha256").update(JSON.stringify({ revision: calibration.revision, project })).digest("hex"),
      psd: resolve(projectRoot, project.source.psdPath)
    },
    readiness: {
      strictAutomaticSync: plan.strictReady,
      partialSyncAvailable: plan.partialSyncAvailable,
      officialMoc3Present: false,
      readyForRuntimeDelivery: false
    },
    blockedAutomation: plan.issues.filter((issue) => issue.severity === "blocking"),
    generatedSidecars,
    editorSteps: [
      { id: "open-source", owner: "operator", required: true, instruction: "在 Cubism Editor 中从源 PSD 建立或打开建模文件，确认 ArtMesh 名称可唯一对应 PSD 图层名。" },
      { id: "grant-api", owner: "Cubism Editor", required: true, instruction: "开启外部应用程序集成并授予 PuppetLoom Allow；需要结构同步时还要授予 Edit。" },
      { id: "validate-pre-sync", owner: "PuppetLoom", required: true, instruction: "运行 cubism editor validate --stage pre-sync，先解决对象缺失、参数范围冲突和 Editor 模式问题。" },
      { id: "sync", owner: "PuppetLoom", required: true, instruction: `运行 cubism editor sync${plan.strictReady ? "" : " --allow-partial"}；部分同步不会声称已写入官方 API 不支持的网格关键形态。` },
      { id: "manual-geometry", owner: "operator", required: !plan.strictReady, instruction: "在 Editor 中人工补齐 blockedAutomation 所列网格、Warp 或程序化变形，并检查遮挡、轮廓和极限姿态。" },
      { id: "validate-post-sync", owner: "PuppetLoom", required: true, instruction: "运行 cubism editor validate --stage post-sync，确认参数、范围和对象覆盖；几何视觉项仍需人工签核。" },
      { id: "export-official-runtime", owner: "Cubism Editor", required: true, instruction: "由 Cubism Editor 官方导出 moc3、model3.json 和纹理。PuppetLoom 不生成或伪造 moc3。" },
      { id: "finalize-and-verify", owner: "PuppetLoom", required: true, instruction: "运行 cubism finalize 合并侧车，再运行 cubism verify 验证全部引用和 MOC3 文件头。" }
    ],
    finalCommands: [
      `puppetloom cubism editor validate --project \"${projectRoot}\" --stage pre-sync`,
      `puppetloom cubism editor sync --project \"${projectRoot}\"${plan.strictReady ? "" : " --allow-partial"}`,
      `puppetloom cubism editor validate --project \"${projectRoot}\" --stage post-sync`,
      `puppetloom cubism finalize --project \"${projectRoot}\" --editor-model <Editor导出的model3.json> --output <新的运行时目录>`,
      "puppetloom cubism verify --model <最终运行时目录中的model3.json>"
    ]
  };
  try {
    await mkdir(staging, { recursive: false });
    await writeSidecars(staging, sidecars);
    await writeJson(join(staging, "puppetloom", "cubism-bridge.json"), plan);
    await writeJson(join(staging, "puppetloom", "handoff.json"), handoff);
    await writeJson(join(staging, "puppetloom", "editor-checklist.json"), {
      version: 1,
      sourceFingerprint: handoff.source.fingerprint,
      sourceRevision: handoff.source.revision,
      items: handoff.editorSteps.map((step) => ({ ...step, status: "pending", evidence: "" }))
    });
    await writeFile(join(staging, "HANDOFF.md"), `# ${project.name} 的 Cubism 官方交接\n\n来源 revision：${calibration.revision}\n\n自动严格同步：${plan.strictReady ? "可用" : "不可用"}。当前目录不含 moc3，也不是可交付运行时。\n\n## 自动化阻断项\n\n${handoff.blockedAutomation.length ? handoff.blockedAutomation.map((issue) => `- [${issue.code}] ${issue.message}`).join("\n") : "- 无"}\n\n## 必须完成\n\n${handoff.editorSteps.map((step) => `- [ ] ${step.instruction}`).join("\n")}\n`, "utf8");
    await writeJson(join(staging, "README.json"), {
      format: "PuppetLoom Cubism bridge workspace",
      next: "在 Cubism Editor 5.4 alpha 或更新版本中同步可写结构，再由 Editor 导出 moc3/model3.json；最后运行 puppetloom cubism finalize。",
      strictReady: plan.strictReady
    });
    const files = await listFiles(staging);
    await rename(staging, outputDirectory);
    return { outputDirectory, plan, handoff, files };
  } catch (error) {
    throw new PuppetLoomError("IO_ERROR", `Cubism 准备失败；未发布内容保留在 ${staging}`, { cause: error });
  }
}

export async function verifyCubismModel(modelPath: string): Promise<CubismVerificationResult> {
  const absoluteModel = resolve(modelPath);
  const root = dirname(absoluteModel);
  const issues: CubismVerificationIssue[] = [];
  let model: CubismModel3Json;
  try { model = parseModel3(JSON.parse(await readFile(absoluteModel, "utf8")), absoluteModel); }
  catch (error) {
    return { valid: false, model: absoluteModel, moc: "", textures: [], referencedFiles: [], issues: [{ code: "INVALID_MODEL3", severity: "error", message: error instanceof Error ? error.message : String(error), path: absoluteModel }] };
  }
  const references = referencedFiles(model);
  for (const reference of references) {
    let path: string;
    try { path = safeReference(root, reference); }
    catch (error) {
      issues.push({ code: "UNSAFE_REFERENCE", severity: "error", message: error instanceof Error ? error.message : String(error), path: reference });
      continue;
    }
    if (!await exists(path)) {
      issues.push({ code: "MISSING_REFERENCE", severity: "error", message: `缺少引用文件：${reference}`, path: reference });
      continue;
    }
    if (extname(path).toLowerCase() === ".json") {
      try { JSON.parse(await readFile(path, "utf8")); }
      catch { issues.push({ code: "INVALID_JSON_REFERENCE", severity: "error", message: `引用文件不是有效 JSON：${reference}`, path: reference }); }
    }
  }
  const mocReference = jsonPath(model.FileReferences.Moc);
  try {
    const path = safeReference(root, mocReference);
    const handle = await open(path, "r");
    try {
      const header = Buffer.alloc(4);
      const { bytesRead } = await handle.read(header, 0, 4, 0);
      if (bytesRead !== 4 || header.toString("ascii") !== "MOC3") issues.push({ code: "INVALID_MOC3_HEADER", severity: "error", message: `${mocReference} 没有官方 moc3 的 MOC3 文件头。`, path: mocReference });
    } finally { await handle.close(); }
  } catch {
    if (!issues.some((issue) => issue.path === mocReference)) issues.push({ code: "MISSING_MOC3", severity: "error", message: `无法读取 moc3：${mocReference}`, path: mocReference });
  }
  for (const texture of model.FileReferences.Textures) {
    try { await sharp(safeReference(root, texture)).metadata(); }
    catch { issues.push({ code: "INVALID_TEXTURE", severity: "error", message: `纹理无法解码：${texture}`, path: texture }); }
  }
  if (model.FileReferences.Textures.length === 0) issues.push({ code: "NO_TEXTURES", severity: "warning", message: "model3.json 没有纹理引用。" });
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    model: absoluteModel,
    moc: mocReference,
    textures: model.FileReferences.Textures.map(jsonPath),
    referencedFiles: references,
    issues
  };
}

export async function finalizeCubismExport(options: CubismFinalizeOptions): Promise<CubismFinalizeResult> {
  const projectDirectory = resolve(options.project);
  const editorModelPath = resolve(options.editorModel);
  const sourceRoot = dirname(editorModelPath);
  const outputDirectory = resolve(options.output);
  if (sourceRoot === outputDirectory) throw new PuppetLoomError("INVALID_INPUT", "最终导出目录不能与 Cubism Editor 的运行时目录相同。" );
  if (await exists(outputDirectory)) throw new PuppetLoomError("OUTPUT_NOT_EMPTY", `最终导出目录必须尚未存在：${outputDirectory}`);
  const [project, calibration, editorModel] = await Promise.all([
    loadProject(projectDirectory), loadCalibration(projectDirectory), readModel3(editorModelPath)
  ]);
  const plan = buildCubismExportPlan(project, calibration.revision);
  const sidecars = generateCubismSidecars(project, plan.mappings);
  plan.issues.push(...sidecars.issues);
  plan.strictReady = !plan.issues.some((issue) => issue.severity === "blocking");
  const parent = dirname(outputDirectory);
  const staging = join(parent, `.${basename(outputDirectory)}.cubism-finalize-${randomUUID()}`);
  const finalModelName = basename(editorModelPath);
  try {
    await mkdir(staging, { recursive: false });
    for (const reference of referencedFiles(editorModel)) {
      const source = safeReference(sourceRoot, reference);
      const target = safeReference(staging, reference);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }

    if (sidecars.physics) {
      const existing = await readOptionalJson<CubismPhysicsJson>(editorModel.FileReferences.Physics ? safeReference(sourceRoot, editorModel.FileReferences.Physics) : undefined);
      sidecars.physics.document = mergePhysics(existing, sidecars.physics.document);
    }
    const existingDisplay = await readOptionalJson<CubismDisplayInfoJson>(editorModel.FileReferences.DisplayInfo ? safeReference(sourceRoot, editorModel.FileReferences.DisplayInfo) : undefined);
    sidecars.displayInfo.document = mergeDisplayInfo(existingDisplay, sidecars.displayInfo.document);
    await writeSidecars(staging, sidecars);

    const existingExpressions = editorModel.FileReferences.Expressions ?? [];
    const existingMotions = editorModel.FileReferences.Motions ?? {};
    const groups = [...(editorModel.Groups ?? [])];
    const eyeIds = plan.mappings.filter((mapping) => mapping.semantic === "blink").flatMap((mapping) => mapping.targetIds);
    const lipIds = plan.mappings.filter((mapping) => mapping.semantic === "mouth-open").flatMap((mapping) => mapping.targetIds);
    const setGroup = (name: "EyeBlink" | "LipSync", ids: string[]): void => {
      if (ids.length === 0) return;
      const index = groups.findIndex((group) => group.Name === name && group.Target === "Parameter");
      const value = { Target: "Parameter" as const, Name: name, Ids: [...new Set([...(index >= 0 ? groups[index]!.Ids : []), ...ids])] };
      if (index >= 0) groups[index] = value;
      else groups.push(value);
    };
    setGroup("EyeBlink", eyeIds);
    setGroup("LipSync", lipIds);
    const mergedModel: CubismModel3Json = {
      ...editorModel,
      Version: 3,
      FileReferences: {
        ...editorModel.FileReferences,
        Textures: editorModel.FileReferences.Textures.map(jsonPath),
        ...(sidecars.physics ? { Physics: sidecars.physics.file } : {}),
        DisplayInfo: sidecars.displayInfo.file,
        Expressions: [
          ...existingExpressions,
          ...sidecars.expressions.map((expression) => ({ Name: `PuppetLoom/${expression.id}`, File: expression.file }))
        ],
        Motions: {
          ...existingMotions,
          PuppetLoom: [
            ...(existingMotions.PuppetLoom ?? []),
            ...sidecars.motions.map((motion) => ({ File: motion.file, FadeInTime: 0.5, FadeOutTime: 0.5 }))
          ]
        }
      },
      Groups: groups
    };
    const modelTarget = join(staging, finalModelName);
    await writeJson(modelTarget, mergedModel);
    await writeJson(join(staging, "puppetloom", "cubism-bridge.json"), {
      ...plan,
      sourceProject: projectDirectory,
      editorModel: editorModelPath,
      finalizedAt: new Date().toISOString()
    });
    const verification = await verifyCubismModel(modelTarget);
    if (!verification.valid) throw new Error(`最终 Cubism 目录未通过验证：${verification.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join("；")}`);
    await writeJson(join(staging, "puppetloom", "official-runtime-verification.json"), {
      version: 1,
      kind: "puppetloom-cubism-runtime-verification",
      verifiedAt: new Date().toISOString(),
      sourceProject: projectDirectory,
      sourceRevision: calibration.revision,
      editorModel: editorModelPath,
      verification
    });
    const files = await listFiles(staging);
    await rename(staging, outputDirectory);
    return {
      outputDirectory,
      modelPath: join(outputDirectory, finalModelName),
      plan,
      verification: { ...verification, model: join(outputDirectory, finalModelName) },
      files
    };
  } catch (error) {
    throw new PuppetLoomError("IO_ERROR", `Cubism 最终导出失败；未发布内容保留在 ${staging}`, { cause: error });
  }
}
