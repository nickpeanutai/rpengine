import * as ort from 'onnxruntime-web/wasm';
import { getInstalledModelFile } from './model-store';
import { MOONSHINE_ENGLISH_V2_MODEL_ID } from './types';

const MODEL_DIRECTORY = 'small-streaming-en';
const CHUNK_SAMPLES = 1_280;
const SAMPLE_RATE = 16_000;
const MAX_TOKENS_PER_SECOND = 6.5;
const MAX_TOKENS = 256;

const SESSION_CONTRACTS = {
  frontend: {
    file: 'frontend.ort',
    inputs: ['audio_chunk', 'sample_buffer', 'sample_len', 'conv1_buffer', 'conv2_buffer', 'frame_count'],
    outputs: ['features', 'sample_buffer_out', 'sample_len_out', 'conv1_buffer_out', 'conv2_buffer_out', 'frame_count_out'],
  },
  encoder: { file: 'encoder.ort', inputs: ['features'], outputs: ['encoded'] },
  adapter: { file: 'adapter.ort', inputs: ['encoded', 'pos_offset'], outputs: ['memory'] },
  crossKv: { file: 'cross_kv.ort', inputs: ['memory'], outputs: ['k_cross', 'v_cross'] },
  decoderKv: {
    file: 'decoder_kv.ort',
    inputs: ['token', 'k_self', 'v_self', 'out_k_cross', 'out_v_cross'],
    outputs: ['logits', 'out_k_self', 'out_v_self', 'out_k_cross', 'out_v_cross'],
  },
} as const;

type SessionName = keyof typeof SESSION_CONTRACTS;

export interface MoonshineV2Session {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
  release?(): Promise<void> | void;
}

export type MoonshineV2SessionFactory = (bytes: Uint8Array, stage: SessionName) => Promise<MoonshineV2Session>;
export type MoonshineV2FileReader = (modelId: string, path: string) => Promise<Uint8Array>;
export type MoonshineV2LoadProgress = (current: number, total: number, name: string) => void;

export interface MoonshineV2Config {
  encoder_dim: number;
  decoder_dim: number;
  depth: number;
  nheads: number;
  head_dim: number;
  vocab_size: number;
  bos_id: number;
  eos_id: number;
  frame_len: number;
  total_lookahead: number;
  d_model_frontend: number;
  c1: number;
  c2: number;
  frontend_state_shapes: {
    sample_buffer: number[];
    sample_len: number[];
    conv1_buffer: number[];
    conv2_buffer: number[];
    frame_count: number[];
  };
}

interface LoadedSessions {
  frontend: MoonshineV2Session;
  encoder: MoonshineV2Session;
  adapter: MoonshineV2Session;
  crossKv: MoonshineV2Session;
  decoderKv: MoonshineV2Session;
}

interface StreamingState {
  sampleBuffer: Float32Array;
  sampleLength: bigint;
  conv1Buffer: Float32Array;
  conv2Buffer: Float32Array;
  frameCount: bigint;
  accumulatedFeatures: Float32Array;
  accumulatedFeatureCount: number;
  encoderFramesEmitted: number;
  adapterPositionOffset: bigint;
  memory: Float32Array;
  memoryLength: number;
  kSelf: Float32Array;
  vSelf: Float32Array;
  cacheSequenceLength: number;
  kCross: Float32Array;
  vCross: Float32Array;
  crossLength: number;
  crossKvValid: boolean;
}

const defaultReader: MoonshineV2FileReader = async (modelId, path) =>
  new Uint8Array(await (await getInstalledModelFile(modelId, path)).arrayBuffer());

const defaultSessionFactory: MoonshineV2SessionFactory = async bytes =>
  ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });

export class MoonshineV2Tokenizer {
  private readonly tokens: Uint8Array[] = [];

  constructor(data: Uint8Array) {
    if (data.length === 0) throw new Error('Tokenizer data is empty.');
    let offset = 0;
    while (offset < data.length) {
      const first = data[offset++];
      if (first === 0) {
        this.tokens.push(new Uint8Array());
        continue;
      }
      let length = first;
      if (first >= 128) {
        if (offset >= data.length) throw new Error(`Tokenizer data is missing a length byte at offset ${offset}.`);
        length = data[offset++] * 128 + first - 128;
      }
      if (length > data.length - offset) throw new Error(`Tokenizer token at offset ${offset} exceeds the input size.`);
      this.tokens.push(data.slice(offset, offset + length));
      offset += length;
    }
    if (this.tokens.length === 0) throw new Error('Tokenizer contains no tokens.');
  }

  decode(tokenIds: readonly number[]) {
    const pieces: Uint8Array[] = [];
    let total = 0;
    for (const tokenId of tokenIds) {
      const bytes = this.tokens[tokenId];
      if (!bytes || bytes.length === 0) throw new Error(`Invalid token ${tokenId}.`);
      if (bytes.length > 2 && bytes[0] === 60 && bytes[bytes.length - 1] === 62) continue;
      pieces.push(bytes);
      total += bytes.length;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
      joined.set(piece, offset);
      offset += piece.length;
    }
    return new TextDecoder().decode(joined).replaceAll('▁', ' ').trim();
  }
}

export class MoonshineV2BatchRuntime {
  private sessions?: LoadedSessions;
  private config?: MoonshineV2Config;
  private tokenizer?: MoonshineV2Tokenizer;

  constructor(
    private readonly createSession: MoonshineV2SessionFactory = defaultSessionFactory,
    private readonly readFile: MoonshineV2FileReader = defaultReader,
  ) {}

  async load(progress: MoonshineV2LoadProgress = () => undefined) {
    if (this.sessions && this.config && this.tokenizer) return;
    const created: Partial<LoadedSessions> = {};
    try {
      progress(1, 7, 'streaming_config.json');
      const configBytes = await this.readStage('configuration', 'streaming_config.json');
      const config = parseConfig(configBytes);

      progress(2, 7, 'tokenizer.bin');
      const tokenizerBytes = await this.readStage('tokenizer', 'tokenizer.bin');
      const tokenizer = stage('tokenizer', () => new MoonshineV2Tokenizer(tokenizerBytes));

      const names = Object.keys(SESSION_CONTRACTS) as SessionName[];
      for (let index = 0; index < names.length; index += 1) {
        const name = names[index];
        const contract = SESSION_CONTRACTS[name];
        progress(index + 3, 7, contract.file);
        const bytes = await this.readStage(name, contract.file);
        const session = await asyncStage(`${name} session creation`, () => this.createSession(bytes, name));
        created[name] = session;
        validateSession(name, session);
      }

      this.config = config;
      this.tokenizer = tokenizer;
      this.sessions = created as LoadedSessions;
    } catch (error) {
      await releaseSessions(created);
      throw error;
    }
  }

  async generate(samples: Float32Array) {
    if (samples.length === 0) throw new Error('Moonshine v2 received empty audio.');
    await this.load();
    const sessions = this.sessions;
    const config = this.config;
    const tokenizer = this.tokenizer;
    if (!sessions || !config || !tokenizer) throw new Error('Moonshine v2 is not loaded.');

    const state = resetState(config);
    const completeChunks = Math.floor(samples.length / CHUNK_SAMPLES);
    for (let chunk = 0; chunk < completeChunks; chunk += 1) {
      const start = chunk * CHUNK_SAMPLES;
      await this.processFrontend(samples.subarray(start, start + CHUNK_SAMPLES), state, config, sessions.frontend);
    }
    await this.encodeFinal(state, config, sessions.encoder, sessions.adapter);
    if (state.memoryLength === 0) return { text: '', tokenIds: [] as number[] };

    state.kSelf = new Float32Array();
    state.vSelf = new Float32Array();
    state.cacheSequenceLength = 0;
    await this.computeCrossKv(state, config, sessions.crossKv);

    const maxTokens = Math.min(Math.ceil(samples.length / SAMPLE_RATE * MAX_TOKENS_PER_SECOND), MAX_TOKENS);
    const tokenIds = [config.bos_id];
    let currentToken = config.bos_id;
    for (let step = 0; step < maxTokens; step += 1) {
      const logits = await this.decodeStep(currentToken, state, config, sessions.decoderKv);
      const nextToken = argmax(logits, config.vocab_size);
      tokenIds.push(nextToken);
      currentToken = nextToken;
      if (nextToken === config.eos_id) break;
    }
    return { text: stage('tokenizer', () => tokenizer.decode(tokenIds)), tokenIds };
  }

  async dispose() {
    const sessions = this.sessions;
    this.sessions = undefined;
    this.config = undefined;
    this.tokenizer = undefined;
    if (sessions) await releaseSessions(sessions);
  }

  private async readStage(stageName: string, filename: string) {
    return asyncStage(`${stageName} file loading`, () => this.readFile(MOONSHINE_ENGLISH_V2_MODEL_ID, `${MODEL_DIRECTORY}/${filename}`));
  }

  private async processFrontend(audio: Float32Array, state: StreamingState, config: MoonshineV2Config, session: MoonshineV2Session) {
    const shapes = config.frontend_state_shapes;
    const outputs = await asyncStage('frontend', () => session.run({
      audio_chunk: floatTensor(audio, [1, audio.length]),
      sample_buffer: floatTensor(state.sampleBuffer, shapes.sample_buffer),
      sample_len: int64Tensor([state.sampleLength], shapes.sample_len),
      conv1_buffer: floatTensor(state.conv1Buffer, shapes.conv1_buffer),
      conv2_buffer: floatTensor(state.conv2Buffer, shapes.conv2_buffer),
      frame_count: int64Tensor([state.frameCount], shapes.frame_count),
    }));
    const features = floatOutput(outputs, 'features', 'frontend');
    validateDims(features.dims, [1, undefined, config.encoder_dim], 'frontend features');
    const featureCount = features.dims[1];
    state.accumulatedFeatures = append(state.accumulatedFeatures, features.data);
    state.accumulatedFeatureCount += featureCount;
    state.sampleBuffer = exactFloatOutput(outputs, 'sample_buffer_out', product(shapes.sample_buffer), 'frontend');
    state.sampleLength = scalarInt64Output(outputs, 'sample_len_out', 'frontend');
    state.conv1Buffer = exactFloatOutput(outputs, 'conv1_buffer_out', product(shapes.conv1_buffer), 'frontend');
    state.conv2Buffer = exactFloatOutput(outputs, 'conv2_buffer_out', product(shapes.conv2_buffer), 'frontend');
    state.frameCount = scalarInt64Output(outputs, 'frame_count_out', 'frontend');
  }

  private async encodeFinal(state: StreamingState, config: MoonshineV2Config, encoder: MoonshineV2Session, adapter: MoonshineV2Session) {
    const totalFeatures = state.accumulatedFeatureCount;
    if (totalFeatures === 0) return;
    const stableCount = totalFeatures;
    const newFrames = stableCount - state.encoderFramesEmitted;
    if (newFrames <= 0) return;
    const windowStart = Math.max(0, state.encoderFramesEmitted - 16 * config.depth);
    const windowSize = totalFeatures - windowStart;
    const featuresStart = windowStart * config.encoder_dim;
    const features = state.accumulatedFeatures.subarray(featuresStart, featuresStart + windowSize * config.encoder_dim);
    const encoderOutputs = await asyncStage('encoder', () => encoder.run({ features: floatTensor(features, [1, windowSize, config.encoder_dim]) }));
    const encoded = floatOutput(encoderOutputs, 'encoded', 'encoder');
    validateDims(encoded.dims, [1, undefined, config.encoder_dim], 'encoder output');
    const startIndex = state.encoderFramesEmitted - windowStart;
    if (startIndex < 0 || startIndex + newFrames > encoded.dims[1]) throw new Error('Moonshine v2 encoder failed: output window is misaligned.');
    const sliceStart = startIndex * config.encoder_dim;
    const encodedSlice = encoded.data.slice(sliceStart, sliceStart + newFrames * config.encoder_dim);
    const adapterOutputs = await asyncStage('adapter', () => adapter.run({
      encoded: floatTensor(encodedSlice, [1, newFrames, config.encoder_dim]),
      pos_offset: int64Tensor([state.adapterPositionOffset], [1]),
    }));
    const memory = floatOutput(adapterOutputs, 'memory', 'adapter');
    validateDims(memory.dims, [1, newFrames, config.decoder_dim], 'adapter memory');
    state.memory = append(state.memory, memory.data);
    state.memoryLength += newFrames;
    state.crossKvValid = false;
    state.encoderFramesEmitted = stableCount;
    state.adapterPositionOffset += BigInt(newFrames);
  }

  private async computeCrossKv(state: StreamingState, config: MoonshineV2Config, session: MoonshineV2Session) {
    if (state.memoryLength === 0) throw new Error('Moonshine v2 cross-KV failed: decoder memory is empty.');
    const outputs = await asyncStage('cross-KV', () => session.run({
      memory: floatTensor(state.memory, [1, state.memoryLength, config.decoder_dim]),
    }));
    const kCross = floatOutput(outputs, 'k_cross', 'cross-KV');
    const vCross = floatOutput(outputs, 'v_cross', 'cross-KV');
    validateDims(kCross.dims, [config.depth, 1, config.nheads, undefined, config.head_dim], 'cross-KV key');
    validateDims(vCross.dims, kCross.dims, 'cross-KV value');
    state.kCross = kCross.data.slice();
    state.vCross = vCross.data.slice();
    state.crossLength = kCross.dims[3];
    state.crossKvValid = true;
  }

  private async decodeStep(token: number, state: StreamingState, config: MoonshineV2Config, session: MoonshineV2Session) {
    if (!state.crossKvValid || state.crossLength === 0) throw new Error('Moonshine v2 decoder failed: cross-KV is unavailable.');
    const selfShape = [config.depth, 1, config.nheads, state.cacheSequenceLength, config.head_dim];
    const crossShape = [config.depth, 1, config.nheads, state.crossLength, config.head_dim];
    const outputs = await asyncStage('decoder', () => session.run({
      token: int64Tensor([BigInt(token)], [1, 1]),
      k_self: floatTensor(state.kSelf, selfShape),
      v_self: floatTensor(state.vSelf, selfShape),
      out_k_cross: floatTensor(state.kCross, crossShape),
      out_v_cross: floatTensor(state.vCross, crossShape),
    }));
    const logits = floatOutput(outputs, 'logits', 'decoder');
    validateDims(logits.dims, [1, 1, config.vocab_size], 'decoder logits');
    const kSelf = floatOutput(outputs, 'out_k_self', 'decoder');
    const vSelf = floatOutput(outputs, 'out_v_self', 'decoder');
    validateDims(kSelf.dims, [config.depth, 1, config.nheads, undefined, config.head_dim], 'decoder key cache');
    validateDims(vSelf.dims, kSelf.dims, 'decoder value cache');
    state.kSelf = kSelf.data.slice();
    state.vSelf = vSelf.data.slice();
    state.cacheSequenceLength = kSelf.dims[3];
    return logits.data;
  }
}

export function parseMoonshineV2Config(data: Uint8Array): MoonshineV2Config {
  return parseConfig(data);
}

function parseConfig(data: Uint8Array): MoonshineV2Config {
  return stage('configuration', () => {
    const value = JSON.parse(new TextDecoder().decode(data)) as unknown;
    if (!value || typeof value !== 'object') throw new Error('Configuration must be an object.');
    const source = value as Record<string, unknown>;
    const integerKeys = ['encoder_dim', 'decoder_dim', 'depth', 'nheads', 'head_dim', 'vocab_size', 'bos_id', 'eos_id', 'frame_len', 'total_lookahead', 'd_model_frontend', 'c1', 'c2'] as const;
    for (const key of integerKeys) {
      const number = source[key];
      if (!Number.isInteger(number) || (number as number) < 0 || (key !== 'bos_id' && key !== 'eos_id' && number === 0)) throw new Error(`Configuration field ${key} is invalid.`);
    }
    const shapeSource = source.frontend_state_shapes;
    if (!shapeSource || typeof shapeSource !== 'object') throw new Error('Configuration frontend_state_shapes is invalid.');
    const shapes = shapeSource as Record<string, unknown>;
    for (const key of ['sample_buffer', 'sample_len', 'conv1_buffer', 'conv2_buffer', 'frame_count'] as const) validateShape(shapes[key], key);
    const config = source as unknown as MoonshineV2Config;
    if (config.bos_id >= config.vocab_size || config.eos_id >= config.vocab_size) throw new Error('Configuration token IDs exceed the vocabulary.');
    if (product(config.frontend_state_shapes.conv1_buffer) !== config.d_model_frontend * 4) throw new Error('Configuration conv1 state shape is inconsistent.');
    if (product(config.frontend_state_shapes.conv2_buffer) !== config.c1 * 4) throw new Error('Configuration conv2 state shape is inconsistent.');
    return config;
  });
}

function resetState(config: MoonshineV2Config): StreamingState {
  const shapes = config.frontend_state_shapes;
  return {
    sampleBuffer: new Float32Array(product(shapes.sample_buffer)), sampleLength: 0n,
    conv1Buffer: new Float32Array(product(shapes.conv1_buffer)), conv2Buffer: new Float32Array(product(shapes.conv2_buffer)), frameCount: 0n,
    accumulatedFeatures: new Float32Array(), accumulatedFeatureCount: 0, encoderFramesEmitted: 0, adapterPositionOffset: 0n,
    memory: new Float32Array(), memoryLength: 0, kSelf: new Float32Array(), vSelf: new Float32Array(), cacheSequenceLength: 0,
    kCross: new Float32Array(), vCross: new Float32Array(), crossLength: 0, crossKvValid: false,
  };
}

function validateSession(name: SessionName, session: MoonshineV2Session) {
  const contract = SESSION_CONTRACTS[name];
  for (const input of contract.inputs) if (!session.inputNames.includes(input)) throw new Error(`Moonshine v2 ${name} session creation failed: missing input ${input}.`);
  for (const output of contract.outputs) if (!session.outputNames.includes(output)) throw new Error(`Moonshine v2 ${name} session creation failed: missing output ${output}.`);
}

async function releaseSessions(sessions: Partial<LoadedSessions>) {
  await Promise.allSettled(Object.values(sessions).map(session => session.release?.()));
}

function floatTensor(data: Float32Array, dims: readonly number[]) { return new ort.Tensor('float32', data, [...dims]); }
function int64Tensor(data: readonly bigint[], dims: readonly number[]) { return new ort.Tensor('int64', BigInt64Array.from(data), [...dims]); }

function floatOutput(outputs: Record<string, ort.Tensor>, name: string, stageName: string) {
  const tensor = outputs[name];
  if (!tensor || tensor.type !== 'float32' || !(tensor.data instanceof Float32Array)) throw new Error(`Moonshine v2 ${stageName} failed: ${name} is not a float32 tensor.`);
  return { data: tensor.data, dims: tensor.dims.map(Number) };
}

function exactFloatOutput(outputs: Record<string, ort.Tensor>, name: string, length: number, stageName: string) {
  const output = floatOutput(outputs, name, stageName);
  if (output.data.length !== length) throw new Error(`Moonshine v2 ${stageName} failed: ${name} has an invalid length.`);
  return output.data.slice();
}

function scalarInt64Output(outputs: Record<string, ort.Tensor>, name: string, stageName: string) {
  const tensor = outputs[name];
  if (!tensor || tensor.type !== 'int64' || !(tensor.data instanceof BigInt64Array) || tensor.data.length !== 1) throw new Error(`Moonshine v2 ${stageName} failed: ${name} is not an int64 scalar.`);
  return tensor.data[0];
}

function validateDims(actual: readonly number[], expected: readonly (number | undefined)[], name: string) {
  if (actual.length !== expected.length || actual.some((value, index) => expected[index] !== undefined && value !== expected[index])) {
    throw new Error(`Moonshine v2 ${name} has shape [${actual.join(',')}], expected [${expected.map(value => value ?? '*').join(',')}].`);
  }
}

function validateShape(value: unknown, name: string): asserts value is number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(dimension => !Number.isInteger(dimension) || dimension <= 0)) throw new Error(`Configuration shape ${name} is invalid.`);
}

function product(values: readonly number[]) { return values.reduce((result, value) => result * value, 1); }
function append(left: Float32Array, right: Float32Array) { const result = new Float32Array(left.length + right.length); result.set(left); result.set(right, left.length); return result; }
function argmax(values: Float32Array, vocabularySize: number) { let best = 0; for (let index = 1; index < vocabularySize; index += 1) if (values[index] > values[best]) best = index; return best; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function stage<T>(name: string, action: () => T): T { try { return action(); } catch (error) { throw new Error(`Moonshine v2 ${name} failed: ${errorMessage(error)}`); } }
async function asyncStage<T>(name: string, action: () => Promise<T>): Promise<T> { try { return await action(); } catch (error) { throw new Error(`Moonshine v2 ${name} failed: ${errorMessage(error)}`); } }
