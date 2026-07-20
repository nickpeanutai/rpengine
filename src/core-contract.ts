import type { CoreSession } from './core';
export type * from './generated/rp-engine-core/contracts';
import type { EffectBatchV4, HostAudioEventV4, HostEventV4 } from './generated/rp-engine-core/contracts';

export function dispatchCore(core: CoreSession, event: HostEventV4): EffectBatchV4 {
  const batch = JSON.parse(core.dispatch(JSON.stringify(event))) as EffectBatchV4;
  if (batch.abiVersion !== 4) throw new Error(`Unexpected RPEngine effect ABI: ${batch.abiVersion}`);
  return batch;
}

export function dispatchCoreAudio(core: CoreSession, event: HostAudioEventV4, samples: Float32Array): EffectBatchV4 {
  const batch = JSON.parse(core.dispatch_audio(JSON.stringify(event), samples)) as EffectBatchV4;
  if (batch.abiVersion !== 4) throw new Error(`Unexpected RPEngine audio effect ABI: ${batch.abiVersion}`);
  return batch;
}

export function takeCoreReplyAudioSegment(core: CoreSession, transportId: number) {
  return JSON.parse(core.take_reply_audio_segment(transportId)) as import('./transport-adapter').ReplyAudioSegment;
}
