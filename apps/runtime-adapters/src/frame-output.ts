/** Contract for frame-sharing outputs. The Windows desktop implements this role with its built-in Spout2 sender. */
export interface RuntimeFrameOutputAdapter {
  readonly id: string;
  readonly format: "rgba8";
  open(input: { width: number; height: number; name: string }): Promise<void>;
  publish(frame: Uint8Array, timestampMs: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * External hosts can implement the same contract without depending on the
 * desktop process. PuppetLoom Desktop uses a zero-copy Electron shared-texture
 * bridge and the Spout2 D3D11 sender; OBS browser-source output is also built in.
 */
export type Spout2FrameOutputAdapter = RuntimeFrameOutputAdapter;
