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
    ...pairs(layers, "backHair", "neck").map(([behind, front]) => [behind, front, "뒷머리는 목 뒤에 있어야 함"] as [LayerOrderSource, LayerOrderSource, string]),
    ...pairs(layers, "backHair", "face").map(([behind, front]) => [behind, front, "뒷머리는 얼굴 뒤에 있어야 함"] as [LayerOrderSource, LayerOrderSource, string]),
    ...pairs(layers, "face", "eyebrow").map(([behind, front]) => [behind, front, "눈썹은 얼굴 레이어 앞에 있어야 함"] as [LayerOrderSource, LayerOrderSource, string])
  ];
  const legs = layers.filter((layer) => layer.role === "leg");
  for (const garment of layers.filter((layer) => layer.role === "bottomWear")) {
    if (looksBack(garment)) for (const leg of legs) expected.push([garment, leg, "뒤치마나 뒤쪽 하의는 드러난 다리 뒤에 있어야 함"]);
    else if (looksFront(garment)) for (const leg of legs) expected.push([leg, garment, "앞치마나 앞쪽 하의는 다리 앞에 있어야 함"]);
  }
  return expected.flatMap(([behind, front, reason]) => behind.order < front.order ? [] : [{
    id: `${behind.id}-behind-${front.id}`,
    behindLayerId: behind.id,
    frontLayerId: front.id,
    message: `레이어 순서가 의심됩니다: ${reason}. 하지만 ${behind.id}(${behind.order})가 현재 ${front.id}(${front.order}) 뒤에 있지 않습니다. 원화와 대조한 뒤 move-layer로 고치세요.`
  }]);
}
