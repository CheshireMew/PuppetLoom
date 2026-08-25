import type { RuntimeMotionInput } from "@puppetloom/core";
import type { OscMessage } from "./osc.js";

function clamp(value: number, min = -1, max = 1): number { return Math.max(min, Math.min(max, value)); }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function quaternionEuler(x: number, y: number, z: number, w: number): { yaw: number; pitch: number; roll: number } {
  const sinPitch = 2 * (w * x - z * y);
  return {
    roll: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
    pitch: Math.abs(sinPitch) >= 1 ? Math.sign(sinPitch) * Math.PI / 2 : Math.asin(sinPitch),
    yaw: Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y))
  };
}

const blendshape: Record<string, keyof RuntimeMotionInput> = {
  blink: "blink", blinkl: "blinkLeft", blinkr: "blinkRight", a: "mouthA", i: "mouthI", u: "mouthU", e: "mouthE", o: "mouthO",
  joy: "smile", fun: "smile", mouthopen: "mouthOpen"
};

export function mapOscMessage(input: OscMessage): RuntimeMotionInput | undefined {
  if (input.address.startsWith("/puppetloom/motion/")) {
    const key = input.address.slice("/puppetloom/motion/".length) as keyof RuntimeMotionInput;
    const value = number(input.arguments[0]); return value === undefined ? undefined : { [key]: clamp(value) };
  }
  if (input.address === "/VMC/Ext/Blend/Val") {
    const name = String(input.arguments[0] ?? "").toLowerCase().replace(/[^a-z]/g, ""); const value = number(input.arguments[1]); const key = blendshape[name];
    return key && value !== undefined ? { [key]: clamp(value, 0, 1) } : undefined;
  }
  if (input.address === "/VMC/Ext/Bone/Pos" && String(input.arguments[0] ?? "").toLowerCase() === "head") {
    const [x, y, z, w] = [input.arguments[4], input.arguments[5], input.arguments[6], input.arguments[7]].map(number);
    if ([x, y, z, w].some((value) => value === undefined)) return undefined;
    const rotation = quaternionEuler(x!, y!, z!, w!);
    return { headYaw: clamp(rotation.yaw / 0.65), headPitch: clamp(-rotation.pitch / 0.55), headRoll: clamp(rotation.roll / 0.5) };
  }
  return undefined;
}

export interface MidiMapping { channel?: number; control: number; target: keyof RuntimeMotionInput; min?: number; max?: number }
export function mapMidi(message: { status: number; data1: number; data2: number }, mappings: MidiMapping[]): RuntimeMotionInput | undefined {
  const command = message.status & 0xf0; const channel = message.status & 0x0f;
  if (command !== 0xb0) return undefined;
  const mapping = mappings.find((candidate) => candidate.control === message.data1 && (candidate.channel === undefined || candidate.channel === channel));
  if (!mapping) return undefined;
  const min = mapping.min ?? -1; const max = mapping.max ?? 1;
  return { [mapping.target]: min + (max - min) * clamp(message.data2 / 127, 0, 1) };
}
