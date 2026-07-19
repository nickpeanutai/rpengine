import type { CoreSession } from './core';
export type * from './generated/rp-engine-core/contracts';
import type { EffectBatchV3, HostAudioEventV3, HostEventV3 } from './generated/rp-engine-core/contracts';

export function dispatchCore(core: CoreSession, event: HostEventV3): EffectBatchV3 {
  const batch = JSON.parse(core.dispatch(JSON.stringify(event))) as EffectBatchV3;
  if (batch.abiVersion !== 3) throw new Error(`Unexpected RPEngine effect ABI: ${batch.abiVersion}`);
  return batch;
}

export function dispatchCoreAudio(core: CoreSession, event: HostAudioEventV3, samples: Float32Array): EffectBatchV3 {
  const batch = JSON.parse(core.dispatch_audio(JSON.stringify(event), samples)) as EffectBatchV3;
  if (batch.abiVersion !== 3) throw new Error(`Unexpected RPEngine audio effect ABI: ${batch.abiVersion}`);
  return batch;
}

export function takeCoreReplyAudioSegment(core: CoreSession, transportId: number) {
  return JSON.parse(core.take_reply_audio_segment(transportId)) as import('./transport-adapter').ReplyAudioSegment;
}
