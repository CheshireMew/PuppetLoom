import { randomUUID } from "node:crypto";
import { parseRuntimeControlRequest, type CharacterStateSelection, type RuntimeMotionInput } from "@puppetloom/core";

export interface RuntimeAdapterClientOptions { url: string; viewerId: number; sourceId: string; priority?: number; ttlMs?: number }

export class RuntimeAdapterClient {
  constructor(readonly options: RuntimeAdapterClientOptions) {}

  async set(input: { motion?: RuntimeMotionInput; parameters?: Record<string, number>; expressions?: Record<string, number>; characterState?: CharacterStateSelection; blend?: number }): Promise<unknown> {
    const request = parseRuntimeControlRequest({
      version: 1, requestId: randomUUID(), op: "set", viewerId: this.options.viewerId,
      source: {
        id: this.options.sourceId, priority: this.options.priority ?? 55, blend: input.blend ?? 1, ttlMs: this.options.ttlMs ?? 750,
        ...(input.motion ? { motion: input.motion } : {}), ...(input.parameters ? { parameters: input.parameters } : {}),
        ...(input.expressions ? { expressions: input.expressions } : {}), ...(input.characterState ? { characterState: input.characterState } : {})
      }
    });
    return this.request(request);
  }

  async release(): Promise<unknown> {
    return this.request(parseRuntimeControlRequest({ version: 1, requestId: randomUUID(), op: "release", viewerId: this.options.viewerId, sourceId: this.options.sourceId }));
  }

  private async request(body: unknown): Promise<unknown> {
    const response = await fetch(`${this.options.url.replace(/\/$/, "")}/v1/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3_000) });
    const result = await response.json() as { ok?: boolean; result?: unknown; error?: string };
    if (!response.ok || !result.ok) throw new Error(result.error ?? `PuppetLoom runtime HTTP ${response.status}`);
    return result.result;
  }
}
