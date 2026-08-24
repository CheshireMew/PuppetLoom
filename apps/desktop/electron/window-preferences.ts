import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface StoredWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ControlWindowPreference {
  bounds?: StoredWindowBounds;
  maximized?: boolean;
}

export interface ViewerWindowPreference {
  bounds?: StoredWindowBounds;
  alwaysOnTop?: boolean;
  mouseTracking?: boolean;
  scale?: number;
}

export interface WindowPreferencesDocument {
  version: 2;
  control: ControlWindowPreference;
  viewerDefaults: { mouseTracking: boolean };
  viewers: Record<string, ViewerWindowPreference>;
  updatedAt: string;
}

const defaultDocument = (): WindowPreferencesDocument => ({
  version: 2,
  control: {},
  viewerDefaults: { mouseTracking: true },
  viewers: {},
  updatedAt: new Date(0).toISOString()
});

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBounds(value: unknown): StoredWindowBounds | undefined {
  if (!value || typeof value !== "object") return undefined;
  const bounds = value as Record<string, unknown>;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(finiteNumber)) return undefined;
  if ((bounds.width as number) <= 0 || (bounds.height as number) <= 0) return undefined;
  return { x: bounds.x as number, y: bounds.y as number, width: bounds.width as number, height: bounds.height as number };
}

function parseViewerPreference(value: unknown): ViewerWindowPreference {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const bounds = parseBounds(raw.bounds);
  return {
    ...(bounds ? { bounds } : {}),
    ...(typeof raw.alwaysOnTop === "boolean" ? { alwaysOnTop: raw.alwaysOnTop } : {}),
    ...(typeof raw.mouseTracking === "boolean" ? { mouseTracking: raw.mouseTracking } : {}),
    ...(finiteNumber(raw.scale) ? { scale: Math.max(0.35, Math.min(3, raw.scale)) } : {})
  };
}

export function parseWindowPreferences(value: unknown): WindowPreferencesDocument {
  if (!value || typeof value !== "object") return defaultDocument();
  const raw = value as Record<string, unknown>;
  if (raw.version === 1) {
    return {
      ...defaultDocument(),
      viewerDefaults: { mouseTracking: typeof raw.mouseTracking === "boolean" ? raw.mouseTracking : true },
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString()
    };
  }
  if (raw.version !== 2) return defaultDocument();
  const controlRaw = raw.control && typeof raw.control === "object" ? raw.control as Record<string, unknown> : {};
  const controlBounds = parseBounds(controlRaw.bounds);
  const defaultsRaw = raw.viewerDefaults && typeof raw.viewerDefaults === "object" ? raw.viewerDefaults as Record<string, unknown> : {};
  const viewersRaw = raw.viewers && typeof raw.viewers === "object" ? raw.viewers as Record<string, unknown> : {};
  return {
    version: 2,
    control: {
      ...(controlBounds ? { bounds: controlBounds } : {}),
      ...(typeof controlRaw.maximized === "boolean" ? { maximized: controlRaw.maximized } : {})
    },
    viewerDefaults: { mouseTracking: typeof defaultsRaw.mouseTracking === "boolean" ? defaultsRaw.mouseTracking : true },
    viewers: Object.fromEntries(Object.entries(viewersRaw).map(([key, preference]) => [key, parseViewerPreference(preference)])),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString()
  };
}

export function projectWindowPreferenceKey(projectDirectory: string): string {
  return resolve(projectDirectory).toLocaleLowerCase();
}

export function visibleWindowBounds(
  candidate: Partial<StoredWindowBounds> | undefined,
  workAreas: StoredWindowBounds[],
  fallbackSize: { width: number; height: number },
  minimumSize: { width: number; height: number },
  aspectRatio?: number
): StoredWindowBounds {
  const areas = workAreas.length > 0 ? workAreas : [{ x: 0, y: 0, width: fallbackSize.width, height: fallbackSize.height }];
  const requestedWidth = finiteNumber(candidate?.width) ? candidate.width : fallbackSize.width;
  const requestedHeight = finiteNumber(candidate?.height) ? candidate.height : fallbackSize.height;
  const requestedX = finiteNumber(candidate?.x) ? candidate.x : areas[0]!.x + (areas[0]!.width - requestedWidth) / 2;
  const requestedY = finiteNumber(candidate?.y) ? candidate.y : areas[0]!.y + (areas[0]!.height - requestedHeight) / 2;
  const centerX = requestedX + requestedWidth / 2;
  const centerY = requestedY + requestedHeight / 2;
  const area = areas.reduce((best, current) => {
    const bestDistance = Math.max(best.x - centerX, 0, centerX - (best.x + best.width)) ** 2 + Math.max(best.y - centerY, 0, centerY - (best.y + best.height)) ** 2;
    const currentDistance = Math.max(current.x - centerX, 0, centerX - (current.x + current.width)) ** 2 + Math.max(current.y - centerY, 0, centerY - (current.y + current.height)) ** 2;
    return currentDistance < bestDistance ? current : best;
  }, areas[0]!);
  let width = Math.min(area.width, Math.max(minimumSize.width, requestedWidth));
  let height = Math.min(area.height, Math.max(minimumSize.height, requestedHeight));
  if (aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0) {
    height = width / aspectRatio;
    if (height > area.height) {
      height = area.height;
      width = height * aspectRatio;
    }
    if (width < minimumSize.width && minimumSize.width <= area.width) {
      width = minimumSize.width;
      height = Math.min(area.height, width / aspectRatio);
    }
  }
  width = Math.round(width);
  height = Math.round(height);
  const x = Math.round(Math.max(area.x, Math.min(requestedX, area.x + area.width - width)));
  const y = Math.round(Math.max(area.y, Math.min(requestedY, area.y + area.height - height)));
  return { x, y, width, height };
}

export class WindowPreferencesStore {
  readonly path: string;
  private document: WindowPreferencesDocument;
  private readonly onWriteFailure: ((cause: unknown) => void) | undefined;

  constructor(path: string, onWriteFailure?: (cause: unknown) => void) {
    this.path = path;
    this.onWriteFailure = onWriteFailure;
    try {
      this.document = parseWindowPreferences(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch {
      this.document = defaultDocument();
    }
  }

  control(): ControlWindowPreference {
    return structuredClone(this.document.control);
  }

  viewer(projectDirectory: string): ViewerWindowPreference {
    return {
      mouseTracking: this.document.viewerDefaults.mouseTracking,
      ...(this.document.viewers[projectWindowPreferenceKey(projectDirectory)] ?? {})
    };
  }

  updateControl(patch: ControlWindowPreference): void {
    this.document.control = { ...this.document.control, ...patch };
    this.write();
  }

  updateViewer(projectDirectory: string, patch: ViewerWindowPreference): void {
    const key = projectWindowPreferenceKey(projectDirectory);
    this.document.viewers[key] = { ...(this.document.viewers[key] ?? {}), ...patch };
    if (typeof patch.mouseTracking === "boolean") this.document.viewerDefaults.mouseTracking = patch.mouseTracking;
    this.write();
  }

  snapshot(): WindowPreferencesDocument {
    return structuredClone(this.document);
  }

  private write(): void {
    this.document.updatedAt = new Date().toISOString();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporaryPath = this.path + ".writing-" + process.pid;
      writeFileSync(temporaryPath, JSON.stringify(this.document, null, 2) + "\n", "utf8");
      renameSync(temporaryPath, this.path);
    } catch (cause) {
      this.onWriteFailure?.(cause);
    }
  }
}
