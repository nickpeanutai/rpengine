import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web/wasm';
import { describe, expect, it } from 'vitest';
import { parseKaldiCmvn, StreamingKaldiFbank, StreamingResampler, VAD_MEL_BINS } from './fire-red-vad-audio';

describe('FireRedVAD audio preparation', () => {
  it.each([44100, 48000])('keeps streaming resampling continuous at %i Hz', sourceRate => {
    const seconds = 0.25;
    const input = Float32Array.from({ length: Math.floor(sourceRate * seconds) }, (_, index) => Math.sin(2 * Math.PI * 440 * index / sourceRate));
    const whole = new StreamingResampler(sourceRate).push(input);
    const split = new StreamingResampler(sourceRate);
    const chunks = [input.slice(0, 137), input.slice(137, 4229), input.slice(4229)];
    const pieces = chunks.map(chunk => split.push(chunk));
    const joined = new Float32Array(pieces.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const piece of pieces) { joined.set(piece, offset); offset += piece.length; }
    expect(joined.length).toBe(whole.length);
    for (let index = 0; index < whole.length; index += 1) expect(joined[index]).toBeCloseTo(whole[index], 5);
  });

  it('parses the pinned official CMVN and produces finite 80-bin features', () => {
    const file = readFileSync(new URL('../public/vad/cmvn.ark', import.meta.url));
    const cmvn = parseKaldiCmvn(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    expect(cmvn.means).toHaveLength(VAD_MEL_BINS);
    expect(cmvn.inverseStd.every(Number.isFinite)).toBe(true);
    const samples = Float32Array.from({ length: 400 }, (_, index) => 0.25 * Math.sin(2 * Math.PI * 440 * index / 16000));
    const features = new StreamingKaldiFbank().push(samples, cmvn);
    expect(features).toHaveLength(VAD_MEL_BINS);
    expect(features.every(Number.isFinite)).toBe(true);
    const official = [-0.64431369, -0.57097048, -0.90471768, -1.32796645, -0.99257678, -0.82119381, -0.70253676, -0.63654411];
    official.forEach((value, index) => expect(features[index]).toBeCloseTo(value, 2));
  });

  it('matches the official ONNX signature and golden probability', async () => {
    ort.env.wasm.numThreads = 1;
    const root = new URL('../public/vad/', import.meta.url);
    const cmvnFile = readFileSync(new URL('cmvn.ark', root));
    const cmvn = parseKaldiCmvn(cmvnFile.buffer.slice(cmvnFile.byteOffset, cmvnFile.byteOffset + cmvnFile.byteLength));
    const samples = Float32Array.from({ length: 400 }, (_, index) => 0.25 * Math.sin(2 * Math.PI * 440 * index / 16000));
    const features = new StreamingKaldiFbank().push(samples, cmvn);
    const model = readFileSync(new URL('fireredvad_stream_vad_with_cache.onnx', root));
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    const result = await session.run({
      feat: new ort.Tensor('float32', features, [1, 1, 80]),
      caches_in: new ort.Tensor('float32', new Float32Array(8 * 128 * 19), [8, 1, 128, 19]),
    });
    expect(result.probs.dims).toEqual([1, 1, 1]);
    expect(result.caches_out.dims).toEqual([8, 1, 128, 19]);
    expect(Number(result.probs.data[0])).toBeCloseTo(0.330979526, 2);
  });
});
