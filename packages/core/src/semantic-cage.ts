import { clamp } from "./math.js";
import type { ImportedLayer, ImportedPsd } from "./psd.js";
import type {
  Point,
  Rect,
  SemanticCagePoint,
  SemanticCagePointId,
  SemanticCageTriangle,
  SemanticControlCage,
  SemanticRole
} from "./types.js";

interface AlphaRect extends Rect {
  count: number;
}

interface HorizontalExtent {
  left: number;
  right: number;
  count: number;
}

const faceRoles: SemanticRole[] = ["face", "eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "nose", "mouth"];
const skullRoles: SemanticRole[] = ["frontHair", "backHair", "sideHair", "headwear", "ear"];

export const semanticFaceTriangles: SemanticCageTriangle[] = [
  ["forehead", "faceLeft", "eyeLeftOuter"],
  ["forehead", "eyeLeftOuter", "eyeLeftInner"],
  ["forehead", "eyeLeftInner", "nose"],
  ["forehead", "nose", "eyeRightInner"],
  ["forehead", "eyeRightInner", "eyeRightOuter"],
  ["forehead", "eyeRightOuter", "faceRight"],
  ["faceLeft", "cheekLeft", "eyeLeftOuter"],
  ["eyeLeftOuter", "cheekLeft", "eyeLeftInner"],
  ["eyeLeftInner", "cheekLeft", "nose"],
  ["nose", "cheekLeft", "mouthLeft"],
  ["nose", "mouthLeft", "mouth"],
  ["nose", "mouth", "mouthRight"],
  ["nose", "mouthRight", "cheekRight"],
  ["nose", "cheekRight", "eyeRightInner"],
  ["eyeRightInner", "cheekRight", "eyeRightOuter"],
  ["eyeRightOuter", "cheekRight", "faceRight"],
  ["cheekLeft", "jawLeft", "mouthLeft"],
  ["mouthLeft", "jawLeft", "chin"],
  ["mouthLeft", "chin", "mouth"],
  ["mouth", "chin", "mouthRight"],
  ["mouthRight", "chin", "jawRight"],
  ["mouthRight", "jawRight", "cheekRight"]
];

export const semanticSkullTriangles: SemanticCageTriangle[] = [
  ["headTop", "skullLeft", "forehead"],
  ["headTop", "forehead", "skullRight"],
  ["skullLeft", "faceLeft", "forehead"],
  ["forehead", "faceRight", "skullRight"],
  ["skullLeft", "faceLeft", "chin"],
  ["skullLeft", "chin", "skullRight"],
  ["chin", "faceRight", "skullRight"]
];

function round(value: number): number {
  return Number(value.toFixed(6));
}

function roundPoint(point: Point): Point {
  return { x: round(point.x), y: round(point.y) };
}

function alphaRect(layer: ImportedLayer): AlphaRect | undefined {
  const { width, height, data } = layer.pixels;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
    }
  }
  if (count === 0) return undefined;
  return {
    x: layer.bounds.x + minX,
    y: layer.bounds.y + minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    count
  };
}

function extentAtY(layer: ImportedLayer, targetY: number, band: number): HorizontalExtent | undefined {
  const localStart = Math.max(0, Math.floor(targetY - band - layer.bounds.y));
  const localEnd = Math.min(layer.pixels.height - 1, Math.ceil(targetY + band - layer.bounds.y));
  if (localEnd < localStart) return undefined;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (let y = localStart; y <= localEnd; y += 1) {
    for (let x = 0; x < layer.pixels.width; x += 1) {
      if ((layer.pixels.data[(y * layer.pixels.width + x) * 4 + 3] ?? 0) <= 8) continue;
      left = Math.min(left, layer.bounds.x + x);
      right = Math.max(right, layer.bounds.x + x);
      count += 1;
    }
  }
  return count > 0 ? { left, right, count } : undefined;
}

function combinedExtentAtY(layers: ImportedLayer[], targetY: number, band: number): HorizontalExtent | undefined {
  const extents = layers.map((layer) => extentAtY(layer, targetY, band)).filter((extent): extent is HorizontalExtent => Boolean(extent));
  if (extents.length === 0) return undefined;
  return {
    left: Math.min(...extents.map((extent) => extent.left)),
    right: Math.max(...extents.map((extent) => extent.right)),
    count: extents.reduce((sum, extent) => sum + extent.count, 0)
  };
}

function center(rect: Rect): Point {
  return { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.5 };
}

function normalized(point: Point, imported: ImportedPsd): Point {
  return roundPoint({ x: point.x / imported.canvas.width, y: point.y / imported.canvas.height });
}

function point(position: Point, confidence: number, source: SemanticCagePoint["source"]): SemanticCagePoint {
  return { position: roundPoint(position), confidence: round(clamp(confidence, 0, 1)), source };
}

function roleLayers(imported: ImportedPsd, primary: SemanticRole, fallback?: SemanticRole): ImportedLayer[] {
  const primaryLayers = imported.layers.filter((layer) => layer.role === primary);
  return primaryLayers.length > 0 || !fallback ? primaryLayers : imported.layers.filter((layer) => layer.role === fallback);
}

function orderedPair(layers: ImportedLayer[]): [ImportedLayer | undefined, ImportedLayer | undefined] {
  const sorted = layers
    .map((layer) => ({ layer, rect: alphaRect(layer) ?? layer.bounds }))
    .sort((left, right) => center(left.rect).x - center(right.rect).x)
    .map(({ layer }) => layer);
  return [sorted[0], sorted.length > 1 ? sorted[sorted.length - 1] : undefined];
}

function robustHeadTop(headLayers: ImportedLayer[], faceRect: AlphaRect): number | undefined {
  const minimum = Math.max(0, Math.floor(Math.min(...headLayers.map((layer) => layer.bounds.y))));
  const end = Math.floor(faceRect.y + faceRect.height * 0.16);
  const requiredSpan = faceRect.width * 0.42;
  for (let y = minimum; y <= end; y += 2) {
    const extent = combinedExtentAtY(headLayers, y, 1);
    if (extent && extent.right - extent.left >= requiredSpan) return y;
  }
  return undefined;
}

function correctedPoint(
  id: SemanticCagePointId,
  candidate: SemanticCagePoint,
  range: { minX?: number; maxX?: number; minY?: number; maxY?: number },
  corrections: string[]
): SemanticCagePoint {
  const x = clamp(candidate.position.x, range.minX ?? 0, range.maxX ?? 1);
  const y = clamp(candidate.position.y, range.minY ?? 0, range.maxY ?? 1);
  if (Math.abs(x - candidate.position.x) < 1e-7 && Math.abs(y - candidate.position.y) < 1e-7) return candidate;
  corrections.push(`${id}: clamped to semantic face order`);
  return point({ x, y }, Math.min(candidate.confidence, 0.72), "corrected");
}

export function buildSemanticControlCage(imported: ImportedPsd): SemanticControlCage | undefined {
  const faceLayer = imported.layers.find((layer) => layer.role === "face");
  if (!faceLayer) return undefined;
  const facePixels = alphaRect(faceLayer);
  if (!facePixels || facePixels.count < 64) return undefined;

  const corrections: string[] = [];
  const checks = ["face-alpha", "horizontal-order", "vertical-order", "eye-containment", "mouth-containment", "neck-attachment"];
  const canvas = imported.canvas;
  const face = {
    x: facePixels.x / canvas.width,
    y: facePixels.y / canvas.height,
    width: facePixels.width / canvas.width,
    height: facePixels.height / canvas.height
  };
  const centerX = face.x + face.width * 0.5;
  const bottom = face.y + face.height;

  const [eyeLeftLayer, eyeRightLayer] = orderedPair(roleLayers(imported, "eyeWhite", "eyelash"));
  const eyeRect = (layer: ImportedLayer | undefined, left: boolean): AlphaRect => alphaRect(layer ?? faceLayer) ?? {
    x: (face.x + (left ? 0.2 : 0.6) * face.width) * canvas.width,
    y: (face.y + 0.34 * face.height) * canvas.height,
    width: face.width * canvas.width * 0.2,
    height: face.height * canvas.height * 0.13,
    count: 0
  };
  const leftEyeRectPx = eyeRect(eyeLeftLayer, true);
  const rightEyeRectPx = eyeRect(eyeRightLayer, false);
  const leftEyeRect = {
    x: leftEyeRectPx.x / canvas.width,
    y: leftEyeRectPx.y / canvas.height,
    width: leftEyeRectPx.width / canvas.width,
    height: leftEyeRectPx.height / canvas.height
  };
  const rightEyeRect = {
    x: rightEyeRectPx.x / canvas.width,
    y: rightEyeRectPx.y / canvas.height,
    width: rightEyeRectPx.width / canvas.width,
    height: rightEyeRectPx.height / canvas.height
  };
  const directEyes = Boolean(eyeLeftLayer && eyeRightLayer);
  const eyeY = clamp((center(leftEyeRect).y + center(rightEyeRect).y) * 0.5, face.y + face.height * 0.26, face.y + face.height * 0.52);

  const noseLayer = imported.layers.find((layer) => layer.role === "nose");
  const noseRect = noseLayer ? alphaRect(noseLayer) : undefined;
  const noseCandidate = noseRect ? normalized(center(noseRect), imported) : { x: centerX, y: face.y + face.height * 0.58 };
  const nosePosition = {
    x: clamp(noseCandidate.x, centerX - face.width * 0.12, centerX + face.width * 0.12),
    y: clamp(noseCandidate.y, eyeY + face.height * 0.05, face.y + face.height * 0.7)
  };
  if (nosePosition.x !== noseCandidate.x || nosePosition.y !== noseCandidate.y) corrections.push("nose: corrected to central face region");

  const mouthLayer = imported.layers.find((layer) => layer.role === "mouth" && !layer.sourcePath.some((entry) => /closed|slight|open/i.test(entry)));
  const mouthRectPx = mouthLayer ? alphaRect(mouthLayer) : undefined;
  const mouthCandidate = mouthRectPx ? normalized(center(mouthRectPx), imported) : { x: centerX, y: face.y + face.height * 0.75 };
  const mouthPosition = {
    x: clamp(mouthCandidate.x, centerX - face.width * 0.1, centerX + face.width * 0.1),
    y: clamp(mouthCandidate.y, nosePosition.y + face.height * 0.08, face.y + face.height * 0.86)
  };
  if (mouthPosition.x !== mouthCandidate.x || mouthPosition.y !== mouthCandidate.y) corrections.push("mouth: corrected below nose and inside face");

  const faceExtentPx = (targetY: number, fallbackLeft: number, fallbackRight: number): HorizontalExtent =>
    extentAtY(faceLayer, targetY * canvas.height, Math.max(2, facePixels.height * 0.025)) ?? {
      left: fallbackLeft * canvas.width,
      right: fallbackRight * canvas.width,
      count: 0
    };
  const templeExtent = faceExtentPx(eyeY, face.x, face.x + face.width);
  const cheekY = clamp(nosePosition.y + (mouthPosition.y - nosePosition.y) * 0.34, eyeY + face.height * 0.08, mouthPosition.y - face.height * 0.03);
  const cheekExtent = faceExtentPx(cheekY, face.x + face.width * 0.03, face.x + face.width * 0.97);
  const chinY = bottom - Math.min(face.height * 0.025, 2 / canvas.height);
  const jawY = mouthPosition.y + (chinY - mouthPosition.y) * 0.58;
  const jawExtent = faceExtentPx(jawY, face.x + face.width * 0.13, face.x + face.width * 0.87);

  const headLayers = imported.layers.filter((layer) => layer.role === "frontHair" || layer.role === "backHair" || layer.role === "sideHair" || layer.role === "face");
  const detectedHeadTopPx = robustHeadTop(headLayers, facePixels);
  const headTopPx = detectedHeadTopPx ?? facePixels.y - facePixels.height * 0.22;
  const headTop = clamp(headTopPx / canvas.height, 0, face.y);
  const foreheadY = clamp(face.y + face.height * 0.17, headTop + face.height * 0.08, eyeY - face.height * 0.12);
  const skullExtentPx = combinedExtentAtY(headLayers, (foreheadY + eyeY) * 0.5 * canvas.height, Math.max(3, facePixels.height * 0.035));
  const skullLeftX = clamp((skullExtentPx?.left ?? (face.x - face.width * 0.16) * canvas.width) / canvas.width, 0, face.x + face.width * 0.08);
  const skullRightX = clamp((skullExtentPx?.right ?? (face.x + face.width * 1.16) * canvas.width) / canvas.width, face.x + face.width * 0.92, 1);

  const mouthHalfWidth = mouthRectPx
    ? clamp((mouthRectPx.width / canvas.width) * 0.5, face.width * 0.045, face.width * 0.18)
    : face.width * 0.09;
  const neckLayer = imported.layers.find((layer) => layer.role === "neck");
  const neckRectPx = neckLayer ? alphaRect(neckLayer) : undefined;
  const neckRect = neckRectPx
    ? { x: neckRectPx.x / canvas.width, y: neckRectPx.y / canvas.height, width: neckRectPx.width / canvas.width, height: neckRectPx.height / canvas.height }
    : { x: centerX - face.width * 0.13, y: bottom, width: face.width * 0.26, height: face.height * 0.2 };

  const eyeConfidence = directEyes ? 0.96 : 0.56;
  const points: Record<SemanticCagePointId, SemanticCagePoint> = {
    headTop: point({ x: centerX, y: headTop }, detectedHeadTopPx === undefined ? 0.58 : 0.86, detectedHeadTopPx === undefined ? "inferred" : "head-alpha"),
    forehead: point({ x: centerX, y: foreheadY }, 0.78, "face-alpha"),
    skullLeft: point({ x: skullLeftX, y: (foreheadY + eyeY) * 0.5 }, skullExtentPx ? 0.84 : 0.56, skullExtentPx ? "head-alpha" : "inferred"),
    skullRight: point({ x: skullRightX, y: (foreheadY + eyeY) * 0.5 }, skullExtentPx ? 0.84 : 0.56, skullExtentPx ? "head-alpha" : "inferred"),
    faceLeft: point({ x: templeExtent.left / canvas.width, y: eyeY }, templeExtent.count > 0 ? 0.92 : 0.58, templeExtent.count > 0 ? "face-alpha" : "inferred"),
    faceRight: point({ x: templeExtent.right / canvas.width, y: eyeY }, templeExtent.count > 0 ? 0.92 : 0.58, templeExtent.count > 0 ? "face-alpha" : "inferred"),
    eyeLeftOuter: point({ x: leftEyeRect.x, y: center(leftEyeRect).y }, eyeConfidence, directEyes ? "layer-alpha" : "inferred"),
    eyeLeft: point(center(leftEyeRect), eyeConfidence, directEyes ? "layer-alpha" : "inferred"),
    eyeLeftInner: point({ x: leftEyeRect.x + leftEyeRect.width, y: center(leftEyeRect).y }, eyeConfidence, directEyes ? "layer-alpha" : "inferred"),
    eyeRightInner: point({ x: rightEyeRect.x, y: center(rightEyeRect).y }, eyeConfidence, directEyes ? "layer-alpha" : "inferred"),
    eyeRight: point(center(rightEyeRect), eyeConfidence, directEyes ? "layer-alpha" : "inferred"),
    eyeRightOuter: point({ x: rightEyeRect.x + rightEyeRect.width, y: center(rightEyeRect).y }, eyeConfidence, directEyes ? "layer-alpha" : "inferred"),
    nose: point(nosePosition, noseRect ? 0.94 : 0.62, noseRect ? "layer-alpha" : "inferred"),
    cheekLeft: point({ x: cheekExtent.left / canvas.width, y: cheekY }, cheekExtent.count > 0 ? 0.9 : 0.58, cheekExtent.count > 0 ? "face-alpha" : "inferred"),
    cheekRight: point({ x: cheekExtent.right / canvas.width, y: cheekY }, cheekExtent.count > 0 ? 0.9 : 0.58, cheekExtent.count > 0 ? "face-alpha" : "inferred"),
    mouthLeft: point({ x: mouthPosition.x - mouthHalfWidth, y: mouthPosition.y }, mouthRectPx ? 0.9 : 0.58, mouthRectPx ? "layer-alpha" : "inferred"),
    mouth: point(mouthPosition, mouthRectPx ? 0.94 : 0.62, mouthRectPx ? "layer-alpha" : "inferred"),
    mouthRight: point({ x: mouthPosition.x + mouthHalfWidth, y: mouthPosition.y }, mouthRectPx ? 0.9 : 0.58, mouthRectPx ? "layer-alpha" : "inferred"),
    jawLeft: point({ x: jawExtent.left / canvas.width, y: jawY }, jawExtent.count > 0 ? 0.88 : 0.56, jawExtent.count > 0 ? "face-alpha" : "inferred"),
    jawRight: point({ x: jawExtent.right / canvas.width, y: jawY }, jawExtent.count > 0 ? 0.88 : 0.56, jawExtent.count > 0 ? "face-alpha" : "inferred"),
    chin: point({ x: centerX, y: chinY }, 0.88, "face-alpha"),
    neckLeft: point({ x: neckRect.x, y: Math.max(chinY, neckRect.y) }, neckRectPx ? 0.88 : 0.5, neckRectPx ? "layer-alpha" : "inferred"),
    neckRight: point({ x: neckRect.x + neckRect.width, y: Math.max(chinY, neckRect.y) }, neckRectPx ? 0.88 : 0.5, neckRectPx ? "layer-alpha" : "inferred")
  };

  points.eyeLeft = correctedPoint("eyeLeft", points.eyeLeft, { minX: points.faceLeft.position.x + face.width * 0.06, maxX: centerX - face.width * 0.06, minY: foreheadY + face.height * 0.06, maxY: nosePosition.y - face.height * 0.04 }, corrections);
  points.eyeRight = correctedPoint("eyeRight", points.eyeRight, { minX: centerX + face.width * 0.06, maxX: points.faceRight.position.x - face.width * 0.06, minY: foreheadY + face.height * 0.06, maxY: nosePosition.y - face.height * 0.04 }, corrections);
  points.eyeLeftOuter = correctedPoint("eyeLeftOuter", point({ x: points.eyeLeftOuter.position.x, y: points.eyeLeft.position.y }, points.eyeLeftOuter.confidence, points.eyeLeftOuter.source), { minX: points.faceLeft.position.x + face.width * 0.015, maxX: points.eyeLeft.position.x - face.width * 0.018 }, corrections);
  points.eyeLeftInner = correctedPoint("eyeLeftInner", point({ x: points.eyeLeftInner.position.x, y: points.eyeLeft.position.y }, points.eyeLeftInner.confidence, points.eyeLeftInner.source), { minX: points.eyeLeft.position.x + face.width * 0.018, maxX: nosePosition.x - face.width * 0.018 }, corrections);
  points.eyeRightInner = correctedPoint("eyeRightInner", point({ x: points.eyeRightInner.position.x, y: points.eyeRight.position.y }, points.eyeRightInner.confidence, points.eyeRightInner.source), { minX: nosePosition.x + face.width * 0.018, maxX: points.eyeRight.position.x - face.width * 0.018 }, corrections);
  points.eyeRightOuter = correctedPoint("eyeRightOuter", point({ x: points.eyeRightOuter.position.x, y: points.eyeRight.position.y }, points.eyeRightOuter.confidence, points.eyeRightOuter.source), { minX: points.eyeRight.position.x + face.width * 0.018, maxX: points.faceRight.position.x - face.width * 0.015 }, corrections);
  points.cheekLeft = correctedPoint("cheekLeft", points.cheekLeft, { maxX: nosePosition.x - face.width * 0.05, minY: eyeY, maxY: mouthPosition.y }, corrections);
  points.cheekRight = correctedPoint("cheekRight", points.cheekRight, { minX: nosePosition.x + face.width * 0.05, minY: eyeY, maxY: mouthPosition.y }, corrections);
  points.mouthLeft = correctedPoint("mouthLeft", point({ x: points.mouthLeft.position.x, y: points.mouth.position.y }, points.mouthLeft.confidence, points.mouthLeft.source), { minX: points.cheekLeft.position.x + face.width * 0.04, maxX: points.mouth.position.x - face.width * 0.018 }, corrections);
  points.mouthRight = correctedPoint("mouthRight", point({ x: points.mouthRight.position.x, y: points.mouth.position.y }, points.mouthRight.confidence, points.mouthRight.source), { minX: points.mouth.position.x + face.width * 0.018, maxX: points.cheekRight.position.x - face.width * 0.04 }, corrections);
  points.jawLeft = correctedPoint("jawLeft", points.jawLeft, { maxX: mouthPosition.x - face.width * 0.035, minY: mouthPosition.y, maxY: chinY }, corrections);
  points.jawRight = correctedPoint("jawRight", points.jawRight, { minX: mouthPosition.x + face.width * 0.035, minY: mouthPosition.y, maxY: chinY }, corrections);

  const primaryIds: SemanticCagePointId[] = ["headTop", "forehead", "faceLeft", "faceRight", "eyeLeft", "eyeRight", "nose", "cheekLeft", "cheekRight", "mouth", "jawLeft", "jawRight", "chin", "neckLeft", "neckRight"];
  const confidence = round(primaryIds.reduce((sum, id) => sum + points[id].confidence, 0) / primaryIds.length);
  return {
    kind: "semantic-face-cage-v1",
    coordinateConvention: "screen-space",
    points,
    faceTriangles: semanticFaceTriangles,
    skullTriangles: semanticSkullTriangles,
    roleGroups: { face: faceRoles, skull: skullRoles },
    validation: {
      status: corrections.length > 0 ? "corrected" : "passed",
      confidence,
      corrections,
      checks
    }
  };
}
