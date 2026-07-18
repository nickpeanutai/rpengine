import { trim_outer_silence } from './core';

export interface SilenceTrimOptions { rmsThreshold?: number; windowDuration?: number; hopDuration?: number; leadingPaddingDuration?: number; trailingPaddingDuration?: number }
export function trimOuterSilence(samples: readonly number[], sampleRate: number, options: SilenceTrimOptions = {}): number[] {
  return Array.from(trim_outer_silence(Float64Array.from(samples), sampleRate, JSON.stringify(options)));
}
