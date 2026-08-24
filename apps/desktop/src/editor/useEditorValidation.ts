import { useCallback, useEffect, useRef, useState } from "react";
import type { PoseValidation, PuppetLoomProject } from "@puppetloom/core";
import { editorPoses } from "./EditorWorkspaceModel.js";
import type {
  EditorValidationRequest,
  EditorValidationResponse,
  EditorValidationResult
} from "./editor-validation.worker.js";

interface ValidationOperation {
  promise: Promise<EditorValidationResult>;
  cancel: () => void;
}

function startValidation(project: PuppetLoomProject): ValidationOperation {
  const worker = new Worker(new URL("./editor-validation.worker.ts", import.meta.url), { type: "module" });
  let settled = false;
  let rejectOperation: (cause: Error) => void = () => undefined;
  const promise = new Promise<EditorValidationResult>((resolve, reject) => {
    rejectOperation = reject;
    worker.onmessage = (event: MessageEvent<EditorValidationResponse>) => {
      settled = true;
      worker.terminate();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      settled = true;
      worker.terminate();
      reject(new Error(event.message || "编辑器后台安全检查失败。"));
    };
    const request: EditorValidationRequest = {
      project,
      poses: Object.entries(editorPoses).map(([id, item]) => ({ id, state: item.state }))
    };
    worker.postMessage(request);
  });
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectOperation(new Error("编辑器后台安全检查已由更新的草稿替代。"));
    }
  };
}

export function validateEditorProject(project: PuppetLoomProject): Promise<EditorValidationResult> {
  return startValidation(project).promise;
}

export function useEditorValidation(project: PuppetLoomProject | undefined): {
  poseChecks: Record<string, PoseValidation>;
  draftSafetyChecks: PoseValidation[];
  error: string;
  validateNow: (candidate: PuppetLoomProject) => Promise<EditorValidationResult>;
} {
  const generation = useRef(0);
  const [poseChecks, setPoseChecks] = useState<Record<string, PoseValidation>>({});
  const [draftSafetyChecks, setDraftSafetyChecks] = useState<PoseValidation[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!project) return;
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    let operation: ValidationOperation | undefined;
    const timeout = window.setTimeout(() => {
      operation = startValidation(project);
      void operation.promise.then((result) => {
        if (generation.current !== currentGeneration) return;
        setPoseChecks(result.poseChecks);
        setDraftSafetyChecks(result.draftSafetyChecks);
        setError("");
      }).catch((cause) => {
        if (generation.current !== currentGeneration) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 240);
    return () => {
      window.clearTimeout(timeout);
      operation?.cancel();
    };
  }, [project]);

  const validateNow = useCallback((candidate: PuppetLoomProject) => validateEditorProject(candidate), []);
  return { poseChecks, draftSafetyChecks, error, validateNow };
}
