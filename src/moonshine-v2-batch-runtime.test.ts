import * as ort from 'onnxruntime-web/wasm';
import { describe, expect, it, vi } from 'vitest';
import {
  MoonshineV2BatchRuntime,
  MoonshineV2Tokenizer,
  parseMoonshineV2Config,
  type MoonshineV2Session,
  type MoonshineV2SessionFactory,
} from './moonshine-v2-batch-runtime';
import { MOONSHINE_ENGLISH_V2_MODEL_ID } from './types';

const config = {
  encoder_dim: 2, decoder_dim: 3, depth: 1, nheads: 1, head_dim: 3, vocab_size: 4,
  bos_id: 1, eos_id: 2, frame_len: 80, total_lookahead: 16, d_model_frontend: 2, c1: 3, c2: 2,
  frontend_state_shapes: {
    sample_buffer: [1, 2], sample_len: [1], conv1_buffer: [1, 2, 4], conv2_buffer: [1, 3, 4], frame_count: [1],
  },
};

const contracts = {
  frontend: { inputNames: ['audio_chunk', 'sample_buffer', 'sample_len', 'conv1_buffer', 'conv2_buffer', 'frame_count'], outputNames: ['features', 'sample_buffer_out', 'sample_len_out', 'conv1_buffer_out', 'conv2_buffer_out', 'frame_count_out'] },
  encoder: { inputNames: ['features'], outputNames: ['encoded'] },
  adapter: { inputNames: ['encoded', 'pos_offset'], outputNames: ['memory'] },
  crossKv: { inputNames: ['memory'], outputNames: ['k_cross', 'v_cross'] },
  decoderKv: { inputNames: ['token', 'k_self', 'v_self', 'out_k_cross', 'out_v_cross'], outputNames: ['logits', 'out_k_self', 'out_v_self', 'out_k_cross', 'out_v_cross'] },
} as const;

describe('MoonshineV2BatchRuntime', () => {
  it('ports the official batch state transitions and drops trailing samples smaller than 1,280', async () => {
    const calls = new Map<string, Array<Record<string, ort.Tensor>>>();
    let decodeStep = 0;
    const factory = fakeFactory(async (stage, feeds) => {
      const list = calls.get(stage) ?? [];
      list.push(feeds);
      calls.set(stage, list);
      if (stage === 'frontend') return outputRecord({
        features: float([0.1, 0.2], [1, 1, 2]),
        sample_buffer_out: float([0, 0], [1, 2]), sample_len_out: int64([0n], [1]),
        conv1_buffer_out: float(new Array(8).fill(0), [1, 2, 4]), conv2_buffer_out: float(new Array(12).fill(0), [1, 3, 4]), frame_count_out: int64([0n], [1]),
      });
      if (stage === 'encoder') return outputRecord({ encoded: float(Array.from(feeds.features.data as Float32Array), feeds.features.dims) });
      if (stage === 'adapter') return outputRecord({ memory: float(new Array(feeds.encoded.dims[1] * 3).fill(0.5), [1, feeds.encoded.dims[1], 3]) });
      if (stage === 'crossKv') return outputRecord({ k_cross: float(new Array(6).fill(1), [1, 1, 1, 2, 3]), v_cross: float(new Array(6).fill(2), [1, 1, 1, 2, 3]) });
      const next = decodeStep++ === 0 ? 3 : 2;
      const logits = [-10, -10, -10, -10]; logits[next] = 10;
      const cacheLength = feeds.k_self.dims[3] + 1;
      return outputRecord({
        logits: float(logits, [1, 1, 4]),
        out_k_self: float(new Array(cacheLength * 3).fill(3), [1, 1, 1, cacheLength, 3]),
        out_v_self: float(new Array(cacheLength * 3).fill(4), [1, 1, 1, cacheLength, 3]),
        out_k_cross: feeds.out_k_cross, out_v_cross: feeds.out_v_cross,
      });
    });
    const progress = vi.fn();
    const runtime = new MoonshineV2BatchRuntime(factory, reader());

    await runtime.load(progress);
    const result = await runtime.generate(new Float32Array(3_000));

    expect(result).toEqual({ text: 'hello', tokenIds: [1, 3, 2] });
    expect(calls.get('frontend')).toHaveLength(2);
    expect(calls.get('frontend')?.every(call => call.audio_chunk.dims.join(',') === '1,1280')).toBe(true);
    expect(calls.get('encoder')?.[0].features.dims).toEqual([1, 2, 2]);
    expect(calls.get('adapter')?.[0].pos_offset.data).toEqual(BigInt64Array.of(0n));
    expect(calls.get('crossKv')?.[0].memory.dims).toEqual([1, 2, 3]);
    expect(calls.get('decoderKv')?.[0].k_self.dims).toEqual([1, 1, 1, 0, 3]);
    expect(calls.get('decoderKv')?.[1].k_self.dims).toEqual([1, 1, 1, 1, 3]);
    expect(progress.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('returns no transcript when an utterance contains no complete official chunk', async () => {
    const run = vi.fn(async () => ({}));
    const runtime = new MoonshineV2BatchRuntime(fakeFactory(run), reader());

    await expect(runtime.generate(new Float32Array(1_279))).resolves.toEqual({ text: '', tokenIds: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it('reuses a successful load and releases partial sessions after a named creation failure', async () => {
    const releases = new Map<string, ReturnType<typeof vi.fn>>();
    const create = vi.fn(async (_bytes: Uint8Array, stage: keyof typeof contracts) => {
      if (stage === 'adapter') throw new Error('bad adapter model');
      const release = vi.fn(); releases.set(stage, release);
      return { ...contracts[stage], run: async () => ({}), release } satisfies MoonshineV2Session;
    });
    const runtime = new MoonshineV2BatchRuntime(create, reader());

    await expect(runtime.load()).rejects.toThrow('Moonshine v2 adapter session creation failed: bad adapter model');
    expect(releases.get('frontend')).toHaveBeenCalledOnce();
    expect(releases.get('encoder')).toHaveBeenCalledOnce();
  });

  it('releases a session whose declared tensor contract is invalid', async () => {
    const release = vi.fn();
    const runtime = new MoonshineV2BatchRuntime(
      async (_bytes, stage) => stage === 'frontend'
        ? { inputNames: [], outputNames: [], run: async () => ({}), release }
        : { ...contracts[stage], run: async () => ({}) },
      reader(),
    );

    await expect(runtime.load()).rejects.toThrow('missing input audio_chunk');
    expect(release).toHaveBeenCalledOnce();
  });

  it('loads all files from the v2 model directory and validates session contracts', async () => {
    const reads: Array<[string, string]> = [];
    const runtime = new MoonshineV2BatchRuntime(
      fakeFactory(async () => ({})),
      async (modelId, path) => { reads.push([modelId, path]); return reader()(modelId, path); },
    );

    await runtime.load();
    await runtime.load();

    expect(reads).toHaveLength(7);
    expect(reads.every(([modelId, path]) => modelId === MOONSHINE_ENGLISH_V2_MODEL_ID && path.startsWith('small-streaming-en/'))).toBe(true);
  });
});

describe('Moonshine v2 configuration and tokenizer parity', () => {
  it('validates dimensions dynamically and rejects inconsistent state shapes', () => {
    expect(parseMoonshineV2Config(json(config))).toMatchObject({ encoder_dim: 2, decoder_dim: 3 });
    expect(() => parseMoonshineV2Config(json({ ...config, encoder_dim: 0 }))).toThrow('encoder_dim');
    expect(() => parseMoonshineV2Config(json({ ...config, frontend_state_shapes: { ...config.frontend_state_shapes, conv1_buffer: [1, 3, 4] } }))).toThrow('conv1 state shape');
  });

  it('uses the official binary lengths, skips special tokens, replaces sentence-piece spaces and rejects empty tokens', () => {
    const tokenizer = new MoonshineV2Tokenizer(tokenizerData());
    expect(tokenizer.decode([1, 3, 2])).toBe('hello');
    expect(() => tokenizer.decode([0])).toThrow('Invalid token 0');
    expect(() => new MoonshineV2Tokenizer(Uint8Array.of(128))).toThrow('missing a length byte');
  });
});

function reader() {
  return async (_modelId: string, path: string) => {
    if (path.endsWith('streaming_config.json')) return json(config);
    if (path.endsWith('tokenizer.bin')) return tokenizerData();
    return Uint8Array.of(1);
  };
}

function fakeFactory(run: (stage: keyof typeof contracts, feeds: Record<string, ort.Tensor>) => Promise<Record<string, ort.Tensor>>): MoonshineV2SessionFactory {
  return async (_bytes, stage) => ({ ...contracts[stage], run: feeds => run(stage, feeds) });
}

function tokenizerData() {
  const tokens = [new Uint8Array(), new TextEncoder().encode('<s>'), new TextEncoder().encode('</s>'), new TextEncoder().encode('▁hello')];
  return Uint8Array.from(tokens.flatMap(token => [token.length, ...token]));
}

function json(value: unknown) { return new TextEncoder().encode(JSON.stringify(value)); }
function float(values: readonly number[] | Float32Array, dims: readonly number[]) { return new ort.Tensor('float32', Float32Array.from(values), [...dims]); }
function int64(values: readonly bigint[], dims: readonly number[]) { return new ort.Tensor('int64', BigInt64Array.from(values), [...dims]); }
function outputRecord(value: Record<string, ort.Tensor>) { return value; }
