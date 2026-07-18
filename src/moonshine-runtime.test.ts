import { describe, expect, it, vi } from 'vitest';
import { OfficialMoonshineRuntime, moonshineDirectory, type MoonshineModelLike } from './moonshine-runtime';
import { MOONSHINE_MODEL_IDS, type MoonshineLanguage } from './types';

const LANGUAGES = (Object.keys(MOONSHINE_MODEL_IDS) as MoonshineLanguage[]).filter(language => language !== 'en');

describe('OfficialMoonshineRuntime', () => {
  it('maps every supported language to its matching base directory', () => {
    for (const language of LANGUAGES) expect(moonshineDirectory(language)).toBe(`base-${language}`);
    expect(moonshineDirectory('ko')).toBe('base-ko');
  });

  it('loads OPFS encoder and decoder bytes into the official model', async () => {
    const reads: Array<[string, string]> = [];
    const progress = vi.fn();
    const generate = vi.fn(async () => 'official transcript');
    const loadModel = vi.fn(async () => undefined);
    const createModel = vi.fn((_path, _precision, _sources) => ({ loadModel, generate } satisfies MoonshineModelLike));
    const runtime = new OfficialMoonshineRuntime(createModel, async (modelId, path) => {
      reads.push([modelId, path]);
      return Uint8Array.of(path.includes('encoder') ? 1 : 2);
    });

    await runtime.load('ko', progress);

    expect(reads).toEqual([
      [MOONSHINE_MODEL_IDS.ko, 'base-ko/encoder_model.ort'],
      [MOONSHINE_MODEL_IDS.ko, 'base-ko/decoder_model_merged.ort'],
    ]);
    expect(createModel).toHaveBeenCalledWith('model/base-ko', 'quantized', {
      encoder: Uint8Array.of(1),
      decoder: Uint8Array.of(2),
      wasmPath: '/ort-wasm/',
    });
    expect(loadModel).toHaveBeenCalledOnce();
    expect(progress.mock.calls.map(call => call.slice(0, 2))).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('reuses a loaded language and replaces it when the language changes', async () => {
    const createModel = vi.fn((_path: string, _precision: string, _sources: unknown) => ({ loadModel: async () => undefined, generate: async () => 'ok' }));
    const readFile = vi.fn(async () => Uint8Array.of(1));
    const runtime = new OfficialMoonshineRuntime(createModel, readFile);

    await runtime.load('ar');
    await runtime.load('ar');
    await runtime.load('zh');

    expect(createModel).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledTimes(4);
    expect(createModel.mock.calls[1]?.[0]).toBe('model/base-zh');
  });

  it('passes 16 kHz samples directly to official generate and preserves its transcript', async () => {
    const generate = vi.fn(async () => '你好，世界。');
    const runtime = new OfficialMoonshineRuntime(
      () => ({ loadModel: async () => undefined, generate }),
      async () => Uint8Array.of(1),
    );
    const samples = new Float32Array(16000);

    await expect(runtime.generate(samples, 'zh')).resolves.toBe('你好，世界。');
    expect(generate).toHaveBeenCalledWith(samples);
  });

  it('reports missing files, empty audio, and invalid official results', async () => {
    const missing = new OfficialMoonshineRuntime(
      () => ({ loadModel: async () => undefined, generate: async () => '' }),
      async () => { throw new Error('missing encoder'); },
    );
    await expect(missing.load('ar')).rejects.toThrow('missing encoder');

    const empty = new OfficialMoonshineRuntime(
      () => ({ loadModel: async () => undefined, generate: async () => '' }),
      async () => Uint8Array.of(1),
    );
    await expect(empty.generate(new Float32Array(), 'ar')).rejects.toThrow('empty audio');

    const invalid = new OfficialMoonshineRuntime(
      () => ({ loadModel: async () => undefined, generate: async () => undefined as unknown as string }),
      async () => Uint8Array.of(1),
    );
    await expect(invalid.generate(new Float32Array(160), 'ar')).rejects.toThrow('returned no transcript');
  });
});
