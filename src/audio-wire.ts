import { base64_bytes, float32_to_pcm16, pcm_chunk_offsets } from './core';

export const PCM_CHUNK_BYTES = 32 * 1024;
export function float32ToPcm16(samples: Float32Array) { return float32_to_pcm16(samples); }
export function pcmChunks(bytes: Uint8Array, chunkBytes = PCM_CHUNK_BYTES) {
  const offsets = pcm_chunk_offsets(bytes.byteLength, chunkBytes);
  const chunks: Uint8Array[] = [];
  for (let index = 0; index + 1 < offsets.length; index += 1) chunks.push(bytes.slice(offsets[index], offsets[index + 1]));
  return chunks;
}
export function base64Bytes(bytes: Uint8Array) { return base64_bytes(bytes); }
