import { initializeCore, type InitInput, VadWorkerPolicyCore } from './core';
import { StreamingKaldiFbank } from './fire-red-vad-audio';

/** Creates VAD objects only after their first-party WASM exports are available. */
export async function createVadCoreObjects(input?: InitInput) {
  await initializeCore(input);
  return { policy: new VadWorkerPolicyCore(), fbank: new StreamingKaldiFbank() };
}
