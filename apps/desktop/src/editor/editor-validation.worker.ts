/// <reference lib="webworker" />

import type { MotionState, PoseValidation, PuppetLoomProject } from "@puppetloom/core";
import { validateProjectPoses, validatePose } from "@puppetloom/core/browser";

export interface EditorValidationRequest {
  project: PuppetLoomProject;
  poses: Array<{ id: string; state: MotionState }>;
}

export interface EditorValidationResult {
  poseChecks: Record<string, PoseValidation>;
  draftSafetyChecks: PoseValidation[];
}

export type EditorValidationResponse =
  | { ok: true; result: EditorValidationResult }
  | { ok: false; error: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

self.onmessage = (event: MessageEvent<EditorValidationRequest>): void => {
  try {
    const { project, poses } = event.data;
    const result: EditorValidationResult = {
      poseChecks: Object.fromEntries(poses.map(({ id, state }) => [id, validatePose(project, id, state)])),
      draftSafetyChecks: validateProjectPoses(project)
    };
    const response: EditorValidationResponse = { ok: true, result };
    self.postMessage(response);
  } catch (cause) {
    const response: EditorValidationResponse = { ok: false, error: messageOf(cause) };
    self.postMessage(response);
  }
};

export {};
