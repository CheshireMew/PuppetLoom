#!/usr/bin/env node
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CharacterStateSelection, RuntimeMotionInput } from "@puppetloom/core";
import { RuntimeAdapterClient } from "./client.js";
import { mapMidi, mapOscMessage, type MidiMapping } from "./mapping.js";
import { parseOscPacket } from "./osc.js";

interface AdapterHostConfig {
  runtimeUrl?: string;
  runtimeManifest?: string;
  viewerId: number;
  sourceId?: string;
  priority?: number;
  ttlMs?: number;
  oscPort?: number;
  httpPort?: number;
  webPlayerUrl?: string;
  midi?: MidiMapping[];
}

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
async function configuration(): Promise<AdapterHostConfig> {
  const path = argument("--config");
  if (!path) throw new Error("请使用 --config <adapter-host.json> 指定配置。");
  const value = JSON.parse(await readFile(resolve(path), "utf8")) as AdapterHostConfig;
  if (!Number.isInteger(value.viewerId) || value.viewerId <= 0) throw new Error("viewerId 必须是正整数。");
  if (!value.runtimeUrl) {
    const manifestPath = value.runtimeManifest ?? join("D:\\Tools", "PuppetLoom", "user-data", "runtime-control.json");
    value.runtimeUrl = (JSON.parse(await readFile(manifestPath, "utf8")) as { url: string }).url;
  }
  return value;
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" }); response.end(body);
}
async function body(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 1_048_576) throw new Error("请求超过 1 MiB。"); chunks.push(buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const config = await configuration();
const client = new RuntimeAdapterClient({ url: config.runtimeUrl!, viewerId: config.viewerId, sourceId: config.sourceId ?? "adapter-host", priority: config.priority ?? 55, ttlMs: config.ttlMs ?? 750 });
const osc = createSocket("udp4");
osc.on("message", (packet) => {
  try {
    const motion = Object.assign({}, ...parseOscPacket(packet).map(mapOscMessage).filter(Boolean)) as RuntimeMotionInput;
    if (Object.keys(motion).length > 0) void client.set({ motion }).catch((error) => process.stderr.write(`${String(error)}\n`));
  } catch (error) { process.stderr.write(`OSC: ${error instanceof Error ? error.message : String(error)}\n`); }
});
osc.bind(config.oscPort ?? 39_540, "127.0.0.1");

const gamepadPage = `<!doctype html><meta charset="utf-8"><title>PuppetLoom 控制桥</title><style>body{font:16px system-ui;background:#171922;color:#eee;padding:24px;max-width:760px;margin:auto}section{margin:18px 0;padding:16px;border:1px solid #ffffff24;border-radius:12px;background:#ffffff08}button{padding:9px 14px;border:0;border-radius:8px;color:#fff;background:#655bd1}code{color:#b8afff}</style><h1>PuppetLoom 手柄与 MIDI 桥</h1><section><h2>Gamepad</h2><p>保持本页打开。左摇杆控制头部，右摇杆控制视线，扳机控制手臂。</p><p id="gamepad-status">等待手柄…</p></section><section><h2>Web MIDI</h2><p>点击授权后，本页直接监听 MIDI CC，并按 adapter-host.json 的 <code>midi</code> 映射发送。</p><button id="midi-start">连接 MIDI</button><p id="midi-status">尚未连接</p></section><script>
const gamepadStatus=document.querySelector('#gamepad-status');let previous='';async function tick(){const pad=[...navigator.getGamepads()].find(Boolean);if(pad){gamepadStatus.textContent=pad.id;const payload={motion:{headYaw:pad.axes[0]||0,headPitch:pad.axes[1]||0,gazeX:pad.axes[2]||0,gazeY:pad.axes[3]||0,armLeft:pad.buttons[6]?.value||0,armRight:pad.buttons[7]?.value||0}};const text=JSON.stringify(payload);if(text!==previous){previous=text;fetch('/v1/control',{method:'POST',headers:{'content-type':'application/json'},body:text}).catch(()=>{})}}requestAnimationFrame(tick)}tick();
const midiStatus=document.querySelector('#midi-status');document.querySelector('#midi-start').addEventListener('click',async()=>{try{if(!navigator.requestMIDIAccess)throw new Error('当前浏览器没有 Web MIDI');const access=await navigator.requestMIDIAccess();const bind=()=>{for(const input of access.inputs.values())input.onmidimessage=(event)=>{const [status,data1,data2]=event.data;fetch('/v1/midi',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status,data1,data2})}).catch(()=>{})};midiStatus.textContent=[...access.inputs.values()].map(input=>input.name).join(' / ')||'已授权，等待 MIDI 设备';};bind();access.onstatechange=bind;}catch(error){midiStatus.textContent=String(error)}});</script>`;
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === "OPTIONS") { response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" }); response.end(); return; }
    if (request.method === "GET" && request.url === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(gamepadPage); return; }
    if (request.method === "GET" && request.url === "/v1/status") { json(response, 200, { ok: true, viewerId: config.viewerId, oscPort: config.oscPort ?? 39_540, httpPort: config.httpPort ?? 39_541, webPlayerUrl: config.webPlayerUrl }); return; }
    if (request.method === "GET" && request.url === "/v1/obs-source") { json(response, 200, { type: "browser_source", url: config.webPlayerUrl, width: 1080, height: 1080, transparent: true, note: "在 OBS 中添加浏览器源并启用透明背景。需要本机纹理共享时，可由 Spout2 输出插件实现 RuntimeFrameOutputAdapter。" }); return; }
    if (request.method === "POST" && request.url === "/v1/control") {
      const value = await body(request) as { motion?: RuntimeMotionInput; parameters?: Record<string, number>; expressions?: Record<string, number>; characterState?: CharacterStateSelection; blend?: number };
      json(response, 200, { ok: true, result: await client.set(value) }); return;
    }
    if (request.method === "POST" && request.url === "/v1/midi") {
      const value = await body(request) as { status: number; data1: number; data2: number }; const motion = mapMidi(value, config.midi ?? []);
      if (!motion) { json(response, 422, { ok: false, error: "没有匹配的 MIDI CC 映射。" }); return; }
      json(response, 200, { ok: true, motion, result: await client.set({ motion }) }); return;
    }
    if (request.method === "POST" && request.url === "/v1/release") { json(response, 200, { ok: true, result: await client.release() }); return; }
    json(response, 404, { ok: false, error: "Not found" });
  })().catch((error) => json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }));
});
server.listen(config.httpPort ?? 39_541, "127.0.0.1", () => process.stdout.write(`${JSON.stringify({ ok: true, http: `http://127.0.0.1:${config.httpPort ?? 39_541}`, osc: `udp://127.0.0.1:${config.oscPort ?? 39_540}`, viewerId: config.viewerId })}\n`));
const close = () => { osc.close(); server.close(() => process.exit(0)); };
process.on("SIGINT", close); process.on("SIGTERM", close);
