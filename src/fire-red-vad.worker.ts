/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import { parseKaldiCmvn, StreamingKaldiFbank, StreamingResampler, VAD_MEL_BINS } from './fire-red-vad-audio';
import { createVadCoreObjects } from './fire-red-vad-runtime';

declare const self: DedicatedWorkerGlobalScope;
const MODEL_URL = '/vad/fireredvad_stream_vad_with_cache.onnx';
const CMVN_URL = '/vad/cmvn.ark';
const CACHE_SHAPE = [8, 1, 128, 19] as const;
const CACHE_SIZE = CACHE_SHAPE.reduce<number>((product, value) => product * value, 1);

let session: ort.InferenceSession | undefined;
let cmvn: ReturnType<typeof parseKaldiCmvn> | undefined;
let requestId = '';
let resampler: StreamingResampler | undefined;
let fbank: StreamingKaldiFbank | undefined;
let caches = new Float32Array(CACHE_SIZE);
let policy: Awaited<ReturnType<typeof createVadCoreObjects>>['policy'] | undefined;

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = '/ort-wasm/';
let messageTail = Promise.resolve();
self.onmessage = event => {
  const message = event.data as Record<string, unknown>;
  messageTail = messageTail.then(() => handle(message)).catch(fail);
};

async function handle(message: Record<string, unknown>) {
  if (!policy || !fbank) ({ policy, fbank } = await createVadCoreObjects());
  if (message.type === 'load') await load();
  else if (message.type === 'start') start(String(message.requestId ?? ''), numberValue(message.sourceRate));
  else if (message.type === 'chunk') await processChunk(message);
  else if (message.type === 'cancel') cancel(String(message.requestId ?? ''));
}

async function load() {
  if (session && cmvn) return loaded();
  const started = performance.now();
  const [modelResponse, cmvnResponse] = await Promise.all([fetch(MODEL_URL), fetch(CMVN_URL)]);
  if (!modelResponse.ok) throw new Error(`FireRedVAD model could not be loaded (${modelResponse.status}).`);
  if (!cmvnResponse.ok) throw new Error(`FireRedVAD CMVN could not be loaded (${cmvnResponse.status}).`);
  const [model, cmvnBuffer] = await Promise.all([modelResponse.arrayBuffer(), cmvnResponse.arrayBuffer()]);
  cmvn = parseKaldiCmvn(cmvnBuffer);
  session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  if (!session.inputNames.includes('feat') || !session.inputNames.includes('caches_in')) throw new Error('FireRedVAD model input signature is incompatible.');
  if (!session.outputNames.includes('probs') || !session.outputNames.includes('caches_out')) throw new Error('FireRedVAD model output signature is incompatible.');
  loaded(Math.round(performance.now() - started));
}

function loaded(elapsedMs = 0) { self.postMessage({ type: 'loaded', model: 'fireredvad_stream_vad_with_cache.onnx', version: '2026-05-06', elapsedMs }); }

function start(nextRequestId: string, sourceRate: number) {
  if (!session || !cmvn || !policy || !fbank) throw new Error('FireRedVAD is not loaded.');
  const state = JSON.parse(policy.start(nextRequestId));
  requestId = nextRequestId; resampler = new StreamingResampler(sourceRate); fbank.reset(); caches = new Float32Array(CACHE_SIZE);
  self.postMessage({ type: 'state', requestId, ...state });
}

async function processChunk(message: Record<string, unknown>) {
  const incomingId = String(message.requestId ?? '');
  if (!requestId || incomingId !== requestId || !policy || !fbank || policy.disabled() || !session || !cmvn || !resampler || !(message.samples instanceof ArrayBuffer)) return;
  policy.observe_capture(numberValue(message.endSeconds));
  const features = fbank.push(resampler.push(new Float32Array(message.samples)), cmvn);
  const frameCount = features.length / VAD_MEL_BINS; if (!frameCount) return;
  const started = performance.now();
  const output = await session.run({ feat: new ort.Tensor('float32', features, [1, frameCount, VAD_MEL_BINS]), caches_in: new ort.Tensor('float32', caches, [...CACHE_SHAPE]) });
  const probabilities = output.probs?.data as Float32Array | undefined;
  const nextCaches = output.caches_out?.data as Float32Array | undefined;
  if (!probabilities || probabilities.length !== frameCount || !nextCaches) throw new Error('FireRedVAD returned an invalid result.');
  caches = new Float32Array(nextCaches);
  const events = JSON.parse(policy.accept_probabilities(probabilities, performance.now() - started)) as Array<Record<string, unknown>>;
  for (const event of events) {
    if (event.type === 'state') self.postMessage({ type: 'state', requestId, ...(event.update as object), autoEndEnabled: true, probability: event.probability, inferenceMs: event.inferenceMs });
    else if (event.type === 'noSpeech') self.postMessage({ type: 'no-speech', requestId, seconds: event.seconds });
    else if (event.type === 'diagnostic') self.postMessage({ type: 'diagnostic', requestId, probability: event.probability, inferenceMs: event.inferenceMs, lagSeconds: event.lagSeconds });
    else if (event.type === 'degraded') self.postMessage({ type: 'degraded', requestId, state: 'listening', seconds: event.seconds, autoEndEnabled: false, message: event.message });
  }
}

function cancel(incomingId: string) { if (incomingId && incomingId !== requestId) return; requestId = ''; resampler = undefined; fbank?.reset(); caches = new Float32Array(CACHE_SIZE); policy?.reset(); }
function fail(error: unknown) { const message = error instanceof Error ? error.message : String(error); if (requestId) self.postMessage({ type: 'degraded', requestId, state: 'listening', seconds: 0, autoEndEnabled: false, message }); else self.postMessage({ type: 'load-error', message }); }
function numberValue(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
