import type { SemanticRole } from "./types.js";

export interface LayerOrderSource {
  id: string;
  sourceName: string;
  sourcePath: string[];
  role: SemanticRole;
  order: number;
}

export interface LayerOrderIssue {
  id: string;
  behindLayerId: string;
  frontLayerId: string;
  message: string;
}

function visibleName(layer: LayerOrderSource): string {
  return `${layer.sourcePath.join("/")} ${layer.sourceName}`;
}

function looksBack(layer: LayerOrderSource): boolean {
  return /(^|[\s_\-/])(back|rear|behind)([\s_\-/]|$)|后|後|裏/i.test(visibleName(layer));
}

function looksFront(layer: LayerOrderSource): boolean {
  return /(^|[\s_\-/])front([\s_\-/]|$)|前/i.test(visibleName(layer));
}

function pairs(layers: LayerOrderSource[], behindRole: SemanticRole, frontRole: SemanticRole): Array<[LayerOrderSource, LayerOrderSource]> {
  const behind = layers.filter((layer) => layer.role === behindRole);
  const front = layers.filter((layer) => layer.role === frontRole);
  return behind.flatMap((back) => front.map((top) => [back, top] as [LayerOrderSource, LayerOrderSource]));
}

/** Reports only stable semantic contradictions. Visual review remains authoritative. */
export function detectLayerOrderIssues(layers: LayerOrderSource[]): LayerOrderIssue[] {
  const expected: Array<[LayerOrderSource, LayerOrderSource, string]> = [
    ...pairs(layers, "backHair", "neck").map(([behind, front]) => [behind, front, "后发应位于脖子后方"] as [LayerOrderSource, LayerOrderSource, string]),
    ...pairs(layers, "backHair", "face").map(([behind, front]) => [behind, front, "后发应位于脸后方"] as [LayerOrderSource, LayerOrderSource, string]),
    ...pairs(layers, "face", "eyebrow").map(([behind, front]) => [behind, front, "眉毛应位于脸图层前方"] as [LayerOrderSource, LayerOrderSource, string])
  ];
  const legs = layers.filter((layer) => layer.role === "leg");
  for (const garment of layers.filter((layer) => layer.role === "bottomWear")) {
    if (looksBack(garment)) for (const leg of legs) expected.push([garment, leg, "后裙或后侧下装应位于裸露腿后方"]);
    else if (looksFront(garment)) for (const leg of legs) expected.push([leg, garment, "前裙或前侧下装应位于腿前方"]);
  }
  return expected.flatMap(([behind, front, reason]) => behind.order < front.order ? [] : [{
    id: `${behind.id}-behind-${front.id}`,
    behindLayerId: behind.id,
    frontLayerId: front.id,
    message: `图层顺序可疑：${reason}，但 ${behind.id}(${behind.order}) 当前不在 ${front.id}(${front.order}) 后面。请对照原画确认后使用 move-layer 修复。`
  }]);
}
