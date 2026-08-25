import { describe, expect, it } from "vitest";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mapMidi, mapOscMessage } from "../apps/runtime-adapters/src/mapping.js";
import { parseOscPacket } from "../apps/runtime-adapters/src/osc.js";

function oscText(value: string): Buffer {
  const bytes = Buffer.byteLength(value) + 1;
  const result = Buffer.alloc(Math.ceil(bytes / 4) * 4);
  result.write(value, "utf8");
  return result;
}

function oscMessage(address: string, tags: string, values: Array<string | number>): Buffer {
  const parts = [oscText(address), oscText(`,${tags}`)];
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index]!;
    if (tag === "s") parts.push(oscText(String(values[index])));
    else {
      const value = Buffer.alloc(4);
      if (tag === "f") value.writeFloatBE(Number(values[index]));
      else value.writeInt32BE(Number(values[index]));
      parts.push(value);
    }
  }
  return Buffer.concat(parts);
}

describe("runtime adapters", () => {
  it("parses native OSC and maps a PuppetLoom motion address", () => {
    const [message] = parseOscPacket(oscMessage("/puppetloom/motion/headYaw", "f", [0.625]));
    expect(message).toMatchObject({ address: "/puppetloom/motion/headYaw" });
    expect(mapOscMessage(message!)).toEqual({ headYaw: expect.closeTo(0.625, 5) });
  });

  it("maps VMC visemes and head rotation into supported motion fields", () => {
    expect(mapOscMessage({ address: "/VMC/Ext/Blend/Val", arguments: ["Blink_L", 0.8] })).toEqual({ blinkLeft: 0.8 });
    expect(mapOscMessage({ address: "/VMC/Ext/Blend/Val", arguments: ["A", 0.55] })).toEqual({ mouthA: 0.55 });
    expect(mapOscMessage({ address: "/VMC/Ext/Bone/Pos", arguments: ["Head", 0, 0, 0, 0, 0, 0, 1] })).toEqual({ headYaw: 0, headPitch: -0, headRoll: 0 });
  });

  it("uses explicit MIDI CC mappings and ignores unrelated messages", () => {
    const mappings = [{ channel: 0, control: 7, target: "smile" as const, min: 0, max: 1 }];
    expect(mapMidi({ status: 0xb0, data1: 7, data2: 127 }, mappings)).toEqual({ smile: 1 });
    expect(mapMidi({ status: 0x90, data1: 7, data2: 127 }, mappings)).toBeUndefined();
  });

  it("ships an installable Stream Deck action with editable endpoint and JSON payload", async () => {
    const root = resolve("apps/runtime-adapters/stream-deck/com.puppetloom.runtime.sdPlugin");
    const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as { SDKVersion: number; CodePath: string; PropertyInspectorPath: string; Actions: Array<{ UUID: string; Icon: string }> };
    expect(manifest).toMatchObject({ SDKVersion: 2, CodePath: "plugin.html", PropertyInspectorPath: "inspector.html", Actions: [{ UUID: "com.puppetloom.runtime.control" }] });
    await Promise.all([access(resolve(root, manifest.CodePath)), access(resolve(root, manifest.PropertyInspectorPath)), access(resolve(root, `${manifest.Actions[0]!.Icon}.svg`))]);
    expect(await readFile(resolve(root, "plugin.html"), "utf8")).toContain("/v1/control");
  });
});
