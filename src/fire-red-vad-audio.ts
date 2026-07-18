import { CmvnCore, KaldiFbankCore, StreamingResamplerCore } from './core';

export const VAD_SAMPLE_RATE = 16000;
export const VAD_FRAME_SAMPLES = 400;
export const VAD_FRAME_SHIFT = 160;
export const VAD_MEL_BINS = 80;
export type CmvnStats = CmvnCore;

export class StreamingResampler {
  private readonly core: StreamingResamplerCore;
  constructor(sourceRate: number, targetRate = VAD_SAMPLE_RATE) { this.core = new StreamingResamplerCore(sourceRate, targetRate); }
  push(chunk: Float32Array) { return this.core.push(chunk); }
  reset() { this.core.reset(); }
}

export class StreamingKaldiFbank {
  private readonly core = new KaldiFbankCore();
  push(chunk: Float32Array, cmvn: CmvnStats) { return this.core.push(chunk, cmvn); }
  reset() { this.core.reset(); }
}

export function parseKaldiCmvn(buffer: ArrayBuffer) { return new CmvnCore(new Uint8Array(buffer)); }
