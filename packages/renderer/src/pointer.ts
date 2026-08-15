export interface PointerLookTarget {
  x: number;
  y: number;
  strength: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScreenRect extends ScreenPoint {
  width: number;
  height: number;
}

export interface NormalizedLookOrigin {
  x: number;
  y: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function shapedAxis(value: number): number {
  const clamped = clamp(value, -1, 1);
  const magnitude = Math.abs(clamped);
  const deadZone = 0.025;
  if (magnitude <= deadZone) return 0;
  const normalized = (magnitude - deadZone) / (1 - deadZone);
  return Math.sign(clamped) * Math.pow(normalized, 0.86);
}

export function pointerTargetFromScreen(
  cursor: ScreenPoint,
  windowBounds: ScreenRect,
  workArea: ScreenRect,
  lookOrigin: NormalizedLookOrigin = { x: 0.5, y: 0.2 }
): PointerLookTarget {
  const centerX = windowBounds.x + windowBounds.width * clamp(lookOrigin.x, 0, 1);
  const centerY = windowBounds.y + windowBounds.height * clamp(lookOrigin.y, 0, 1);
  const horizontalReach = Math.max(windowBounds.width * 0.9, workArea.width * 0.36);
  const verticalReach = Math.max(windowBounds.height * 0.5, workArea.height * 0.36);
  return {
    x: shapedAxis((cursor.x - centerX) / horizontalReach),
    y: shapedAxis((cursor.y - centerY) / verticalReach),
    strength: 1
  };
}
