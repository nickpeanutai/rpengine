import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { describe, expect, it } from 'vitest';
import { MoonshineV2BatchRuntime } from './moonshine-v2-batch-runtime';

const modelDirectory = process.env.MOONSHINE_V2_MODEL_DIR;
const nativeResultPath = process.env.MOONSHINE_V2_NATIVE_RESULT;
const enabled = Boolean(modelDirectory && nativeResultPath);

describe('Moonshine v2 official native/browser parity', () => {
  it.runIf(enabled)('produces identical tokens and transcript for the official two-cities fixture', async () => {
    const ortDistribution = new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = {
      mjs: pathToFileURL(join(ortDistribution.pathname, 'ort-wasm-simd-threaded.asyncify.mjs')).href,
      wasm: pathToFileURL(join(ortDistribution.pathname, 'ort-wasm-simd-threaded.asyncify.wasm')).href,
    };
    const runtime = new MoonshineV2BatchRuntime(
      undefined,
      async (_modelId, path) => new Uint8Array(await readFile(join(modelDirectory!, path.replace(/^small-streaming-en\//, '')))),
    );
    const samples = decodePcm16Wav(new Uint8Array(await readFile(new URL('../moonshine/test-assets/two_cities_16k.wav', import.meta.url))));
    const native = JSON.parse(await readFile(nativeResultPath!, 'utf8')) as { tokenIds: number[]; text: string };

    const browser = await runtime.generate(samples);
    if (process.env.MOONSHINE_V2_PRINT_RESULT === '1') console.log(JSON.stringify(browser));

    expect(browser.tokenIds).toEqual(native.tokenIds);
    expect(browser.text).toBe(native.text);
    await runtime.dispose();
  }, 30_000);
});

function decodePcm16Wav(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') throw new Error('Parity fixture is not a WAV file.');
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let pcmOffset = 0;
  let pcmLength = 0;
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (kind === 'fmt ') {
      if (view.getUint16(start, true) !== 1) throw new Error('Parity fixture must use PCM encoding.');
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      bits = view.getUint16(start + 14, true);
    } else if (kind === 'data') {
      pcmOffset = start;
      pcmLength = length;
      break;
    }
    offset = start + length + (length % 2);
  }
  if (channels !== 1 || sampleRate !== 16_000 || bits !== 16 || pcmLength === 0) throw new Error('Parity fixture must be 16 kHz mono PCM16.');
  const samples = new Float32Array(pcmLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(pcmOffset + index * 2, true) / 32_768;
  return samples;
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}
