import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  decode: vi.fn(),
  encoderInputs: [] as Array<Record<string, unknown>>,
  decoderInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock('llama-tokenizer-js', () => ({ default: { decode: mocks.decode } }));
vi.mock('onnxruntime-web/wasm', () => {
  class Tensor {
    constructor(public type: string, public data: unknown, public dims?: number[]) {}
  }
  return {
    env: { wasm: { wasmPaths: '', numThreads: 1 } },
    Tensor,
    InferenceSession: { create: mocks.create },
  };
});

import MoonshineModel from '../moonshine-js/src/model';

function presentOutputs(Tensor: new (type: string, data: unknown, dims?: number[]) => unknown) {
  const values: Record<string, unknown> = {};
  for (let layer = 0; layer < 8; layer += 1) {
    for (const source of ['decoder', 'encoder']) {
      for (const kind of ['key', 'value']) values[`present.${layer}.${source}.${kind}`] = new Tensor('float32', [layer], [1]);
    }
  }
  return values;
}

describe('upstream MoonshineModel.generate', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.decode.mockReset();
    mocks.encoderInputs.length = 0;
    mocks.decoderInputs.length = 0;
  });

  it('uses upstream attention-mask, token, EOS, and cache behavior with injected model bytes', async () => {
    const ort = await import('onnxruntime-web/wasm');
    const encoder = {
      inputNames: ['input_values', 'attention_mask'],
      run: vi.fn(async (input: Record<string, unknown>) => {
        mocks.encoderInputs.push(input);
        return { last_hidden_state: new ort.Tensor('float32', [9], [1, 1, 1]) };
      }),
    };
    let decoderStep = 0;
    const decoder = {
      run: vi.fn(async (input: Record<string, unknown>) => {
        mocks.decoderInputs.push(input);
        const token = decoderStep++ === 0 ? 3 : 2;
        return {
          logits: { getData: async () => Float32Array.from([0, 0, token === 2 ? 9 : 0, token === 3 ? 9 : 0]) },
          ...presentOutputs(ort.Tensor),
        };
      }),
    };
    mocks.create.mockResolvedValueOnce(encoder).mockResolvedValueOnce(decoder);
    mocks.decode.mockReturnValue('official transcript');
    const encoderBytes = Uint8Array.of(1, 2);
    const decoderBytes = Uint8Array.of(3, 4);
    const model = new MoonshineModel('model/base-en', 'quantized', {
      encoder: encoderBytes,
      decoder: decoderBytes,
      wasmPath: '/ort-wasm/',
    });

    await model.loadModel();
    await expect(model.generate(new Float32Array(16000))).resolves.toBe('official transcript');

    expect(mocks.create.mock.calls[0]?.[0]).toBe(encoderBytes);
    expect(mocks.create.mock.calls[1]?.[0]).toBe(decoderBytes);
    expect(mocks.encoderInputs[0]).toHaveProperty('attention_mask');
    expect(mocks.decoderInputs).toHaveLength(2);
    expect(mocks.decoderInputs[0]).toMatchObject({ use_cache_branch: { data: [false] } });
    expect(mocks.decoderInputs[1]).toMatchObject({ use_cache_branch: { data: [true] } });
    expect(mocks.decode).toHaveBeenCalledWith([1, 3]);
  });
});
