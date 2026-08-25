import { Worker } from "node:worker_threads";
import type { PuppetLoomProject, SourcePreparationTask, VerifyResult } from "@puppetloom/core";
import type { DesktopCreateRequest, EditorWorkspace } from "./global.js";

export type ProjectWorkerRequest =
  | { operation: "inspect"; input: string; alphaCleanup: DesktopCreateRequest["alphaCleanup"] }
  | { operation: "create"; request: DesktopCreateRequest }
  | { operation: "load-project"; directory: string; revision?: number }
  | { operation: "load-workspace"; directory: string }
  | { operation: "project-health"; directory: string }
  | { operation: "project-library"; root: string; maxDepth?: number; maximumProjects?: number }
  | { operation: "source-prepare"; reference: string; output: string; name?: string; provider?: SourcePreparationTask["decomposition"]["provider"] }
  | { operation: "source-review"; task: string; psd: string }
  | { operation: "source-finalize"; task: string; review: number; decision: "ready" | "needs-repair"; note: string };

export interface ProjectWorkerCreateResult {
  outputDirectory: string;
  report: unknown;
  verify: VerifyResult;
  project: PuppetLoomProject;
}

export type ProjectWorkerResult = unknown | ProjectWorkerCreateResult | PuppetLoomProject | EditorWorkspace;

type ProjectWorkerMessage =
  | { kind: "progress"; phase: unknown }
  | { kind: "result"; result: ProjectWorkerResult }
  | { kind: "error"; error: string; stack?: string };

export interface ProjectWorkerOperation<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export function startProjectWorker<T>(request: ProjectWorkerRequest, onProgress?: (phase: unknown) => void): ProjectWorkerOperation<T> {
  const worker = new Worker(new URL("./project-worker.js", import.meta.url));
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => {
    worker.on("message", (message: ProjectWorkerMessage) => {
      if (message.kind === "progress") {
        onProgress?.(message.phase);
        return;
      }
      settled = true;
      void worker.terminate();
      if (message.kind === "result") resolve(message.result as T);
      else {
        const error = new Error(message.error);
        if (message.stack) error.stack = message.stack;
        reject(error);
      }
    });
    worker.once("error", (cause) => {
      if (settled) return;
      settled = true;
      reject(cause);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`项目后台任务意外退出（code ${code}）。`));
    });
    worker.postMessage({ kind: "run", request });
  });
  return {
    promise,
    cancel: () => {
      if (settled) return;
      worker.postMessage({ kind: "cancel" });
    }
  };
}

export async function runProjectWorker<T>(request: ProjectWorkerRequest, onProgress?: (phase: unknown) => void): Promise<T> {
  return startProjectWorker<T>(request, onProgress).promise;
}
