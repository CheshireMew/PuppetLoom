import { parentPort } from "node:worker_threads";
import {
  createProject,
  inspectPsd,
  loadCalibrationWorkspace,
  loadProject,
  loadProjectRevision,
  verifyProject
} from "@puppetloom/core";
import type { ProjectWorkerCreateResult, ProjectWorkerRequest } from "./project-worker-client.js";

if (!parentPort) throw new Error("项目后台任务缺少父线程。" );

let controller: AbortController | undefined;
let running = false;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

parentPort.on("message", (message: { kind: "run"; request: ProjectWorkerRequest } | { kind: "cancel" }) => {
  if (message.kind === "cancel") {
    controller?.abort(new Error("用户已停止创建；最终项目目录没有被发布。"));
    return;
  }
  if (running) return;
  running = true;
  void run(message.request).then(
    (result) => parentPort!.postMessage({ kind: "result", result }),
    (cause) => parentPort!.postMessage({
      kind: "error",
      error: messageOf(cause),
      ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {})
    })
  );
});

async function run(request: ProjectWorkerRequest): Promise<unknown> {
  if (request.operation === "inspect") return inspectPsd(request.input, { alphaCleanup: request.alphaCleanup ?? "automatic" });
  if (request.operation === "load-project") {
    return request.revision === undefined
      ? loadProject(request.directory)
      : loadProjectRevision(request.directory, request.revision);
  }
  if (request.operation === "load-workspace") return loadCalibrationWorkspace(request.directory);
  controller = new AbortController();
  const input = request.request;
  const result = await createProject({
    input: input.input,
    output: input.output,
    seed: input.seed ?? 42,
    alphaCleanup: input.alphaCleanup ?? "automatic",
    signal: controller.signal,
    onProgress: (phase) => parentPort!.postMessage({ kind: "progress", phase }),
    ...(input.reference ? { reference: input.reference } : {}),
    ...(input.name ? { name: input.name } : {})
  });
  const response: ProjectWorkerCreateResult = {
    outputDirectory: result.outputDirectory,
    report: result.report,
    verify: await verifyProject(result.outputDirectory),
    project: result.project
  };
  return response;
}
