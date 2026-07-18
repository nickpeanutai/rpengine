/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import { initializeCore, TtsWorkerCore } from './core';
// @ts-expect-error Upstream Supertonic reference is intentionally plain JavaScript.
import { TextToSpeech, UnicodeProcessor, voiceStyleFromData } from './vendor/supertonic-helper.js';
import { getInstalledModelFile } from './model-store';
import { SUPERTONIC_EXPRESSION_TAGS } from './expression';
import { SUPERTONIC_MODEL_ID } from './types';
import type { WorkerRequestV2 } from './core-contract';

declare const self: DedicatedWorkerGlobalScope;
interface SupertonicRuntime { call(text: string, language: string, style: unknown, steps: number, speed: number): Promise<{ wav: number[]; duration: number[] }>; sampleRate: number }

let runtime: SupertonicRuntime | undefined;
let policy: TtsWorkerCore;
const styles = new Map<string, unknown>();
ort.env.wasm.numThreads = Math.min(4, Math.max(1, (self.navigator.hardwareConcurrency || 2) - 2));
ort.env.wasm.wasmPaths = '/ort-wasm/';
self.onmessage = event => { void handle(event.data as WorkerRequestV2); };

async function handle(request: WorkerRequestV2) {
  try {
    await initializeCore(); policy ??= new TtsWorkerCore();
    if (request.type === 'load') await load(request.operationId, request.voice ?? 'F4');
    else if (request.type === 'synthesize') await synthesize(request);
  } catch (error) { self.postMessage({ type: 'error', operationId: request.operationId, error: error instanceof Error ? error.message : String(error) }); }
}

async function load(operationId: number, voice: string) {
  const plan = JSON.parse(policy.load_plan(voice)) as { config: string; unicodeIndexer: string; models: string[] };
  const [configFile, indexFile] = await Promise.all([getInstalledModelFile(SUPERTONIC_MODEL_ID, plan.config), getInstalledModelFile(SUPERTONIC_MODEL_ID, plan.unicodeIndexer)]);
  const config = JSON.parse(await configFile.text()) as Record<string, unknown>;
  const index = JSON.parse(await indexFile.text()) as Record<string, unknown>;
  const sessions: ort.InferenceSession[] = [];
  for (let i = 0; i < plan.models.length; i += 1) {
    self.postMessage({ type: 'load-progress', operationId, current: i + 1, total: plan.models.length + 1, name: plan.models[i] });
    const file = await getInstalledModelFile(SUPERTONIC_MODEL_ID, `Supertonic3.bundle/onnx/${plan.models[i]}`);
    sessions.push(await ort.InferenceSession.create(new Uint8Array(await file.arrayBuffer()), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
  }
  runtime = new TextToSpeech(config, new UnicodeProcessor(index), ...sessions) as SupertonicRuntime;
  self.postMessage({ type: 'load-progress', operationId, current: 5, total: 5, name: `voice_styles/${voice}.json` });
  await style(voice); policy.mark_loaded(voice);
  self.postMessage({ type: 'loaded', operationId, sampleRate: runtime.sampleRate, threads: ort.env.wasm.numThreads, expressionTags: [...SUPERTONIC_EXPRESSION_TAGS], executionProvider: 'wasm' });
}

async function style(voice: string) {
  const cached = styles.get(voice); if (cached) return cached;
  const file = await getInstalledModelFile(SUPERTONIC_MODEL_ID, `Supertonic3.bundle/voice_styles/${voice}.json`);
  const loaded = voiceStyleFromData([JSON.parse(await file.text())]); styles.set(voice, loaded); policy.mark_voice_loaded(voice); return loaded;
}

async function synthesize(request: Extract<WorkerRequestV2, { type: 'synthesize' }>) {
  if (!runtime) throw new Error('Supertonic 3 is not loaded.');
  const plan = JSON.parse(policy.synthesis_plan(request.text, request.language, request.voice, JSON.stringify(SUPERTONIC_EXPRESSION_TAGS))) as { text: string; language: string; voice: string; steps: number; speed: number };
  const started = performance.now();
  const result = await runtime.call(plan.text, plan.language, await style(plan.voice), plan.steps, plan.speed);
  const samples = policy.process_audio(Float32Array.from(result.wav), runtime.sampleRate);
  self.postMessage({ type: 'synthesized', operationId: request.operationId, samples, sampleRate: runtime.sampleRate, duration: samples.length / runtime.sampleRate, sourceDuration: result.duration[0], elapsedMs: Math.round(performance.now() - started) }, [samples.buffer]);
}
