import type { CalibrationOverrides, MotionState } from "@puppetloom/core";
import { mergeCalibrationOverridesForPreview, neutralMotionState } from "@puppetloom/core/browser";
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CircleDot,
  type LucideIcon
} from "lucide-react";

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pose(overrides: Partial<MotionState>): MotionState {
  return {
    ...neutralMotionState,
    ...overrides,
    bodySway: overrides.headYaw === undefined ? 0 : overrides.headYaw * 0.5,
    bodyPitch: overrides.headPitch === undefined ? 0 : overrides.headPitch * 0.38,
    gazeX: overrides.headYaw === undefined ? 0 : overrides.headYaw * 0.45,
    gazeY: overrides.headPitch === undefined ? 0 : overrides.headPitch * 0.3
  };
}

export const editorPoses: Record<string, { label: string; state: MotionState; icon: LucideIcon }> = {
  neutral: { label: "中立", state: pose({}), icon: CircleDot }, left: { label: "左转", state: pose({ headYaw: -1 }), icon: ArrowLeft }, right: { label: "右转", state: pose({ headYaw: 1 }), icon: ArrowRight },
  up: { label: "向上看", state: pose({ headPitch: -1 }), icon: ArrowUp }, down: { label: "向下看", state: pose({ headPitch: 1 }), icon: ArrowDown },
  "left-up": { label: "左上", state: pose({ headYaw: -1, headPitch: -1 }), icon: ArrowUpLeft }, "right-up": { label: "右上", state: pose({ headYaw: 1, headPitch: -1 }), icon: ArrowUpRight },
  "left-down": { label: "左下", state: pose({ headYaw: -1, headPitch: 1 }), icon: ArrowDownLeft }, "right-down": { label: "右下", state: pose({ headYaw: 1, headPitch: 1 }), icon: ArrowDownRight }
};

export function layerOverride(overrides: CalibrationOverrides, layerId: string, patch: NonNullable<CalibrationOverrides["layers"]>[string]): CalibrationOverrides {
  return mergeCalibrationOverridesForPreview(overrides, { layers: { [layerId]: patch } });
}

export function relativeProjectPath(root: string, absolute: string): string {
  return absolute.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
}

export function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select");
}
