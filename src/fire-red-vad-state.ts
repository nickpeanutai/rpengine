import { VadStateCore } from './core';

export type VadCaptureState = 'listening' | 'speech_started' | 'speech_ended';
export interface VadStateUpdate { state: VadCaptureState; seconds: number }
export class FireRedVadStateMachine {
  private readonly core: VadStateCore;
  constructor(threshold = 0.5, speechStartSeconds = 0.20, minimumSpeechSeconds = 0.25, silenceEndSeconds = 0.50) {
    this.core = new VadStateCore(threshold, speechStartSeconds, minimumSpeechSeconds, silenceEndSeconds);
  }
  process(probability: number, seconds: number, frameSeconds = 0.01): VadStateUpdate | undefined {
    const update = this.core.process(probability, seconds, frameSeconds);
    return update ? JSON.parse(update) as VadStateUpdate : undefined;
  }
}
