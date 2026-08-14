import type { SemanticRole, Side } from "./types.js";

export interface Classification {
  role: SemanticRole;
  side: Side;
  confidence: number;
}

const roleMatchers: Array<{ role: SemanticRole; patterns: RegExp[] }> = [
  { role: "eyeClosed", patterns: [/eye.?close/, /closed.?eye/, /blink/, /闭眼/, /閉じ目/, /闭目/] },
  { role: "eyeWhite", patterns: [/eye.?white/, /eyewhite/, /白目/, /眼白/] },
  { role: "iris", patterns: [/\biris(?:es)?\b/, /\birides\b/, /pupil/, /瞳孔/, /虹膜/, /瞳/] },
  { role: "eyelash", patterns: [/eye.?lash/, /eyelash/, /睫毛/, /まつ毛/] },
  { role: "eyebrow", patterns: [/eye.?brow/, /eyebrow/, /眉毛/, /眉/] },
  { role: "frontHair", patterns: [/front.?hair/, /bangs?/, /fringe/, /前发/, /前髪/, /刘海/] },
  { role: "backHair", patterns: [/back.?hair/, /rear.?hair/, /後ろ髪/, /后发/, /後髪/] },
  { role: "sideHair", patterns: [/side.?hair/, /侧发/, /側髪/] },
  { role: "headwear", patterns: [/head.?wear/, /hat/, /帽/, /头饰/, /髪飾/] },
  { role: "bottomWear", patterns: [/bottom.?wear/, /skirt/, /pants?/, /shorts?/, /下装/, /裙/, /裤/] },
  { role: "topWear", patterns: [/top.?wear/, /torso/, /bodywear/, /shirt/, /coat/, /dress/, /上装/, /衣服/, /躯干/] },
  { role: "arm", patterns: [/(^|[^a-z])arms?([^a-z]|$)/, /手臂/, /胳膊/, /腕/] },
  { role: "hand", patterns: [/hand.?wear/, /hands?/, /手套/, /手部/, /手$/] },
  { role: "leg", patterns: [/leg.?wear/, /legs?/, /thigh/, /stocking/, /socks?/, /腿/, /袜/] },
  { role: "foot", patterns: [/foot.?wear/, /feet/, /shoes?/, /boots?/, /鞋/, /脚/] },
  { role: "face", patterns: [/(^|[^a-z])face([^a-z]|$)/, /head.?base/, /脸/, /臉/, /顔/] },
  { role: "nose", patterns: [/(^|[^a-z])nose([^a-z]|$)/, /鼻/] },
  { role: "mouth", patterns: [/(^|[^a-z])mouth([^a-z]|$)/, /嘴/, /口/] },
  { role: "ear", patterns: [/(^|[^a-z])ears?([^a-z]|$)/, /耳/] },
  { role: "neck", patterns: [/(^|[^a-z])neck([^a-z]|$)/, /脖子/, /颈/, /首/] },
  { role: "tail", patterns: [/(^|[^a-z])tail([^a-z]|$)/, /尾巴/, /尻尾/, /しっぽ/] },
  { role: "accessory", patterns: [/accessory/, /ornament/, /attachment/, /饰品/, /配件/, /装饰/] }
];

export function normalizeLayerName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/のコピー|copy|副本|拷贝/g, "")
    .replace(/[_.]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function explicitSideFromName(name: string): Side | undefined {
  const normalized = normalizeLayerName(name);
  if (/(^|[\s-])(l|left)(?=$|[\s-])/.test(normalized) || /左/.test(normalized)) return "left";
  if (/(^|[\s-])(r|right)(?=$|[\s-])/.test(normalized) || /右/.test(normalized)) return "right";
  return undefined;
}

export function classifyLayerName(name: string): Classification {
  const normalized = normalizeLayerName(name);
  const side = explicitSideFromName(normalized) ?? "center";
  for (const matcher of roleMatchers) {
    if (matcher.patterns.some((pattern) => pattern.test(normalized))) {
      return { role: matcher.role, side, confidence: 1 };
    }
  }
  return { role: "unknown", side, confidence: 0 };
}

export function inferSideFromCenter(centerX: number, canvasWidth: number): Side {
  if (Math.abs(centerX - canvasWidth * 0.5) < canvasWidth * 0.035) return "center";
  return centerX < canvasWidth * 0.5 ? "right" : "left";
}

export function roleLabel(role: SemanticRole): string {
  const labels: Record<SemanticRole, string> = {
    backHair: "后发",
    frontHair: "前发",
    sideHair: "侧发",
    face: "脸",
    eyeWhite: "眼白",
    iris: "虹膜",
    eyelash: "睫毛",
    eyeClosed: "闭眼",
    eyebrow: "眉毛",
    nose: "鼻子",
    mouth: "嘴",
    ear: "耳朵",
    neck: "脖子",
    topWear: "上身",
    bottomWear: "下身",
    arm: "手臂",
    hand: "手",
    leg: "腿",
    foot: "脚",
    headwear: "头饰",
    tail: "尾巴",
    accessory: "饰品",
    unknown: "未识别"
  };
  return labels[role];
}

export const pairedRoles = new Set<SemanticRole>(["eyeWhite", "iris", "eyelash", "eyeClosed", "eyebrow", "ear", "arm", "hand", "leg", "foot"]);
