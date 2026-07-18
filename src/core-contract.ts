import type { CoreSession } from './core';
export type * from './generated/rp-engine-core/contracts';
import type { EffectBatchV2, HostAudioEventV2, HostEventV2 } from './generated/rp-engine-core/contracts';

export function dispatchCore(core: CoreSession, event: HostEventV2): EffectBatchV2 {
  const batch = JSON.parse(core.dispatch(JSON.stringify(event))) as EffectBatchV2;
  if (batch.abiVersion !== 2) throw new Error(`Unexpected RPEngine effect ABI: ${batch.abiVersion}`);
  return batch;
}

export function dispatchCoreAudio(core: CoreSession, event: HostAudioEventV2, samples: Float32Array): EffectBatchV2 {
  const batch = JSON.parse(core.dispatch_audio(JSON.stringify(event), samples)) as EffectBatchV2;
  if (batch.abiVersion !== 2) throw new Error(`Unexpected RPEngine audio effect ABI: ${batch.abiVersion}`);
  return batch;
}

export function takeCoreReplyAudioTransport(core: CoreSession, transportId: number): EffectBatchV2 {
  const batch = JSON.parse(core.take_reply_audio_transport(transportId)) as EffectBatchV2;
  if (batch.abiVersion !== 2) throw new Error(`Unexpected RPEngine audio transport ABI: ${batch.abiVersion}`);
  return batch;
}
